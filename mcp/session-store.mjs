import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { normalizeCwdPath } from './codex-client.mjs';

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS = 200;

export const CODEX_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'CODEX_THREAD_NOT_FOUND',
  CWD_MISMATCH: 'CODEX_THREAD_CWD_MISMATCH',
  SELECTOR_CONFLICT: 'CODEX_THREAD_SELECTOR_CONFLICT',
  BUSY: 'CODEX_THREAD_BUSY',
  STORAGE_UNAVAILABLE: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
  RESUME_UNAVAILABLE: 'CODEX_RESUME_UNAVAILABLE',
});

const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATES = new Set(['ready', 'closing', 'uncertain']);

export class CodexSessionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CodexSessionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function normalizeCwd(cwd) {
  return normalizeCwdPath(cwd);
}

export function validateSessionKey(key) {
  if (typeof key !== 'string' || !SESSION_KEY_RE.test(key)) {
    throw new CodexSessionError(
      CODEX_ERROR_CODES.SELECTOR_CONFLICT,
      'subagent-codex: sessionKey must be 1-128 characters matching ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
    );
  }
  return key;
}

export function validateThreadId(threadId) {
  if (typeof threadId !== 'string' || !UUID_RE.test(threadId)) {
    throw new CodexSessionError(
      CODEX_ERROR_CODES.NOT_FOUND,
      'subagent-codex: threadId must be a valid UUID',
    );
  }
  return threadId;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertEnterableDir(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new CodexSessionError(
      CODEX_ERROR_CODES.CWD_MISMATCH,
      `subagent-codex: cwd must be an absolute path: ${String(cwd)}`,
    );
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new CodexSessionError(
      CODEX_ERROR_CODES.CWD_MISMATCH,
      `subagent-codex: cwd is not an accessible directory: ${cwd}`,
    );
  }
}

function serializeEntry(entry) {
  return {
    ...(entry.sessionKey !== undefined ? { sessionKey: entry.sessionKey } : {}),
    threadId: entry.threadId,
    cwd: entry.cwd,
    model: entry.model ?? null,
    lastUsedAt: entry.lastUsedAt,
    used: entry.used ?? null,
    contextWindow: entry.contextWindow ?? null,
    size: entry.size ?? null,
    state: entry.state,
  };
}

function atomicWriteJson(filePath, payload) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const data = JSON.stringify(payload, null, 2);
  let fd;
  try {
    fd = openSync(tmpPath, 'w', 0o600);
    writeFileSync(fd, data, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw error;
  }
}

function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function isLockFileStale(lockFilePath) {
  let raw;
  try {
    raw = readFileSync(lockFilePath, 'utf8');
  } catch {
    // Never assume an unreadable lock (e.g. EBUSY / EACCES / EPERM) is stale.
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Locks are created atomically via tmp + fsync + linkSync; refuse to break
    // a lock whose owner PID cannot be confirmed dead.
    return false;
  }
  const pid = parsed?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return !isPidAlive(pid);
}

function atomicCreateExclusiveFile(targetPath, payload) {
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(fd, payload, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(tmpPath, targetPath);
      return;
    } catch (linkError) {
      if (linkError && (linkError.code === 'ENOSYS' || linkError.code === 'EPERM' || linkError.code === 'EXDEV')) {
        const fallbackFd = openSync(targetPath, 'wx', 0o600);
        try {
          writeFileSync(fallbackFd, payload, 'utf8');
          fsyncSync(fallbackFd);
        } finally {
          closeSync(fallbackFd);
        }
        return;
      }
      throw linkError;
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmpPath); } catch {}
  }
}

