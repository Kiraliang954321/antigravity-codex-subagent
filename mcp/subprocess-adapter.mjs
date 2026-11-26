import { spawn } from 'node:child_process';

function waitForStreamEnd(stream) {
  if (!stream || stream.readableEnded || stream.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const settle = () => {
      stream.off('end', settle);
      stream.off('close', settle);
      stream.off('error', settle);
      resolve();
    };
    stream.once('end', settle);
    stream.once('close', settle);
    stream.once('error', settle);
  });
}

/**
 * Node child_process adapter matching the subprocess contract expected by codex-client.mjs
 * and mirroring DSH's dsh-subprocess-local exit vs. pipe-drain semantics on Windows.
 */
export function spawnSubprocess({ argv, cwd, stdio: _stdio, graceMs = 3000, env = {} }) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('subagent-codex: spawn argv must be a non-empty array');
  }

  const mergedEnv = { ...process.env };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) {
      delete mergedEnv[key];
    } else {
      mergedEnv[key] = String(value);
    }
  }

  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: mergedEnv,
    windowsHide: true,
  });

  // Guard stdio streams against uncaught error events during teardown after wire.close().
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  const pipeDrainMs = Number.isFinite(graceMs) && graceMs > 0 ? Math.min(graceMs, 1000) : 500;
  const outputClosed = Promise.all([waitForStreamEnd(child.stdout), waitForStreamEnd(child.stderr)]);

  let settled = false;
  let exited = false;
  let spawnError;
  let treeKillPromise = null;
  let treeKillFinished = true;
  // Stays true on clean EOF self-exit (no terminate() called), or when Windows taskkill /T /F
  // explicitly exits 0. Set to false permanently if taskkill ever fails/errors/times out,
  // because once the root PID exits without taskkill /T succeeding, retrying with exit 128
  // cannot prove descendants exited.
  let treeKillConfirmed = true;
  let treeKillEverFailed = false;
  const exitWaiters = new Set();

  const isExitReady = () => exited && treeKillFinished;

  const maybeResolveWaiters = () => {
    if (!isExitReady()) return;
    const confirmed = treeKillConfirmed;
    for (const entry of exitWaiters) {
      entry.resolve(confirmed);
    }
    exitWaiters.clear();
  };

  const rejectWaiters = (error) => {
    for (const entry of exitWaiters) {
      entry.reject(error);
    }
    exitWaiters.clear();
  };

  const done = new Promise((resolve, reject) => {
    let pipeDrainTimer;

    const finishSuccess = (outcome) => {
      if (settled) return;
      settled = true;
      if (pipeDrainTimer !== undefined) {
        clearTimeout(pipeDrainTimer);
        pipeDrainTimer = undefined;
      }
      resolve(outcome);
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      exited = true;
      treeKillFinished = true;
      spawnError = error;
      if (pipeDrainTimer !== undefined) {
        clearTimeout(pipeDrainTimer);
        pipeDrainTimer = undefined;
      }
      rejectWaiters(error);
      reject(error);
    });

    // Use 'exit' rather than 'close' so inherited stdio handles in grandchildren on Windows
    // cannot hang waitForExit() or done indefinitely after the target process has exited.
    child.once('exit', (exitCode, signal) => {
      exited = true;
      maybeResolveWaiters();
      const outcome = { exitCode, signal };

      pipeDrainTimer = setTimeout(() => {
        pipeDrainTimer = undefined;
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        finishSuccess(outcome);
      }, pipeDrainMs);
      pipeDrainTimer.unref?.();

      outputClosed.then(() => {
        finishSuccess(outcome);
      });
    });
  });

  // Avoid unhandled rejection if caller only awaits waitForExit() or disposes early.
  done.catch(() => {});

  const waitForExit = (signal) => {
    if (spawnError) return Promise.reject(spawnError);
    if (isExitReady()) return Promise.resolve(treeKillConfirmed);
    if (signal?.aborted) return Promise.resolve(false);

    return new Promise((resolve, reject) => {
      let onAbort;
      const cleanup = () => {
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
          onAbort = undefined;
        }
      };

      const entry = {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };

      exitWaiters.add(entry);

      if (signal) {
        onAbort = () => {
          if (!exitWaiters.delete(entry)) return;
          cleanup();
          resolve(false);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };

  const terminate = () => {
    if (exited && treeKillFinished && treeKillConfirmed) return;
    const pid = child.pid;
    if (process.platform === 'win32' && typeof pid === 'number' && pid > 0) {
      if (treeKillPromise !== null && !treeKillFinished) return;
      // Once a prior taskkill failed and root has exited, retrying taskkill cannot prove
      // descendants exited (parent-child link is gone); keep treeKillConfirmed = false.
      if (treeKillEverFailed && exited) {
        treeKillConfirmed = false;
        treeKillFinished = true;
        maybeResolveWaiters();
        return;
      }
      const exitedBeforeTerminate = exited && !treeKillEverFailed;
      treeKillFinished = false;
      treeKillConfirmed = exitedBeforeTerminate;
      treeKillPromise = new Promise((resolve) => {
        let finished = false;
        let killer;
        let safetyTimer;
        const finishTreeKill = (confirmed) => {
          if (finished) return;
          finished = true;
          if (safetyTimer !== undefined) {
            clearTimeout(safetyTimer);
            safetyTimer = undefined;
          }
          if (!confirmed) {
            treeKillEverFailed = true;
            if (!exited) {
              try { child.kill(); } catch {}
            }
          }
          treeKillConfirmed = Boolean(confirmed);
          treeKillFinished = true;
          maybeResolveWaiters();
          resolve(treeKillConfirmed);
        };

        try {
          // Kill the entire Windows process tree first while keeping the root PID alive
          // until taskkill finishes enumerating and terminating descendants.
          killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.once('error', () => {
            finishTreeKill(false);
          });
          killer.once('exit', (code) => {
            // Only confirm full process-tree termination when taskkill itself succeeded
            // (exit 0) or when the root had already exited cleanly before any failed terminate().
            const confirmed = code === 0 || (code === 128 && exitedBeforeTerminate && !treeKillEverFailed);
            finishTreeKill(confirmed);
          });
          killer.unref?.();

          const safetyMs = Number.isFinite(graceMs) && graceMs > 0 ? Math.max(graceMs, 4000) : 4000;
          safetyTimer = setTimeout(() => {
            try { killer?.kill(); } catch {}
            finishTreeKill(false);
          }, safetyMs);
          safetyTimer.unref?.();
        } catch {
          finishTreeKill(false);
        }
      });
    } else {
      try {
        child.kill();
      } catch {
        // Ignore kill errors if already exiting.
      }
      const killDelay = Number.isFinite(graceMs) && graceMs > 0 ? Math.min(graceMs, 5000) : 3000;
      const timer = setTimeout(() => {
        if (exited) return;
        try {
          child.kill('SIGKILL');
        } catch {}
      }, killDelay);
      timer.unref?.();
    }
  };

  return {
    pid: typeof child.pid === 'number' ? child.pid : -1,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    waitForExit,
    terminate,
  };
}
