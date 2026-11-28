import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRpcError, createCodexWire } from './codex-wire.mjs';

export const DEFAULT_EOF_GRACE_MS = 6_000;
export const DEFAULT_DISPOSE_GRACE_MS = 3_000;

function readConfigMtimeMs(codexHome) {
  try {
    const configPath = path.join(codexHome || path.join(os.homedir(), '.codex'), 'config.toml');
    return statSync(configPath).mtimeMs;
  } catch {
    return null;
  }
}

export const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

export const CODEX_PERMISSION_MODES = [
  'never',
  'read-only',
  'approve-for-me',
  'dangerously-bypass-approvals-and-sandbox',
];

export const DEFAULT_CODEX_PERMISSION_MODE = 'never';

export const THREAD_PERMISSION_PARAMS = Object.freeze({
  never: Object.freeze({ approvalPolicy: 'never' }),
  'read-only': Object.freeze({
    approvalPolicy: 'never',
    sandbox: 'read-only',
  }),
  'approve-for-me': Object.freeze({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  }),
  'dangerously-bypass-approvals-and-sandbox': Object.freeze({
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  }),
});

export const SANDBOX_POLICY_TYPE_BY_MODE = Object.freeze({
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'dangerFullAccess',
});

export function resolveThreadPermissionParams(permissionMode = DEFAULT_CODEX_PERMISSION_MODE, sandbox) {
  if (!CODEX_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`subagent-codex: invalid permissionMode "${permissionMode}"`);
  }
  if (sandbox !== undefined && !CODEX_SANDBOX_MODES.includes(sandbox)) {
    throw new Error(`subagent-codex: invalid sandbox "${sandbox}"`);
  }
  if (permissionMode === 'read-only' && sandbox !== undefined && sandbox !== 'read-only') {
    throw new Error(`subagent-codex: permissionMode "read-only" conflicts with sandbox "${sandbox}"`);
  }
  const base = THREAD_PERMISSION_PARAMS[permissionMode];
  return sandbox !== undefined ? { ...base, sandbox } : { ...base };
}

function matchesExpectedSandbox(actualSandbox, expectedMode) {
  const expectedType = SANDBOX_POLICY_TYPE_BY_MODE[expectedMode];
  if (typeof actualSandbox === 'string') {
    return actualSandbox === expectedMode || actualSandbox === expectedType;
  }
  if (actualSandbox && typeof actualSandbox === 'object' && typeof actualSandbox.type === 'string') {
    return actualSandbox.type === expectedType || actualSandbox.type === expectedMode;
  }
  return false;
}

