import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const DEFAULT_SERVER_NAME = 'codex-subagent';
const ALLOWED_LOCAL_WIN_DRIVE_TYPES = new Set(['Fixed', 'Removable', 'Ram', 'CDRom']);
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
export const DEFAULT_MAX_IMAGES = 10;
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function clearWindowsDriveTypeCache() {
  // No-op: drive type checks are never cached across tool calls.
}

export function isUncOrDevicePath(rawPath) {
  if (typeof rawPath !== 'string') return true;
  if (rawPath.includes('\0')) return true;
  if (process.platform === 'win32') {
    // Reject UNC (\\server\share, //server/share) and Win32 device/extended namespaces (\\?\, \\.\)
    if (/^(\\\\|\/\/)/.test(rawPath)) return true;
  }
  return false;
}

function parseFsutilDriveTypeOutput(output) {
  const lower = String(output ?? '').toLowerCase();
  if (lower.includes('fixed drive')) return 'Fixed';
  if (lower.includes('removable drive')) return 'Removable';
  if (lower.includes('ram disk')) return 'Ram';
  if (lower.includes('cd-rom drive')) return 'CDRom';
  if (lower.includes('remote/network drive') || lower.includes('network drive')) return 'Network';
  if (lower.includes('no such root directory')) return 'NoRootDirectory';
  return null;
}

export function getWindowsDriveType(letter, requestCache) {
  const upper = letter.toUpperCase();
  if (requestCache instanceof Map && requestCache.has(upper)) {
    return requestCache.get(upper);
  }
  let driveType = null;
  try {
    const out = execFileSync(
      'fsutil',
      ['fsinfo', 'drivetype', `${upper}:`],
      { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    driveType = parseFsutilDriveTypeOutput(out);
  } catch {
    driveType = null;
  }

  if (driveType === null) {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `try { [System.IO.DriveInfo]::new('${upper}').DriveType.ToString() } catch { 'Unknown' }`,
        ],
        { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      driveType = out.trim() || 'Unknown';
    } catch {
      driveType = 'Unknown';
    }
  }

  if (requestCache instanceof Map) {
    requestCache.set(upper, driveType);
  }
  return driveType;
}

export function assertLocalWindowsDrive(absPath, label, serverName = DEFAULT_SERVER_NAME, requestCache) {
  if (process.platform !== 'win32') return;
  const match = /^([A-Za-z]):[\\/]/.exec(absPath);
  if (!match) {
    throw new Error(`${serverName}: ${label} must be a local drive path (UNC/device/root-relative paths are rejected): ${absPath}`);
  }
  const driveType = getWindowsDriveType(match[1], requestCache);
  if (!ALLOWED_LOCAL_WIN_DRIVE_TYPES.has(driveType)) {
    throw new Error(
      `${serverName}: ${label} points to a non-local or unverified drive (${match[1].toUpperCase()}:, type=${driveType}), which is not allowed`,
    );
  }
}

export function resolveLocalPathWithoutRemoteTraversal(absPath, label, { maxHops = 32, serverName = DEFAULT_SERVER_NAME, requestCache } = {}) {
  if (process.platform !== 'win32') return absPath;
  let current = path.win32.normalize(absPath);
  let hops = 0;

  for (;;) {
    assertLocalWindowsDrive(current, label, serverName, requestCache);
    const parsed = path.win32.parse(current);
    const root = parsed.root;
    const parts = current.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let cursor = root;
    let redirected = false;

    for (let i = 0; i < parts.length; i += 1) {
      cursor = path.win32.join(cursor, parts[i]);
      let lst;
      try {
        lst = lstatSync(cursor);
      } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
          throw new Error(`${serverName}: ${label} does not exist or is inaccessible: ${absPath}`);
        }
        throw new Error(`${serverName}: ${label} could not be verified safely (${error?.code ?? 'IO_ERROR'}): ${cursor}`);
      }
      if (lst.isSymbolicLink()) {
        hops += 1;
        if (hops > maxHops) {
          throw new Error(`${serverName}: ${label} exceeded maximum reparse/symlink depth (${maxHops})`);
        }
        let target;
        try {
          target = readlinkSync(cursor);
        } catch {
          throw new Error(`${serverName}: ${label} contains an unreadable reparse point: ${cursor}`);
        }
        if (/^\\\\\?\\UNC\\/i.test(target) || /^\\\\[^?.\s]/i.test(target) || /^\/\//.test(target) || /^\\\\\.\\/i.test(target)) {
          throw new Error(`${serverName}: ${label} resolves through a remote/device reparse point, which is not allowed`);
        }
        const normalizedTarget = target.replace(/^\\\\\?\\/, '');
        if (isUncOrDevicePath(normalizedTarget)) {
          throw new Error(`${serverName}: ${label} resolves through a remote/device reparse point, which is not allowed`);
        }
        const resolvedTarget = path.win32.isAbsolute(normalizedTarget)
          ? normalizedTarget
          : path.win32.resolve(path.win32.dirname(cursor), normalizedTarget);
        assertLocalWindowsDrive(resolvedTarget, label, serverName, requestCache);
        const remaining = parts.slice(i + 1);
        current = remaining.length > 0
          ? path.win32.join(resolvedTarget, ...remaining)
          : resolvedTarget;
        redirected = true;
        break;
      }
    }
    if (!redirected) {
      return current;
    }
  }
}

