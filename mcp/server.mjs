import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  CODEX_PERMISSION_MODES,
  CODEX_SANDBOX_MODES,
  CodexRunFailure,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_EOF_GRACE_MS,
  archiveCodexThread,
  compactCodexThread,
  createWarmCodexPool,
  forkCodexThread,
  probeCodexThread,
  readCodexConfigAndModels,
  resolveThreadPermissionParams,
  startCodexRun,
  writeCodexUserConfig,
} from './codex-client.mjs';
import { createDiskJobStore, resolveIsolatedJobsDir } from './disk-job-store.mjs';
import {
  assertUsableCwd,
  resolveAccessibleCwd,
  validateLocalImages,
} from './local-path-guard.mjs';
import {
  CODEX_ERROR_CODES,
  CodexSessionError,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_TTL_MS,
  openCodexSessionStore,
  validateSessionKey,
  validateThreadId,
} from './session-store.mjs';
import { spawnSubprocess } from './subprocess-adapter.mjs';

const SERVER_NAME = 'codex-subagent';
const SERVER_VERSION = '0.5.0';
const DEFAULT_MODEL = undefined;
const PROTOCOL_FALLBACK_VERSION = '2024-11-05';
const SETTINGS_RESOURCE_URI = 'ui://codex-subagent/settings.html';
const SETTINGS_RESOURCE_MIME = 'text/html;profile=mcp-app';
const MAX_SETTINGS_HTML_BYTES = 10 * 1024 * 1024;
const SETTINGS_LIMITS = Object.freeze({ maxModelLength: 128 });
const EMPTY_RATE_LIMITS = {
  available: false,
  planType: null,
  ordinaryUsageAllowed: null,
  windows: [],
  credits: null,
  spendControlReached: null,
  rateLimitReachedType: null,
  updatedAt: null,
  error: null,
};
const RATE_LIMIT_KINDS = new Set(['five_hour', 'weekly', 'daily', 'window']);
const PLAN_TYPE_PATTERN = /^[a-z0-9_-]{1,48}$/i;
const RATE_LIMIT_REACHED_PATTERN = /^[a-z0-9_-]{1,64}$/i;
const MODEL_PATTERN = /^[^\s\p{Cc}\p{Cf}]{1,128}$/u;
const REASONING_EFFORT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const DEFAULT_WAIT_MS = 120_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 150_000;
const JOB_TTL_MS = 30 * 60 * 1000;
const STALE_TEMP_FILE_MS = 5 * 60 * 1000;
const STARTUP_PRUNE_BUDGET_MS = 15_000;
const PROGRESS_THROTTLE_MS = 1_000;
const MAX_OUTPUT_SCHEMA_BYTES = 65_536;
const DEFAULT_WARM_IDLE_MS = 0;
const MAX_RECENT_ACTIVITIES = 5;
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOOL_PARAM_KEYS = new Set([
  'description',
  'prompt',
  'cwd',
  'sessionKey',
  'threadId',
  'targetSessionKey',
  'lastTurnId',
  'action',
  'model',
  'permissionMode',
  'sandbox',
  'images',
  'outputSchema',
  'waitMs',
  'reasoningEffort',
]);

const WAIT_PARAM_KEYS = new Set(['jobId', 'waitMs', 'cancel', 'steer', 'images']);

const SUBAGENT_CODEX_TOOL = Object.freeze({
  name: 'subagent_codex',
  description:
    'Delegate a self-contained coding or analysis task to an independent Codex subagent over the official Codex app-server protocol, with optional cross-turn thread persistence (`sessionKey` / `threadId`), sandbox & permission controls (`sandbox` / `permissionMode`), local image inputs (`images`), JSON Schema `outputSchema`, live progress telemetry & background wait/polling (`waitMs` + `subagent_codex_wait`), context compaction (`action: "compact"`), thread branching (`action: "fork"`), or archiving an owned thread (`action: "close"`).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['cwd'],
    properties: {
      description: {
        type: 'string',
        description:
          'A short (3-5 word) description of the delegated task, for display. Required when action is "run"; optional when action is "close", "compact", or "fork".',
      },
      prompt: {
        type: 'string',
        description:
          'Complete task instructions when action is "run". Optional (or "") when action is "close", "compact", or "fork".',
      },
      cwd: {
        type: 'string',
        description: 'Absolute local path to the working directory for the Codex run.',
      },
      sessionKey: {
        type: 'string',
        description:
          'Optional task-scoped key (^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$) to create, resume, compact, fork, or close a persistent Codex thread in the same cwd.',
      },
      threadId: {
        type: 'string',
        description: 'Optional owned Codex thread UUID to resume, compact, fork, or close.',
      },
      targetSessionKey: {
        type: 'string',
        description: 'Required when action is "fork": new sessionKey for the forked persistent thread.',
      },
      lastTurnId: {
        type: 'string',
        description: 'Optional when action is "fork": inclusive last turnId to fork through.',
      },
      action: {
        type: 'string',
        enum: ['run', 'close', 'compact', 'fork'],
        default: 'run',
        description:
          'Operation to perform: "run" (default), "compact" (compress long thread context in place), "fork" (branch thread into targetSessionKey), or "close" (archive and unregister a persistent thread).',
      },
      model: {
        type: 'string',
        description: 'Optional Codex model override (defaults to prior session model on resume, else CODEX_MODEL env setting or ~/.codex/config.toml default).',
      },
      permissionMode: {
        type: 'string',
        enum: CODEX_PERMISSION_MODES,
        description:
          'Optional Codex approval/sandbox mode override ("never", "read-only", "approve-for-me", "dangerously-bypass-approvals-and-sandbox").',
      },
      sandbox: {
        type: 'string',
        enum: CODEX_SANDBOX_MODES,
        description:
          'Optional protocol-level Codex sandbox override ("read-only", "workspace-write", "danger-full-access").',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of up to 10 local image file paths (.png, .jpg, .jpeg, .webp, .gif; <= 20MB each; relative to cwd or absolute) attached to the turn as localImage inputs.',
      },
      outputSchema: {
        type: 'object',
        description: 'Optional JSON Schema object constraining Codex final output (only valid when action is "run").',
      },
      waitMs: {
        type: 'number',
        description:
          'Maximum milliseconds to wait synchronously before returning status="running" with a jobId and live telemetry for subagent_codex_wait (default 120000, clamped to 1000..150000).',
      },
      reasoningEffort: {
        type: 'string',
        enum: REASONING_EFFORTS,
        description: 'Optional reasoning effort override ("low", "medium", "high", "xhigh").',
      },
    },
  },
});

const SUBAGENT_CODEX_WAIT_TOOL = Object.freeze({
  name: 'subagent_codex_wait',
  description:
    'Wait for, steer, or cancel a background Codex subagent job started by `subagent_codex` when it returned `status: "running"` with a `jobId` (including recovering unclaimed settled jobs across MCP server restarts within 30 minutes).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['jobId'],
    properties: {
      jobId: {
        type: 'string',
        description: 'The jobId returned by `subagent_codex` (or `subagent_codex_wait`).',
      },
      waitMs: {
        type: 'number',
        description:
          'Maximum milliseconds to wait before returning status="running" again (default 120000, clamped to 1000..150000).',
      },
      cancel: {
        type: 'boolean',
        description: 'Set true to abort and clean up the background Codex run.',
      },
      steer: {
        type: 'string',
        description: 'Optional steering instruction injected into the currently active turn via turn/steer (cannot be combined with cancel: true).',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional local image paths attached to a steer message (only valid when steer is provided).',
      },
    },
  },
});

const LIST_SESSIONS_TOOL = Object.freeze({
  name: 'subagent_codex_list_sessions',
  description:
    'List persistent Codex subagent threads and any active or unclaimed background Codex jobs (with live telemetry) in the Antigravity codex-subagent registry.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
});

const SETTINGS_RESOURCE = {
  uri: SETTINGS_RESOURCE_URI,
  name: 'Codex Subagent Settings',
  description: 'Configure default Codex model and reasoning effort synced with ~/.codex/config.toml.',
  mimeType: SETTINGS_RESOURCE_MIME,
  _meta: { ui: { prefersBorder: false } },
};

const SUBAGENT_CODEX_SETTINGS_TOOL = {
  name: 'subagent_codex_settings',
  description: 'Open the Codex Subagent default model and reasoning effort settings panel.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  _meta: {
    ui: { resourceUri: SETTINGS_RESOURCE_URI },
    'com.google.antigravity/ui': {
      entrypoints: [{ type: 'global', title: 'Codex Subagent' }],
    },
  },
};

function appTool(name, description, properties) {
  return {
    name, description,
    inputSchema: { type: 'object', additionalProperties: false, properties },
    _meta: { ui: { visibility: ['app'] } },
  };
}

const SETTINGS_APP_TOOLS = [
  appTool('codex_ui_get_settings', 'Get Codex default model and reasoning effort settings.', {
    syncCodex: { type: 'boolean' },
  }),
  appTool('codex_ui_update_settings', 'Update Codex default model and reasoning effort settings.', {
    reset: { type: 'boolean' },
    codex: {
      type: 'object', additionalProperties: false,
      properties: { model: { type: ['string', 'null'] }, reasoningEffort: { type: ['string', 'null'] } },
    },
  }),
];

function uiResult(structuredContent, text = 'ok') {
  return { content: [{ type: 'text', text }], structuredContent };
}