function toSandboxPolicyObject(actualSandbox, expectedMode) {
  if (actualSandbox && typeof actualSandbox === 'object' && typeof actualSandbox.type === 'string') {
    return actualSandbox;
  }
  const mode = typeof actualSandbox === 'string' ? actualSandbox : expectedMode;
  if (mode === 'read-only' || mode === 'readOnly') {
    return { type: 'readOnly', networkAccess: false };
  }
  if (mode === 'danger-full-access' || mode === 'dangerFullAccess') {
    return { type: 'dangerFullAccess' };
  }
  if (mode === 'workspace-write' || mode === 'workspaceWrite') {
    return {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return null;
}

function matchesRequestedModel(actualModel, requestedModel) {
  if (typeof actualModel !== 'string' || !actualModel || typeof requestedModel !== 'string' || !requestedModel) {
    return false;
  }
  return actualModel.toLowerCase() === requestedModel.toLowerCase();
}

function assertConfirmedThreadConfig(res, { effectiveThreadPerms, explicitModel, expectedModel, stage }) {
  const expectedApproval = effectiveThreadPerms.approvalPolicy;
  if (expectedApproval !== undefined && res.approvalPolicy !== expectedApproval) {
    throw new CodexRunFailure({
      stage,
      category: 'access-policy',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error(`subagent-codex: ${stage} could not confirm requested approvalPolicy "${expectedApproval}"`));
  }

  const expectedReviewer = effectiveThreadPerms.approvalsReviewer;
  if (expectedReviewer !== undefined && res.approvalsReviewer !== expectedReviewer) {
    throw new CodexRunFailure({
      stage,
      category: 'access-policy',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error(`subagent-codex: ${stage} could not confirm requested approvalsReviewer "${expectedReviewer}" (got ${JSON.stringify(res.approvalsReviewer)})`));
  }

  const expectedSandbox = effectiveThreadPerms.sandbox;
  if (expectedSandbox !== undefined && !matchesExpectedSandbox(res.sandbox, expectedSandbox)) {
    throw new CodexRunFailure({
      stage,
      category: 'access-policy',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error(`subagent-codex: ${stage} could not confirm requested ${expectedSandbox} sandbox`));
  }

  const returnedModel = typeof res.model === 'string' && res.model.length > 0 ? res.model : null;
  if (explicitModel !== undefined) {
    if (!returnedModel || !matchesRequestedModel(returnedModel, explicitModel)) {
      throw new CodexRunFailure({
        stage,
        category: 'product-error',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error(`subagent-codex: ${stage} could not confirm requested model "${explicitModel}" (got ${JSON.stringify(returnedModel)})`));
    }
  } else if (expectedModel !== undefined && expectedModel !== null && returnedModel !== null) {
    if (!matchesRequestedModel(returnedModel, expectedModel)) {
      throw new CodexRunFailure({
        stage,
        category: 'product-error',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error(`subagent-codex: ${stage} returned mismatched model "${returnedModel}" (expected "${expectedModel}")`));
    }
  }

  const confirmedModel = returnedModel ?? expectedModel ?? null;
  const confirmedSandboxPolicy = toSandboxPolicyObject(res.sandbox, expectedSandbox);
  return { confirmedModel, confirmedSandboxPolicy };
}

export function normalizeCwdPath(cwd) {
  let resolved;
  try {
    resolved = realpathSync.native(cwd);
  } catch {
    resolved = path.resolve(cwd);
  }
  if (process.platform === 'win32') {
    let win = path.win32.normalize(resolved).replace(/\//g, '\\');
    if (win.length > 3 && win.endsWith('\\')) win = win.slice(0, -1);
    return win.toLowerCase();
  }
  return resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}

function isWithinDirectory(candidatePath, rootDir) {
  const normRoot = normalizeCwdPath(rootDir);
  const normCandidate = normalizeCwdPath(candidatePath);
  const sep = process.platform === 'win32' ? '\\' : '/';
  return normCandidate === normRoot || normCandidate.startsWith(`${normRoot}${sep}`);
}

function isArchivedPath(rolloutPath) {
  if (typeof rolloutPath !== 'string') return false;
  return /[\\/]archived_sessions[\\/]/i.test(rolloutPath);
}

function failureDiagnostic(facts) {
  const fields = [
    'product: Codex',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ];
  if (facts.httpStatus !== undefined) fields.push(`HTTP status: ${facts.httpStatus}`);
  if (facts.upstreamCode !== undefined) fields.push(`upstream code: ${facts.upstreamCode}`);
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ];
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`);
  }
  const headline = `Product subagent failure (${fields.join('; ')})`;
  return [headline, facts.reason, facts.stderrTail && `Codex stderr (tail):\n${facts.stderrTail}`].filter(Boolean).join('\n');
}

export class CodexRunFailure extends Error {
  constructor(facts, cause) {
    super(`subagent-codex: ${failureDiagnostic(facts)}`, cause === undefined ? undefined : { cause });
    this.name = 'CodexRunFailure';
    this.facts = facts;
    if (facts.code) this.code = facts.code;
  }
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

const STDERR_TAIL_BYTES = 4096;

function cleanDiagnosticText(text) {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => char === '\n' || char === '\t' ? char : '')
    .split('\n')
    .map((line) => /authorization|bearer|credential|secret|password|token|api[-_ ]?key|rollout leak|cookie|private[-_ ]?key/i.test(line) ? '[redacted]' : line)
    .join('\n')
    .trim();
}

function sanitizeRpcErrorMessage(error) {
  const raw = typeof error?.message === 'string' ? error.message : String(error ?? '');
  return raw.slice(0, 240);
}

/**
 * Classify upstream app-server JSON-RPC / transport errors, distinguishing
 * `-32600` variants (unknown method, not found, archived, active writer,
 * invalid params) and timeouts without relying on numeric code alone.
 */
export function classifyCodexRpcError(error, context = {}) {
  const method = error?.method ?? context.method;
  const rawCode = error?.code;
  const msg = sanitizeRpcErrorMessage(error);
  const lower = msg.toLowerCase();

  if (rawCode === 'ETIMEDOUT' || error?.name === 'TimeoutError' || /timed out|timeout/.test(lower)) {
    return {
      classification: 'timeout',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      upstreamCode: rawCode,
      method,
      message: msg,
    };
  }

  if (rawCode === -32601 || (rawCode === -32600 && /(unknown method|method not found|unsupported method|unknown variant.*method)/.test(lower))) {
    return {
      classification: 'unknown-method',
      code: method === 'thread/resume' ? 'CODEX_RESUME_UNAVAILABLE' : 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      upstreamCode: rawCode,
      method,
      message: msg,
    };
  }

  if (rawCode === -32600 || rawCode === -32602 || typeof rawCode === 'number') {
    if (/active writer|already has an active writer|busy|in use/.test(lower)) {
      return {
        classification: 'active-writer',
        code: 'CODEX_THREAD_BUSY',
        upstreamCode: rawCode,
        method,
        message: msg,
      };
    }
    const structuredReason = typeof error?.data?.reason === 'string'
      ? error.data.reason.toLowerCase()
      : undefined;
    if (
      structuredReason === 'thread_archived'
      || structuredReason === 'archived'
      || (
        !/\b(?:not|isn't|is not|never|un-?)\s*archived\b/.test(lower)
        && /^(?:error:\s*)?(?:thread|rollout|session)(?:\s+[0-9a-f-]+)?\s+(?:is|was|has been)?\s*(?:already\s+)?archived\.?$/.test(lower.trim())
      )
    ) {
      return {
        classification: 'archived',
        code: 'CODEX_THREAD_NOT_FOUND',
        upstreamCode: rawCode,
        method,
        message: msg,
      };
    }
    if (/no rollout found|thread\b[^\n]*not found|not found[^\n]*thread|thread\b[^\n]*does not exist|missing thread|unknown thread/.test(lower)) {
      return {
        classification: 'not-found',
        code: 'CODEX_THREAD_NOT_FOUND',
        upstreamCode: rawCode,
        method,
        message: msg,
      };
    }
    if (rawCode === -32602 || /invalid|missing|unknown variant|deserialize|uuid|expected/.test(lower)) {
      return {
        classification: 'invalid-params',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
        upstreamCode: rawCode,
        method,
        message: msg,
      };
    }
  }

  return {
    classification: 'unknown',
    code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    upstreamCode: rawCode,
    method,
    message: msg,
  };
}

/**
 * Resolve the official package-local `@openai/codex` wrapper argv without
 * ever falling back to `PATH`.
 */
export function resolveCodexAppServerArgv({ wrapperPath, codexAnchorPath } = {}) {
  if (wrapperPath !== undefined) {
    if (typeof wrapperPath !== 'string' || !wrapperPath.trim()) {
      throw new Error('subagent-codex: explicit wrapperPath must be a non-empty string');
    }
    const resolved = path.resolve(wrapperPath);
    if (!statSync(resolved).isFile()) {
      throw new Error(`subagent-codex: explicit wrapperPath is not a file: ${resolved}`);
    }
    return [process.execPath, resolved, 'app-server', '--stdio'];
  }

  const localAnchors = [];
  if (codexAnchorPath) localAnchors.push(codexAnchorPath);
  localAnchors.push(path.dirname(fileURLToPath(import.meta.url)));
  localAnchors.push(process.cwd());

  const localRequire = createRequire(import.meta.url);
  let codexPkgJsonPath;

  for (const base of localAnchors) {
    try {
      const stockPkgJsonPath = localRequire.resolve('@deepseek-ai/dsh-subagent-codex/package.json', { paths: [base] });
      const stockRequire = createRequire(stockPkgJsonPath);
      codexPkgJsonPath = stockRequire.resolve('@openai/codex/package.json');
      break;
    } catch {
      try {
        codexPkgJsonPath = localRequire.resolve('@openai/codex/package.json', { paths: [base] });
        break;
      } catch {
        // Continue to next anchor.
      }
    }
  }

  if (!codexPkgJsonPath) {
    const globalNodeModulesDirs = [];
    const npmPrefix = process.env.npm_config_prefix?.trim();
    if (npmPrefix) {
      if (process.platform === 'win32') {
        globalNodeModulesDirs.push(path.join(npmPrefix, 'node_modules'));
      } else {
        globalNodeModulesDirs.push(path.join(npmPrefix, 'lib', 'node_modules'));
        globalNodeModulesDirs.push(path.join(npmPrefix, 'node_modules'));
      }
    }
    if (process.platform === 'win32') {
      if (process.env.APPDATA) {
        globalNodeModulesDirs.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
      }
      globalNodeModulesDirs.push(path.join(path.dirname(process.execPath), 'node_modules'));
    } else {
      globalNodeModulesDirs.push(path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
      globalNodeModulesDirs.push('/usr/local/lib/node_modules');
      globalNodeModulesDirs.push('/opt/homebrew/lib/node_modules');
    }

    for (const nmDir of globalNodeModulesDirs) {
      const candidatePkg = path.join(nmDir, '@openai', 'codex', 'package.json');
      try {
        if (statSync(candidatePkg).isFile()) {
          codexPkgJsonPath = candidatePkg;
          break;
        }
      } catch {
        // Ignore missing or inaccessible global npm directory.
      }
    }
  }

  if (!codexPkgJsonPath) {
    const dshProfileAnchors = [];
    if (process.env.DSH_PROFILE_DIR) dshProfileAnchors.push(process.env.DSH_PROFILE_DIR);
    dshProfileAnchors.push(path.join(os.homedir(), '.dsh', 'profiles', 'desktop'));

    for (const base of dshProfileAnchors) {
      try {
        const stockPkgJsonPath = localRequire.resolve('@deepseek-ai/dsh-subagent-codex/package.json', { paths: [base] });
        const stockRequire = createRequire(stockPkgJsonPath);
        codexPkgJsonPath = stockRequire.resolve('@openai/codex/package.json');
        break;
      } catch {
        try {
          codexPkgJsonPath = localRequire.resolve('@openai/codex/package.json', { paths: [base] });
          break;
        } catch {
          // Continue to next anchor.
        }
      }
    }
  }

  if (!codexPkgJsonPath) {
    throw new Error('subagent-codex: unable to resolve @openai/codex wrapper (install @openai/codex locally or globally, or set CODEX_WRAPPER_PATH)');
  }
  const manifest = JSON.parse(readFileSync(codexPkgJsonPath, 'utf8'));
  const binRel = manifest?.bin?.codex;
  if (typeof binRel !== 'string' || !binRel) {
    throw new Error('subagent-codex: @openai/codex manifest has no bin.codex entry');
  }
  const codexBin = path.resolve(path.dirname(codexPkgJsonPath), binRel);
  if (!statSync(codexBin).isFile()) {
    throw new Error(`subagent-codex: resolved codex wrapper does not exist: ${codexBin}`);
  }
  return [process.execPath, codexBin, 'app-server', '--stdio'];
}

async function waitForTreeExitWithin(child, ms) {
  if (child.pid <= 0) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  try {
    return await child.waitForExit(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Close stdin to let the app-server flush rollout files and exit cleanly within
 * `eofGraceMs` without calling `terminate()` on the normal path. Only escalate
 * to `terminate()` + `waitForExit()` if the EOF grace expires.
 */
export async function disposeCodexChild(wire, child, {
  eofGraceMs = DEFAULT_EOF_GRACE_MS,
  disposeGraceMs = DEFAULT_DISPOSE_GRACE_MS,
} = {}) {
  void disposeGraceMs;
  let outcome;
  const donePromise = child.done.then((value) => {
    outcome = value;
    return value;
  }, () => undefined);

  if (child.pid <= 0) {
    wire?.close();
    await donePromise;
    return { terminated: false, outcome };
  }

  try {
    child.stdin?.end();
  } catch {
    // Ignore already-closed stdin.
  }

  const exitedOnEof = await waitForTreeExitWithin(child, eofGraceMs);
  if (exitedOnEof) {
    await donePromise;
    wire?.close();
    return { terminated: false, outcome };
  }

  wire?.close();
  child.terminate();
  try {
    const boundedGrace = Number.isFinite(disposeGraceMs) && disposeGraceMs > 0 ? disposeGraceMs : DEFAULT_DISPOSE_GRACE_MS;
    const exitedAfterTerminate = await waitForTreeExitWithin(child, boundedGrace);
    if (!exitedAfterTerminate) {
      throw new CodexRunFailure({
        stage: 'teardown',
        category: 'timeout',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
        outcome,
      }, new Error(`subagent-codex: child process tree did not exit within disposeGraceMs=${boundedGrace}`));
    }
  } catch (error) {
    if (error instanceof CodexRunFailure) throw error;
    throw new CodexRunFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, toError(error));
  }
  await Promise.race([
    donePromise,
    new Promise((resolve) => {
      const t = setTimeout(resolve, 1000);
      t.unref?.();
    }),
  ]);
  return { terminated: true, outcome };
}

function isCleanSelfExit(exitInfo) {
  return !exitInfo.terminated
    && exitInfo.outcome?.exitCode === 0
    && (exitInfo.outcome?.signal === null || exitInfo.outcome?.signal === undefined);
}

async function teardownAfterArchiveConfirmed(wire, child, { eofGraceMs, disposeGraceMs }, contextLabel) {
  const exitInfo = await disposeCodexChild(wire, child, { eofGraceMs, disposeGraceMs });
  if (!exitInfo.terminated && !isCleanSelfExit(exitInfo)) {
    throw new CodexRunFailure({
      stage: 'teardown',
      category: 'process',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      outcome: exitInfo.outcome,
    });
  }
  return exitInfo.terminated
    ? `teardown: child terminated after eofGraceMs=${eofGraceMs}; ${contextLabel}`
    : undefined;
}

function validateRolloutFile(rolloutPath, codexHome, { expectedThreadId, expectedTurnId, requireCompaction = false } = {}) {
  if (typeof rolloutPath !== 'string' || !path.isAbsolute(rolloutPath)) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error('subagent-codex: persistent thread missing absolute rollout path'));
  }
  if (isArchivedPath(rolloutPath)) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_NOT_FOUND',
    }, new Error('subagent-codex: thread rollout path is archived'));
  }
  let realRollout;
  try {
    // On Windows, thread/resume can return an extended-length (\\?\) path.
    // The JS realpath implementation cannot resolve its drive component.
    realRollout = realpathSync.native(rolloutPath);
  } catch (error) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, toError(error));
  }
  if (codexHome && !isWithinDirectory(realRollout, codexHome)) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error('subagent-codex: rollout path escapes configured CODEX_HOME'));
  }
  let stat;
  try {
    stat = statSync(realRollout);
  } catch (error) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, toError(error));
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error('subagent-codex: rollout file is empty or not a regular file'));
  }
  let raw;
  try {
    raw = readFileSync(realRollout, 'utf8');
  } catch (error) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, toError(error));
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error('subagent-codex: rollout file has no JSONL entries'));
  }
  let matchedThreadId = expectedThreadId === undefined;
  let matchedTurnComplete = expectedTurnId === undefined;
  let matchedCompaction = !requireCompaction;
  try {
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object') {
        throw new Error('non-object JSONL rollout entry');
      }
      if (!matchedThreadId && entry.type === 'session_meta') {
        const metaId = entry.payload?.id ?? entry.id;
        if (metaId === expectedThreadId) {
          matchedThreadId = true;
        }
      }
      if (!matchedTurnComplete && entry.type === 'event_msg' && entry.payload?.type === 'task_complete') {
        if (entry.payload.turn_id === expectedTurnId || entry.payload.root_turn_id === expectedTurnId) {
          matchedTurnComplete = true;
        }
      }
      if (!matchedCompaction && entry.type === 'event_msg' && entry.payload) {
        const p = entry.payload;
        if (p.type === 'item_completed' && p.turn_id === expectedTurnId && typeof p.item?.type === 'string' && /^context_?compaction$/i.test(p.item.type)) {
          matchedCompaction = true;
        } else if (p.type === 'context_compacted' && (p.turn_id === expectedTurnId || p.root_turn_id === expectedTurnId)) {
          matchedCompaction = true;
        }
      }
    }
  } catch (error) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, toError(error));
  }
  if (!matchedThreadId) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error(`subagent-codex: rollout file session_meta did not match threadId "${expectedThreadId}"`));
  }
  if (!matchedTurnComplete) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error(`subagent-codex: rollout file has not persisted task_complete for turn "${expectedTurnId}"`));
  }
  if (!matchedCompaction) {
    throw new CodexRunFailure({
      stage: 'persistence',
      category: 'invalid-result',
      code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
    }, new Error(`subagent-codex: rollout file has not persisted compaction evidence for turn "${expectedTurnId}"`));
  }
  return stat.size;
}

async function waitForValidRolloutFile(rolloutPath, codexHome, { expectedThreadId, expectedTurnId, retries = 5, retryDelayMs = 40 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return validateRolloutFile(rolloutPath, codexHome, { expectedThreadId, expectedTurnId });
    } catch (error) {
      lastError = error;
      if (error instanceof CodexRunFailure && error.facts?.code === 'CODEX_THREAD_NOT_FOUND') {
        throw error;
      }
      if (attempt < retries) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs);
          timer.unref?.();
        });
      }
    }
  }
  throw lastError;
}

function validateTurnInputBlocks(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new Error('subagent-codex: the task prompt must be a non-empty array of input blocks');
  }
  const items = [];
  const texts = [];
  for (const block of prompt) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      items.push({ type: 'text', text: block.text });
      continue;
    }
    if (block && block.type === 'localImage' && typeof block.path === 'string' && block.path.trim().length > 0) {
      items.push({
        type: 'localImage',
        path: block.path,
        ...(block.detail !== undefined ? { detail: block.detail } : {}),
      });
      continue;
    }
    throw new Error('subagent-codex: the task must contain only text or localImage blocks');
  }
  if (texts.length === 0 || texts.every((text) => text.trim().length === 0)) {
    throw new Error('subagent-codex: the task prompt must not be empty');
  }
  return items;
}

/**
 * Start one Codex `app-server --stdio` child (or reuse an idle warm worker when
 * `spec.warmPool` is enabled and config-compatible) and execute an ephemeral,
 * new, or resumed persistent turn.
 */
export async function startCodexRun(request, spec) {
  const inputItems = validateTurnInputBlocks(request.prompt);
  if (request.signal?.aborted) {
    throw new Error('subagent-codex: request was aborted before app-server startup');
  }

  const permissionMode = spec.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
  const effectiveThreadPerms = resolveThreadPermissionParams(permissionMode, spec.sandbox);
  const eofGraceMs = spec.eofGraceMs ?? DEFAULT_EOF_GRACE_MS;
  const disposeGraceMs = spec.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
  const lease = spec.lease ?? {
    mode: 'ephemeral',
    model: spec.model ?? null,
    previousModel: null,
    async markUncertain() {},
    async commit() {},
    release() {},
  };
  const mode = lease.mode ?? 'ephemeral';
  const effectiveModel = spec.explicitModel !== undefined
    ? spec.explicitModel
    : (lease.model ?? spec.model);
  const codexHome = spec.codexHome ?? spec.env?.CODEX_HOME;
  const warmPool = spec.warmPool;
  const warmEnabled = Boolean(warmPool?.isEnabled?.()) && mode !== 'ephemeral';
  // Use the same timestamp when parking so a config edit during the turn invalidates the worker.
  const configMtimeMs = readConfigMtimeMs(codexHome);
  const buildWarmSignature = (modelValue) => JSON.stringify({
    cwdNorm: normalizeCwdPath(spec.cwd),
    permissionMode,
    sandbox: spec.sandbox ?? null,
    model: modelValue ?? null,
    config: spec.config ?? null,
    codexHome: codexHome ?? null,
    configMtimeMs,
  });
  const requestedWarmSignature = buildWarmSignature(effectiveModel);

  const spawnFreshWorker = () => {
    const argv = spec.argv ?? resolveCodexAppServerArgv({
      wrapperPath: spec.wrapperPath,
      codexAnchorPath: spec.codexAnchorPath,
    });

    let child;
    try {
      child = spec.spawn({
        argv,
        cwd: spec.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: disposeGraceMs,
        env: spec.env ?? {},
      });
    } catch (error) {
      throw new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, toError(error));
    }

    if (!child?.stdin || !child?.stdout) {
      throw new CodexRunFailure(
        { stage: 'initialize', category: 'unknown' },
        new Error('subagent-codex: subprocess dropped piped stdio streams'),
      );
    }

    const diagnosticMux = { current: spec.onDiagnostic };
    const wire = createCodexWire({
      stdin: child.stdin,
      stdout: child.stdout,
      permissionMode,
      requestTimeoutMs: spec.requestTimeoutMs,
      onDiagnostic: (event) => {
        if (typeof diagnosticMux.current === 'function') {
          diagnosticMux.current(event);
        }
      },
    });

    // Drain stderr into diagnostics only; never allow stderr bytes into model output.
    let stderr = Buffer.alloc(0);
    let stderrTruncated = false;
    const resetStderr = () => {
      stderr = Buffer.alloc(0);
      stderrTruncated = false;
    };
    const onStderr = (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrTruncated ||= stderr.length + bytes.length > STDERR_TAIL_BYTES;
      stderr = Buffer.concat([stderr, bytes.subarray(-STDERR_TAIL_BYTES)]).subarray(-STDERR_TAIL_BYTES);
      if (bytes.length && typeof diagnosticMux.current === 'function') {
        try {
          diagnosticMux.current({ type: 'stderr', length: bytes.length });
        } catch {}
      }
    };
    const enrichFailure = (facts, cause) => {
      // Drop a possibly partial first line when truncating, so its redaction prefix cannot be lost.
      const stderrText = stderr.toString('utf8');
      const tail = stderrTruncated ? stderrText.replace(/^[^\n]*(?:\n|$)/, '') : stderrText;
      const stderrTail = cleanDiagnosticText(tail);
      const reason = cause && !(cause instanceof CodexRunFailure) && cleanDiagnosticText(toError(cause).message).slice(0, 512);
      return {
        ...facts,
        ...(stderrTail && Buffer.byteLength(stderrTail) <= STDERR_TAIL_BYTES ? { stderrTail } : {}),
        ...(reason ? { reason } : {}),
      };
    };
    const onStderrError = () => {};
    child.stderr?.on('data', onStderr);
    child.stderr?.on('error', onStderrError);

    let disposalPromise;
    const disposeProcess = () => {
      disposalPromise ??= (async () => {
        try {
          const res = await disposeCodexChild(wire, child, { eofGraceMs, disposeGraceMs });
          await new Promise((resolve) => setImmediate(resolve));
          return res;
        } finally {
          diagnosticMux.current = undefined;
          child.stderr?.off('data', onStderr);
          child.stderr?.off('error', onStderrError);
        }
      })();
      return disposalPromise;
    };

    let processFailureFacts;
    const processFailure = child.done.then((outcome) => {
      processFailureFacts = { stage: 'process', category: 'process', outcome };
      throw new CodexRunFailure(processFailureFacts);
    }, (error) => {
      processFailureFacts = { stage: 'process', category: 'unknown' };
      throw new CodexRunFailure(processFailureFacts, toError(error));
    });
    processFailure.catch(() => {});

    return {
      child,
      wire,
      diagnosticMux,
      resetStderr,
      enrichFailure,
      disposeProcess,
      processFailure,
      getProcessFailureFacts: () => processFailureFacts,
      confirmedModel: effectiveModel ?? null,
      confirmedSandboxPolicy: null,
      rolloutPath: undefined,
    };
  };

  let threadId = lease.threadId;
  let worker;
  let warmReused = false;
  let rolloutPath;
  let confirmedModel = effectiveModel ?? null;
  let confirmedSandboxPolicy = null;
  let startupStage = 'initialize';

  // Fast path: attempt to reuse a config-compatible parked warm worker for resumed threads.
  if (mode === 'resume' && warmEnabled && threadId) {
    let candidate;
    try {
      candidate = await warmPool.acquireWorker(threadId, requestedWarmSignature);
    } catch (error) {
      lease.release?.();
      throw error;
    }
    if (candidate) {
      candidate.resetStderr();
      candidate.diagnosticMux.current = spec.onDiagnostic;
      try {
        startupStage = 'thread-read';
        const readRes = await Promise.race([
          candidate.wire.readThread(threadId, { includeTurns: false, signal: request.signal }),
          candidate.processFailure,
        ]);
        if (readRes.thread.id !== threadId) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'invalid-result',
            code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          }, new Error('subagent-codex: thread/read returned mismatched threadId'));
        }
        if (typeof readRes.thread.cwd === 'string' && normalizeCwdPath(readRes.thread.cwd) !== normalizeCwdPath(spec.cwd)) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'access-policy',
            code: 'CODEX_THREAD_CWD_MISMATCH',
          }, new Error('subagent-codex: thread/read cwd mismatch'));
        }
        if (isArchivedPath(readRes.thread.path) || readRes.thread.archived === true) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'not-found',
            code: 'CODEX_THREAD_NOT_FOUND',
          }, new Error('subagent-codex: thread is archived'));
        }
        if (codexHome && typeof readRes.thread.path === 'string' && !isWithinDirectory(readRes.thread.path, codexHome)) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'invalid-result',
            code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          }, new Error('subagent-codex: thread/read path escapes CODEX_HOME'));
        }
        worker = candidate;
        warmReused = true;
        rolloutPath = readRes.thread.path ?? candidate.rolloutPath;
        confirmedModel = candidate.confirmedModel ?? confirmedModel;
        confirmedSandboxPolicy = candidate.confirmedSandboxPolicy ?? null;
      } catch (error) {
        try {
          await warmPool.discardWorker(threadId, candidate);
        } catch (discardError) {
          lease.release?.();
          throw discardError;
        }
        if (request.signal?.aborted) {
          lease.release?.();
          throw new Error('subagent-codex: request was aborted before run publication');
        }
        if (error instanceof CodexRunFailure && (
          error.facts?.code === 'CODEX_THREAD_NOT_FOUND'
          || error.facts?.code === 'CODEX_THREAD_CWD_MISMATCH'
        )) {
          lease.release?.();
          throw error;
        }
        if (error instanceof CodexRpcError) {
          const classified = classifyCodexRpcError(error, { method: 'thread/read' });
          if (classified.classification === 'archived' || classified.classification === 'not-found') {
            lease.release?.();
            throw new CodexRunFailure({
              stage: 'thread-read',
              category: classified.classification,
              code: classified.code,
              upstreamCode: classified.upstreamCode,
            }, error);
          }
        }
        // Dead or stale idle warm worker: fall back cleanly to cold spawn + thread/resume.
        startupStage = 'initialize';
      }
    }
  }

  if (!worker) {
    try {
      worker = spawnFreshWorker();
    } catch (error) {
      lease.release?.();
      throw error;
    }
  }

  const { wire, diagnosticMux, enrichFailure, disposeProcess, processFailure, getProcessFailureFacts } = worker;

  const runAbort = new AbortController();
  const requestCancel = () => {
    if (runAbort.signal.aborted) return;
    runAbort.abort(new Error('subagent-codex: run cancelled locally'));
    void wire.interrupt();
  };
  const onAbort = () => requestCancel();
  request.signal?.addEventListener('abort', onAbort, { once: true });

  if (!warmReused) {
    try {
      await Promise.race([wire.initialize({ signal: request.signal }), processFailure]);

      if (mode === 'ephemeral') {
        startupStage = 'thread-start';
        const started = await Promise.race([
          wire.startThread({
            cwd: spec.cwd,
            ephemeral: true,
            ...(effectiveModel === undefined || effectiveModel === null ? {} : { model: effectiveModel }),
            ...effectiveThreadPerms,
            ...(spec.config === undefined ? {} : { config: spec.config }),
          }, { signal: request.signal }),
          processFailure,
        ]);
        const confirmed = assertConfirmedThreadConfig(started, {
          effectiveThreadPerms,
          explicitModel: spec.explicitModel,
          expectedModel: effectiveModel,
          stage: startupStage,
        });
        confirmedModel = confirmed.confirmedModel;
        confirmedSandboxPolicy = confirmed.confirmedSandboxPolicy;
        threadId = started.thread.id;
      } else if (mode === 'new') {
        startupStage = 'thread-start';
        const started = await Promise.race([
          wire.startThread({
            cwd: spec.cwd,
            ephemeral: false,
            ...(effectiveModel === undefined || effectiveModel === null ? {} : { model: effectiveModel }),
            ...effectiveThreadPerms,
            ...(spec.config === undefined ? {} : { config: spec.config }),
          }, { signal: request.signal }),
          processFailure,
        ]);
        const confirmed = assertConfirmedThreadConfig(started, {
          effectiveThreadPerms,
          explicitModel: spec.explicitModel,
          expectedModel: effectiveModel,
          stage: startupStage,
        });
        confirmedModel = confirmed.confirmedModel;
        confirmedSandboxPolicy = confirmed.confirmedSandboxPolicy;
        threadId = started.thread.id;
        rolloutPath = started.thread.path;
        if (typeof rolloutPath !== 'string' || !path.isAbsolute(rolloutPath)) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'invalid-result',
            code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          }, new Error('subagent-codex: persistent thread/start returned no absolute rollout path'));
        }
        if (codexHome && !isWithinDirectory(rolloutPath, codexHome)) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'invalid-result',
            code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          }, new Error('subagent-codex: persistent thread/start path escapes CODEX_HOME'));
        }
        // Persist uncertain ownership record immediately once threadId is known.
        await lease.markUncertain({ threadId, model: confirmedModel });
        try {
          spec.onThreadKnown?.(threadId);
        } catch {}
      } else if (mode === 'resume') {
        startupStage = 'thread-read';
        const readRes = await Promise.race([
          wire.readThread(threadId, { includeTurns: false, signal: request.signal }),
          processFailure,
        ]);
        if (readRes.thread.id !== threadId) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'invalid-result',
            code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          }, new Error('subagent-codex: thread/read returned mismatched threadId'));
        }
        if (typeof readRes.thread.cwd === 'string' && normalizeCwdPath(readRes.thread.cwd) !== normalizeCwdPath(spec.cwd)) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'access-policy',
            code: 'CODEX_THREAD_CWD_MISMATCH',
          }, new Error('subagent-codex: thread/read cwd mismatch'));
        }
        if (isArchivedPath(readRes.thread.path) || readRes.thread.archived === true) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'not-found',
            code: 'CODEX_THREAD_NOT_FOUND',
          }, new Error('subagent-codex: thread is archived'));
        }
        if (codexHome && typeof readRes.thread.path === 'string' && !isWithinDirectory(readRes.thread.path, codexHome)) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'invalid-result',
            code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          }, new Error('subagent-codex: thread/read path escapes CODEX_HOME'));
        }

        startupStage = 'thread-resume';
        const resumeRes = await Promise.race([
          wire.resumeThread({
            threadId,
            cwd: spec.cwd,
            excludeTurns: true,
            ...(effectiveModel === undefined || effectiveModel === null ? {} : { model: effectiveModel }),
            ...effectiveThreadPerms,
            ...(spec.config === undefined ? {} : { config: spec.config }),
          }, { signal: request.signal }),
          processFailure,
        ]);
        if (resumeRes.thread.id !== threadId) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'invalid-result',
            code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          }, new Error('subagent-codex: thread/resume returned mismatched threadId'));
        }
        const resumedCwd = resumeRes.cwd ?? resumeRes.thread.cwd;
        if (typeof resumedCwd === 'string' && normalizeCwdPath(resumedCwd) !== normalizeCwdPath(spec.cwd)) {
          throw new CodexRunFailure({
            stage: startupStage,
            category: 'access-policy',
            code: 'CODEX_THREAD_CWD_MISMATCH',
          }, new Error('subagent-codex: thread/resume cwd mismatch'));
        }
        const confirmed = assertConfirmedThreadConfig(resumeRes, {
          effectiveThreadPerms,
          explicitModel: spec.explicitModel,
          expectedModel: effectiveModel,
          stage: startupStage,
        });
        rolloutPath = resumeRes.thread.path ?? readRes.thread.path;
        confirmedModel = confirmed.confirmedModel;
        confirmedSandboxPolicy = confirmed.confirmedSandboxPolicy;
      } else {
        throw new Error(`subagent-codex: unsupported lease mode "${mode}"`);
      }
    } catch (error) {
      request.signal?.removeEventListener('abort', onAbort);
      const cancelledBeforeCleanup = runAbort.signal.aborted;
      const classified = error instanceof CodexRpcError ? classifyCodexRpcError(error) : undefined;
      const failure = error instanceof CodexRunFailure
        ? error
        : new CodexRunFailure({
          stage: startupStage,
          category: classified?.classification ?? 'unknown',
          code: classified?.code,
          upstreamCode: classified?.upstreamCode,
          outcome: getProcessFailureFacts()?.outcome,
        }, toError(error));

      try {
        await disposeProcess();
      } catch (disposeError) {
        lease.release?.();
        const cleanupFailure = toError(disposeError);
        const enriched = new CodexRunFailure(enrichFailure(failure.facts, failure.cause), failure.cause);
        throw new AggregateError([enriched, cleanupFailure], `${enriched.message}; ${cleanupFailure.message}`);
      }
      lease.release?.();
      if (cancelledBeforeCleanup || request.signal?.aborted) {
        throw new Error('subagent-codex: request was aborted before run publication');
      }
      throw new CodexRunFailure(enrichFailure(failure.facts, failure.cause), failure.cause);
    }
  }

  worker.rolloutPath = rolloutPath;
  worker.confirmedModel = confirmedModel;
  worker.confirmedSandboxPolicy = confirmedSandboxPolicy;

  let diagnostic;
  let parked = false;
  const recordFailureDiagnostic = (facts) => {
    const headline = failureDiagnostic(facts);
    const perm = wire.collectDiagnostic();
    diagnostic = perm === undefined ? headline : `${headline}\n${perm}`;
    return diagnostic;
  };

  const result = (async () => {
    let resumeMarked = false;
    let turnDispatched = false;
    try {
      if (mode === 'resume') {
        // Keep the existing row ready during read/resume preflight; persist the
        // uncertainty marker before dispatch, so a client crash cannot lose it.
        if (runAbort.signal.aborted) throw runAbort.signal.reason;
        await lease.markUncertain({ threadId, model: confirmedModel });
        resumeMarked = true;
        if (runAbort.signal.aborted) throw runAbort.signal.reason;
        if (getProcessFailureFacts() !== undefined) await processFailure;
        if (wire.endedBeforeTerminal()) throw new Error('subagent-codex: app-server stream closed before turn/start');
      }
      turnDispatched = true;
      const turnRes = await Promise.race([
        wire.startTurn({
          threadId,
          input: inputItems,
          ...(effectiveThreadPerms.approvalPolicy !== undefined ? { approvalPolicy: effectiveThreadPerms.approvalPolicy } : {}),
          ...(effectiveThreadPerms.approvalsReviewer !== undefined ? { approvalsReviewer: effectiveThreadPerms.approvalsReviewer } : {}),
          ...(confirmedSandboxPolicy !== null ? { sandboxPolicy: confirmedSandboxPolicy } : {}),
          ...(confirmedModel !== null ? { model: confirmedModel } : {}),
          ...(spec.reasoningEffort !== undefined ? { effort: spec.reasoningEffort } : {}),
          ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
        }, { signal: runAbort.signal, timeoutMs: spec.turnTimeoutMs }),
        processFailure,
      ]);

      if (turnRes.stopReason !== 'completed') {
        await disposeProcess().catch(() => {});
        const facts = {
          ...(wire.collectFailure() ?? { stage: 'turn', category: 'limit' }),
          ...(getProcessFailureFacts()?.outcome ? { outcome: getProcessFailureFacts().outcome } : {}),
        };
        recordFailureDiagnostic(enrichFailure(facts));
        return {
          output: turnRes.output,
          stopReason: turnRes.stopReason,
          usage: turnRes.usage ?? wire.collectUsage(),
          diagnostic,
        };
      }

      const usage = turnRes.usage ?? wire.collectUsage();

      // Opt-in warm pool path: verify full rollout + current turn completion persisted
      // while child stays alive, commit lease, and park worker for reuse. If rollout
      // does not show task_complete for this turnId while alive, fall back cleanly to
      // cold EOF teardown + full rollout validation.
      if (warmEnabled && !runAbort.signal.aborted && !warmPool.isDisposed?.()) {
        let warmRolloutSize;
        try {
          warmRolloutSize = await waitForValidRolloutFile(rolloutPath, codexHome, {
            expectedThreadId: threadId,
            expectedTurnId: turnRes.turnId,
          });
        } catch (error) {
          if (error instanceof CodexRunFailure && error.facts?.code === 'CODEX_THREAD_NOT_FOUND') {
            await disposeProcess().catch(() => {});
            throw error;
          }
          warmRolloutSize = undefined;
        }
        if (warmRolloutSize !== undefined && getProcessFailureFacts() === undefined && !wire.endedBeforeTerminal()) {
          await lease.commit({
            threadId,
            cwd: spec.cwd,
            model: confirmedModel,
            used: usage?.totalTokens ?? null,
            contextWindow: usage?.modelContextWindow ?? null,
            size: warmRolloutSize,
          });
          diagnosticMux.current = undefined;
          const parkedOk = warmPool.parkWorker({
            ...worker,
            threadId,
            rolloutPath,
            confirmedModel,
            confirmedSandboxPolicy,
            signature: buildWarmSignature(confirmedModel),
          });
          if (parkedOk) {
            parked = true;
            return {
              output: turnRes.output,
              stopReason: 'completed',
              usage,
              structured: { threadId, resumed: mode === 'resume', usage },
            };
          }
          // Pool was disposed concurrently while committing; dispose child cleanly now.
          await disposeProcess().catch(() => {});
          return {
            output: turnRes.output,
            stopReason: 'completed',
            usage,
            structured: { threadId, resumed: mode === 'resume', usage },
          };
        }
      }

      // Normal cold completion path: wait for EOF exit without calling terminate().
      // If EOF grace expires and we terminate the child after turn completion,
      // still accept completion when ephemeral or when rollout validation passes.
      const exitInfo = await disposeProcess();
      if (!exitInfo.terminated && !isCleanSelfExit(exitInfo)) {
        const facts = {
          stage: 'teardown',
          category: 'process',
          code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          outcome: exitInfo.outcome,
        };
        recordFailureDiagnostic(facts);
        throw new CodexRunFailure(facts);
      }

      if (mode !== 'ephemeral') {
        let size;
        try {
          size = validateRolloutFile(rolloutPath, codexHome, {
            expectedThreadId: threadId,
            expectedTurnId: turnRes.turnId,
          });
        } catch (error) {
          if (exitInfo.terminated) {
            const facts = {
              stage: 'teardown',
              category: 'timeout',
              code: error instanceof CodexRunFailure && error.facts?.code
                ? error.facts.code
                : 'CODEX_THREAD_STORAGE_UNAVAILABLE',
              outcome: exitInfo.outcome,
            };
            recordFailureDiagnostic(facts);
            throw new CodexRunFailure(facts, toError(error));
          }
          throw error;
        }
        await lease.commit({
          threadId,
          cwd: spec.cwd,
          model: confirmedModel,
          used: usage?.totalTokens ?? null,
          contextWindow: usage?.modelContextWindow ?? null,
          size,
        });
      }

      const teardownDiagnostic = exitInfo.terminated
        ? mode === 'ephemeral'
          ? `teardown: child terminated after eofGraceMs=${eofGraceMs}; ephemeral turn completed`
          : `teardown: child terminated after eofGraceMs=${eofGraceMs}; rollout validated`
        : undefined;

      return {
        output: turnRes.output,
        stopReason: 'completed',
        usage,
        ...(teardownDiagnostic !== undefined ? { diagnostic: teardownDiagnostic } : {}),
        ...(mode !== 'ephemeral' ? { structured: { threadId, resumed: mode === 'resume', usage } } : {}),
      };
    } catch (error) {
      const transportEnded = wire.endedBeforeTerminal();
      let cleanupError;
      try {
        await disposeProcess();
        const rejectedBeforeStart = error instanceof CodexRpcError && error.method === 'turn/start'
          && typeof error.code === 'number' && !wire.observedTurnStart();
        if (resumeMarked && (!turnDispatched || rejectedBeforeStart)) {
          await lease.rollbackBeforeTurn?.();
        }
      } catch (failure) {
        cleanupError = failure;
      }
      if (runAbort.signal.aborted && cleanupError === undefined) {
        return {
          output: wire.collectOutput(),
          stopReason: 'aborted',
        };
      }
      const classified = error instanceof CodexRpcError ? classifyCodexRpcError(error) : undefined;
      const processFacts = getProcessFailureFacts();
      const facts = error instanceof CodexRunFailure
        ? error.facts
        : transportEnded && processFacts !== undefined
          ? processFacts
          : {
            ...(wire.collectFailure() ?? { stage: 'turn', category: classified?.classification ?? 'unknown' }),
            ...(classified?.code ? { code: classified.code } : {}),
            ...(classified?.upstreamCode !== undefined ? { upstreamCode: classified.upstreamCode } : {}),
            ...(processFacts?.outcome ? { outcome: processFacts.outcome } : {}),
          };
      const failure = new CodexRunFailure(enrichFailure(facts, cleanupError ?? (error.cause ?? error)), toError(error));
      const diag = recordFailureDiagnostic(failure.facts);
      try {
        spec.onError?.(failure, 'error');
      } catch {}
      return {
        output: wire.collectOutput(),
        diagnostic: diag,
        stopReason: 'error',
      };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      lease.release?.();
    }
  })();

  let disposal;
  return {
    id: randomUUID(),
    localAgent: undefined,
    result,
    async steer(steerBlocks, options = {}) {
      const steerItems = validateTurnInputBlocks(steerBlocks);
      const currentTurnId = wire.getTurnId();
      if (runAbort.signal.aborted || parked || !currentTurnId) {
        throw new CodexRunFailure({
          stage: 'turn',
          category: 'product-error',
          code: 'CODEX_TURN_NOT_STEERABLE',
        }, new Error('subagent-codex: turn is not currently active or steerable'));
      }
      const res = await wire.steerTurn({
        threadId,
        expectedTurnId: currentTurnId,
        input: steerItems,
      }, { signal: options.signal });
      try {
        spec.onDiagnostic?.({
          type: 'steered',
          threadId,
          turnId: res.turnId,
        });
      } catch {}
      return res;
    },
    dispose() {
      if (disposal !== undefined) return disposal;
      if (parked) {
        disposal = Promise.resolve();
        return disposal;
      }
      request.signal?.removeEventListener('abort', onAbort);
      requestCancel();
      // The result owns the lease until commit or rollback finishes.
      disposal = disposeProcess().then(() => result).then(() => undefined);
      return disposal;
    },
  };
}

/**
 * Compact an owned Codex thread via `thread/compact/start`, returning the same
 * background-capable `{ id, result, dispose }` handle shape as `startCodexRun`.
 */
export async function compactCodexThread(spec) {
  if (spec.signal?.aborted) {
    throw new Error('subagent-codex: compact aborted before app-server startup');
  }
  const threadId = spec.threadId;
  const permissionMode = spec.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
  const effectiveThreadPerms = resolveThreadPermissionParams(permissionMode, spec.sandbox);
  const eofGraceMs = spec.eofGraceMs ?? DEFAULT_EOF_GRACE_MS;
  const disposeGraceMs = spec.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
  const lease = spec.lease ?? {
    mode: 'resume',
    model: spec.model ?? null,
    async markUncertain() {},
    async rollbackBeforeTurn() {},
    async commit() {},
    release() {},
  };
  const effectiveModel = spec.explicitModel !== undefined
    ? spec.explicitModel
    : (lease.model ?? spec.model);
  const codexHome = spec.codexHome ?? spec.env?.CODEX_HOME;

  const argv = spec.argv ?? resolveCodexAppServerArgv({
    wrapperPath: spec.wrapperPath,
    codexAnchorPath: spec.codexAnchorPath,
  });

  let child;
  try {
    child = spec.spawn({
      argv,
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: disposeGraceMs,
      env: spec.env ?? {},
    });
  } catch (error) {
    lease.release?.();
    throw new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, toError(error));
  }

  if (!child?.stdin || !child?.stdout) {
    lease.release?.();
    throw new CodexRunFailure(
      { stage: 'initialize', category: 'unknown' },
      new Error('subagent-codex: subprocess dropped piped stdio streams'),
    );
  }

  const wire = createCodexWire({
    stdin: child.stdin,
    stdout: child.stdout,
    permissionMode,
    requestTimeoutMs: spec.requestTimeoutMs,
    onDiagnostic: spec.onDiagnostic,
  });

  let stderr = Buffer.alloc(0);
  let stderrTruncated = false;
  const onStderr = (chunk) => {
    const bytes = Buffer.from(chunk);
    stderrTruncated ||= stderr.length + bytes.length > STDERR_TAIL_BYTES;
    stderr = Buffer.concat([stderr, bytes.subarray(-STDERR_TAIL_BYTES)]).subarray(-STDERR_TAIL_BYTES);
  };
  const onStderrError = () => {};
  child.stderr?.on('data', onStderr);
  child.stderr?.on('error', onStderrError);

  const enrichFailure = (facts, cause) => {
    const stderrText = stderr.toString('utf8');
    const tail = stderrTruncated ? stderrText.replace(/^[^\n]*(?:\n|$)/, '') : stderrText;
    const stderrTail = cleanDiagnosticText(tail);
    const reason = cause && !(cause instanceof CodexRunFailure) && cleanDiagnosticText(toError(cause).message).slice(0, 512);
    return {
      ...facts,
      ...(stderrTail && Buffer.byteLength(stderrTail) <= STDERR_TAIL_BYTES ? { stderrTail } : {}),
      ...(reason ? { reason } : {}),
    };
  };

  let disposalPromise;
  const disposeProcess = () => {
    disposalPromise ??= (async () => {
      try {
        const res = await disposeCodexChild(wire, child, { eofGraceMs, disposeGraceMs });
        await new Promise((resolve) => setImmediate(resolve));
        return res;
      } finally {
        child.stderr?.off('data', onStderr);
        child.stderr?.off('error', onStderrError);
      }
    })();
    return disposalPromise;
  };

  let processFailureFacts;
  const processFailure = child.done.then((outcome) => {
    processFailureFacts = { stage: 'process', category: 'process', outcome };
    throw new CodexRunFailure(processFailureFacts);
  }, (error) => {
    processFailureFacts = { stage: 'process', category: 'unknown' };
    throw new CodexRunFailure(processFailureFacts, toError(error));
  });
  processFailure.catch(() => {});

  const runAbort = new AbortController();
  const requestCancel = () => {
    if (runAbort.signal.aborted) return;
    runAbort.abort(new Error('subagent-codex: compact cancelled locally'));
    void wire.interrupt();
  };
  const onAbort = () => requestCancel();
  spec.signal?.addEventListener('abort', onAbort, { once: true });

  let rolloutPath;
  let confirmedModel = effectiveModel ?? null;
  let startupStage = 'initialize';

  try {
    await Promise.race([wire.initialize({ signal: spec.signal }), processFailure]);
    startupStage = 'thread-read';
    const readRes = await Promise.race([
      wire.readThread(threadId, { includeTurns: false, signal: spec.signal }),
      processFailure,
    ]);
    if (readRes.thread.id !== threadId) {
      throw new CodexRunFailure({
        stage: startupStage,
        category: 'invalid-result',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error('subagent-codex: thread/read returned mismatched threadId'));
    }
    if (typeof readRes.thread.cwd === 'string' && normalizeCwdPath(readRes.thread.cwd) !== normalizeCwdPath(spec.cwd)) {
      throw new CodexRunFailure({
        stage: startupStage,
        category: 'access-policy',
        code: 'CODEX_THREAD_CWD_MISMATCH',
      }, new Error('subagent-codex: thread/read cwd mismatch'));
    }
    if (isArchivedPath(readRes.thread.path) || readRes.thread.archived === true) {
      throw new CodexRunFailure({
        stage: startupStage,
        category: 'not-found',
        code: 'CODEX_THREAD_NOT_FOUND',
      }, new Error('subagent-codex: thread is archived'));
    }
    if (codexHome && typeof readRes.thread.path === 'string' && !isWithinDirectory(readRes.thread.path, codexHome)) {
      throw new CodexRunFailure({
        stage: startupStage,
        category: 'invalid-result',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error('subagent-codex: thread/read path escapes CODEX_HOME'));
    }

    startupStage = 'thread-resume';
    const resumeRes = await Promise.race([
      wire.resumeThread({
        threadId,
        cwd: spec.cwd,
        excludeTurns: true,
        ...(effectiveModel === undefined || effectiveModel === null ? {} : { model: effectiveModel }),
        ...effectiveThreadPerms,
        ...(spec.config === undefined ? {} : { config: spec.config }),
      }, { signal: spec.signal }),
      processFailure,
    ]);
    const confirmed = assertConfirmedThreadConfig(resumeRes, {
      effectiveThreadPerms,
      explicitModel: spec.explicitModel,
      expectedModel: effectiveModel,
      stage: startupStage,
    });
    rolloutPath = resumeRes.thread.path ?? readRes.thread.path;
    confirmedModel = confirmed.confirmedModel;
  } catch (error) {
    spec.signal?.removeEventListener('abort', onAbort);
    const cancelledBeforeCleanup = runAbort.signal.aborted;
    const classified = error instanceof CodexRpcError ? classifyCodexRpcError(error) : undefined;
    const failure = error instanceof CodexRunFailure
      ? error
      : new CodexRunFailure({
        stage: startupStage,
        category: classified?.classification ?? 'unknown',
        code: classified?.code,
        upstreamCode: classified?.upstreamCode,
        outcome: processFailureFacts?.outcome,
      }, toError(error));
    try {
      await disposeProcess();
    } catch (disposeError) {
      lease.release?.();
      const cleanupFailure = toError(disposeError);
      const enriched = new CodexRunFailure(enrichFailure(failure.facts, failure.cause), failure.cause);
      throw new AggregateError([enriched, cleanupFailure], `${enriched.message}; ${cleanupFailure.message}`);
    }
    lease.release?.();
    if (cancelledBeforeCleanup || spec.signal?.aborted) {
      throw new Error('subagent-codex: compact aborted before start');
    }
    throw new CodexRunFailure(enrichFailure(failure.facts, failure.cause), failure.cause);
  }

  let diagnostic;
  const result = (async () => {
    let resumeMarked = false;
    let compactDispatched = false;
    try {
      if (runAbort.signal.aborted) throw runAbort.signal.reason;
      await lease.markUncertain({ threadId, model: confirmedModel });
      resumeMarked = true;
      if (runAbort.signal.aborted) throw runAbort.signal.reason;
      if (processFailureFacts !== undefined) await processFailure;
      if (wire.endedBeforeTerminal()) throw new Error('subagent-codex: app-server stream closed before thread/compact/start');

      compactDispatched = true;
      const compactRes = await Promise.race([
        wire.compactThread(threadId, { signal: runAbort.signal, timeoutMs: spec.turnTimeoutMs }),
        processFailure,
      ]);
      const usage = compactRes.usage ?? wire.collectUsage();

      const exitInfo = await disposeProcess();
      if (!exitInfo.terminated && !isCleanSelfExit(exitInfo)) {
        const facts = {
          stage: 'teardown',
          category: 'process',
          code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
          outcome: exitInfo.outcome,
        };
        diagnostic = failureDiagnostic(facts);
        throw new CodexRunFailure(facts);
      }

      const size = validateRolloutFile(rolloutPath, codexHome, {
        expectedThreadId: threadId,
        expectedTurnId: compactRes.turnId,
        requireCompaction: true,
      });
      await lease.commit({
        threadId,
        cwd: spec.cwd,
        model: confirmedModel,
        used: usage?.totalTokens ?? null,
        contextWindow: usage?.modelContextWindow ?? null,
        size,
      });

      return {
        stopReason: 'completed',
        compacted: compactRes.compacted,
        usage,
        structured: {
          compacted: true,
          threadId,
          turnId: compactRes.turnId ?? null,
          usage,
          size,
        },
      };
    } catch (error) {
      const transportEnded = wire.endedBeforeTerminal();
      let cleanupError;
      try {
        await disposeProcess();
        const rejectedBeforeStart = error instanceof CodexRpcError && error.method === 'thread/compact/start'
          && typeof error.code === 'number' && !wire.observedTurnStart();
        if (resumeMarked && (!compactDispatched || rejectedBeforeStart)) {
          await lease.rollbackBeforeTurn?.();
        }
      } catch (failure) {
        cleanupError = failure;
      }
      if (runAbort.signal.aborted && cleanupError === undefined) {
        return { stopReason: 'aborted' };
      }
      const classified = error instanceof CodexRpcError ? classifyCodexRpcError(error) : undefined;
      const facts = error instanceof CodexRunFailure
        ? error.facts
        : transportEnded && processFailureFacts !== undefined
          ? processFailureFacts
          : {
            ...(wire.collectFailure() ?? { stage: 'compact', category: classified?.classification ?? 'unknown' }),
            ...(classified?.code ? { code: classified.code } : {}),
            ...(classified?.upstreamCode !== undefined ? { upstreamCode: classified.upstreamCode } : {}),
            ...(processFailureFacts?.outcome ? { outcome: processFailureFacts.outcome } : {}),
          };
      const failure = new CodexRunFailure(enrichFailure(facts, cleanupError ?? (error.cause ?? error)), toError(error));
      const headline = failureDiagnostic(failure.facts);
      const perm = wire.collectDiagnostic();
      diagnostic = perm === undefined ? headline : `${headline}\n${perm}`;
      try {
        spec.onError?.(failure, 'error');
      } catch {}
      return {
        diagnostic,
        stopReason: 'error',
      };
    } finally {
      spec.signal?.removeEventListener('abort', onAbort);
      lease.release?.();
    }
  })();

  let disposal;
  return {
    id: randomUUID(),
    result,
    dispose() {
      if (disposal !== undefined) return disposal;
      spec.signal?.removeEventListener('abort', onAbort);
      requestCancel();
      disposal = disposeProcess().then(() => result).then(() => undefined);
      return disposal;
    },
  };
}

/**
 * Fork an owned persistent Codex thread into a new thread registered under a new sessionKey.
 */
export async function forkCodexThread({
  spawn,
  argv,
  wrapperPath,
  codexAnchorPath,
  sourceThreadId,
  lastTurnId,
  cwd,
  permissionMode = DEFAULT_CODEX_PERMISSION_MODE,
  sandbox,
  explicitModel,
  model,
  config,
  env = {},
  eofGraceMs = DEFAULT_EOF_GRACE_MS,
  disposeGraceMs = DEFAULT_DISPOSE_GRACE_MS,
  signal,
  codexHome,
  requestTimeoutMs,
  lease,
  onDiagnostic,
}) {
  if (signal?.aborted) {
    throw new Error('subagent-codex: fork aborted before app-server startup');
  }
  const effectiveThreadPerms = resolveThreadPermissionParams(permissionMode, sandbox);
  const effectiveModel = explicitModel !== undefined
    ? explicitModel
    : (lease?.model ?? model);

  const resolvedArgv = argv ?? resolveCodexAppServerArgv({ wrapperPath, codexAnchorPath });
  const child = spawn({
    argv: resolvedArgv,
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: disposeGraceMs,
    env,
  });
  if (!child?.stdin || !child?.stdout) {
    lease?.release?.();
    throw new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, new Error('subagent-codex: subprocess dropped piped stdio streams'));
  }

  const wire = createCodexWire({
    stdin: child.stdin,
    stdout: child.stdout,
    permissionMode,
    requestTimeoutMs,
    onDiagnostic,
  });

  const onStderr = () => {};
  child.stderr?.on('data', onStderr);
  child.stderr?.on('error', onStderr);

  try {
    await wire.initialize({ signal });
    const readRes = await wire.readThread(sourceThreadId, { includeTurns: false, signal });
    if (readRes.thread.id !== sourceThreadId) {
      throw new CodexRunFailure({
        stage: 'thread-read',
        category: 'invalid-result',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error('subagent-codex: thread/read returned mismatched sourceThreadId'));
    }
    if (typeof readRes.thread.cwd === 'string' && normalizeCwdPath(readRes.thread.cwd) !== normalizeCwdPath(cwd)) {
      throw new CodexRunFailure({
        stage: 'thread-read',
        category: 'access-policy',
        code: 'CODEX_THREAD_CWD_MISMATCH',
      }, new Error('subagent-codex: thread/read cwd mismatch'));
    }
    if (isArchivedPath(readRes.thread.path) || readRes.thread.archived === true) {
      throw new CodexRunFailure({
        stage: 'thread-read',
        category: 'not-found',
        code: 'CODEX_THREAD_NOT_FOUND',
      }, new Error('subagent-codex: source thread is archived'));
    }
    if (codexHome && typeof readRes.thread.path === 'string' && !isWithinDirectory(readRes.thread.path, codexHome)) {
      throw new CodexRunFailure({
        stage: 'thread-read',
        category: 'invalid-result',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error('subagent-codex: source thread path escapes CODEX_HOME'));
    }

    const forkRes = await wire.forkThread({
      threadId: sourceThreadId,
      cwd,
      ephemeral: false,
      excludeTurns: true,
      ...(lastTurnId !== undefined ? { lastTurnId } : {}),
      ...(effectiveModel === undefined || effectiveModel === null ? {} : { model: effectiveModel }),
      ...effectiveThreadPerms,
      ...(config === undefined ? {} : { config }),
    }, { signal });

    const confirmed = assertConfirmedThreadConfig(forkRes, {
      effectiveThreadPerms,
      explicitModel,
      expectedModel: effectiveModel,
      stage: 'thread-fork',
    });

    const newThreadId = forkRes.thread.id;
    if (newThreadId === sourceThreadId) {
      throw new CodexRunFailure({
        stage: 'thread-fork',
        category: 'invalid-result',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error('subagent-codex: thread/fork returned identical threadId'));
    }
    const newRolloutPath = forkRes.thread.path;
    if (typeof newRolloutPath !== 'string' || !path.isAbsolute(newRolloutPath) || isArchivedPath(newRolloutPath)) {
      throw new CodexRunFailure({
        stage: 'thread-fork',
        category: 'invalid-result',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error('subagent-codex: thread/fork returned missing or invalid rollout path'));
    }
    if (codexHome && !isWithinDirectory(newRolloutPath, codexHome)) {
      throw new CodexRunFailure({
        stage: 'thread-fork',
        category: 'invalid-result',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error('subagent-codex: forked thread path escapes CODEX_HOME'));
    }

    await lease?.markUncertain?.({ threadId: newThreadId, model: confirmed.confirmedModel });

    const exitInfo = await disposeCodexChild(wire, child, { eofGraceMs, disposeGraceMs });
    if (!exitInfo.terminated && !isCleanSelfExit(exitInfo)) {
      throw new CodexRunFailure({
        stage: 'teardown',
        category: 'process',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
        outcome: exitInfo.outcome,
      });
    }

    const size = validateRolloutFile(newRolloutPath, codexHome, { expectedThreadId: newThreadId });
    await lease?.commit?.({
      threadId: newThreadId,
      cwd,
      model: confirmed.confirmedModel,
      size,
    });

    return {
      forked: true,
      sourceThreadId,
      ...(lease?.sourceSessionKey !== undefined ? { sourceSessionKey: lease.sourceSessionKey } : {}),
      threadId: newThreadId,
      sessionKey: lease?.targetSessionKey,
      cwd,
      model: confirmed.confirmedModel,
      size,
    };
  } catch (error) {
    if (error instanceof CodexRunFailure) throw error;
    const classified = error instanceof CodexRpcError ? classifyCodexRpcError(error, { method: 'thread/fork' }) : undefined;
    throw new CodexRunFailure({
      stage: 'thread-fork',
      category: classified?.classification ?? 'unknown',
      code: classified?.code,
      upstreamCode: classified?.upstreamCode,
    }, toError(error));
  } finally {
    await disposeCodexChild(wire, child, { eofGraceMs, disposeGraceMs }).catch(() => {});
    child.stderr?.off('data', onStderr);
    child.stderr?.off('error', onStderr);
    lease?.release?.();
  }
}

/**
 * Archive an owned Codex thread via `thread/archive`, confirming clean EOF exit
 * and falling back to `thread/read` evidence on duplicate/timeout errors before
 * allowing registry cleanup.
 */
export async function archiveCodexThread({
  spawn,
  argv,
  wrapperPath,
  codexAnchorPath,
  threadId,
  cwd,
  env = {},
  eofGraceMs = DEFAULT_EOF_GRACE_MS,
  disposeGraceMs = DEFAULT_DISPOSE_GRACE_MS,
  signal,
  codexHome,
  requestTimeoutMs,
  onDiagnostic,
}) {
  if (signal?.aborted) {
    throw new Error('subagent-codex: archive aborted before app-server startup');
  }
  const resolvedArgv = argv ?? resolveCodexAppServerArgv({ wrapperPath, codexAnchorPath });
  const child = spawn({
    argv: resolvedArgv,
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: disposeGraceMs,
    env,
  });
  if (!child?.stdin || !child?.stdout) {
    throw new CodexRunFailure({ stage: 'initialize', category: 'unknown' }, new Error('subagent-codex: subprocess dropped piped stdio streams'));
  }

  const wire = createCodexWire({
    stdin: child.stdin,
    stdout: child.stdout,
    requestTimeoutMs,
    onDiagnostic,
  });

  const onStderr = () => {};
  child.stderr?.on('data', onStderr);
  child.stderr?.on('error', onStderr);

  try {
    await wire.initialize({ signal });
    try {
      await wire.archiveThread(threadId, { signal });
      const diagnostic = await teardownAfterArchiveConfirmed(
        wire,
        child,
        { eofGraceMs, disposeGraceMs },
        'archive confirmed',
      );
      return {
        archived: true,
        threadId,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      };
    } catch (error) {
      if (error instanceof CodexRunFailure) throw error;
      const classified = classifyCodexRpcError(error, { method: 'thread/archive' });
      if (classified.classification === 'not-found' || classified.classification === 'archived' || classified.classification === 'timeout') {
        let readRes;
        try {
          readRes = await wire.readThread(threadId, { includeTurns: false, signal });
        } catch (readError) {
          const readClassified = classifyCodexRpcError(readError, { method: 'thread/read' });
          await disposeCodexChild(wire, child, { eofGraceMs, disposeGraceMs }).catch(() => {});
          throw new CodexRunFailure({
            stage: 'archive',
            category: readClassified.classification,
            code: readClassified.code,
            upstreamCode: readClassified.upstreamCode,
          }, toError(readError));
        }
        const readPath = readRes.thread?.path;
        const confirmedArchived = readRes.thread?.archived === true || isArchivedPath(readPath);
        if (confirmedArchived && (!codexHome || typeof readPath !== 'string' || isWithinDirectory(readPath, codexHome))) {
          const diagnostic = await teardownAfterArchiveConfirmed(
            wire,
            child,
            { eofGraceMs, disposeGraceMs },
            'archive confirmed via thread/read',
          );
          return {
            archived: true,
            threadId,
            alreadyArchived: true,
            ...(readPath ? { path: readPath } : {}),
            ...(diagnostic === undefined ? {} : { diagnostic }),
          };
        }
        throw new CodexRunFailure({
          stage: 'archive',
          category: 'invalid-result',
          code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
        }, new Error('subagent-codex: thread/read did not confirm archived state after archive failure'));
      }
      throw new CodexRunFailure({
        stage: 'archive',
        category: classified.classification,
        code: classified.code,
        upstreamCode: classified.upstreamCode,
      }, toError(error));
    }
  } finally {
    await disposeCodexChild(wire, child, { eofGraceMs, disposeGraceMs }).catch(() => {});
    child.stderr?.off('data', onStderr);
    child.stderr?.off('error', onStderr);
  }
}

/**
 * Read-only probe for reconciling an `uncertain` persistent thread.
 * Returns one of `'ready' | 'archived' | 'missing' | 'uncertain'`.
 */
export async function probeCodexThread({
  spawn,
  argv,
  wrapperPath,
  codexAnchorPath,
  threadId,
  cwd,
  env = {},
  eofGraceMs = DEFAULT_EOF_GRACE_MS,
  disposeGraceMs = DEFAULT_DISPOSE_GRACE_MS,
  signal,
  codexHome,
  requestTimeoutMs,
  onDiagnostic,
}) {
  if (signal?.aborted) return 'uncertain';
  let resolvedArgv;
  try {
    resolvedArgv = argv ?? resolveCodexAppServerArgv({ wrapperPath, codexAnchorPath });
  } catch {
    return 'uncertain';
  }
  let child;
  try {
    child = spawn({
      argv: resolvedArgv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: disposeGraceMs,
      env,
    });
  } catch {
    return 'uncertain';
  }
  if (!child?.stdin || !child?.stdout) {
    return 'uncertain';
  }

  const wire = createCodexWire({
    stdin: child.stdin,
    stdout: child.stdout,
    requestTimeoutMs,
    onDiagnostic,
  });

  const onStderr = () => {};
  child.stderr?.on('data', onStderr);
  child.stderr?.on('error', onStderr);

  const processExit = child.done.then(
    () => { throw new Error('subagent-codex: probe app-server exited unexpectedly'); },
    (err) => { throw toError(err); },
  );
  processExit.catch(() => {});

  try {
    await Promise.race([wire.initialize({ signal }), processExit]);
    let readRes;
    try {
      readRes = await Promise.race([
        wire.readThread(threadId, { includeTurns: false, signal }),
        processExit,
      ]);
    } catch (error) {
      if (error instanceof CodexRpcError) {
        const classified = classifyCodexRpcError(error, { method: 'thread/read' });
        if (classified.classification === 'archived') return 'archived';
        if (classified.classification === 'not-found') return 'missing';
      }
      return 'uncertain';
    }

    const thread = readRes?.thread;
    if (!thread || thread.id !== threadId) return 'uncertain';
    if (thread.archived === true || isArchivedPath(thread.path)) return 'archived';
    if (thread.ephemeral === true) return 'missing';
    if (thread.status && typeof thread.status === 'object' && (
      thread.status.type === 'active' || thread.status.type === 'systemError'
    )) {
      return 'uncertain';
    }
    if (cwd && typeof thread.cwd === 'string' && normalizeCwdPath(thread.cwd) !== normalizeCwdPath(cwd)) {
      return 'uncertain';
    }

    const rolloutPath = thread.path;
    if (typeof rolloutPath !== 'string' || !path.isAbsolute(rolloutPath)) {
      return 'uncertain';
    }
    if (codexHome && !isWithinDirectory(rolloutPath, codexHome)) {
      return 'uncertain';
    }
    try {
      validateRolloutFile(rolloutPath, codexHome, { expectedThreadId: threadId });
    } catch (error) {
      if (error instanceof CodexRunFailure && error.facts?.code === 'CODEX_THREAD_NOT_FOUND') {
        return 'archived';
      }
      return 'uncertain';
    }
    return 'ready';
  } catch {
    return 'uncertain';
  } finally {
    await disposeCodexChild(wire, child, { eofGraceMs, disposeGraceMs }).catch(() => {});
    child.stderr?.off('data', onStderr);
    child.stderr?.off('error', onStderr);
  }
}

async function withCodexConfigWire({
  spawn, argv, wrapperPath, codexAnchorPath, cwd, env = {},
  eofGraceMs = DEFAULT_EOF_GRACE_MS, disposeGraceMs = DEFAULT_DISPOSE_GRACE_MS,
  signal, requestTimeoutMs,
}, run) {
  signal?.throwIfAborted();
  const child = spawn({
    argv: argv ?? resolveCodexAppServerArgv({ wrapperPath, codexAnchorPath }),
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: disposeGraceMs,
    env,
  });
  const processExit = child.done.then(() => {
    throw new Error('subagent-codex: app-server exited during config synchronization');
  });
  processExit.catch(() => {});
  const onStderrError = () => {};
  let wire;
  try {
    child.stderr?.on('error', onStderrError);
    child.stderr?.resume();
    if (!child.stdin || !child.stdout) {
      throw new Error('subagent-codex: subprocess dropped piped stdio streams');
    }
    wire = createCodexWire({ stdin: child.stdin, stdout: child.stdout, requestTimeoutMs });
    await Promise.race([wire.initialize({ signal }), processExit]);
    return await run(wire);
  } finally {
    try {
      await disposeCodexChild(wire, child, {
        eofGraceMs: Math.min(eofGraceMs, 250),
        disposeGraceMs: Math.min(disposeGraceMs, 2000),
      });
    } finally {
      child.stderr?.off('error', onStderrError);
    }
  }
}

function configModelSettings(cfg) {
  const model = cfg?.config?.model;
  const effort = cfg?.config?.model_reasoning_effort;
  return {
    model: (typeof model === 'string' && model.trim()) || null,
    reasoningEffort: (typeof effort === 'string' && effort.trim()) || null,
  };
}

function normalizeCatalogModel(entry) {
  return {
    id: String(entry.id ?? entry.model),
    model: String(entry.model ?? entry.id),
    displayName: (typeof entry.displayName === 'string' && entry.displayName.trim()) || String(entry.model ?? entry.id),
    description: typeof entry.description === 'string' ? entry.description.trim() : '',
    isDefault: Boolean(entry.isDefault),
    defaultReasoningEffort: (typeof entry.defaultReasoningEffort === 'string' && entry.defaultReasoningEffort.trim()) || null,
    supportedReasoningEfforts: Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.map((opt) => typeof opt === 'string'
        ? { reasoningEffort: opt.trim(), description: '' }
        : {
            reasoningEffort: typeof opt?.reasoningEffort === 'string' ? opt.reasoningEffort.trim() : '',
            description: typeof opt?.description === 'string' ? opt.description.trim() : '',
          }).filter((opt) => opt.reasoningEffort.length > 0)
      : [],
  };
}

function isRateLimitObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProPlanWithoutFiveHourLimit(planType) {
  return ['pro', 'prolite', 'promax', 'edu_pro'].includes(planType?.trim().toLowerCase());
}

function roundPercent(num) {
  const clamped = Math.max(0, Math.min(100, num));
  return Math.round(clamped * 10) / 10;
}

function normalizeRateLimitWindow(win) {
  if (!isRateLimitObject(win) || !Number.isFinite(win.usedPercent)) return null;

  const usedPercent = roundPercent(win.usedPercent);
  const remainingPercent = roundPercent(100 - usedPercent);
  const windowDurationMins = Number.isInteger(win.windowDurationMins) && win.windowDurationMins > 0
    ? win.windowDurationMins : null;
  const resetsAt = Number.isFinite(win.resetsAt) && win.resetsAt > 0 ? Math.floor(win.resetsAt) : null;
  let kind = 'window';
  if (windowDurationMins === 300) kind = 'five_hour';
  else if (windowDurationMins === 10080) kind = 'weekly';
  else if (windowDurationMins === 1440) kind = 'daily';
  return { kind, usedPercent, remainingPercent, windowDurationMins, resetsAt };
}

function normalizeCreditsSnapshot(credits) {
  if (!isRateLimitObject(credits)) return null;

  const { balance } = credits;
  const balanceText = typeof balance === 'string' ? balance.trim() : Number.isFinite(balance) ? String(balance) : '';
  return {
    hasCredits: Boolean(credits.hasCredits),
    unlimited: Boolean(credits.unlimited),
    balance: balanceText.slice(0, 64) || null,
  };
}

function emptyRateLimitsSnapshot(error = null) {
  return {
    available: false,
    planType: null,
    ordinaryUsageAllowed: null,
    windows: [],
    credits: null,
    spendControlReached: null,
    rateLimitReachedType: null,
    updatedAt: null,
    error,
  };
}

function normalizeRateLimitsResponse(response) {
  const byLimitId = response?.rateLimitsByLimitId;
  const bucket = isRateLimitObject(byLimitId?.codex) ? byLimitId.codex
    : isRateLimitObject(response?.rateLimits) ? response.rateLimits
    : Object.values(byLimitId ?? {}).find(isRateLimitObject);
  if (!bucket) return emptyRateLimitsSnapshot('Invalid rate limits response');

  const planType = typeof bucket.planType === 'string' ? bucket.planType.trim().toLowerCase() || null : null;
  let windows = [bucket.primary, bucket.secondary].map(normalizeRateLimitWindow).filter(Boolean);
  if (isProPlanWithoutFiveHourLimit(planType)) {
    if (windows.length > 1 && windows.some((window) => window.kind !== 'five_hour')) {
      windows = windows.filter((window) => window.kind !== 'five_hour');
    }
    if (windows.length === 1 && windows[0].windowDurationMins === null) windows[0].kind = 'weekly';
  }
  windows.sort((a, b) => (a.windowDurationMins ?? Number.POSITIVE_INFINITY) - (b.windowDurationMins ?? Number.POSITIVE_INFINITY));

  return {
    available: true,
    planType,
    ordinaryUsageAllowed: typeof response?.ordinaryUsageAllowed === 'boolean' ? response.ordinaryUsageAllowed : null,
    windows,
    credits: normalizeCreditsSnapshot(bucket.credits),
    spendControlReached: typeof bucket.spendControlReached === 'boolean' ? bucket.spendControlReached : null,
    rateLimitReachedType: typeof bucket.rateLimitReachedType === 'string' ? bucket.rateLimitReachedType.trim() || null : null,
    updatedAt: new Date().toISOString(),
    error: null,
  };
}

async function readCodexRateLimits(wire, options) {
  try {
    const rlTimeoutMs = Math.min(options.requestTimeoutMs ?? 30_000, 10_000);
    const requestOptions = { signal: options.signal, timeoutMs: rlTimeoutMs };
    let response;
    try {
      response = await wire.readAccountRateLimits({ excludeResetCreditDetails: true }, requestOptions);
    } catch (error) {
      if (!(error instanceof CodexRpcError) || (error.code !== -32602 && error.code !== -32600)) throw error;
      response = await wire.readAccountRateLimits({}, requestOptions);
    }
    return normalizeRateLimitsResponse(response);
  } catch (error) {
    return emptyRateLimitsSnapshot(sanitizeRpcErrorMessage(error));
  }
}

export async function readCodexConfigAndModels(options = {}) {
  const { signal } = options;
  try {
    return await withCodexConfigWire(options, async (wire) => {
      const [{ cfg, configError }, { models, catalogError }, rateLimits] = await Promise.all([
        (async () => {
          try {
            const cfg = await wire.readConfig({ includeLayers: false }, { signal });
            return { cfg, configError: null };
          } catch (error) {
            return { cfg: undefined, configError: sanitizeRpcErrorMessage(error) };
          }
        })(),
        (async () => {
          try {
            const models = [];
            let cursor;
            for (let page = 0; page < 10 && models.length < 200; page += 1) {
              const result = await wire.listModels({ includeHidden: false, ...(cursor ? { cursor } : {}) }, { signal });
              if (!Array.isArray(result.data)) throw new Error('model/list response must contain a data array');
              for (const entry of result.data) {
                if (!entry || entry.hidden === true || (entry.id == null && entry.model == null)) continue;
                models.push(normalizeCatalogModel(entry));
                if (models.length === 200) break;
              }
              cursor = result.nextCursor;
              if (!cursor) break;
            }
            return { models, catalogError: null };
          } catch (error) {
            return { models: [], catalogError: sanitizeRpcErrorMessage(error) };
          }
        })(),
        readCodexRateLimits(wire, options),
      ]);
      const { model, reasoningEffort } = configModelSettings(cfg);
      const catalogDefaultModel = models.find((entry) => entry.isDefault)?.model ?? models[0]?.model ?? null;
      const matchedModel = models.find((entry) => entry.model.toLowerCase() === (model ?? catalogDefaultModel ?? '').toLowerCase());
      return {
        synced: configError === null,
        model,
        reasoningEffort,
        catalogDefaultModel,
        catalogDefaultReasoningEffort: matchedModel?.defaultReasoningEffort ?? null,
        models,
        catalogAvailable: catalogError === null,
        ...(catalogError === null ? {} : { catalogError }),
        error: configError ?? catalogError,
        rateLimits,
      };
    });
  } catch (error) {
    const message = cleanDiagnosticText(toError(error).message);
    return {
      synced: false,
      model: null,
      reasoningEffort: null,
      catalogDefaultModel: null,
      catalogDefaultReasoningEffort: null,
      models: [],
      catalogAvailable: false,
      error: message,
      rateLimits: emptyRateLimitsSnapshot(message),
    };
  }
}

export async function writeCodexUserConfig(options = {}) {
  const { signal, model, reasoningEffort } = options;
  const edits = [];
  if (model !== undefined) edits.push({ keyPath: 'model', value: model, mergeStrategy: 'replace' });
  if (reasoningEffort !== undefined) edits.push({ keyPath: 'model_reasoning_effort', value: reasoningEffort, mergeStrategy: 'replace' });
  return withCodexConfigWire(options, async (wire) => {
    const writeRes = await wire.batchWriteConfig({ edits }, { signal });
    const cfg = await wire.readConfig({ includeLayers: false }, { signal });
    return {
      status: writeRes.status ?? 'ok',
      overridden: Boolean(writeRes.overriddenMetadata || writeRes.status === 'okOverridden'),
      overriddenMessage: typeof writeRes.overriddenMetadata?.message === 'string' ? writeRes.overriddenMetadata.message : null,
      ...configModelSettings(cfg),
    };
  });
}

/**
 * Opt-in warm `app-server` worker pool keyed by persistent `threadId`.
 * Disabled by default (`idleMs = 0`). When enabled (`idleMs > 0`), reuses
 * initialized workers across consecutive turns with matching config signature,
 * evicting cleanly on idle timeout, config mismatch, LRU overflow, close, or shutdown.
 */
export function createWarmCodexPool({
  idleMs = 0,
  maxWorkers = 8,
} = {}) {
  const normalizedIdleMs = Number.isFinite(idleMs) && idleMs > 0 ? Math.floor(idleMs) : 0;
  const normalizedMax = Number.isInteger(maxWorkers) && maxWorkers > 0 ? maxWorkers : 8;
  const pool = new Map();
  const inFlightEvictions = new Map();
  const failedEvictions = new Map();
  let disposed = false;

  const trackEviction = (threadId, worker) => {
    const tracked = worker.disposeProcess().then(
      () => {
        if (failedEvictions.get(threadId) === worker) {
          failedEvictions.delete(threadId);
        }
      },
      (error) => {
        // Record unconfirmed tree teardown; NEVER clear solely on root `child.done`.
        // Only an explicit confirmed full-tree exit clears this gate.
        failedEvictions.set(threadId, worker);
        throw error;
      },
    ).finally(() => {
      if (inFlightEvictions.get(threadId) === tracked) {
        inFlightEvictions.delete(threadId);
      }
    });
    // Prevent unhandled rejection when eviction was started in the background (idle timer / LRU).
    tracked.catch(() => {});
    inFlightEvictions.set(threadId, tracked);
    return tracked;
  };

  const clearEntry = (threadId) => {
    const entry = pool.get(threadId);
    if (!entry) return undefined;
    pool.delete(threadId);
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    return entry;
  };

  const assertPriorEvictionCleared = async (threadId) => {
    const pending = inFlightEvictions.get(threadId);
    if (pending) {
      await pending;
    }
    const stuckWorker = failedEvictions.get(threadId);
    if (stuckWorker) {
      // Re-attempt full process-tree termination and only clear when the entire tree confirms exit.
      stuckWorker.child.terminate();
      const exited = await waitForTreeExitWithin(stuckWorker.child, DEFAULT_DISPOSE_GRACE_MS);
      if (exited) {
        failedEvictions.delete(threadId);
        return;
      }
      throw new CodexRunFailure({
        stage: 'teardown',
        category: 'timeout',
        code: 'CODEX_THREAD_STORAGE_UNAVAILABLE',
      }, new Error(`subagent-codex: warm worker for thread "${threadId}" has not confirmed process-tree exit; refusing concurrent archive/spawn`));
    }
  };

  const evict = async (threadId) => {
    const entry = clearEntry(threadId);
    if (entry) {
      await trackEviction(threadId, entry.worker);
      return;
    }
    await assertPriorEvictionCleared(threadId);
  };

  const parkWorker = (worker) => {
    if (disposed || normalizedIdleMs <= 0 || !worker?.threadId) {
      return false;
    }
    const existing = clearEntry(worker.threadId);
    if (existing) {
      void trackEviction(worker.threadId, existing.worker);
    }
    while (pool.size >= normalizedMax) {
      const oldestKey = pool.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = clearEntry(oldestKey);
      if (oldest) {
        void trackEviction(oldestKey, oldest.worker);
      }
    }
    const entry = {
      worker,
      idleTimer: undefined,
    };
    entry.idleTimer = setTimeout(() => {
      void evict(worker.threadId).catch(() => {});
    }, normalizedIdleMs);
    entry.idleTimer.unref?.();
    pool.set(worker.threadId, entry);

    // If the parked child exits unexpectedly while idle, evict its entry right away.
    worker.child.done.then(() => {
      if (pool.get(worker.threadId) === entry) {
        clearEntry(worker.threadId);
        void worker.disposeProcess().catch(() => {});
      }
    }, () => {
      if (pool.get(worker.threadId) === entry) {
        clearEntry(worker.threadId);
        void worker.disposeProcess().catch(() => {});
      }
    });
    return true;
  };

  const discardWorker = async (threadId, worker) => {
    const existing = pool.get(threadId);
    if (existing?.worker === worker) {
      clearEntry(threadId);
    }
    await trackEviction(threadId, worker);
  };

  const acquireWorker = async (threadId, expectedSignature) => {
    if (disposed || normalizedIdleMs <= 0) return undefined;
    await assertPriorEvictionCleared(threadId);
    const entry = clearEntry(threadId);
    if (!entry) return undefined;
    if (entry.worker.signature !== expectedSignature || entry.worker.getProcessFailureFacts() !== undefined) {
      await trackEviction(threadId, entry.worker);
      return undefined;
    }
    return entry.worker;
  };

  const evictParked = () => {
    const tasks = [];
    for (const threadId of [...pool.keys()]) {
      const entry = clearEntry(threadId);
      if (entry) {
        tasks.push(trackEviction(threadId, entry.worker));
      }
    }
    return tasks;
  };

  const evictAll = async () => {
    await Promise.allSettled(evictParked());
  };

  const disposeAll = async () => {
    disposed = true;
    evictParked();
    const tasks = [...inFlightEvictions.values()];
    const results = await Promise.allSettled(tasks);
    for (const threadId of [...failedEvictions.keys()]) {
      try {
        await assertPriorEvictionCleared(threadId);
      } catch {
        // Keep failedEvictions entry so caller knows shutdown teardown did not confirm exit.
      }
    }
    const allFulfilled = results.every((r) => r.status === 'fulfilled');
    return { ok: allFulfilled && failedEvictions.size === 0 };
  };

  return {
    isEnabled: () => !disposed && normalizedIdleMs > 0,
    isDisposed: () => disposed,
    acquireWorker,
    discardWorker,
    parkWorker,
    evict,
    evictAll,
    disposeAll,
    stats: () => ({
      enabled: !disposed && normalizedIdleMs > 0,
      idleMs: normalizedIdleMs,
      activeWarmWorkers: pool.size,
      threadIds: [...pool.keys()],
    }),
  };
}