function acquireProcessLock(filePath) {
  if (!filePath) return () => {};
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const lockPath = `${filePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const token = randomUUID();
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  });

  const throwLocked = () => {
    throw new CodexSessionError(
      CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
      `subagent-codex: session registry is already locked by another store instance (${lockPath})`,
    );
  };

  let acquired = false;
  try {
    atomicCreateExclusiveFile(lockPath, payload);
    acquired = true;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw new CodexSessionError(
        CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
        `subagent-codex: failed to lock session registry: ${error?.message ?? error}`,
      );
    }

    // Serialize stale-lock inspection and takeover across processes using a single
    // exclusive reclaim gate so no live lock can ever be unlinked or overwritten.
    if (!isLockFileStale(lockPath)) {
      throwLocked();
    }

    const reclaimToken = randomUUID();
    const reclaimPayload = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: reclaimToken,
    });
    try {
      // Never unlink another process's reclaim gate by path: if another contender
      // holds `.reclaim`, fail closed with STORAGE_UNAVAILABLE.
      atomicCreateExclusiveFile(reclaimPath, reclaimPayload);
    } catch {
      throwLocked();
    }

    try {
      // Re-verify confirmed dead-PID ownership inside the exclusive reclaim gate.
      if (!isLockFileStale(lockPath)) {
        throwLocked();
      }
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== 'ENOENT') throwLocked();
      }
      try {
        atomicCreateExclusiveFile(lockPath, payload);
        acquired = true;
      } catch (retryErr) {
        if (retryErr?.code === 'EEXIST') throwLocked();
        throw new CodexSessionError(
          CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
          `subagent-codex: failed to acquire reclaimed session lock: ${retryErr?.message ?? retryErr}`,
        );
      }
    } finally {
      try {
        const curReclaim = JSON.parse(readFileSync(reclaimPath, 'utf8'));
        if (curReclaim?.token === reclaimToken) {
          unlinkSync(reclaimPath);
        }
      } catch {}
    }
  }

  let released = false;
  return () => {
    if (released || !acquired) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current?.token !== token) return;
    } catch {
      return;
    }
    try { unlinkSync(lockPath); } catch {}
  };
}

function loadRegistryFile(filePath) {
  if (!filePath) return [];
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw new CodexSessionError(
      CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
      `subagent-codex: failed to read session registry: ${error?.message ?? error}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CodexSessionError(
      CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
      `subagent-codex: corrupt session registry JSON: ${error?.message ?? error}`,
    );
  }
  if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
    throw new CodexSessionError(
      CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
      'subagent-codex: unsupported or corrupt session registry schema',
    );
  }
  const seenIds = new Set();
  const seenKeys = new Set();
  const entries = [];
  for (const rawEntry of parsed.sessions) {
    if (
      !isPlainObject(rawEntry)
      || typeof rawEntry.threadId !== 'string' || !rawEntry.threadId
      || typeof rawEntry.cwd !== 'string' || !rawEntry.cwd
      || typeof rawEntry.lastUsedAt !== 'string' || Number.isNaN(Date.parse(rawEntry.lastUsedAt))
      || !VALID_STATES.has(rawEntry.state)
      || (rawEntry.sessionKey !== undefined && typeof rawEntry.sessionKey !== 'string')
      || (rawEntry.model !== null && rawEntry.model !== undefined && typeof rawEntry.model !== 'string')
      || (rawEntry.used !== null && rawEntry.used !== undefined && typeof rawEntry.used !== 'number')
      || (rawEntry.contextWindow !== null && rawEntry.contextWindow !== undefined && (typeof rawEntry.contextWindow !== 'number' || !Number.isFinite(rawEntry.contextWindow)))
      || (rawEntry.size !== null && rawEntry.size !== undefined && typeof rawEntry.size !== 'number')
    ) {
      throw new CodexSessionError(
        CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
        'subagent-codex: invalid entry in session registry',
      );
    }
    if (seenIds.has(rawEntry.threadId)) {
      throw new CodexSessionError(
        CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
        `subagent-codex: duplicate threadId in session registry: ${rawEntry.threadId}`,
      );
    }
    seenIds.add(rawEntry.threadId);
    if (rawEntry.sessionKey !== undefined) {
      if (!SESSION_KEY_RE.test(rawEntry.sessionKey)) {
        throw new CodexSessionError(
          CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
          `subagent-codex: invalid sessionKey in session registry: ${rawEntry.sessionKey}`,
        );
      }
      if (seenKeys.has(rawEntry.sessionKey)) {
        throw new CodexSessionError(
          CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
          `subagent-codex: duplicate sessionKey in session registry: ${rawEntry.sessionKey}`,
        );
      }
      seenKeys.add(rawEntry.sessionKey);
    }
    entries.push(serializeEntry(rawEntry));
  }
  return entries;
}

/**
 * Open the file-backed Codex thread registry with single-process ownership,
 * key/ID convergence, short-critical-section locking, close state machine,
 * and TTL/LRU pruning.
 */