function redactSecrets(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

function validateSettingsArgs(args, name, keys) {
  if (!isPlainObject(args) || Object.getPrototypeOf(args) !== Object.prototype) {
    throw new Error(name + ': arguments must be a plain object');
  }
  for (const key of Object.keys(args)) {
    if (!keys.includes(key)) throw new Error(name + ': unknown argument "' + key + '"');
  }
}

function validateCodexSettingsPatch(patch, allowedEfforts) {
  const name = 'codex_ui_update_settings';
  validateSettingsArgs(patch, name, ['reset', 'codex']);
  const { reset, codex } = patch;
  if (reset !== undefined && typeof reset !== 'boolean') throw new Error(name + ': reset must be a boolean');
  if (codex === undefined) return { reset };
  validateSettingsArgs(codex, name + '.codex', ['model', 'reasoningEffort']);
  const normalized = {};
  for (const [key, value] of Object.entries(codex)) {
    if (value !== null && typeof value !== 'string') throw new Error(name + ': ' + key + ' must be a string or null');
    const trimmed = value?.trim() || null;
    if (trimmed !== null && !(key === 'model' ? MODEL_PATTERN.test(trimmed) : allowedEfforts.has(trimmed))) {
      throw new Error(name + ': invalid ' + key);
    }
    normalized[key] = trimmed;
  }
  return { reset, codex: normalized };
}

function logError(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${SERVER_NAME}: ${name} must be a positive finite number (got ${JSON.stringify(raw)})`);
  }
  return Math.floor(parsed);
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${SERVER_NAME}: ${name} must be a non-negative finite number (got ${JSON.stringify(raw)})`);
  }
  return Math.floor(parsed);
}

function clampWaitMs(value, label = 'waitMs') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${SERVER_NAME}: ${label} must be a positive finite number`);
  }
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.floor(value)));
}

function buildChildEnv() {
  const env = {};
  const passthroughKeys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'CODEX_HOME',
  ];
  for (const key of passthroughKeys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim() !== '') {
      env[key] = value;
    }
  }
  return env;
}

function formatTextOutput(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function formatUsageSummary(usage) {
  const used = usage?.totalTokens;
  const window = usage?.modelContextWindow;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
    const ratio = used / window;
    const pctNum = Math.floor(ratio * 1000 + 1e-9) / 10;
    const pctStr = Number.isInteger(pctNum) ? String(pctNum) : pctNum.toFixed(1);
    return {
      used,
      window,
      ratio,
      pct: pctNum,
      pctText: `${pctStr}%`,
      tokenField: `tokens=${used}/${window} (${pctStr}%)`,
      warning: ratio >= 0.8
        ? `[CONTEXT_WARNING] Context window usage is at ${pctStr}% (${used}/${window} tokens). Consider compacting with action: "compact" or starting a fresh sessionKey.`
        : null,
    };
  }
  return {
    used,
    window: null,
    ratio: null,
    pct: null,
    pctText: null,
    tokenField: null,
    warning: null,
  };
}

function formatToolError(error) {
  const messageText = error instanceof Error ? error.message : String(error);
  const code = error instanceof CodexSessionError || error instanceof CodexRunFailure ? error.code : undefined;
  const codePrefix = code ? `[${code}] ` : '';
  const busyHint =
    code === 'CODEX_THREAD_BUSY' && /active writer/i.test(messageText)
      ? '\nHint: Another client (such as Codex Desktop) or a concurrent call may currently hold this thread.'
      : '';
  return {
    isError: true,
    content: [{ type: 'text', text: `${codePrefix}${messageText}${busyHint}` }],
  };
}

function delay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted')),
    );
  }
  return new Promise((resolve, reject) => {
    let timer;
    let onAbort;
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    if (signal) {
      onAbort = () => {
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted')));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function validateSubagentArgs(args, defaults) {
  if (!isPlainObject(args)) {
    throw new Error('subagent_codex: arguments must be a plain object');
  }
  for (const key of Object.keys(args)) {
    if (!TOOL_PARAM_KEYS.has(key)) {
      throw new Error(`subagent_codex: unknown argument "${key}"`);
    }
  }
  if (typeof args.cwd !== 'string') {
    throw new Error('subagent_codex: "cwd" must be a string');
  }
  for (const opt of [
    'description',
    'prompt',
    'sessionKey',
    'threadId',
    'targetSessionKey',
    'lastTurnId',
    'action',
    'model',
    'permissionMode',
    'sandbox',
    'reasoningEffort',
  ]) {
    if (args[opt] !== undefined && typeof args[opt] !== 'string') {
      throw new Error(`subagent_codex: "${opt}" must be a string`);
    }
  }

  const cwd = assertUsableCwd('cwd', args.cwd);
  const action = args.action ?? 'run';
  if (action !== 'run' && action !== 'close' && action !== 'compact' && action !== 'fork') {
    throw new Error('subagent_codex: "action" must be "run", "close", "compact", or "fork"');
  }

  const sessionKey = args.sessionKey === undefined ? undefined : validateSessionKey(args.sessionKey);
  const threadId = args.threadId === undefined ? undefined : validateThreadId(args.threadId);

  let description;
  let prompt;
  let images = [];
  let outputSchema;
  let targetSessionKey;
  let lastTurnId;

  if (action === 'run') {
    if (args.targetSessionKey !== undefined) {
      throw new Error('subagent_codex: "targetSessionKey" is only allowed when action is "fork"');
    }
    if (args.lastTurnId !== undefined) {
      throw new Error('subagent_codex: "lastTurnId" is only allowed when action is "fork"');
    }
    if (typeof args.description !== 'string' || !args.description.trim()) {
      throw new Error('subagent_codex: "description" must be a non-empty string when action is "run"');
    }
    if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
      throw new Error('subagent_codex: "prompt" must be non-empty when action is "run"');
    }
    description = args.description.trim();
    prompt = args.prompt;
    images = validateLocalImages(args.images, cwd);
    if (args.outputSchema !== undefined) {
      if (!isPlainObject(args.outputSchema)) {
        throw new Error('subagent_codex: "outputSchema" must be a JSON Schema object');
      }
      const serialized = JSON.stringify(args.outputSchema);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTPUT_SCHEMA_BYTES) {
        throw new Error(`subagent_codex: "outputSchema" exceeds maximum size of ${MAX_OUTPUT_SCHEMA_BYTES} bytes`);
      }
      outputSchema = args.outputSchema;
    }
  } else {
    if (args.outputSchema !== undefined) {
      throw new Error('subagent_codex: "outputSchema" is only allowed when action is "run"');
    }
    if (args.prompt !== undefined && args.prompt !== '') {
      throw new Error(`subagent_codex: "prompt" must be "" or omitted when action is "${action}"`);
    }
    if (args.images !== undefined) {
      throw new Error(`subagent_codex: "images" is not allowed when action is "${action}"`);
    }
    if (sessionKey === undefined && threadId === undefined) {
      throw new Error(`subagent_codex: action "${action}" requires sessionKey or threadId`);
    }
    if (action === 'fork') {
      if (args.targetSessionKey === undefined) {
        throw new Error('subagent_codex: action "fork" requires "targetSessionKey"');
      }
      targetSessionKey = validateSessionKey(args.targetSessionKey);
      if (args.lastTurnId !== undefined) {
        if (!args.lastTurnId.trim()) {
          throw new Error('subagent_codex: "lastTurnId" must be a non-empty string when provided');
        }
        lastTurnId = args.lastTurnId.trim();
      }
      description = args.description && args.description.trim() ? args.description.trim() : 'Fork Codex session';
    } else {
      if (args.targetSessionKey !== undefined) {
        throw new Error('subagent_codex: "targetSessionKey" is only allowed when action is "fork"');
      }
      if (args.lastTurnId !== undefined) {
        throw new Error('subagent_codex: "lastTurnId" is only allowed when action is "fork"');
      }
      description =
        args.description && args.description.trim()
          ? args.description.trim()
          : action === 'compact'
            ? 'Compact Codex session'
            : 'Close Codex session';
    }
    prompt = '';
  }

  let explicitModel;
  if (args.model !== undefined) {
    if (!args.model.trim()) {
      throw new Error('subagent_codex: "model" must be non-empty when provided');
    }
    explicitModel = args.model.trim();
  }

  let permissionMode = defaults.permissionMode;
  if (args.permissionMode !== undefined) {
    if (!CODEX_PERMISSION_MODES.includes(args.permissionMode)) {
      throw new Error(`subagent_codex: "permissionMode" must be one of ${CODEX_PERMISSION_MODES.join(', ')}`);
    }
    permissionMode = args.permissionMode;
  }

  let sandbox = defaults.sandbox;
  if (args.sandbox !== undefined) {
    if (!CODEX_SANDBOX_MODES.includes(args.sandbox)) {
      throw new Error(`subagent_codex: "sandbox" must be one of ${CODEX_SANDBOX_MODES.join(', ')}`);
    }
    sandbox = args.sandbox;
  }

  // Validate permissionMode + sandbox compatibility upfront before acquiring any lease.
  resolveThreadPermissionParams(permissionMode, sandbox);

  let reasoningEffort = defaults.reasoningEffort;
  if (args.reasoningEffort !== undefined) {
    if (!REASONING_EFFORTS.includes(args.reasoningEffort)) {
      throw new Error(`subagent_codex: "reasoningEffort" must be one of ${REASONING_EFFORTS.join(', ')}`);
    }
    reasoningEffort = args.reasoningEffort;
  }

  const waitMs =
    args.waitMs === undefined ? defaults.waitMs : clampWaitMs(args.waitMs, 'subagent_codex waitMs');

  return {
    description,
    prompt,
    images,
    outputSchema,
    cwd,
    action,
    sessionKey,
    threadId,
    targetSessionKey,
    lastTurnId,
    explicitModel,
    model: explicitModel ?? defaults.model,
    permissionMode,
    sandbox,
    reasoningEffort,
    waitMs,
  };
}

function validateWaitArgs(args, defaults) {
  if (!isPlainObject(args)) {
    throw new Error('subagent_codex_wait: arguments must be a plain object');
  }
  for (const key of Object.keys(args)) {
    if (!WAIT_PARAM_KEYS.has(key)) {
      throw new Error(`subagent_codex_wait: unknown argument "${key}"`);
    }
  }
  if (typeof args.jobId !== 'string' || !args.jobId.trim()) {
    throw new Error('subagent_codex_wait: "jobId" must be a non-empty string');
  }
  if (args.cancel !== undefined && typeof args.cancel !== 'boolean') {
    throw new Error('subagent_codex_wait: "cancel" must be a boolean');
  }
  if (args.steer !== undefined && (typeof args.steer !== 'string' || !args.steer.trim())) {
    throw new Error('subagent_codex_wait: "steer" must be a non-empty string when provided');
  }
  if (args.cancel === true && args.steer !== undefined) {
    throw new Error('subagent_codex_wait: "steer" cannot be combined with "cancel": true');
  }
  if (args.images !== undefined) {
    if (args.steer === undefined) {
      throw new Error('subagent_codex_wait: "images" is only allowed when "steer" is provided');
    }
    if (!Array.isArray(args.images)) {
      throw new Error('subagent_codex_wait: "images" must be an array of local image file paths');
    }
  }
  const waitMs =
    args.waitMs === undefined ? defaults.waitMs : clampWaitMs(args.waitMs, 'subagent_codex_wait waitMs');

  return {
    jobId: args.jobId.trim(),
    waitMs,
    cancel: args.cancel === true,
    steer: args.steer,
    images: args.images,
  };
}

function loadConfig() {
  const rawModel = process.env.CODEX_MODEL;
  const model = rawModel === undefined ? DEFAULT_MODEL : (rawModel.trim() || undefined);

  const permissionMode = process.env.CODEX_PERMISSION_MODE?.trim() || DEFAULT_CODEX_PERMISSION_MODE;
  if (!CODEX_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`${SERVER_NAME}: CODEX_PERMISSION_MODE must be one of ${CODEX_PERMISSION_MODES.join(', ')}`);
  }

  const sandbox = process.env.CODEX_SANDBOX?.trim() || undefined;
  if (sandbox !== undefined && !CODEX_SANDBOX_MODES.includes(sandbox)) {
    throw new Error(`${SERVER_NAME}: CODEX_SANDBOX must be one of ${CODEX_SANDBOX_MODES.join(', ')}`);
  }
  resolveThreadPermissionParams(permissionMode, sandbox);

  const rawEffort = process.env.CODEX_REASONING_EFFORT?.trim() || undefined;
  if (rawEffort !== undefined && !REASONING_EFFORTS.includes(rawEffort)) {
    throw new Error(`${SERVER_NAME}: CODEX_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')}`);
  }

  const waitMs = clampWaitMs(parsePositiveIntEnv('CODEX_DEFAULT_WAIT_MS', DEFAULT_WAIT_MS), 'CODEX_DEFAULT_WAIT_MS');
  const eofGraceMs = parsePositiveIntEnv('CODEX_EOF_GRACE_MS', DEFAULT_EOF_GRACE_MS);
  const disposeGraceMs = parsePositiveIntEnv('CODEX_DISPOSE_GRACE_MS', DEFAULT_DISPOSE_GRACE_MS);
  const requestTimeoutMs = parsePositiveIntEnv('CODEX_REQUEST_TIMEOUT_MS', undefined);
  const turnTimeoutMs = parsePositiveIntEnv('CODEX_TURN_TIMEOUT_MS', undefined);
  const ttlMs = parsePositiveIntEnv('CODEX_SESSION_TTL_MS', DEFAULT_TTL_MS);
  const maxSessions = parsePositiveIntEnv('CODEX_MAX_SESSIONS', DEFAULT_MAX_SESSIONS);
  const warmIdleMs = parseNonNegativeIntEnv('CODEX_WARM_IDLE_MS', DEFAULT_WARM_IDLE_MS);

  const storePath = process.env.CODEX_SESSION_STORE_PATH?.trim()
    ? path.resolve(process.env.CODEX_SESSION_STORE_PATH.trim())
    : path.join(pluginRoot, 'data', 'codex-subagent-sessions.json');
  const jobsDir = resolveIsolatedJobsDir(storePath);

  const wrapperPath = process.env.CODEX_WRAPPER_PATH?.trim() || undefined;
  const codexAnchorPath = process.env.CODEX_ANCHOR_PATH?.trim() || undefined;
  const codexHome = process.env.CODEX_HOME?.trim() || undefined;
  const childEnv = buildChildEnv();

  return {
    model,
    permissionMode,
    sandbox,
    reasoningEffort: rawEffort,
    waitMs,
    eofGraceMs,
    disposeGraceMs,
    requestTimeoutMs,
    turnTimeoutMs,
    ttlMs,
    maxSessions,
    warmIdleMs,
    storePath,
    jobsDir,
    wrapperPath,
    codexAnchorPath,
    codexHome,
    childEnv,
  };
}