export function assertLocalResolvedRealpath(realPath, label, serverName = DEFAULT_SERVER_NAME, requestCache) {
  if (process.platform !== 'win32') return;
  if (/^\\\\\?\\UNC\\/i.test(realPath) || /^\\\\[^?.\s]/i.test(realPath) || /^\/\//.test(realPath)) {
    throw new Error(`${serverName}: ${label} resolved to a remote UNC path, which is not allowed`);
  }
  const stripped = realPath.replace(/^\\\\\?\\/, '');
  assertLocalWindowsDrive(stripped, label, serverName, requestCache);
}

export function assertUsableCwd(label, cwd, serverName = DEFAULT_SERVER_NAME) {
  if (typeof cwd !== 'string' || !cwd.trim() || isUncOrDevicePath(cwd) || !path.isAbsolute(cwd)) {
    throw new Error(`${serverName}: ${label} must be an absolute local path: ${String(cwd)}`);
  }
  const requestCache = new Map();
  const safePath = resolveLocalPathWithoutRemoteTraversal(cwd, label, { serverName, requestCache });
  let realCwd;
  try {
    realCwd = realpathSync.native(safePath);
  } catch {
    throw new Error(`${serverName}: ${label} is not an accessible directory: ${cwd}`);
  }
  assertLocalResolvedRealpath(realCwd, label, serverName, requestCache);
  const canonicalCwd = process.platform === 'win32' ? realCwd.replace(/^\\\\\?\\/, '') : realCwd;
  try {
    if (!statSync(canonicalCwd).isDirectory()) {
      throw new Error('not a directory');
    }
    accessSync(canonicalCwd, constants.X_OK);
  } catch {
    throw new Error(`${serverName}: ${label} is not an accessible directory: ${cwd}`);
  }
  return canonicalCwd;
}

export function resolveAccessibleCwd(candidate, fallback, serverName = DEFAULT_SERVER_NAME) {
  if (typeof candidate === 'string' && path.isAbsolute(candidate) && !isUncOrDevicePath(candidate)) {
    try {
      const requestCache = new Map();
      const safePath = resolveLocalPathWithoutRemoteTraversal(candidate, 'cwd', { serverName, requestCache });
      const real = realpathSync.native(safePath);
      assertLocalResolvedRealpath(real, 'cwd', serverName, requestCache);
      const canonical = process.platform === 'win32' ? real.replace(/^\\\\\?\\/, '') : real;
      if (statSync(canonical).isDirectory()) return canonical;
    } catch {}
  }
  return fallback;
}

export function validateLocalImages(rawImages, cwd, {
  maxImages = DEFAULT_MAX_IMAGES,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  toolName = 'subagent_codex',
  serverName = DEFAULT_SERVER_NAME,
} = {}) {
  if (rawImages === undefined) return [];
  if (!Array.isArray(rawImages)) {
    throw new Error(`${toolName}: "images" must be an array of local image file paths`);
  }
  if (rawImages.length > maxImages) {
    throw new Error(`${toolName}: "images" supports at most ${maxImages} files per call`);
  }
  const requestCache = new Map();
  const resolved = [];
  for (let i = 0; i < rawImages.length; i += 1) {
    const entry = rawImages[i];
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${toolName}: images[${i}] must be a non-empty file path string`);
    }
    const trimmed = entry.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
      throw new Error(`${toolName}: images[${i}] must be a local file path, not a URL`);
    }
    if (isUncOrDevicePath(trimmed)) {
      throw new Error(`${toolName}: images[${i}] must be a local path (UNC/device paths are rejected)`);
    }
    if (process.platform === 'win32' && (/^[\\/]/.test(trimmed) || /^[A-Za-z]:(?![\\/])/.test(trimmed))) {
      throw new Error(`${toolName}: images[${i}] must be a relative path or full drive-letter path`);
    }
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
    const safeCandidate = resolveLocalPathWithoutRemoteTraversal(candidate, `images[${i}]`, { serverName, requestCache });

    let realPath;
    try {
      realPath = realpathSync.native(safeCandidate);
    } catch {
      throw new Error(`${toolName}: images[${i}] does not exist or is inaccessible: ${trimmed}`);
    }
    assertLocalResolvedRealpath(realPath, `images[${i}]`, serverName, requestCache);

    const ext = path.extname(realPath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(
        `${toolName}: images[${i}] has unsupported extension "${ext || '(none)'}" (allowed: ${[...ALLOWED_IMAGE_EXTENSIONS].join(', ')})`,
      );
    }
    let stat;
    try {
      stat = statSync(realPath);
      accessSync(realPath, constants.R_OK);
    } catch {
      throw new Error(`${toolName}: images[${i}] is not readable: ${trimmed}`);
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`${toolName}: images[${i}] must be a non-empty regular file: ${trimmed}`);
    }
    if (stat.size > maxImageBytes) {
      const maxMb = Math.round(maxImageBytes / (1024 * 1024));
      throw new Error(`${toolName}: images[${i}] exceeds maximum size of ${maxMb}MB`);
    }
    resolved.push(realPath);
  }
  return resolved;
}