export async function openCodexSessionStore({
  file,
  ttlMs = DEFAULT_TTL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  now = () => Date.now(),
} = {}) {
  if (file !== undefined && (typeof file !== 'string' || !file.trim())) {
    throw new Error('subagent-codex: session store file must be a non-empty string when provided');
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error('subagent-codex: ttlMs must be a finite number >= 0');
  }
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error('subagent-codex: maxSessions must be an integer >= 1');
  }

  const releaseProcessLock = acquireProcessLock(file);
  let loadedEntries;
  try {
    loadedEntries = loadRegistryFile(file);
  } catch (error) {
    releaseProcessLock();
    throw error;
  }

  const sessions = new Map();
  const keyIndex = new Map();
  for (const entry of loadedEntries) {
    sessions.set(entry.threadId, entry);
    if (entry.sessionKey !== undefined) keyIndex.set(entry.sessionKey, entry.threadId);
  }

  const activeIds = new Set();
  const activeKeys = new Set();
  const activeReconciles = new Map();
  let pendingNewReservations = 0;
  let disposed = false;
  let mutexTail = Promise.resolve();

  const withCriticalSection = (fn) => {
    const run = mutexTail.then(() => {
      if (disposed) {
        throw new CodexSessionError(
          CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
          'subagent-codex: session store has been disposed',
        );
      }
      return fn();
    });
    mutexTail = run.catch(() => {});
    return run;
  };

  const persist = () => {
    if (!file) return;
    try {
      atomicWriteJson(file, {
        version: 1,
        sessions: [...sessions.values()].map(serializeEntry),
      });
    } catch (error) {
      throw new CodexSessionError(
        CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
        `subagent-codex: failed to persist session registry: ${error?.message ?? error}`,
      );
    }
  };

  const persistOrRollback = (rollback) => {
    try {
      persist();
    } catch (error) {
      try { rollback(); } catch {}
      throw error;
    }
  };

  const isoNow = () => new Date(now()).toISOString();

  const isRowActive = (row) => activeIds.has(row.threadId)
    || (row.sessionKey !== undefined && activeKeys.has(row.sessionKey));

  const resolveExisting = ({ sessionKey, threadId, cwd }) => {
    const hasKey = sessionKey !== undefined;
    const hasId = threadId !== undefined;
    if (hasKey) validateSessionKey(sessionKey);
    if (hasId) validateThreadId(threadId);

    const idByKey = hasKey ? keyIndex.get(sessionKey) : undefined;
    const byKey = idByKey !== undefined ? sessions.get(idByKey) : undefined;
    const byId = hasId ? sessions.get(threadId) : undefined;

    if (hasKey && hasId) {
      if (!byId) {
        if (byKey && byKey.threadId !== threadId) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.SELECTOR_CONFLICT,
            `subagent-codex: sessionKey "${sessionKey}" is bound to thread "${byKey.threadId}", not "${threadId}"`,
          );
        }
        throw new CodexSessionError(
          CODEX_ERROR_CODES.NOT_FOUND,
          `subagent-codex: thread "${threadId}" is not owned by this session store`,
        );
      }
      if (byKey && byKey.threadId !== byId.threadId) {
        throw new CodexSessionError(
          CODEX_ERROR_CODES.SELECTOR_CONFLICT,
          `subagent-codex: sessionKey "${sessionKey}" conflicts with threadId "${threadId}"`,
        );
      }
      if (!byKey && byId.sessionKey !== sessionKey) {
        throw new CodexSessionError(
          CODEX_ERROR_CODES.SELECTOR_CONFLICT,
          `subagent-codex: thread "${threadId}" is not bound to sessionKey "${sessionKey}"`,
        );
      }
    } else if (hasId && !byId) {
      throw new CodexSessionError(
        CODEX_ERROR_CODES.NOT_FOUND,
        `subagent-codex: thread "${threadId}" is not owned by this session store`,
      );
    }

    const row = byId ?? byKey;
    if (row && cwd !== undefined && normalizeCwd(row.cwd) !== normalizeCwd(cwd)) {
      throw new CodexSessionError(
        CODEX_ERROR_CODES.CWD_MISMATCH,
        `subagent-codex: thread "${row.threadId}" is bound to cwd "${row.cwd}", not "${cwd}"`,
      );
    }
    return row;
  };

  const lockRow = (row, requestedKey) => {
    activeIds.add(row.threadId);
    if (row.sessionKey !== undefined) activeKeys.add(row.sessionKey);
    if (requestedKey !== undefined) activeKeys.add(requestedKey);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeIds.delete(row.threadId);
      if (row.sessionKey !== undefined) activeKeys.delete(row.sessionKey);
      if (requestedKey !== undefined) activeKeys.delete(requestedKey);
    };
  };

  return {
    async getOwnedThread({ sessionKey, threadId, cwd } = {}) {
      if (cwd !== undefined) assertEnterableDir(cwd);
      return await withCriticalSection(() => {
        const row = resolveExisting({ sessionKey, threadId, cwd });
        return row ? { ...serializeEntry(row), active: isRowActive(row) } : undefined;
      });
    },

    async acquire({ sessionKey, threadId, cwd, model, defaultModel, reconcileUncertain } = {}, signal) {
      if (signal?.aborted) {
        throw new Error('subagent-codex: acquire aborted before session admission');
      }
      assertEnterableDir(cwd);

      if (sessionKey === undefined && threadId === undefined) {
        return {
          mode: 'ephemeral',
          threadId: undefined,
          cwd,
          model: model ?? defaultModel ?? null,
          previousModel: null,
          async markUncertain() {},
          async commit() {},
          release() {},
        };
      }

      if (typeof reconcileUncertain === 'function') {
        const waitExistingProbe = async () => {
          const existingId = await withCriticalSection(() => resolveExisting({ sessionKey, threadId, cwd })?.threadId);
          const pendingProbe = existingId !== undefined ? activeReconciles.get(existingId) : undefined;
          if (pendingProbe) {
            await pendingProbe.catch(() => {});
          }
        };
        await waitExistingProbe();

        const probeTarget = await withCriticalSection(() => {
          const row = resolveExisting({ sessionKey, threadId, cwd });
          if (!row || row.state !== 'uncertain' || isRowActive(row)) return undefined;
          return {
            snapshot: serializeEntry(row),
            releaseLock: lockRow(row, sessionKey),
          };
        });
        if (probeTarget) {
          const probeRun = (async () => {
            try {
              const outcome = await reconcileUncertain(probeTarget.snapshot, signal);
              await withCriticalSection(() => {
                const current = sessions.get(probeTarget.snapshot.threadId);
                if (!current || current.state !== 'uncertain') return;
                if (outcome === 'ready') {
                  const prevState = current.state;
                  current.state = 'ready';
                  persistOrRollback(() => {
                    current.state = prevState;
                  });
                } else if (outcome === 'archived' || outcome === 'missing') {
                  const prevKeyOwner = current.sessionKey !== undefined ? keyIndex.get(current.sessionKey) : undefined;
                  sessions.delete(current.threadId);
                  if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                    keyIndex.delete(current.sessionKey);
                  }
                  persistOrRollback(() => {
                    sessions.set(current.threadId, current);
                    if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                      keyIndex.set(current.sessionKey, current.threadId);
                    }
                  });
                }
              });
            } finally {
              probeTarget.releaseLock();
              if (activeReconciles.get(probeTarget.snapshot.threadId) === probeRun) {
                activeReconciles.delete(probeTarget.snapshot.threadId);
              }
            }
          })();
          activeReconciles.set(probeTarget.snapshot.threadId, probeRun);
          await probeRun;
        }
      }

      return await withCriticalSection(() => {
        const row = resolveExisting({ sessionKey, threadId, cwd });

        if (row) {
          if (isRowActive(row) || (sessionKey !== undefined && activeKeys.has(sessionKey))) {
            throw new CodexSessionError(
              CODEX_ERROR_CODES.BUSY,
              `subagent-codex: thread "${row.threadId}" already has an active writer`,
            );
          }
          if (row.state === 'closing') {
            throw new CodexSessionError(
              CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
              `subagent-codex: thread "${row.threadId}" is in closing state pending reconciliation`,
            );
          }
          if (row.state === 'uncertain') {
            throw new CodexSessionError(
              CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
              `subagent-codex: thread "${row.threadId}" is in uncertain state pending reconciliation`,
            );
          }

          const releaseLock = lockRow(row, sessionKey);
          const boundThreadId = row.threadId;
          const previousModel = row.model ?? null;
          const resolvedModel = model ?? row.model ?? defaultModel ?? null;
          let released = false;

          return {
            mode: 'resume',
            threadId: boundThreadId,
            sessionKey: row.sessionKey,
            cwd: row.cwd,
            model: resolvedModel,
            previousModel,
            async markUncertain({ model: observedModel } = {}) {
              await withCriticalSection(() => {
                const current = sessions.get(boundThreadId);
                if (!current) return;
                const prev = { ...current };
                current.state = 'uncertain';
                current.lastUsedAt = isoNow();
                if (current.model === null && observedModel) current.model = observedModel;
                persistOrRollback(() => {
                  Object.assign(current, prev);
                });
              });
            },
            async rollbackBeforeTurn() {
              await withCriticalSection(() => {
                const current = sessions.get(boundThreadId);
                if (released || current?.state !== 'uncertain') return;
                const prevState = current.state;
                current.state = 'ready';
                persistOrRollback(() => {
                  current.state = prevState;
                });
              });
            },
            async commit({ model: observedModel, used, contextWindow, size } = {}) {
              await withCriticalSection(() => {
                const current = sessions.get(boundThreadId);
                if (!current) {
                  throw new CodexSessionError(
                    CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
                    `subagent-codex: thread "${boundThreadId}" disappeared before commit`,
                  );
                }
                const prev = { ...current };
                current.state = 'ready';
                current.lastUsedAt = isoNow();
                if (typeof observedModel === 'string' && observedModel) {
                  current.model = observedModel;
                }
                if (used !== undefined) {
                  current.used = used;
                  current.contextWindow = contextWindow ?? null;
                } else if (contextWindow !== undefined) {
                  current.contextWindow = contextWindow;
                }
                if (size !== undefined) current.size = size;
                persistOrRollback(() => {
                  Object.assign(current, prev);
                });
              });
            },
            release() {
              if (released) return;
              released = true;
              releaseLock();
            },
          };
        }

        // Brand-new keyed persistent session
        if (activeKeys.has(sessionKey)) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.BUSY,
            `subagent-codex: sessionKey "${sessionKey}" already has an active startup`,
          );
        }
        if (sessions.size + pendingNewReservations >= maxSessions) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
            `subagent-codex: session registry reached maxSessions (${maxSessions}) with no evictable idle entries`,
          );
        }

        activeKeys.add(sessionKey);
        pendingNewReservations += 1;
        let reservationHeld = true;
        const releaseReservation = () => {
          if (reservationHeld) {
            reservationHeld = false;
            pendingNewReservations = Math.max(0, pendingNewReservations - 1);
          }
        };
        let assignedThreadId;
        let released = false;

        return {
          mode: 'new',
          threadId: undefined,
          sessionKey,
          cwd,
          model: model ?? defaultModel ?? null,
          previousModel: null,
          async markUncertain({ threadId: createdThreadId, model: observedModel } = {}) {
            validateThreadId(createdThreadId);
            await withCriticalSection(() => {
              if (assignedThreadId !== undefined && assignedThreadId !== createdThreadId) {
                throw new CodexSessionError(
                  CODEX_ERROR_CODES.SELECTOR_CONFLICT,
                  'subagent-codex: lease assigned conflicting threadIds',
                );
              }
              const existing = sessions.get(createdThreadId);
              const prevKeyOwner = keyIndex.get(sessionKey);
              const entry = {
                sessionKey,
                threadId: createdThreadId,
                cwd: existing?.cwd ?? cwd,
                model: existing?.model ?? observedModel ?? model ?? null,
                lastUsedAt: existing?.lastUsedAt ?? isoNow(),
                used: existing?.used ?? null,
                contextWindow: existing?.contextWindow ?? null,
                size: existing?.size ?? null,
                state: 'uncertain',
              };
              sessions.set(createdThreadId, entry);
              keyIndex.set(sessionKey, createdThreadId);
              persistOrRollback(() => {
                if (existing) sessions.set(createdThreadId, existing);
                else sessions.delete(createdThreadId);
                if (prevKeyOwner !== undefined) keyIndex.set(sessionKey, prevKeyOwner);
                else keyIndex.delete(sessionKey);
              });
              assignedThreadId = createdThreadId;
              activeIds.add(createdThreadId);
              releaseReservation();
            });
          },
          async commit({ threadId: committedThreadId, model: observedModel, used, contextWindow, size } = {}) {
            const targetId = committedThreadId ?? assignedThreadId;
            validateThreadId(targetId);
            await withCriticalSection(() => {
              const existing = sessions.get(targetId);
              const prevKeyOwner = keyIndex.get(sessionKey);
              const entry = {
                sessionKey,
                threadId: targetId,
                cwd: existing?.cwd ?? cwd,
                model: (typeof observedModel === 'string' && observedModel)
                  ? observedModel
                  : (model ?? existing?.model ?? null),
                lastUsedAt: isoNow(),
                used: used !== undefined ? used : (existing?.used ?? null),
                contextWindow: used !== undefined
                  ? (contextWindow ?? null)
                  : (contextWindow !== undefined ? contextWindow : (existing?.contextWindow ?? null)),
                size: size ?? existing?.size ?? null,
                state: 'ready',
              };
              sessions.set(targetId, entry);
              keyIndex.set(sessionKey, targetId);
              persistOrRollback(() => {
                if (existing) sessions.set(targetId, existing);
                else sessions.delete(targetId);
                if (prevKeyOwner !== undefined) keyIndex.set(sessionKey, prevKeyOwner);
                else keyIndex.delete(sessionKey);
              });
              assignedThreadId = targetId;
              activeIds.add(targetId);
              releaseReservation();
            });
          },
          release() {
            if (released) return;
            released = true;
            releaseReservation();
            activeKeys.delete(sessionKey);
            if (assignedThreadId !== undefined) activeIds.delete(assignedThreadId);
          },
        };
      });
    },

    async acquireFork({
      sourceSessionKey,
      sourceThreadId,
      targetSessionKey,
      cwd,
      model,
      defaultModel,
      reconcileUncertain,
      prune,
    } = {}, signal) {
      if (signal?.aborted) {
        throw new Error('subagent-codex: acquireFork aborted before session admission');
      }
      assertEnterableDir(cwd);
      validateSessionKey(targetSessionKey);
      if (sourceSessionKey === undefined && sourceThreadId === undefined) {
        throw new CodexSessionError(
          CODEX_ERROR_CODES.SELECTOR_CONFLICT,
          'subagent-codex: fork requires sourceSessionKey or sourceThreadId',
        );
      }

      if (typeof reconcileUncertain === 'function') {
        const existingId = await withCriticalSection(() => resolveExisting({ sessionKey: sourceSessionKey, threadId: sourceThreadId, cwd })?.threadId);
        const pendingProbe = existingId !== undefined ? activeReconciles.get(existingId) : undefined;
        if (pendingProbe) {
          await pendingProbe.catch(() => {});
        }

        const probeTarget = await withCriticalSection(() => {
          const row = resolveExisting({ sessionKey: sourceSessionKey, threadId: sourceThreadId, cwd });
          if (!row || row.state !== 'uncertain' || isRowActive(row)) return undefined;
          return {
            snapshot: serializeEntry(row),
            releaseLock: lockRow(row, sourceSessionKey),
          };
        });
        if (probeTarget) {
          const probeRun = (async () => {
            try {
              const outcome = await reconcileUncertain(probeTarget.snapshot, signal);
              await withCriticalSection(() => {
                const current = sessions.get(probeTarget.snapshot.threadId);
                if (!current || current.state !== 'uncertain') return;
                if (outcome === 'ready') {
                  const prevState = current.state;
                  current.state = 'ready';
                  persistOrRollback(() => {
                    current.state = prevState;
                  });
                } else if (outcome === 'archived' || outcome === 'missing') {
                  const prevKeyOwner = current.sessionKey !== undefined ? keyIndex.get(current.sessionKey) : undefined;
                  sessions.delete(current.threadId);
                  if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                    keyIndex.delete(current.sessionKey);
                  }
                  persistOrRollback(() => {
                    sessions.set(current.threadId, current);
                    if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                      keyIndex.set(current.sessionKey, current.threadId);
                    }
                  });
                }
              });
            } finally {
              probeTarget.releaseLock();
              if (activeReconciles.get(probeTarget.snapshot.threadId) === probeRun) {
                activeReconciles.delete(probeTarget.snapshot.threadId);
              }
            }
          })();
          activeReconciles.set(probeTarget.snapshot.threadId, probeRun);
          await probeRun;
        }
      }

      const preflight = await withCriticalSection(() => {
        const sourceRow = resolveExisting({ sessionKey: sourceSessionKey, threadId: sourceThreadId, cwd });
        if (!sourceRow) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.NOT_FOUND,
            'subagent-codex: source thread was not found in the session store',
          );
        }
        if (isRowActive(sourceRow) || (sourceSessionKey !== undefined && activeKeys.has(sourceSessionKey))) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.BUSY,
            `subagent-codex: source thread "${sourceRow.threadId}" already has an active run`,
          );
        }
        if (sourceRow.state === 'closing') {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
            `subagent-codex: source thread "${sourceRow.threadId}" is in closing state pending reconciliation`,
          );
        }
        if (sourceRow.state === 'uncertain') {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
            `subagent-codex: source thread "${sourceRow.threadId}" is in uncertain state pending reconciliation`,
          );
        }

        const existingTargetId = keyIndex.get(targetSessionKey);
        if (existingTargetId !== undefined) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.SELECTOR_CONFLICT,
            `subagent-codex: targetSessionKey "${targetSessionKey}" is already bound to thread "${existingTargetId}"`,
          );
        }
        if (activeKeys.has(targetSessionKey)) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.BUSY,
            `subagent-codex: targetSessionKey "${targetSessionKey}" already has an active startup`,
          );
        }
        const needPrune = sessions.size + pendingNewReservations >= maxSessions && typeof prune === 'function';
        if (!needPrune && sessions.size + pendingNewReservations >= maxSessions) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
            `subagent-codex: session registry reached maxSessions (${maxSessions}) with no evictable idle entries`,
          );
        }
        // Hold source row lock, targetSessionKey reservation, AND a capacity slot
        // reservation BEFORE pruning so concurrent callers cannot steal the freed slot.
        const releaseSourceLock = lockRow(sourceRow, sourceSessionKey);
        activeKeys.add(targetSessionKey);
        pendingNewReservations += 1;
        let reservationHeld = true;
        const releaseReservation = () => {
          if (reservationHeld) {
            reservationHeld = false;
            pendingNewReservations = Math.max(0, pendingNewReservations - 1);
          }
        };
        return {
          needPrune,
          sourceThreadId: sourceRow.threadId,
          releaseReservation,
          releaseHeldLocks() {
            releaseReservation();
            releaseSourceLock();
            activeKeys.delete(targetSessionKey);
          },
        };
      });

      if (preflight.needPrune) {
        try {
          await prune({
            reserveSlots: 0,
            protectedThreadIds: [preflight.sourceThreadId],
            signal,
          }).catch(() => {});
        } catch (err) {
          preflight.releaseHeldLocks();
          throw err;
        }
      }

      try {
        return await withCriticalSection(() => {
          const sourceRow = sessions.get(preflight.sourceThreadId);
          if (!sourceRow) {
            throw new CodexSessionError(
              CODEX_ERROR_CODES.NOT_FOUND,
              'subagent-codex: source thread was not found in the session store',
            );
          }
          const existingTargetId = keyIndex.get(targetSessionKey);
          if (existingTargetId !== undefined) {
            throw new CodexSessionError(
              CODEX_ERROR_CODES.SELECTOR_CONFLICT,
              `subagent-codex: targetSessionKey "${targetSessionKey}" is already bound to thread "${existingTargetId}"`,
            );
          }
          // `>` because this fork already holds 1 unit of pendingNewReservations from preflight.
          if (sessions.size + pendingNewReservations > maxSessions) {
            throw new CodexSessionError(
              CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
              `subagent-codex: session registry reached maxSessions (${maxSessions}) with no evictable idle entries`,
            );
          }

          let assignedThreadId;
          let released = false;

          return {
            mode: 'fork',
            sourceThreadId: sourceRow.threadId,
            sourceSessionKey: sourceRow.sessionKey,
            targetSessionKey,
            cwd: sourceRow.cwd,
            model: model ?? sourceRow.model ?? defaultModel ?? null,
            previousModel: sourceRow.model ?? null,
            async markUncertain({ threadId: forkedThreadId, model: observedModel } = {}) {
              validateThreadId(forkedThreadId);
              await withCriticalSection(() => {
                if (forkedThreadId === sourceRow.threadId) {
                  throw new CodexSessionError(
                    CODEX_ERROR_CODES.SELECTOR_CONFLICT,
                    'subagent-codex: fork returned the source threadId',
                  );
                }
                if (assignedThreadId !== undefined && assignedThreadId !== forkedThreadId) {
                  throw new CodexSessionError(
                    CODEX_ERROR_CODES.SELECTOR_CONFLICT,
                    'subagent-codex: fork lease assigned conflicting threadIds',
                  );
                }
                const existing = sessions.get(forkedThreadId);
                if (existing && (existing.sessionKey !== targetSessionKey || forkedThreadId !== assignedThreadId)) {
                  throw new CodexSessionError(
                    CODEX_ERROR_CODES.SELECTOR_CONFLICT,
                    `subagent-codex: forked threadId "${forkedThreadId}" collides with an existing session`,
                  );
                }
                const prevKeyOwner = keyIndex.get(targetSessionKey);
                const entry = {
                  sessionKey: targetSessionKey,
                  threadId: forkedThreadId,
                  cwd: existing?.cwd ?? sourceRow.cwd,
                  model: existing?.model ?? observedModel ?? model ?? sourceRow.model ?? null,
                  lastUsedAt: existing?.lastUsedAt ?? isoNow(),
                  used: existing?.used ?? null,
                  contextWindow: existing?.contextWindow ?? null,
                  size: existing?.size ?? null,
                  state: 'uncertain',
                };
                sessions.set(forkedThreadId, entry);
                keyIndex.set(targetSessionKey, forkedThreadId);
                persistOrRollback(() => {
                  if (existing) sessions.set(forkedThreadId, existing);
                  else sessions.delete(forkedThreadId);
                  if (prevKeyOwner !== undefined) keyIndex.set(targetSessionKey, prevKeyOwner);
                  else keyIndex.delete(targetSessionKey);
                });
                assignedThreadId = forkedThreadId;
                activeIds.add(forkedThreadId);
                preflight.releaseReservation();
              });
            },
            async commit({ threadId: committedThreadId, model: observedModel, used, contextWindow, size } = {}) {
              const targetId = committedThreadId ?? assignedThreadId;
              validateThreadId(targetId);
              await withCriticalSection(() => {
                if (targetId === sourceRow.threadId) {
                  throw new CodexSessionError(
                    CODEX_ERROR_CODES.SELECTOR_CONFLICT,
                    'subagent-codex: fork returned the source threadId',
                  );
                }
                if (assignedThreadId !== undefined && assignedThreadId !== targetId) {
                  throw new CodexSessionError(
                    CODEX_ERROR_CODES.SELECTOR_CONFLICT,
                    'subagent-codex: fork lease assigned conflicting threadIds',
                  );
                }
                const existing = sessions.get(targetId);
                if (existing && (existing.sessionKey !== targetSessionKey || targetId !== assignedThreadId)) {
                  throw new CodexSessionError(
                    CODEX_ERROR_CODES.SELECTOR_CONFLICT,
                    `subagent-codex: forked threadId "${targetId}" collides with an existing session`,
                  );
                }
                const prevKeyOwner = keyIndex.get(targetSessionKey);
                const entry = {
                  sessionKey: targetSessionKey,
                  threadId: targetId,
                  cwd: existing?.cwd ?? sourceRow.cwd,
                  model: (typeof observedModel === 'string' && observedModel)
                    ? observedModel
                    : (model ?? existing?.model ?? sourceRow.model ?? null),
                  lastUsedAt: isoNow(),
                  used: used !== undefined ? used : (existing?.used ?? null),
                  contextWindow: used !== undefined
                    ? (contextWindow ?? null)
                    : (contextWindow !== undefined ? contextWindow : (existing?.contextWindow ?? null)),
                  size: size ?? existing?.size ?? null,
                  state: 'ready',
                };
                sessions.set(targetId, entry);
                keyIndex.set(targetSessionKey, targetId);
                persistOrRollback(() => {
                  if (existing) sessions.set(targetId, existing);
                  else sessions.delete(targetId);
                  if (prevKeyOwner !== undefined) keyIndex.set(targetSessionKey, prevKeyOwner);
                  else keyIndex.delete(targetSessionKey);
                });
                assignedThreadId = targetId;
                activeIds.add(targetId);
                preflight.releaseReservation();
              });
            },
            release() {
              if (released) return;
              released = true;
              preflight.releaseHeldLocks();
              if (assignedThreadId !== undefined) activeIds.delete(assignedThreadId);
            },
          };
        });
      } catch (error) {
        preflight.releaseHeldLocks();
        throw error;
      }
    },

    async close(selector, archiver) {
      if (!isPlainObject(selector) || (selector.sessionKey === undefined && selector.threadId === undefined)) {
        throw new CodexSessionError(
          CODEX_ERROR_CODES.SELECTOR_CONFLICT,
          'subagent-codex: close requires sessionKey or threadId',
        );
      }
      if (selector.cwd !== undefined) assertEnterableDir(selector.cwd);
      if (typeof archiver !== 'function') {
        throw new Error('subagent-codex: close requires an archiver function');
      }

      const target = await withCriticalSection(() => {
        const row = resolveExisting(selector);
        if (!row) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.NOT_FOUND,
            'subagent-codex: target session was not found in the registry',
          );
        }
        if (isRowActive(row)) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.BUSY,
            `subagent-codex: thread "${row.threadId}" has an active run and cannot be closed`,
          );
        }
        const prevState = row.state;
        row.state = 'closing';
        persistOrRollback(() => {
          row.state = prevState;
        });
        const releaseLock = lockRow(row, selector.sessionKey);
        return {
          snapshot: serializeEntry(row),
          releaseLock,
        };
      });

      try {
        await archiver(target.snapshot);
        await withCriticalSection(() => {
          const current = sessions.get(target.snapshot.threadId);
          if (current) {
            const prevKeyOwner = current.sessionKey !== undefined ? keyIndex.get(current.sessionKey) : undefined;
            sessions.delete(current.threadId);
            if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
              keyIndex.delete(current.sessionKey);
            }
            persistOrRollback(() => {
              sessions.set(current.threadId, current);
              if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                keyIndex.set(current.sessionKey, current.threadId);
              }
            });
          }
        });
        return {
          closed: true,
          threadId: target.snapshot.threadId,
          ...(target.snapshot.sessionKey !== undefined ? { sessionKey: target.snapshot.sessionKey } : {}),
        };
      } finally {
        target.releaseLock();
      }
    },

    async prune({
      archive,
      reconcileClosing,
      reconcileUncertain,
      reserveSlots = 0,
      maxUncertainChecks = 20,
      protectedThreadIds,
      signal,
    } = {}) {
      if (!Number.isInteger(reserveSlots) || reserveSlots < 0) {
        throw new Error('subagent-codex: reserveSlots must be a non-negative integer');
      }
      const protectedSet = protectedThreadIds instanceof Set
        ? protectedThreadIds
        : new Set(Array.isArray(protectedThreadIds) ? protectedThreadIds : []);
      const evicted = [];

      // Step 1: Reconcile any rows left in `closing` state from an interrupted close/prune.
      if (typeof reconcileClosing === 'function' && !signal?.aborted) {
        const closingIds = await withCriticalSection(() =>
          [...sessions.values()]
            .filter((row) => row.state === 'closing' && !isRowActive(row))
            .map((row) => row.threadId),
        );
        for (const id of closingIds) {
          if (signal?.aborted) return evicted;
          const item = await withCriticalSection(() => {
            const row = sessions.get(id);
            if (!row || row.state !== 'closing' || isRowActive(row)) return undefined;
            return { snapshot: serializeEntry(row), releaseLock: lockRow(row) };
          });
          if (!item) continue;
          try {
            const outcome = await reconcileClosing(item.snapshot, signal);
            await withCriticalSection(() => {
              const current = sessions.get(item.snapshot.threadId);
              if (!current) return;
              if (outcome === 'archived') {
                const prevKeyOwner = current.sessionKey !== undefined ? keyIndex.get(current.sessionKey) : undefined;
                sessions.delete(current.threadId);
                if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                  keyIndex.delete(current.sessionKey);
                }
                persistOrRollback(() => {
                  sessions.set(current.threadId, current);
                  if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                    keyIndex.set(current.sessionKey, current.threadId);
                  }
                });
                evicted.push(serializeEntry(current));
              } else if (outcome === 'uncertain') {
                const prevState = current.state;
                current.state = 'uncertain';
                persistOrRollback(() => {
                  current.state = prevState;
                });
              }
            });
          } catch {
            // Keep `closing` state for later reconciliation if probe failed.
          } finally {
            item.releaseLock();
          }
        }
      }

      // Step 1b: Bounded startup reconciliation for `uncertain` rows left by interrupted turns.
      if (typeof reconcileUncertain === 'function' && maxUncertainChecks > 0 && !signal?.aborted) {
        const uncertainIds = await withCriticalSection(() =>
          [...sessions.values()]
            .filter((row) => row.state === 'uncertain' && !isRowActive(row))
            .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))
            .slice(0, maxUncertainChecks)
            .map((row) => row.threadId),
        );
        for (const id of uncertainIds) {
          if (signal?.aborted) return evicted;
          const locked = await withCriticalSection(() => {
            const row = sessions.get(id);
            if (!row || row.state !== 'uncertain' || isRowActive(row)) return undefined;
            return { snapshot: serializeEntry(row), releaseLock: lockRow(row) };
          });
          if (!locked) continue;
          const probeRun = (async () => {
            try {
              const outcome = await reconcileUncertain(locked.snapshot, signal);
              await withCriticalSection(() => {
                const current = sessions.get(locked.snapshot.threadId);
                if (!current || current.state !== 'uncertain') return;
                if (outcome === 'ready') {
                  const prevState = current.state;
                  current.state = 'ready';
                  persistOrRollback(() => {
                    current.state = prevState;
                  });
                } else if (outcome === 'archived' || outcome === 'missing') {
                  const prevKeyOwner = current.sessionKey !== undefined ? keyIndex.get(current.sessionKey) : undefined;
                  sessions.delete(current.threadId);
                  if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                    keyIndex.delete(current.sessionKey);
                  }
                  persistOrRollback(() => {
                    sessions.set(current.threadId, current);
                    if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                      keyIndex.set(current.sessionKey, current.threadId);
                    }
                  });
                  evicted.push(serializeEntry(current));
                }
              });
            } catch {
              // Leave as `uncertain` on transient probe errors.
            } finally {
              locked.releaseLock();
              if (activeReconciles.get(locked.snapshot.threadId) === probeRun) {
                activeReconciles.delete(locked.snapshot.threadId);
              }
            }
          })();
          activeReconciles.set(locked.snapshot.threadId, probeRun);
          await probeRun;
        }
      }

      if (typeof archive !== 'function' || signal?.aborted) return evicted;

      const tryArchiveCandidate = async (candidateId, shouldEvict) => {
        if (signal?.aborted) return false;
        const locked = await withCriticalSection(() => {
          const row = sessions.get(candidateId);
          if (!row || row.state !== 'ready' || isRowActive(row)) return undefined;
          if (typeof shouldEvict === 'function' && !shouldEvict(row)) return undefined;
          const prevState = row.state;
          row.state = 'closing';
          persistOrRollback(() => {
            row.state = prevState;
          });
          const releaseLock = lockRow(row);
          return { snapshot: serializeEntry(row), releaseLock };
        });
        if (!locked) return false;
        try {
          await archive(locked.snapshot, signal);
          await withCriticalSection(() => {
            const current = sessions.get(locked.snapshot.threadId);
            if (current) {
              const prevKeyOwner = current.sessionKey !== undefined ? keyIndex.get(current.sessionKey) : undefined;
              sessions.delete(current.threadId);
              if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                keyIndex.delete(current.sessionKey);
              }
              persistOrRollback(() => {
                sessions.set(current.threadId, current);
                if (current.sessionKey !== undefined && prevKeyOwner === current.threadId) {
                  keyIndex.set(current.sessionKey, current.threadId);
                }
              });
              evicted.push(locked.snapshot);
            }
          });
          return true;
        } catch {
          // Leave in `closing` state so we do not falsely re-expose or drop unverified archive.
          return false;
        } finally {
          locked.releaseLock();
        }
      };

      // Step 2: TTL sweep (idle + ready only; re-verify TTL inside critical section before closing).
      if (ttlMs > 0) {
        const expiredIds = await withCriticalSection(() => {
          const currentNow = now();
          return [...sessions.values()]
            .filter((row) => row.state === 'ready' && !isRowActive(row) && !protectedSet.has(row.threadId) && (currentNow - Date.parse(row.lastUsedAt)) >= ttlMs)
            .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt) || a.threadId.localeCompare(b.threadId))
            .map((row) => row.threadId);
        });
        for (const id of expiredIds) {
          if (signal?.aborted) return evicted;
          await tryArchiveCandidate(id, (row) => !protectedSet.has(row.threadId) && (now() - Date.parse(row.lastUsedAt)) >= ttlMs);
        }
      }

      // Step 3: LRU capacity sweep (total entries + pending new reservations <= maxSessions - reserveSlots).
      const targetMax = Math.max(0, maxSessions - reserveSlots);
      for (;;) {
        if (signal?.aborted) return evicted;
        const nextVictimId = await withCriticalSection(() => {
          if (sessions.size + pendingNewReservations <= targetMax) return undefined;
          const eligible = [...sessions.values()]
            .filter((row) => row.state === 'ready' && !isRowActive(row) && !protectedSet.has(row.threadId))
            .sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt) || a.threadId.localeCompare(b.threadId));
          return eligible[0]?.threadId;
        });
        if (nextVictimId === undefined) break;
        const ok = await tryArchiveCandidate(nextVictimId, (row) => !protectedSet.has(row.threadId) && (sessions.size + pendingNewReservations) > targetMax);
        if (!ok) break;
      }

      return evicted;
    },

    list() {
      return [...sessions.values()]
        .map((row) => ({ ...serializeEntry(row), active: isRowActive(row) }))
        .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
    },

    async dispose() {
      if (disposed) return;
      await mutexTail;
      disposed = true;
      releaseProcessLock();
    },
  };
}