function notifyJobProgressListeners(job, label) {
  if (!job.progressListeners || job.progressListeners.size === 0) return;
  for (const listener of job.progressListeners) {
    try {
      listener(label);
    } catch {}
  }
}

function phaseFromActivityKind(kind) {
  switch (kind) {
    case 'commandExecution':
      return 'executing';
    case 'fileChange':
      return 'editing';
    case 'mcpToolCall':
      return 'toolCall';
    case 'reasoning':
      return 'thinking';
    case 'plan':
      return 'planning';
    case 'webSearch':
      return 'searching';
    case 'contextCompaction':
      return 'compacting';
    default:
      return 'streaming';
  }
}

function recordJobTelemetry(job, event) {
  if (!isPlainObject(event) || typeof event.type !== 'string') return;
  const nowIso = new Date().toISOString();

  if (event.type === 'turnStarted') {
    const incomingTurnId = typeof event.turnId === 'string' && event.turnId ? event.turnId : null;
    if (incomingTurnId && job.turnId === incomingTurnId) {
      // Idempotent duplicate turn/started for the same turnId: keep active activities intact.
      job.lastActivityMonoMs = performance.now();
      job.lastActivityAt = nowIso;
      return;
    }
    if (incomingTurnId) {
      job.turnId = incomingTurnId;
    }
    job.activeActivities.clear();
    job.phase = null;
    job.lastActivityMonoMs = performance.now();
    job.lastActivityAt = nowIso;
    notifyJobProgressListeners(job, 'turn started');
    return;
  }

  if (event.type === 'heartbeat') {
    if (job.turnId && event.turnId && event.turnId !== job.turnId) return;
    if (typeof event.phase === 'string' && event.phase) {
      job.phase = event.phase;
    }
    job.lastActivityMonoMs = performance.now();
    job.lastActivityAt = nowIso;
    notifyJobProgressListeners(job, job.phase ?? 'running');
    return;
  }

  if (event.type === 'planUpdated') {
    if (job.turnId && event.turnId && event.turnId !== job.turnId) return;
    job.plan = {
      explanation: typeof event.explanation === 'string' ? event.explanation : null,
      steps: Array.isArray(event.steps)
        ? event.steps.map((s) => ({ step: String(s?.step ?? ''), status: String(s?.status ?? 'pending') }))
        : [],
    };
    job.lastActivityMonoMs = performance.now();
    job.lastActivityAt = nowIso;
    notifyJobProgressListeners(job, `plan updated (${job.plan.steps.length} steps)`);
    return;
  }

  if (event.type === 'diffUpdated') {
    if (job.turnId && event.turnId && event.turnId !== job.turnId) return;
    const files = Array.isArray(event.files) ? event.files.map((f) => String(f)) : [];
    const filesChangedCount = typeof event.filesChangedCount === 'number' ? event.filesChangedCount : files.length;
    job.diffSummary = { filesChangedCount, files };
    job.lastActivityMonoMs = performance.now();
    job.lastActivityAt = nowIso;
    notifyJobProgressListeners(job, `diff updated (${filesChangedCount} files)`);
    return;
  }

  if (event.type === 'steered') {
    job.phase = 'steered';
    job.recentActivities.push({ kind: 'steer', phase: 'started', at: nowIso });
    if (job.recentActivities.length > MAX_RECENT_ACTIVITIES) {
      job.recentActivities.splice(0, job.recentActivities.length - MAX_RECENT_ACTIVITIES);
    }
    job.lastActivityMonoMs = performance.now();
    job.lastActivityAt = nowIso;
    notifyJobProgressListeners(job, 'turn steered');
    return;
  }

  if (event.type === 'compacted') {
    job.phase = 'compacted';
    job.recentActivities.push({ kind: 'contextCompaction', phase: 'completed', at: nowIso });
    if (job.recentActivities.length > MAX_RECENT_ACTIVITIES) {
      job.recentActivities.splice(0, job.recentActivities.length - MAX_RECENT_ACTIVITIES);
    }
    job.lastActivityMonoMs = performance.now();
    job.lastActivityAt = nowIso;
    notifyJobProgressListeners(job, 'context compacted');
    return;
  }

  if (event.type === 'activity') {
    if (job.turnId && event.turnId && event.turnId !== job.turnId) return;
    if (typeof event.kind !== 'string' || (event.phase !== 'started' && event.phase !== 'completed')) return;
    const entry = {
      kind: event.kind,
      phase: event.phase,
      at: nowIso,
    };
    if (typeof event.itemId === 'string' && event.itemId) {
      if (event.phase === 'started') {
        job.activeActivities.set(event.itemId, entry);
      } else {
        job.activeActivities.delete(event.itemId);
      }
    }
    if (event.phase === 'started') {
      job.phase = phaseFromActivityKind(event.kind);
    }
    job.recentActivities.push(entry);
    if (job.recentActivities.length > MAX_RECENT_ACTIVITIES) {
      job.recentActivities.splice(0, job.recentActivities.length - MAX_RECENT_ACTIVITIES);
    }
    job.lastActivityMonoMs = performance.now();
    job.lastActivityAt = nowIso;
    notifyJobProgressListeners(job, `${event.kind}:${event.phase}`);
    return;
  }

  if (event.type === 'tokenUsage') {
    if (job.turnId && event.turnId && event.turnId !== job.turnId) return;
    const usage = event.usage;
    if (isPlainObject(usage) && typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
      const summary = formatUsageSummary(usage);
      job.tokenUsage = {
        totalTokens: usage.totalTokens,
        modelContextWindow:
          typeof usage.modelContextWindow === 'number' && Number.isFinite(usage.modelContextWindow)
            ? usage.modelContextWindow
            : null,
        utilizationPct: summary?.pct ?? null,
      };
      job.lastActivityMonoMs = performance.now();
      job.lastActivityAt = nowIso;
      notifyJobProgressListeners(job, summary?.tokenField ?? `tokens=${usage.totalTokens}`);
    }
    return;
  }

  if (event.type === 'unattended-decision') {
    job.lastActivityMonoMs = performance.now();
    job.lastActivityAt = nowIso;
  }
}

