import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { normalizeCwdPath } from './codex-client.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const DEFAULT_STALE_TEMP_FILE_MS = 5 * 60 * 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidJobId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function atomicWriteJsonFile(filePath, payload) {
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

export function resolveIsolatedJobsDir(storePath) {
  const baseName = (path.basename(storePath, path.extname(storePath)) || 'sessions')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = createHash('sha256')
    .update(normalizeCwdPath(storePath))
    .digest('hex')
    .slice(0, 12);
  return path.join(path.dirname(storePath), 'jobs', `${baseName}-${hash}`);
}

export function isStaleTempOrClaimFile(name, fullPath, now, staleTempFileMs = DEFAULT_STALE_TEMP_FILE_MS) {
  // Format: <uuid>.json.<pid>.<claimUuid>.(tmp|claim)
  const match = /\.(\d+)\.[0-9a-f-]{36}\.(tmp|claim)$/i.exec(name);
  if (match) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) {
      // Live holder PID: NEVER sweep regardless of file age.
      if (pid === process.pid || isPidAlive(pid)) {
        return false;
      }
      return true;
    }
  }
  try {
    const stat = statSync(fullPath);
    return now - stat.mtimeMs >= staleTempFileMs;
  } catch {
    return false;
  }
}

export function createDiskJobStore(jobsDir, {
  serverName = 'codex-subagent',
  jobTtlMs = DEFAULT_JOB_TTL_MS,
  staleTempFileMs = DEFAULT_STALE_TEMP_FILE_MS,
  logError = () => {},
} = {}) {
  void jobTtlMs;
  const jobFilePath = (jobId) => path.join(jobsDir, `${jobId}.json`);

  const writeJob = (record) => {
    if (!isValidJobId(record?.jobId)) return false;
    try {
      atomicWriteJsonFile(jobFilePath(record.jobId), record);
      return true;
    } catch (error) {
      logError(`failed to persist job receipt ${record.jobId}: ${error?.message ?? error}`);
      return false;
    }
  };

  const deleteJob = (jobId) => {
    if (!isValidJobId(jobId)) return;
    try {
      unlinkSync(jobFilePath(jobId));
    } catch {}
  };

  const peekJobFromDisk = (jobId) => {
    if (!isValidJobId(jobId)) return null;
    const src = jobFilePath(jobId);
    let raw;
    try {
      raw = readFileSync(src, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return null;
      }
      throw new Error(`${serverName}: temporarily unable to read persisted job ${jobId}: ${error?.message ?? error}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logError(`corrupt persisted job receipt ${jobId}: ${error?.message ?? error}`);
      try { unlinkSync(src); } catch {}
      return null;
    }

    if (
      !isPlainObject(parsed)
      || parsed.version !== 1
      || parsed.jobId !== jobId
      || typeof parsed.expiresAt !== 'number'
      || !isPlainObject(parsed.result)
    ) {
      try { unlinkSync(src); } catch {}
      return null;
    }

    if (Date.now() > parsed.expiresAt) {
      try { unlinkSync(src); } catch {}
      return null;
    }

    return parsed;
  };

  const claimJobFromDisk = (jobId) => {
    const parsed = peekJobFromDisk(jobId);
    if (!parsed) return null;

    const src = jobFilePath(jobId);
    // Single-winner atomic claim via rename. Only one waiter can win; losers get ENOENT.
    const claimPath = `${src}.${process.pid}.${randomUUID()}.claim`;
    try {
      renameSync(src, claimPath);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return null;
      }
      throw new Error(`${serverName}: temporarily unable to claim persisted job ${jobId}: ${error?.message ?? error}`);
    }

    try {
      unlinkSync(claimPath);
    } catch {
      // Best-effort cleanup; receipt is already claimed and owned by this caller.
    }
    return parsed.result;
  };

  const sweep = () => {
    if (!existsSync(jobsDir)) return;
    let names;
    try {
      names = readdirSync(jobsDir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const fullPath = path.join(jobsDir, name);
      if (name.endsWith('.tmp') || name.endsWith('.claim')) {
        if (isStaleTempOrClaimFile(name, fullPath, now, staleTempFileMs)) {
          try {
            unlinkSync(fullPath);
          } catch {}
        }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const base = name.slice(0, -5);
      if (!isValidJobId(base)) continue;
      let raw;
      try {
        raw = readFileSync(fullPath, 'utf8');
      } catch {
        // Transient read failure (e.g. EBUSY / EAGAIN): never delete a receipt we could not read.
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        try { unlinkSync(fullPath); } catch {}
        continue;
      }
      if (
        !isPlainObject(parsed)
        || parsed.version !== 1
        || parsed.jobId !== base
        || typeof parsed.expiresAt !== 'number'
        || now > parsed.expiresAt
      ) {
        try { unlinkSync(fullPath); } catch {}
      }
    }
  };

  const listUnclaimed = (excludeJobIds = new Set()) => {
    if (!existsSync(jobsDir)) return [];
    let names;
    try {
      names = readdirSync(jobsDir);
    } catch {
      return [];
    }
    const now = Date.now();
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const jobId = name.slice(0, -5);
      if (!isValidJobId(jobId) || excludeJobIds.has(jobId)) continue;
      const fullPath = path.join(jobsDir, name);
      let raw;
      try {
        raw = readFileSync(fullPath, 'utf8');
      } catch {
        // Transient read failure or racing claim: never delete.
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        try { unlinkSync(fullPath); } catch {}
        continue;
      }
      if (
        !isPlainObject(parsed)
        || parsed.version !== 1
        || parsed.jobId !== jobId
        || typeof parsed.expiresAt !== 'number'
        || !isPlainObject(parsed.result)
      ) {
        try { unlinkSync(fullPath); } catch {}
        continue;
      }
      if (now > parsed.expiresAt) {
        try { unlinkSync(fullPath); } catch {}
        continue;
      }
      out.push({
        jobId: parsed.jobId,
        description: parsed.description ?? '',
        sessionKey: parsed.sessionKey ?? null,
        threadId: parsed.threadId ?? null,
        cwd: parsed.cwd ?? '',
        status: 'completed_unclaimed',
        elapsedMs:
          typeof parsed.settledAt === 'number' && typeof parsed.startedAt === 'number'
            ? Math.max(0, parsed.settledAt - parsed.startedAt)
            : 0,
        settledAt: typeof parsed.settledAt === 'number' ? new Date(parsed.settledAt).toISOString() : null,
        expiresAt: new Date(parsed.expiresAt).toISOString(),
        persisted: true,
      });
    }
    return out;
  };

  return {
    jobsDir,
    writeJob,
    deleteJob,
    peekJobFromDisk,
    claimJobFromDisk,
    sweep,
    listUnclaimed,
  };
}