function snapshotTelemetry(job) {
  let currentActivity = null;
  for (const value of job.activeActivities.values()) {
    currentActivity = value;
  }
  return {
    turnId: job.turnId,
    phase: job.phase ?? null,
    lastActivityAt: job.lastActivityAt,
    idleMs: Math.max(0, Math.round(performance.now() - job.lastActivityMonoMs)),
    currentActivity: currentActivity ? { ...currentActivity } : null,
    activeCount: job.activeActivities.size,
    recentActivities: job.recentActivities.map((item) => ({ ...item })),
    plan: job.plan
      ? {
          explanation: job.plan.explanation,
          steps: job.plan.steps.map((s) => ({ ...s })),
        }
      : null,
    diffSummary: job.diffSummary
      ? {
          filesChangedCount: job.diffSummary.filesChangedCount,
          files: [...job.diffSummary.files],
        }
      : null,
    tokenUsage: job.tokenUsage ? { ...job.tokenUsage } : null,
  };
}

async function main() {
  const config = loadConfig();
  let codexSnap = {
    synced: false,
    model: null,
    reasoningEffort: null,
    catalogDefaultModel: null,
    catalogDefaultReasoningEffort: null,
    models: [],
    catalogAvailable: false,
    overridden: false,
    overriddenMessage: null,
    error: null,
    rateLimits: { ...EMPTY_RATE_LIMITS, windows: [] },
  };
  let syncPromise = null;
  let codexConfigOverride = null;
  let settingsUpdate = Promise.resolve();
  const codexConfigOptions = (signal) => ({
    spawn: spawnSubprocess,
    cwd: resolveAccessibleCwd(pluginRoot, pluginRoot),
    wrapperPath: config.wrapperPath,
    codexAnchorPath: config.codexAnchorPath,
    env: config.childEnv,
    eofGraceMs: config.eofGraceMs,
    disposeGraceMs: config.disposeGraceMs,
    requestTimeoutMs: config.requestTimeoutMs,
    signal,
  });
  const syncCodexSnapshot = (signal) => {
    if (syncPromise) return syncPromise;
    syncPromise = readCodexConfigAndModels(codexConfigOptions(signal)).then((snapshot) => {
      const { overridden, overriddenMessage } = codexSnap;
      codexSnap = { ...snapshot, overridden, overriddenMessage };
      return codexSnap;
    }).finally(() => { syncPromise = null; });
    return syncPromise;
  };
  // RPC diagnostics and override messages can include paths from Codex layers.
  const pathInText = /(?:\b[a-z]:[\\/]|\\\\|file:\/|(?:^|[\s"'(`=])(?:~?\/|~\\)\S)/i;
  const safeMessage = (message) => message && (pathInText.test(message) ? '[local path redacted]' : redactSecrets(message));
  const safeModel = (model) => (typeof model === 'string' && MODEL_PATTERN.test(model) && safeMessage(model) === model ? model : null);
  const safeEffort = (effort) => (typeof effort === 'string' && REASONING_EFFORT_PATTERN.test(effort) && safeMessage(effort) === effort ? effort : null);
  const safeClampPercent = (value) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const sanitizeRateLimits = (raw) => {
    const updatedAt = typeof raw?.updatedAt === 'string' ? raw.updatedAt : null;
    const error = safeMessage(typeof raw?.error === 'string' ? raw.error : null) ?? null;
    if (!isPlainObject(raw) || raw.available !== true) {
      return { ...EMPTY_RATE_LIMITS, windows: [], updatedAt, error };
    }

    const timestamp = Date.parse(updatedAt);
    const windows = Array.isArray(raw.windows) ? raw.windows.filter(isPlainObject).map((window) => ({
      kind: RATE_LIMIT_KINDS.has(window.kind) ? window.kind : 'window',
      usedPercent: safeClampPercent(window.usedPercent),
      remainingPercent: safeClampPercent(window.remainingPercent),
      windowDurationMins: Number.isInteger(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : null,
      resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
    })) : [];
    const credits = raw.credits;
    return {
      available: true,
      planType: typeof raw.planType === 'string' && PLAN_TYPE_PATTERN.test(raw.planType) ? raw.planType : null,
      ordinaryUsageAllowed: typeof raw.ordinaryUsageAllowed === 'boolean' ? raw.ordinaryUsageAllowed : null,
      windows,
      credits: isPlainObject(credits) ? {
        hasCredits: Boolean(credits.hasCredits),
        unlimited: Boolean(credits.unlimited),
        balance: credits.balance == null ? null : safeMessage(String(credits.balance).slice(0, 64)),
      } : null,
      spendControlReached: typeof raw.spendControlReached === 'boolean' ? raw.spendControlReached : null,
      rateLimitReachedType: typeof raw.rateLimitReachedType === 'string' && RATE_LIMIT_REACHED_PATTERN.test(raw.rateLimitReachedType)
        ? raw.rateLimitReachedType : null,
      updatedAt: Number.isFinite(timestamp) && new Date(timestamp).toISOString() === updatedAt ? updatedAt : null,
      error,
    };
  };
  const buildSettingsPayload = () => {
    const { synced, model, reasoningEffort, catalogDefaultModel, catalogDefaultReasoningEffort, catalogAvailable,
      overridden, overriddenMessage, error } = codexSnap;
    return {
      codexConfig: {
        synced, model: safeModel(model), reasoningEffort: safeEffort(reasoningEffort), catalogDefaultModel: safeModel(catalogDefaultModel),
        catalogDefaultReasoningEffort: safeEffort(catalogDefaultReasoningEffort), catalogAvailable, overridden,
        overriddenMessage: safeMessage(overriddenMessage), error: safeMessage(error),
      },
      defaults: {
        model: safeModel(model ?? catalogDefaultModel ?? config.model),
        reasoningEffort: safeEffort(reasoningEffort ?? catalogDefaultReasoningEffort ?? config.reasoningEffort),
        envModel: safeModel(config.model),
        envReasoningEffort: config.reasoningEffort ?? null,
      },
      effective: {
        model: safeModel(codexConfigOverride?.model ?? config.model ?? model ?? catalogDefaultModel),
        reasoningEffort: safeEffort(codexConfigOverride?.reasoningEffort ?? config.reasoningEffort ?? reasoningEffort ?? catalogDefaultReasoningEffort),
      },
      options: {
        models: codexSnap.models.filter((entry) => safeModel(entry.id) && safeModel(entry.model)).map((entry) => ({
          ...entry,
          displayName: safeMessage(entry.displayName),
          description: safeMessage(entry.description),
          defaultReasoningEffort: safeEffort(entry.defaultReasoningEffort),
          supportedReasoningEfforts: entry.supportedReasoningEfforts
            .filter((option) => safeEffort(option.reasoningEffort))
            .map((option) => ({ ...option, description: safeMessage(option.description) })),
        })),
        reasoningEfforts: [...REASONING_EFFORTS],
      },
      limits: { ...SETTINGS_LIMITS },
      rateLimits: sanitizeRateLimits(codexSnap.rateLimits),
    };
  };
  const runtimeDefaults = () => ({
    model: codexConfigOverride?.model ?? config.model,
    settingsModel: codexConfigOverride?.model,
    reasoningEffort: codexConfigOverride?.reasoningEffort ?? config.reasoningEffort,
  });
  const allowedEffortsSet = () => new Set([
    ...REASONING_EFFORTS,
    ...codexSnap.models.flatMap((model) => model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort))
      .filter((effort) => REASONING_EFFORT_PATTERN.test(effort)),
  ]);
  let settingsHtmlCache;

  const store = await openCodexSessionStore({
    file: config.storePath,
    ttlMs: config.ttlMs,
    maxSessions: config.maxSessions,
  });

  const diskJobs = createDiskJobStore(config.jobsDir, {
    serverName: SERVER_NAME,
    jobTtlMs: JOB_TTL_MS,
    staleTempFileMs: STALE_TEMP_FILE_MS,
    logError,
  });
  diskJobs.sweep();

  const warmPool = createWarmCodexPool({
    idleMs: config.warmIdleMs,
  });

  const updateSettings = async (args, signal) => {
    await syncPromise;
    signal.throwIfAborted();
    const { reset, codex } = validateCodexSettingsPatch(args, allowedEffortsSet());
    if (reset === true) {
      const receipt = await writeCodexUserConfig({ ...codexConfigOptions(signal), model: null, reasoningEffort: null });
      codexConfigOverride = null;
      codexSnap = { ...codexSnap, synced: false, overridden: receipt.overridden, overriddenMessage: receipt.overriddenMessage };
      await warmPool.evictAll();
      await syncCodexSnapshot(signal);
      return;
    }

    if (codex === undefined) return;
    const { model: nextModel, reasoningEffort: nextEffort } = codex;
    if (codexSnap.synced
      && (nextModel === undefined || nextModel === codexSnap.model)
      && (nextEffort === undefined || nextEffort === codexSnap.reasoningEffort)) return;

    const { model, reasoningEffort, overridden, overriddenMessage } = await writeCodexUserConfig({
      ...codexConfigOptions(signal), model: nextModel, reasoningEffort: nextEffort,
    });
    const matchedModel = codexSnap.models.find((entry) => entry.model.toLowerCase()
      === (model ?? codexSnap.catalogDefaultModel ?? '').toLowerCase());
    codexSnap = {
      ...codexSnap, synced: true, model, reasoningEffort, overridden, overriddenMessage, error: null,
      catalogDefaultReasoningEffort: matchedModel?.defaultReasoningEffort ?? null,
    };
    codexConfigOverride = { model, reasoningEffort };
    await warmPool.evictAll();
  };

  const makeArchiveFn = (fallbackCwd, signal) => async ({ threadId, cwd: entryCwd }, callSignal) => {
    const effectiveSignal = callSignal ?? signal;
    await warmPool.evict(threadId);
    return archiveCodexThread({
      spawn: spawnSubprocess,
      wrapperPath: config.wrapperPath,
      codexAnchorPath: config.codexAnchorPath,
      threadId,
      cwd: resolveAccessibleCwd(entryCwd ?? fallbackCwd, pluginRoot),
      env: config.childEnv,
      eofGraceMs: config.eofGraceMs,
      disposeGraceMs: config.disposeGraceMs,
      signal: effectiveSignal,
      codexHome: config.codexHome,
      requestTimeoutMs: config.requestTimeoutMs,
    });
  };

  const makeReadReconcileFn = () => async (row, signal) => {
    try {
      await warmPool.evict(row.threadId);
      await archiveCodexThread({
        spawn: spawnSubprocess,
        wrapperPath: config.wrapperPath,
        codexAnchorPath: config.codexAnchorPath,
        threadId: row.threadId,
        cwd: resolveAccessibleCwd(row.cwd, pluginRoot),
        env: config.childEnv,
        eofGraceMs: config.eofGraceMs,
        disposeGraceMs: config.disposeGraceMs,
        signal,
        codexHome: config.codexHome,
        requestTimeoutMs: config.requestTimeoutMs,
      });
      return 'archived';
    } catch {
      return 'uncertain';
    }
  };

  const makeUncertainReconcileFn = () => async (row, signal) => {
    await warmPool.evict(row.threadId);
    return probeCodexThread({
      spawn: spawnSubprocess,
      wrapperPath: config.wrapperPath,
      codexAnchorPath: config.codexAnchorPath,
      threadId: row.threadId,
      cwd: resolveAccessibleCwd(row.cwd, pluginRoot),
      env: config.childEnv,
      eofGraceMs: config.eofGraceMs,
      disposeGraceMs: config.disposeGraceMs,
      signal,
      codexHome: config.codexHome,
      requestTimeoutMs: config.requestTimeoutMs,
    });
  };

  const ownedRuns = new Set();
  const inFlightOps = new Set();
  const jobs = new Map();
  const inFlightRequests = new Map();
  let shuttingDown = false;
  let shutdownPromise;

  const trackOp = (promise) => {
    inFlightOps.add(promise);
    const cleanup = () => inFlightOps.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  };

  const sendMessage = (payload) => {
    if (process.stdout.destroyed || process.stdout.writableEnded) return;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const sendResult = (id, result) => {
    if (id === undefined) return;
    sendMessage({ jsonrpc: '2.0', id, result });
  };

  const sendError = (id, code, message, data) => {
    if (id === undefined) return;
    sendMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    });
  };

  const persistJobReceiptIfUnclaimed = (job) => {
    if (job.persistedToDisk) return true;
    if (!job.settled || job.claimed || !job.publishedRunning) return true;
    const settledAt = job.settledAt ?? Date.now();
    const ok = diskJobs.writeJob({
      version: 1,
      jobId: job.id,
      startedAt: job.startedAt,
      settledAt,
      expiresAt: settledAt + JOB_TTL_MS,
      description: job.description,
      sessionKey: job.sessionKey ?? null,
      threadId: job.threadId ?? null,
      cwd: job.cwd,
      result: job.result,
    });
    if (ok) {
      job.persistedToDisk = true;
    }
    return ok;
  };

  const persistJobReceiptWithRetry = async (job, { attempts = 3, retryDelayMs = 50 } = {}) => {
    for (let i = 0; i < attempts; i += 1) {
      if (persistJobReceiptIfUnclaimed(job)) return true;
      if (i + 1 < attempts) {
        await delay(retryDelayMs).catch(() => {});
      }
    }
    return false;
  };

  const claimJob = (job) => {
    if (job.claimed) return null;
    job.claimed = true;
    if (job.expiryTimer !== undefined) {
      clearTimeout(job.expiryTimer);
      job.expiryTimer = undefined;
    }
    jobs.delete(job.id);
    if (job.persistedToDisk) {
      // Unify single-claim ownership with disk receipts via atomic rename claim.
      return diskJobs.claimJobFromDisk(job.id);
    }
    diskJobs.deleteJob(job.id);
    return job.result;
  };

  const buildRunningResponse = (job) => {
    job.publishedRunning = true;
    persistJobReceiptIfUnclaimed(job);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'running',
              jobId: job.id,
              description: job.description,
              ...(job.sessionKey !== undefined ? { sessionKey: job.sessionKey } : {}),
              ...(job.threadId !== undefined ? { threadId: job.threadId } : {}),
              cwd: job.cwd,
              elapsedMs: Date.now() - job.startedAt,
              telemetry: snapshotTelemetry(job),
              message:
                'Codex is still running in the background. Call subagent_codex_wait with this jobId to continue waiting (or cancel: true to abort).',
            },
            null,
            2,
          ),
        },
      ],
    };
  };

  const awaitJobWithin = async (job, waitMs, requestSignal) => {
    if (job.settled) {
      const claimed = claimJob(job);
      return claimed === null
        ? { settled: true, alreadyClaimed: true }
        : { settled: true, result: claimed };
    }
    if (requestSignal?.aborted) {
      throw requestSignal.reason instanceof Error
        ? requestSignal.reason
        : new Error(String(requestSignal.reason ?? 'aborted'));
    }

    const waitCancel = new AbortController();
    const onRequestAbort = () => {
      waitCancel.abort(requestSignal.reason ?? new Error('Request cancelled by MCP client'));
    };
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true });

    try {
      const outcome = await Promise.race([
        job.done.then((result) => ({ settled: true, result })),
        delay(waitMs, waitCancel.signal).then(() => ({ settled: false })),
      ]);
      waitCancel.abort();
      if (outcome.settled) {
        const claimed = claimJob(job);
        return claimed === null
          ? { settled: true, alreadyClaimed: true }
          : { settled: true, result: claimed };
      }
      return { settled: false };
    } finally {
      requestSignal?.removeEventListener('abort', onRequestAbort);
    }
  };

  const attachProgressListener = (job, progressToken) => {
    if (progressToken === undefined || !job?.progressListeners) return () => {};
    let step = 0;
    let lastSentMono = -Infinity;
    const listener = (label) => {
      const nowMono = performance.now();
      if (nowMono - lastSentMono < PROGRESS_THROTTLE_MS) return;
      lastSentMono = nowMono;
      step += 1;
      const elapsedSec = Math.round((Date.now() - job.startedAt) / 1000);
      sendMessage({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: step,
          message: `[${elapsedSec}s] ${label}`,
        },
      });
    };
    job.progressListeners.add(listener);
    return () => {
      job.progressListeners.delete(listener);
    };
  };

  const createJobRecord = (validated) => {
    const jobId = randomUUID();
    const jobController = new AbortController();
    const nowMs = Date.now();
    const nowMono = performance.now();
    return {
      id: jobId,
      description: validated.description,
      sessionKey: validated.sessionKey,
      threadId: validated.threadId,
      cwd: validated.cwd,
      startedAt: nowMs,
      lastActivityMonoMs: nowMono,
      lastActivityAt: new Date(nowMs).toISOString(),
      turnId: null,
      phase: null,
      plan: null,
      diffSummary: null,
      tokenUsage: null,
      activeActivities: new Map(),
      recentActivities: [],
      progressListeners: new Set(),
      activeRun: null,
      publishedRunning: false,
      persistedToDisk: false,
      claimed: false,
      controller: jobController,
      settled: false,
      settledAt: null,
      result: null,
      expiryTimer: undefined,
      done: null,
    };
  };

  const attachJobCompletion = (job, runPromise) => {
    job.done = runPromise.then((finalResult) => {
      job.settled = true;
      job.settledAt = Date.now();
      job.result = finalResult;
      job.activeActivities.clear();
      job.activeRun = null;
      persistJobReceiptIfUnclaimed(job);
      if (jobs.has(job.id) && !job.claimed && job.expiryTimer === undefined) {
        job.expiryTimer = setTimeout(() => {
          jobs.delete(job.id);
          diskJobs.deleteJob(job.id);
        }, JOB_TTL_MS);
        job.expiryTimer.unref?.();
      }
      return finalResult;
    });
    jobs.set(job.id, job);
    return job;
  };

  const startBackgroundCodexJob = (validated, rt = runtimeDefaults()) => {
    const job = createJobRecord(validated);
    const jobController = job.controller;

    const runPromise = (async () => {
      const hasSelector = validated.sessionKey !== undefined || validated.threadId !== undefined;
      let lease;
      try {
        if (hasSelector) {
          const existing = await store.getOwnedThread({
            sessionKey: validated.sessionKey,
            threadId: validated.threadId,
            cwd: validated.cwd,
          });
          if (!existing && validated.sessionKey !== undefined && validated.threadId === undefined) {
            await store
              .prune({
                archive: makeArchiveFn(validated.cwd, jobController.signal),
                reconcileClosing: makeReadReconcileFn(),
                reconcileUncertain: makeUncertainReconcileFn(),
                reserveSlots: 1,
                signal: jobController.signal,
              })
              .catch(() => {});
          }
          lease = await store.acquire(
            {
              sessionKey: validated.sessionKey,
              threadId: validated.threadId,
              cwd: validated.cwd,
              model: validated.explicitModel ?? rt.settingsModel,
              defaultModel: config.model,
              reconcileUncertain: makeUncertainReconcileFn(),
            },
            jobController.signal,
          );
          if (lease.threadId) {
            job.threadId = lease.threadId;
          }
        }

        const promptBlocks = [
          { type: 'text', text: validated.prompt },
          ...validated.images.map((imagePath) => ({ type: 'localImage', path: imagePath })),
        ];

        let run;
        try {
          run = await startCodexRun(
            {
              cwd: validated.cwd,
              prompt: promptBlocks,
              signal: jobController.signal,
            },
            {
              cwd: validated.cwd,
              model: rt.model,
              explicitModel: validated.explicitModel,
              reasoningEffort: validated.reasoningEffort,
              outputSchema: validated.outputSchema,
              config:
                validated.reasoningEffort !== undefined
                  ? { model_reasoning_effort: validated.reasoningEffort }
                  : undefined,
              permissionMode: validated.permissionMode,
              sandbox: validated.sandbox,
              env: config.childEnv,
              eofGraceMs: config.eofGraceMs,
              disposeGraceMs: config.disposeGraceMs,
              spawn: spawnSubprocess,
              wrapperPath: config.wrapperPath,
              codexAnchorPath: config.codexAnchorPath,
              codexHome: config.codexHome,
              requestTimeoutMs: config.requestTimeoutMs,
              turnTimeoutMs: config.turnTimeoutMs,
              warmPool,
              lease,
              onThreadKnown: (knownId) => {
                job.threadId = knownId;
              },
              onDiagnostic: (event) => {
                recordJobTelemetry(job, event);
              },
              onError: (err, stopReason) => {
                logError(`child run failed (${stopReason}): ${err?.message ?? err}`);
              },
            },
          );
        } catch (error) {
          lease?.release?.();
          throw error;
        }

        job.activeRun = run;
        ownedRuns.add(run);
        const cleanupRun = () => {
          ownedRuns.delete(run);
          if (job.activeRun === run) job.activeRun = null;
        };
        run.result.then(cleanupRun, cleanupRun);

        const res = await run.result;
        if (res.stopReason !== 'completed') {
          const partialText = formatTextOutput(res.output);
          const errorParts = [res.diagnostic || `Codex run failed (${res.stopReason})`];
          if (res.stopReason === 'max-tokens') {
            const usageInfo = formatUsageSummary(res.usage);
            if (usageInfo) {
              errorParts.push(`Context usage: ${usageInfo.tokenField ?? `tokens=${usageInfo.used}`}`);
            }
          }
          if (partialText) {
            errorParts.push(`Partial output:\n${partialText}`);
          }
          return {
            isError: true,
            content: [{ type: 'text', text: errorParts.join('\n\n') }],
          };
        }

        const text = formatTextOutput(res.output);
        let finalText = text;
        if (res.structured?.threadId) {
          job.threadId = res.structured.threadId;
          const usageInfo = formatUsageSummary(res.structured.usage ?? res.usage);
          const footerParts = [
            `threadId=${res.structured.threadId}`,
            `resumed=${Boolean(res.structured.resumed)}`,
          ];
          if (usageInfo?.tokenField) {
            footerParts.push(usageInfo.tokenField);
          }
          const footerLines = [`[codex-thread ${footerParts.join(' ')}]`];
          if (usageInfo?.warning) {
            footerLines.push(usageInfo.warning);
          }
          const footer = footerLines.join('\n');
          finalText = text ? `${text}\n\n${footer}` : footer;
        }

        return {
          content: [{ type: 'text', text: finalText }],
        };
      } catch (error) {
        return formatToolError(error);
      }
    })();

    return attachJobCompletion(job, runPromise);
  };

  const startCompactJob = (validated, rt = runtimeDefaults()) => {
    const job = createJobRecord(validated);
    const jobController = job.controller;

    const runPromise = (async () => {
      let lease;
      try {
        const existing = await store.getOwnedThread({
          sessionKey: validated.sessionKey,
          threadId: validated.threadId,
          cwd: validated.cwd,
        });
        if (!existing) {
          throw new CodexSessionError(
            CODEX_ERROR_CODES.NOT_FOUND,
            'subagent-codex: target thread was not found in the session store',
          );
        }
        lease = await store.acquire(
          {
            sessionKey: validated.sessionKey,
            threadId: validated.threadId,
            cwd: validated.cwd,
            model: validated.explicitModel ?? rt.settingsModel,
            defaultModel: config.model,
            reconcileUncertain: makeUncertainReconcileFn(),
          },
          jobController.signal,
        );

        let run;
        try {
          if (lease.mode !== 'resume' || !lease.threadId) {
            throw new CodexSessionError(
              CODEX_ERROR_CODES.NOT_FOUND,
              'subagent-codex: target thread was not found in the session store',
            );
          }
          job.threadId = lease.threadId;
          await warmPool.evict(lease.threadId);
          run = await compactCodexThread({
            spawn: spawnSubprocess,
            wrapperPath: config.wrapperPath,
            codexAnchorPath: config.codexAnchorPath,
            threadId: lease.threadId,
            cwd: validated.cwd,
            permissionMode: validated.permissionMode,
            sandbox: validated.sandbox,
            explicitModel: validated.explicitModel,
            model: rt.model,
            config:
              validated.reasoningEffort !== undefined
                ? { model_reasoning_effort: validated.reasoningEffort }
                : undefined,
            env: config.childEnv,
            eofGraceMs: config.eofGraceMs,
            disposeGraceMs: config.disposeGraceMs,
            signal: jobController.signal,
            codexHome: config.codexHome,
            requestTimeoutMs: config.requestTimeoutMs,
            turnTimeoutMs: config.turnTimeoutMs,
            lease,
            onDiagnostic: (event) => {
              recordJobTelemetry(job, event);
            },
            onError: (err, stopReason) => {
              logError(`compact run failed (${stopReason}): ${err?.message ?? err}`);
            },
          });
        } catch (error) {
          lease.release?.();
          throw error;
        }

        job.activeRun = run;
        ownedRuns.add(run);
        const cleanupRun = () => {
          ownedRuns.delete(run);
          if (job.activeRun === run) job.activeRun = null;
        };
        run.result.then(cleanupRun, cleanupRun);

        const res = await run.result;
        if (res.stopReason !== 'completed') {
          return {
            isError: true,
            content: [{ type: 'text', text: res.diagnostic || `Codex compaction failed (${res.stopReason})` }],
          };
        }

        const usageInfo = formatUsageSummary(res.structured?.usage ?? res.usage);
        const summary = {
          compacted: true,
          compactedEventObserved: Boolean(res.compacted),
          threadId: lease.threadId,
          ...(validated.sessionKey !== undefined ? { sessionKey: validated.sessionKey } : {}),
          turnId: res.structured?.turnId ?? null,
          ...(usageInfo
            ? {
                used: usageInfo.used,
                contextWindow: usageInfo.window,
                utilizationPct: usageInfo.pct,
              }
            : {}),
          size: res.structured?.size ?? null,
        };
        const footerParts = [`threadId=${lease.threadId}`, 'resumed=true'];
        if (usageInfo?.tokenField) {
          footerParts.push(usageInfo.tokenField);
        }
        return {
          content: [{ type: 'text', text: `${JSON.stringify(summary, null, 2)}\n\n[codex-thread ${footerParts.join(' ')}]` }],
        };
      } catch (error) {
        return formatToolError(error);
      }
    })();

    return attachJobCompletion(job, runPromise);
  };

  const closeOwnedThread = (selector, requestSignal) => trackOp((async () => {
    const ownedRow = await store.getOwnedThread(selector);
    if (!ownedRow) {
      throw new CodexSessionError(CODEX_ERROR_CODES.NOT_FOUND, 'subagent-codex: target thread was not found in the session store');
    }
    if (ownedRow.active) {
      throw new CodexSessionError(CODEX_ERROR_CODES.BUSY, `subagent-codex: thread "${ownedRow.threadId}" has an active run and cannot be closed`);
    }
    return store.close(selector, makeArchiveFn(selector.cwd, requestSignal));
  })());

  const forkOwnedThread = (validated, requestSignal, rt = runtimeDefaults()) => trackOp((async () => {
    const lease = await store.acquireFork(
      {
        sourceSessionKey: validated.sessionKey,
        sourceThreadId: validated.threadId,
        targetSessionKey: validated.targetSessionKey,
        cwd: validated.cwd,
        model: validated.explicitModel ?? rt.settingsModel,
        defaultModel: config.model,
        reconcileUncertain: makeUncertainReconcileFn(),
        prune: (pruneOpts) =>
          store.prune({
            archive: makeArchiveFn(validated.cwd, requestSignal),
            reconcileClosing: makeReadReconcileFn(),
            reconcileUncertain: makeUncertainReconcileFn(),
            ...pruneOpts,
          }),
      },
      requestSignal,
    );
    try {
      await warmPool.evict(lease.sourceThreadId);
      const receipt = await forkCodexThread({
        spawn: spawnSubprocess,
        wrapperPath: config.wrapperPath,
        codexAnchorPath: config.codexAnchorPath,
        sourceThreadId: lease.sourceThreadId,
        lastTurnId: validated.lastTurnId,
        cwd: validated.cwd,
        permissionMode: validated.permissionMode,
        sandbox: validated.sandbox,
        explicitModel: validated.explicitModel,
        model: rt.model,
        config:
          validated.reasoningEffort !== undefined
            ? { model_reasoning_effort: validated.reasoningEffort }
            : undefined,
        env: config.childEnv,
        eofGraceMs: config.eofGraceMs,
        disposeGraceMs: config.disposeGraceMs,
        signal: requestSignal,
        codexHome: config.codexHome,
        requestTimeoutMs: config.requestTimeoutMs,
        lease,
      });
      return receipt;
    } catch (error) {
      lease.release?.();
      throw error;
    }
  })());

  const handleSubagentCodex = async (rawArgs, requestSignal, progressToken) => {
    const rt = runtimeDefaults();
    const validated = validateSubagentArgs(rawArgs, {
      model: rt.model,
      permissionMode: config.permissionMode,
      sandbox: config.sandbox,
      reasoningEffort: rt.reasoningEffort,
      waitMs: config.waitMs,
    });

    if (validated.action === 'close') {
      const { sessionKey, threadId, cwd } = validated;
      const receipt = await closeOwnedThread({ sessionKey, threadId, cwd }, requestSignal);
      return { content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }] };
    }

    if (validated.action === 'fork') {
      const receipt = await forkOwnedThread(validated, requestSignal, rt);
      return { content: [{ type: 'text', text: `${JSON.stringify(receipt, null, 2)}\n\n[codex-thread threadId=${receipt.threadId} resumed=false]` }] };
    }

    const job =
      validated.action === 'compact'
        ? startCompactJob(validated, rt)
        : startBackgroundCodexJob(validated, rt);

    const detachProgress = attachProgressListener(job, progressToken);
    try {
      const waitRes = await awaitJobWithin(job, validated.waitMs, requestSignal);
      if (waitRes.settled) {
        if (waitRes.alreadyClaimed) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Unknown or already claimed jobId: ${job.id}` }],
          };
        }
        return waitRes.result;
      }
      return buildRunningResponse(job);
    } catch (error) {
      // Explicit client cancellation on the initiating request tears down the job cleanly.
      job.controller.abort(error instanceof Error ? error : new Error(String(error)));
      await Promise.race([job.done, delay(5_000).catch(() => {})]);
      claimJob(job);
      throw error;
    } finally {
      detachProgress();
    }
  };

  const handleSubagentCodexWait = async (rawArgs, requestSignal, progressToken) => {
    const validated = validateWaitArgs(rawArgs, { waitMs: config.waitMs });
    const job = jobs.get(validated.jobId);
    if (!job) {
      if (validated.steer !== undefined) {
        const peeked = diskJobs.peekJobFromDisk(validated.jobId);
        if (peeked) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Cannot steer job ${validated.jobId} because it has already finished (call subagent_codex_wait without steer to retrieve the result).`,
              },
            ],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown or already claimed jobId: ${validated.jobId}` }],
        };
      }

      const diskResult = diskJobs.claimJobFromDisk(validated.jobId);
      if (diskResult) {
        if (validated.cancel) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'cancelled', jobId: validated.jobId }, null, 2),
              },
            ],
          };
        }
        return diskResult;
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown or already claimed jobId: ${validated.jobId}` }],
      };
    }

    if (validated.cancel) {
      job.controller.abort(new Error('Cancelled via subagent_codex_wait'));
      await Promise.race([job.done, delay(5_000).catch(() => {})]);
      claimJob(job);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'cancelled', jobId: validated.jobId }, null, 2),
          },
        ],
      };
    }

    if (validated.steer !== undefined) {
      if (job.settled) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Cannot steer job ${validated.jobId} because it has already finished (call subagent_codex_wait without steer to retrieve the result).`,
            },
          ],
        };
      }
      const steerImages = validateLocalImages(validated.images, job.cwd, {
        toolName: 'subagent_codex_wait',
        serverName: SERVER_NAME,
      });
      if (!job.activeRun || typeof job.activeRun.steer !== 'function') {
        throw new Error(`subagent_codex_wait: job ${validated.jobId} is not in an active steerable turn`);
      }
      const steerBlocks = [
        { type: 'text', text: validated.steer },
        ...steerImages.map((imagePath) => ({ type: 'localImage', path: imagePath })),
      ];
      await job.activeRun.steer(steerBlocks, { signal: requestSignal });
    }

    const detachProgress = attachProgressListener(job, progressToken);
    try {
      const waitRes = await awaitJobWithin(job, validated.waitMs, requestSignal);
      if (waitRes.settled) {
        if (waitRes.alreadyClaimed) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Unknown or already claimed jobId: ${validated.jobId}` }],
          };
        }
        return waitRes.result;
      }
      return buildRunningResponse(job);
    } finally {
      detachProgress();
    }
  };

  const handleListSessions = async (rawArgs) => {
    if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
      throw new Error('subagent_codex_list_sessions: arguments must be an object');
    }
    if (isPlainObject(rawArgs) && Object.keys(rawArgs).length > 0) {
      throw new Error(`subagent_codex_list_sessions: unknown argument "${Object.keys(rawArgs)[0]}"`);
    }
    const now = Date.now();
    const sessions = store.list();
    const inMemoryIds = new Set();
    const activeJobs = [...jobs.values()].map((job) => {
      inMemoryIds.add(job.id);
      return {
        jobId: job.id,
        description: job.description,
        sessionKey: job.sessionKey ?? null,
        threadId: job.threadId ?? null,
        cwd: job.cwd,
        status: job.settled ? 'completed_unclaimed' : 'running',
        elapsedMs: now - job.startedAt,
        telemetry: snapshotTelemetry(job),
      };
    });
    const persistedJobs = diskJobs.listUnclaimed(inMemoryIds, { bypassCache: true });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ sessions, activeJobs: [...activeJobs, ...persistedJobs] }, null, 2),
        },
      ],
    };
  };

  const handleRequest = async (message) => {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;

    if (method === 'notifications/initialized' || method === 'initialized') {
      return;
    }

    if (method === 'notifications/cancelled') {
      const targetId = isPlainObject(params) ? params.requestId : undefined;
      if (targetId !== undefined && inFlightRequests.has(targetId)) {
        inFlightRequests.get(targetId).abort(new Error('Request cancelled by MCP client'));
      }
      return;
    }

    if (method === 'initialize') {
      const protocolVersion =
        isPlainObject(params) && typeof params.protocolVersion === 'string' && params.protocolVersion
          ? params.protocolVersion
          : PROTOCOL_FALLBACK_VERSION;
      sendResult(id, {
        protocolVersion,
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
      return;
    }

    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    if (method === 'resources/list') {
      sendResult(id, { resources: [SETTINGS_RESOURCE] });
      return;
    }

    if (method === 'resources/read') {
      if (params?.uri !== SETTINGS_RESOURCE_URI) {
        sendError(id, -32602, 'Unknown settings resource URI');
        return;
      }
      try {
        const override = process.env.CODEX_SETTINGS_HTML?.trim();
        const settingsPath = path.resolve(override || path.join(pluginRoot, 'ui', 'dist', 'settings.html'));
        const file = statSync(settingsPath);
        if (!file.isFile() || file.size > MAX_SETTINGS_HTML_BYTES) throw new Error('Invalid settings HTML file');
        let html;
        if (!override && settingsHtmlCache?.resolvedPath === settingsPath
          && settingsHtmlCache.mtimeMs === file.mtimeMs && settingsHtmlCache.size === file.size) {
          html = settingsHtmlCache.html;
        } else {
          if (!override) settingsHtmlCache = undefined;
          html = readFileSync(settingsPath, 'utf8');
          if (!html.trim() || Buffer.byteLength(html, 'utf8') > MAX_SETTINGS_HTML_BYTES) {
            throw new Error('Settings HTML is empty or exceeds the size limit');
          }
          if (!override) settingsHtmlCache = { resolvedPath: settingsPath, mtimeMs: file.mtimeMs, size: file.size, html };
        }
        sendResult(id, { contents: [{ uri: SETTINGS_RESOURCE_URI, mimeType: SETTINGS_RESOURCE_MIME, text: html, _meta: SETTINGS_RESOURCE._meta }] });
      } catch {
        settingsHtmlCache = undefined;
        sendError(id, -32603, 'Could not read settings HTML: missing, empty, or exceeds the size limit');
      }
      return;
    }

    if (method === 'tools/list') {
      sendResult(id, {
        tools: [SUBAGENT_CODEX_TOOL, SUBAGENT_CODEX_WAIT_TOOL, LIST_SESSIONS_TOOL, SUBAGENT_CODEX_SETTINGS_TOOL, ...SETTINGS_APP_TOOLS],
      });
      return;
    }

    if (method === 'tools/call') {
      if (!isRequest) return;
      if (shuttingDown) {
        sendResult(id, formatToolError(new Error(`${SERVER_NAME}: server is shutting down`)));
        return;
      }
      const toolName = isPlainObject(params) ? params.name : undefined;
      const rawArgs = isPlainObject(params) ? params.arguments : undefined;
      const toolArgs = rawArgs ?? {};
      const meta = isPlainObject(params) && isPlainObject(params._meta) ? params._meta : undefined;
      const progressToken =
        meta && ((typeof meta.progressToken === 'string' && meta.progressToken.length > 0) || Number.isInteger(meta.progressToken))
          ? meta.progressToken
          : undefined;

      const controller = new AbortController();
      inFlightRequests.set(id, controller);
      try {
        let result;
        if (toolName === 'subagent_codex') {
          result = await handleSubagentCodex(toolArgs, controller.signal, progressToken);
        } else if (toolName === 'subagent_codex_wait') {
          result = await handleSubagentCodexWait(toolArgs, controller.signal, progressToken);
        } else if (toolName === 'subagent_codex_list_sessions') {
          result = await handleListSessions(toolArgs);
        } else if (toolName === SUBAGENT_CODEX_SETTINGS_TOOL.name) {
          validateSettingsArgs(rawArgs === undefined ? {} : rawArgs, toolName, []);
          result = uiResult({ serverVersion: SERVER_VERSION, ...buildSettingsPayload() }, 'Codex Subagent Settings');
        } else if (toolName === 'codex_ui_get_settings') {
          const args = rawArgs === undefined ? {} : rawArgs;
          validateSettingsArgs(args, toolName, ['syncCodex']);
          if (args.syncCodex !== undefined && typeof args.syncCodex !== 'boolean') {
            throw new Error('codex_ui_get_settings: syncCodex must be a boolean');
          }
          if (args.syncCodex !== false) {
            await settingsUpdate;
            await syncCodexSnapshot(controller.signal);
          }
          result = uiResult(buildSettingsPayload());
        } else if (toolName === 'codex_ui_update_settings') {
          const update = settingsUpdate.then(async () => {
            await updateSettings(rawArgs === undefined ? {} : rawArgs, controller.signal);
            return uiResult(buildSettingsPayload());
          });
          settingsUpdate = update.catch(() => {});
          result = await update;
        } else {
          sendError(id, -32602, 'Unknown tool: ' + String(toolName));
          return;
        }
        sendResult(id, result);
      } catch (error) {
        sendResult(id, formatToolError(error));
      } finally {
        inFlightRequests.delete(id);
      }
      return;
    }

    if (isRequest) {
      sendError(id, -32601, `Method not found: ${String(method)}`);
    }
  };

  const startupPruneController = new AbortController();
  let startupPruneTimer;
  let startupPrunePromise = Promise.resolve();

  const shutdown = (reason) => {
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      if (startupPruneTimer !== undefined) {
        clearTimeout(startupPruneTimer);
        startupPruneTimer = undefined;
      }
      startupPruneController.abort(new Error(`Server shutting down (${reason})`));
      for (const controller of inFlightRequests.values()) {
        controller.abort(new Error(`Server shutting down (${reason})`));
      }
      for (const job of jobs.values()) {
        if (job.expiryTimer !== undefined) {
          clearTimeout(job.expiryTimer);
          job.expiryTimer = undefined;
        }
        if (job.settled) {
          persistJobReceiptIfUnclaimed(job);
        } else {
          job.controller.abort(new Error(`Server shutting down (${reason})`));
        }
      }
      const runDisposeResults = await Promise.allSettled([...ownedRuns].map((run) => run.dispose()));
      const runsOk = runDisposeResults.every((r) => r.status === 'fulfilled');
      const drainBudgetMs = Math.max(config.eofGraceMs + config.disposeGraceMs + 2_000, 10_000);
      let drained = false;
      const drainAll = Promise.allSettled([
        ...[...jobs.values()].map((job) => job.done),
        ...inFlightOps,
        startupPrunePromise,
      ]).then(() => {
        drained = true;
      });
      await Promise.race([drainAll, delay(drainBudgetMs).catch(() => {})]);

      // Persist recoverable terminal receipts for all published unclaimed jobs with bounded retry.
      let receiptsOk = true;
      for (const job of jobs.values()) {
        if (!job.settled && job.publishedRunning && !job.claimed) {
          job.settled = true;
          job.settledAt = Date.now();
          job.result = {
            isError: true,
            content: [{ type: 'text', text: `Codex run aborted during server shutdown (${reason})` }],
          };
        }
        if (job.settled && job.publishedRunning && !job.claimed && !job.persistedToDisk) {
          const ok = await persistJobReceiptWithRetry(job);
          if (!ok) {
            receiptsOk = false;
            logError(`failed to persist terminal job receipt ${job.id} during shutdown`);
          }
        }
      }
      if (receiptsOk) {
        jobs.clear();
      }

      let warmOk = true;
      try {
        const warmOutcome = await warmPool.disposeAll();
        if (warmOutcome && warmOutcome.ok === false) {
          warmOk = false;
        }
      } catch (err) {
        warmOk = false;
        logError(`warm pool dispose error: ${err?.message ?? err}`);
      }

      let storeOk = true;
      if (drained && runsOk && warmOk) {
        await store.dispose().catch((err) => {
          storeOk = false;
          logError(`store dispose error: ${err?.message ?? err}`);
        });
      } else {
        // Retain registry lock until process exit so a new server cannot race with
        // unconfirmed teardown or still-running archive operations.
        logError(`dirty shutdown (drained=${drained}, runsOk=${runsOk}, receiptsOk=${receiptsOk}, warmOk=${warmOk}); retaining lock until process exit`);
      }
      return drained && runsOk && receiptsOk && warmOk && storeOk;
    })();
    return shutdownPromise;
  };

  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const processBuffer = () => {
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        sendError(null, -32700, `Parse error: ${error?.message ?? error}`);
        continue;
      }

      if (!isPlainObject(message) || typeof message.method !== 'string') {
        if (isPlainObject(message) && message.id !== undefined && message.id !== null) {
          sendError(message.id, -32600, 'Invalid JSON-RPC request');
        }
        continue;
      }

      void handleRequest(message).catch((error) => {
        logError(`unhandled request error (${message.method}): ${error?.message ?? error}`);
        if (message.id !== undefined && message.id !== null) {
          sendError(message.id, -32603, error instanceof Error ? error.message : String(error));
        }
      });
    }
  };

  process.stdin.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    processBuffer();
  });

  const exitAfterShutdown = async (reason, exitCode = 0) => {
    const clean = await shutdown(reason);
    process.exit(clean ? exitCode : 1);
  };

  process.stdin.on('end', () => {
    buffer += decoder.end();
    processBuffer();
    void exitAfterShutdown('stdin end', 0);
  });

  process.stdin.on('close', () => {
    void exitAfterShutdown('stdin close', 0);
  });

  process.on('SIGINT', () => {
    void exitAfterShutdown('SIGINT', 0);
  });

  process.on('SIGTERM', () => {
    void exitAfterShutdown('SIGTERM', 0);
  });

  // Start serving MCP stdio immediately so handshake & signal handlers are never blocked
  // by background session recovery probes.
  process.stdin.resume();

  startupPruneTimer = setTimeout(() => {
    startupPruneController.abort(new Error('startup prune time budget exceeded'));
  }, STARTUP_PRUNE_BUDGET_MS);
  startupPruneTimer.unref?.();

  startupPrunePromise = store
    .prune({
      archive: makeArchiveFn(pluginRoot, startupPruneController.signal),
      reconcileClosing: makeReadReconcileFn(),
      reconcileUncertain: makeUncertainReconcileFn(),
      signal: startupPruneController.signal,
    })
    .catch((err) => {
      if (!shuttingDown) {
        logError(`startup prune skipped: ${err?.message ?? err}`);
      }
    })
    .finally(() => {
      if (startupPruneTimer !== undefined) {
        clearTimeout(startupPruneTimer);
        startupPruneTimer = undefined;
      }
    });
}

main().catch((error) => {
  logError(`fatal startup error: ${error?.stack ?? error}`);
  process.exit(1);
});
