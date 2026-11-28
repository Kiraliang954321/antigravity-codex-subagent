import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_EARLY_TURN_NOTIFICATIONS = 256;
const HEARTBEAT_THROTTLE_MS = 250;
const HEARTBEAT_PHASE_BY_METHOD = Object.freeze({
  'item/reasoning/summaryTextDelta': 'thinking',
  'item/reasoning/textDelta': 'thinking',
  'item/agentMessage/delta': 'streaming',
  'item/commandExecution/outputDelta': 'executing',
  'item/plan/delta': 'planning',
});
const STREAM_CHANNEL_BY_PHASE = Object.freeze({
  thinking: 'reasoning', streaming: 'agentMessage', executing: 'commandOutput', planning: 'plan',
});

export class CodexRpcError extends Error {
  constructor(code, message, data, method) {
    super(message);
    this.name = 'CodexRpcError';
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`);
  }
  return value;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(signal, fallback) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(fallback ?? `subagent-codex: app-server request aborted: ${String(signal?.reason ?? 'aborted')}`);
}

function unattendedDecision(params) {
  const available = params.availableDecisions;
  if (available === undefined || available === null) return 'decline';
  if (Array.isArray(available)) {
    if (available.includes('cancel')) return 'cancel';
    if (available.includes('decline')) return 'decline';
  }
  throw new Error('subagent-codex: app-server offered no unattended approval decision');
}

function numericHttpStatus(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
    ? value
    : undefined;
}

function objectFailureInfo(value) {
  const keys = Object.keys(value);
  const category = keys[0];
  if (keys.length !== 1 || category === undefined) return { category: 'unknown' };
  const detail = value[category];
  if (!isPlainObject(detail)) return { category: 'unknown' };
  switch (category) {
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts': {
      const httpStatus = numericHttpStatus(detail.httpStatusCode);
      return httpStatus === undefined
        ? { category: 'transport' }
        : { category: 'transport', httpStatus };
    }
    case 'activeTurnNotSteerable':
      return { category: 'product-error' };
    default:
      return { category: 'unknown' };
  }
}

export function extractTurnFailureInfo(turn) {
  if (!isPlainObject(turn) || turn.status !== 'failed') return { category: 'unknown' };
  const error = turn.error;
  if (!isPlainObject(error)) return { category: 'unknown' };
  const info = error.codexErrorInfo;
  if (typeof info === 'string') {
    switch (info) {
      case 'contextWindowExceeded':
        return { category: 'limit', maxTokens: true };
      case 'sessionBudgetExceeded':
      case 'usageLimitExceeded':
        return { category: 'limit' };
      case 'serverOverloaded':
      case 'internalServerError':
        return { category: 'service' };
      case 'cyberPolicy':
      case 'misalignmentPolicyViolation':
      case 'unauthorized':
        return { category: 'access-policy' };
      case 'badRequest':
      case 'threadRollbackFailed':
      case 'other':
        return { category: 'product-error' };
      case 'sandboxError':
        return { category: 'access-policy', sandboxFailure: true };
      default:
        return { category: 'unknown' };
    }
  }
  return isPlainObject(info) ? objectFailureInfo(info) : { category: 'unknown' };
}

function normalizeTurnInput(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('subagent-codex: turn input must be a non-empty array');
  }
  return input.map((entry) => {
    if (typeof entry === 'string') {
      return { type: 'text', text: entry, text_elements: [] };
    }
    if (isPlainObject(entry) && entry.type === 'text' && typeof entry.text === 'string') {
      return {
        type: 'text',
        text: entry.text,
        text_elements: Array.isArray(entry.text_elements) ? entry.text_elements : [],
      };
    }
    if (isPlainObject(entry) && entry.type === 'localImage' && typeof entry.path === 'string' && entry.path.trim().length > 0) {
      return {
        type: 'localImage',
        path: entry.path,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      };
    }
    throw new Error('subagent-codex: turn input must contain only text or localImage blocks');
  });
}

function extractActivityKind(item) {
  if (!isPlainObject(item) || typeof item.type !== 'string') return null;
  switch (item.type) {
    case 'commandExecution':
      return 'commandExecution';
    case 'fileChange':
      return 'fileChange';
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return 'mcpToolCall';
    case 'reasoning':
      return 'reasoning';
    case 'plan':
      return 'plan';
    case 'webSearch':
      return 'webSearch';
    case 'contextCompaction':
      return 'contextCompaction';
    case 'agentMessage':
      return item.phase === 'commentary' ? 'commentary' : null;
    default:
      return null;
  }
}

function summarizeActivity(item) {
  const summary = typeof item.status === 'string' ? { status: item.status } : {};
  switch (item.type) {
    case 'commandExecution': {
      let command = item.command;
      if (Array.isArray(command)) {
        try { command = command.join(' '); } catch { command = undefined; }
      }
      if (typeof command === 'string') summary.command = command.slice(0, 512);
      if (typeof item.exitCode === 'number') summary.exitCode = item.exitCode;
      return summary;
    }
    case 'fileChange':
      if (Array.isArray(item.changes)) {
        summary.files = item.changes.slice(0, 20).map((change) =>
          typeof change === 'string' ? change : change?.path).filter((file) => typeof file === 'string' && file);
      }
      return summary;
    case 'mcpToolCall':
    case 'dynamicToolCall':
      if (typeof item.server === 'string') summary.server = item.server;
      if (typeof item.tool === 'string') summary.tool = item.tool;
      return summary;
    case 'agentMessage':
      if (item.phase === 'commentary') {
        return { phase: 'commentary', ...(typeof item.text === 'string' ? { text: item.text.slice(0, 2000) } : {}) };
      }
      return summary;
    default:
      return summary;
  }
}

function extractDiffFiles(diffText) {
  if (typeof diffText !== 'string' || !diffText) return [];
  const seen = new Set();
  const files = [];
  const addFile = (rawPath) => {
    if (!rawPath || rawPath === '/dev/null') return;
    const cleaned = rawPath.replace(/^"|"$/g, '');
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    files.push(cleaned);
  };
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (m) addFile(m[1]);
    } else if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      if (target.startsWith('b/')) addFile(target.slice(2));
      else if (target !== '/dev/null') addFile(target);
    }
  }
  return files;
}

function normalizeSignal(signal) {
  return signal && typeof signal.addEventListener === 'function' ? signal : undefined;
}

/**
 * Create a JSON-RPC 2.0 stdio wire client for Codex app-server v2.
 *
 * `stdin` is the writable stream into the child process (`child.stdin`).
 * `stdout` is the readable stream from the child process (`child.stdout`).
 */
export function createCodexWire({
  stdin,
  stdout,
  signal,
  onDiagnostic,
  permissionMode = 'never',
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
} = {}) {
  if (!stdin || typeof stdin.write !== 'function') {
    throw new Error('subagent-codex: wire requires a writable stdin stream');
  }
  if (!stdout || typeof stdout.on !== 'function') {
    throw new Error('subagent-codex: wire requires a readable stdout stream');
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('subagent-codex: requestTimeoutMs must be a positive finite number');
  }
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024) {
    throw new Error('subagent-codex: maxFrameBytes must be an integer >= 1024');
  }

  const wireSignal = normalizeSignal(signal);
  const decoder = new StringDecoder('utf8');
  const pending = new Map();
  let reqSeq = 0;
  let buffer = '';
  let bufferedBytes = 0;
  let started = false;
  let closed = false;
  let inputEnded = false;
  let fatalError;

  let activeThreadId;
  let activeTurnId;
  let pendingTurnId;
  let turnCompletion;
  let compactMode = false;
  let compactedObserved = false;
  let terminalObserved = false;
  let earlyActivityNotifications = [];
  const earlyStreamNotifications = [];
  const earlyTelemetryByTurnId = new Map();
  const earlyPlanByTurnId = new Map();
  const earlyDiffByTurnId = new Map();
  const earlyAnswersByTurnId = new Map();
  const earlyTurnCompletions = new Map();
  const lastHeartbeatByPhase = new Map();
  let turnStartedEmittedForTurnId;
  const completedTurnIds = new Set();

  let lastFinalAnswer;
  let lastPartialAnswer;
  let lastUnphasedAnswer;
  const selectedAnswer = () => lastFinalAnswer ?? lastPartialAnswer ?? lastUnphasedAnswer;
  let latestUsage;
  let diagnostic;
  let diagnosticOrder = 0;
  let observationOrder = 0;
  let pendingDiagnostic;
  let failure;

  const emitDiagnostic = (event) => {
    if (typeof onDiagnostic !== 'function') return;
    try {
      onDiagnostic(event);
    } catch {
      // Diagnostics must never break protocol handling.
    }
  };

  const nextOrder = () => {
    observationOrder += 1;
    return observationOrder;
  };

  const recordDiagnostic = (request, decision, reason, order = nextOrder()) => {
    if (order < diagnosticOrder) return;
    diagnosticOrder = order;
    diagnostic = `Codex unattended decision (mode: ${permissionMode}; request: ${request}; decision: ${decision}): ${reason}`;
    emitDiagnostic({ type: 'unattended-decision', permissionMode, request, decision, reason });
  };

  const recordRequestDiagnostic = (provisional, request, decision, reason) => {
    const order = nextOrder();
    if (provisional) {
      pendingDiagnostic = { order, request, decision, reason };
      return;
    }
    recordDiagnostic(request, decision, reason, order);
  };

  const fail = (err) => {
    const normalized = toError(err);
    if (!fatalError) fatalError = normalized;
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.cleanup();
      entry.reject(normalized);
    }
    if (turnCompletion) {
      const completion = turnCompletion;
      turnCompletion = undefined;
      completion.reject(normalized);
    }
  };

  const writeFrame = (payload) => {
    if (closed) throw new Error('subagent-codex: wire is closed');
    if (fatalError) throw fatalError;
    if (stdin.destroyed || stdin.writableEnded) {
      throw new Error('subagent-codex: app-server stdin is closed');
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const writeErrorResponse = (id, code, message) => {
    try {
      writeFrame({ jsonrpc: '2.0', id, error: { code, message } });
    } catch {
      // Ignore write failures while tearing down.
    }
  };

  const flushOutput = () => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error('subagent-codex: wire is closed'));
      return;
    }
    if (fatalError) {
      reject(fatalError);
      return;
    }
    stdin.write('', (error) => {
      if (error) reject(toError(error));
      else resolve();
    });
  });

  const observePendingTurnId = (id) => {
    if (!turnCompletion) {
      throw new Error('subagent-codex: app-server referenced a turn before turn/start');
    }
    if (pendingTurnId !== undefined && pendingTurnId !== id) {
      throw new Error('subagent-codex: app-server referenced conflicting turns');
    }
    pendingTurnId = id;
  };

  const pushEarlyActivity = (entry) => {
    if (earlyActivityNotifications.length < MAX_EARLY_TURN_NOTIFICATIONS) {
      earlyActivityNotifications.push(entry);
    }
  };

  const pushBoundedTurnMap = (map, maxKeys, entry) => {
    if (typeof entry.turnId !== 'string' || !entry.turnId) return;
    if (map.has(entry.turnId)) {
      map.delete(entry.turnId);
    } else if (map.size >= maxKeys) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
    map.set(entry.turnId, entry);
  };

  const pushEarlyTelemetry = (entry) => {
    // Coalesce usage telemetry per turnId (only the latest usage for each turn matters),
    // keeping historical usage floods completely separate from answer/activity queues.
    pushBoundedTurnMap(earlyTelemetryByTurnId, 64, entry);
  };

  const pushEarlyPlan = (entry) => {
    pushBoundedTurnMap(earlyPlanByTurnId, 32, entry);
  };

  const pushEarlyDiff = (entry) => {
    pushBoundedTurnMap(earlyDiffByTurnId, 32, entry);
  };

  const pushEarlyAnswerOrDecision = (entry) => {
    if (typeof entry.turnId !== 'string' || !entry.turnId) return;
    let list = earlyAnswersByTurnId.get(entry.turnId);
    if (!list) {
      if (earlyAnswersByTurnId.size >= 32) {
        const oldestKey = earlyAnswersByTurnId.keys().next().value;
        if (oldestKey !== undefined) earlyAnswersByTurnId.delete(oldestKey);
      }
      list = [];
      earlyAnswersByTurnId.set(entry.turnId, list);
    }
    if (list.length >= 64) {
      list.shift();
    }
    list.push(entry);
  };

  const validateRunIds = (params, nullableTurn = false) => {
    if (params.threadId !== activeThreadId) {
      throw new Error('subagent-codex: app-server request referenced another thread');
    }
    if (nullableTurn && params.turnId === null) return false;
    const id = requireNonEmptyString(params.turnId, 'server request turn id');
    if (completedTurnIds.has(id)) {
      throw new Error('subagent-codex: app-server request referenced an already-completed turn');
    }
    if (activeTurnId === undefined) {
      observePendingTurnId(id);
      return true;
    }
    if (id !== activeTurnId) {
      throw new Error('subagent-codex: app-server request referenced another turn');
    }
    return false;
  };

  const recordDeclinedItem = (item, order) => {
    if (item.type === 'commandExecution' && item.status === 'declined') {
      recordDiagnostic('command execution', 'declined', 'Codex declined the command under the selected permission mode', order);
      return true;
    }
    if (item.type === 'fileChange' && item.status === 'declined') {
      recordDiagnostic('file change', 'declined', 'Codex declined the file change under the selected permission mode', order);
      return true;
    }
    return false;
  };

  const handleServerRequest = async (id, method, params) => {
    try {
      let result;
      switch (method) {
        case 'item/commandExecution/requestApproval': {
          const provisional = validateRunIds(params);
          const decision = unattendedDecision(params);
          recordRequestDiagnostic(
            provisional,
            'command approval',
            decision === 'cancel' ? 'cancelled' : 'declined',
            'the provider does not grant interactive approval',
          );
          result = { decision };
          break;
        }
        case 'item/fileChange/requestApproval': {
          const provisional = validateRunIds(params);
          const decision = unattendedDecision(params);
          recordRequestDiagnostic(
            provisional,
            'file approval',
            decision === 'cancel' ? 'cancelled' : 'declined',
            'the provider does not grant interactive approval',
          );
          result = { decision };
          break;
        }
        case 'item/permissions/requestApproval': {
          recordRequestDiagnostic(
            validateRunIds(params),
            'permission grant',
            'denied',
            'the provider grants no additional turn permissions',
          );
          result = { permissions: {}, scope: 'turn' };
          break;
        }
        case 'item/tool/requestUserInput': {
          recordRequestDiagnostic(
            validateRunIds(params),
            'user input',
            'empty response',
            'the provider does not collect interactive answers',
          );
          result = { answers: {} };
          break;
        }
        case 'mcpServer/elicitation/request': {
          recordRequestDiagnostic(
            validateRunIds(params, true),
            'MCP elicitation',
            'declined',
            'the provider does not collect interactive MCP input',
          );
          result = { action: 'decline', content: null, _meta: null };
          break;
        }
        default: {
          const err = new CodexRpcError(
            -32601,
            `subagent-codex: unsupported app-server request ${JSON.stringify(method)}`,
            undefined,
            method,
          );
          writeErrorResponse(id, -32601, err.message);
          fail(err);
          return;
        }
      }
      writeFrame({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const normalized = toError(error);
      writeErrorResponse(id, -32603, normalized.message);
      fail(normalized);
    }
  };

  const handleNotification = (method, params, order) => {
    if (method === 'thread/tokenUsage/updated') {
      if (activeThreadId === undefined || params.threadId !== activeThreadId) return;
      if (typeof params.turnId === 'string' && completedTurnIds.has(params.turnId)) return;
      if (activeTurnId === undefined && turnCompletion !== undefined) {
        if (typeof params.turnId === 'string' && params.turnId.length > 0) {
          // Resume can publish historical usage just before the turn/start response.
          // Coalesce per turnId in its own map so bursts never evict answers or completions.
          pushEarlyTelemetry({ method, params, turnId: params.turnId, order: order ?? nextOrder() });
        }
        return;
      }
      if (params.turnId !== undefined && activeTurnId !== undefined && params.turnId !== activeTurnId) return;
      const tokenUsage = isPlainObject(params.tokenUsage) ? params.tokenUsage : undefined;
      const last = tokenUsage && isPlainObject(tokenUsage.last) ? tokenUsage.last : undefined;
      const totalTokens = typeof last?.totalTokens === 'number' && Number.isFinite(last.totalTokens)
        ? last.totalTokens
        : undefined;
      const modelContextWindow = typeof tokenUsage?.modelContextWindow === 'number' && Number.isFinite(tokenUsage.modelContextWindow)
        ? tokenUsage.modelContextWindow
        : null;
      if (totalTokens !== undefined) {
        latestUsage = { totalTokens, modelContextWindow };
        emitDiagnostic({
          type: 'tokenUsage',
          threadId: activeThreadId,
          turnId: activeTurnId ?? null,
          usage: latestUsage,
        });
      }
      return;
    }

    const heartbeatPhase = HEARTBEAT_PHASE_BY_METHOD[method];
    if (heartbeatPhase !== undefined) {
      if (activeThreadId === undefined || params.threadId !== activeThreadId) return;
      const id = typeof params.turnId === 'string' && params.turnId.length > 0 ? params.turnId : undefined;
      if (id === undefined || completedTurnIds.has(id)) return;
      if (activeTurnId === undefined && turnCompletion === undefined) return;
      if (activeTurnId !== undefined && id !== activeTurnId) return;
      const nowMono = performance.now();
      const prevMono = lastHeartbeatByPhase.get(heartbeatPhase) ?? -Infinity;
      if (nowMono - prevMono >= HEARTBEAT_THROTTLE_MS) {
        lastHeartbeatByPhase.set(heartbeatPhase, nowMono);
        emitDiagnostic({
          type: 'heartbeat',
          phase: heartbeatPhase,
          threadId: activeThreadId,
          turnId: activeTurnId ?? id,
        });
      }
      if (typeof params.delta === 'string' && params.delta.length > 0) {
        const limit = 8192;
        const end = params.delta.codePointAt(limit - 1) > 0xffff ? limit - 1 : limit;
        const streamEvent = {
          type: 'streamDelta',
          channel: STREAM_CHANNEL_BY_PHASE[heartbeatPhase],
          threadId: activeThreadId,
          turnId: activeTurnId ?? id,
          itemId: typeof params.itemId === 'string' && params.itemId ? params.itemId : null,
          delta: params.delta.slice(0, end),
        };
        if (activeTurnId !== undefined) emitDiagnostic(streamEvent);
        else if (earlyStreamNotifications.length < MAX_EARLY_TURN_NOTIFICATIONS) {
          earlyStreamNotifications.push({ streamEvent, order: order ?? nextOrder() });
        }
      }
      return;
    }

    if (method === 'turn/plan/updated') {
      if (activeThreadId === undefined || params.threadId !== activeThreadId) return;
      const id = typeof params.turnId === 'string' && params.turnId.length > 0 ? params.turnId : undefined;
      if (id !== undefined && completedTurnIds.has(id)) return;
      if (activeTurnId === undefined && turnCompletion !== undefined) {
        if (id !== undefined) {
          pushEarlyPlan({ method, params, turnId: id, order: order ?? nextOrder() });
        }
        return;
      }
      if (id !== undefined && activeTurnId !== undefined && id !== activeTurnId) return;
      const steps = (Array.isArray(params.plan) ? params.plan : [])
        .slice(0, 20)
        .map((step) => ({
          step: String(step?.step ?? '').slice(0, 120),
          status: String(step?.status ?? 'pending'),
        }));
      emitDiagnostic({
        type: 'planUpdated',
        threadId: activeThreadId,
        turnId: activeTurnId ?? id ?? null,
        explanation: typeof params.explanation === 'string' ? params.explanation.slice(0, 200) : null,
        steps,
      });
      return;
    }

    if (method === 'turn/diff/updated') {
      if (activeThreadId === undefined || params.threadId !== activeThreadId) return;
      const id = typeof params.turnId === 'string' && params.turnId.length > 0 ? params.turnId : undefined;
      if (id !== undefined && completedTurnIds.has(id)) return;
      if (activeTurnId === undefined && turnCompletion !== undefined) {
        if (id !== undefined) {
          pushEarlyDiff({ method, params, turnId: id, order: order ?? nextOrder() });
        }
        return;
      }
      if (id !== undefined && activeTurnId !== undefined && id !== activeTurnId) return;
      const files = extractDiffFiles(params.diff);
      emitDiagnostic({
        type: 'diffUpdated',
        threadId: activeThreadId,
        turnId: activeTurnId ?? id ?? null,
        filesChangedCount: files.length,
        files: files.slice(0, 20),
      });
      if (typeof params.diff === 'string' && params.diff.length > 0) {
        emitDiagnostic({
          type: 'diffDetail',
          threadId: activeThreadId,
          turnId: activeTurnId ?? id ?? null,
          filesChangedCount: files.length,
          files: files.slice(0, 50),
          diff: params.diff.slice(0, 32768),
          truncated: params.diff.length > 32768,
        });
      }
      return;
    }

    if (method === 'thread/compacted') {
      if (activeThreadId === undefined || params.threadId !== activeThreadId) return;
      const id = typeof params.turnId === 'string' && params.turnId.length > 0 ? params.turnId : undefined;
      if (id === undefined || completedTurnIds.has(id)) return;
      if (activeTurnId === undefined) {
        if (turnCompletion !== undefined) {
          pushEarlyActivity({ method, params, turnId: id, order: order ?? nextOrder() });
        }
        return;
      }
      if (id !== activeTurnId) return;
      compactedObserved = true;
      emitDiagnostic({
        type: 'compacted',
        threadId: activeThreadId,
        turnId: activeTurnId,
      });
      return;
    }

    if (method === 'turn/started') {
      if (requireNonEmptyString(params.threadId, 'turn/started thread id') !== activeThreadId) return;
      const turn = requireObject(params.turn, 'turn/started turn');
      const id = requireNonEmptyString(turn.id, 'turn/started turn id');
      if (completedTurnIds.has(id)) return;
      if (turnCompletion !== undefined && activeTurnId === undefined) {
        if (compactMode) {
          commitTurnId(id);
          return;
        }
        observePendingTurnId(id);
        pushEarlyActivity({ method, params, turnId: id, order: order ?? nextOrder() });
        return;
      }
      if (id === activeTurnId && turnStartedEmittedForTurnId !== id) {
        turnStartedEmittedForTurnId = id;
        emitDiagnostic({ type: 'turnStarted', threadId: activeThreadId, turnId: id });
      }
      return;
    }

    if (method === 'item/started') {
      if (requireNonEmptyString(params.threadId, 'item/started thread id') !== activeThreadId) return;
      const id = requireNonEmptyString(params.turnId, 'item/started turn id');
      if (completedTurnIds.has(id)) return;
      if (activeTurnId === undefined) {
        if (turnCompletion !== undefined) {
          pushEarlyActivity({ method, params, turnId: id, order: order ?? nextOrder() });
        }
        return;
      }
      if (id !== activeTurnId) return;
      const item = requireObject(params.item, 'item/started item');
      const kind = extractActivityKind(item);
      if (kind !== null && typeof item.id === 'string' && item.id.length > 0) {
        emitDiagnostic({
          type: 'activity',
          threadId: activeThreadId,
          turnId: activeTurnId,
          itemId: item.id,
          kind,
          phase: 'started',
        });
        emitDiagnostic({
          type: 'activityDetail', threadId: activeThreadId, turnId: activeTurnId,
          itemId: item.id, kind, phase: 'started', summary: summarizeActivity(item),
        });
      }
      return;
    }

    if (method === 'item/completed') {
      if (requireNonEmptyString(params.threadId, 'item/completed thread id') !== activeThreadId) return;
      const id = requireNonEmptyString(params.turnId, 'item/completed turn id');
      if (completedTurnIds.has(id)) return;
      if (activeTurnId === undefined) {
        if (turnCompletion !== undefined) {
          const item = isPlainObject(params.item) ? params.item : undefined;
          const isAnswerOrDecline = item?.type === 'agentMessage'
            || ((item?.type === 'commandExecution' || item?.type === 'fileChange') && item?.status === 'declined');
          const entry = { method, params, turnId: id, order: order ?? nextOrder() };
          if (isAnswerOrDecline) {
            pushEarlyAnswerOrDecision(entry);
          } else {
            pushEarlyActivity(entry);
          }
        }
        return;
      }
      if (id !== activeTurnId) return;
      const item = requireObject(params.item, 'item/completed item');
      const kind = extractActivityKind(item);
      const hasItemId = typeof item.id === 'string' && item.id.length > 0;
      if (kind !== null && hasItemId) {
        emitDiagnostic({
          type: 'activity',
          threadId: activeThreadId,
          turnId: activeTurnId,
          itemId: item.id,
          kind,
          phase: 'completed',
        });
        emitDiagnostic({
          type: 'activityDetail', threadId: activeThreadId, turnId: activeTurnId,
          itemId: item.id, kind, phase: 'completed', summary: summarizeActivity(item),
        });
      }
      if (hasItemId) {
        emitDiagnostic({
          type: 'itemCompleted', threadId: activeThreadId, turnId: activeTurnId,
          itemId: item.id, itemType: item.type, phase: item.phase ?? null,
        });
      }
      if (recordDeclinedItem(item, order)) return;
      if (item.type === 'contextCompaction') {
        compactedObserved = true;
        emitDiagnostic({
          type: 'compacted',
          threadId: activeThreadId,
          turnId: activeTurnId ?? null,
        });
        return;
      }
      if (item.type !== 'agentMessage') return;
      if (typeof item.text !== 'string') {
        throw new Error('subagent-codex: app-server returned an invalid agent message');
      }
      const previous = selectedAnswer();
      const answer = { text: item.text, itemId: hasItemId ? item.id : null, phase: item.phase ?? null };
      if (item.phase === 'final_answer') lastFinalAnswer = answer;
      else if (item.phase === 'partial_answer') lastPartialAnswer = answer;
      else if (item.phase === null || item.phase === undefined) lastUnphasedAnswer = answer;
      else if (item.phase !== 'commentary') {
        throw new Error(`subagent-codex: app-server returned an unknown agent message phase ${JSON.stringify(item.phase)}`);
      }
      if (selectedAnswer() !== previous) {
        emitDiagnostic({
          type: 'answerItemSelected', threadId: activeThreadId, turnId: activeTurnId,
          itemId: answer.itemId, phase: answer.phase,
        });
      }
      return;
    }

    if (method === 'turn/completed') {
      if (requireNonEmptyString(params.threadId, 'turn/completed thread id') !== activeThreadId) return;
      const turn = requireObject(params.turn, 'turn/completed turn');
      const id = requireNonEmptyString(turn.id, 'turn/completed turn id');
      if (completedTurnIds.has(id)) return;
      if (turnCompletion === undefined) return;
      if (activeTurnId === undefined) {
        if (compactMode) {
          commitTurnId(id);
        } else {
          observePendingTurnId(id);
          // Dedicated slot outside the bounded telemetry buffer so bursts of early
          // usage/item notifications can never evict a terminal turn/completed event.
          if (!earlyTurnCompletions.has(id)) {
            earlyTurnCompletions.set(id, { params, order: order ?? nextOrder() });
          }
          return;
        }
      }
      if (id !== activeTurnId) return;
      completedTurnIds.add(id);
      terminalObserved = true;
      const status = String(turn.status);
      if (!['completed', 'interrupted', 'failed'].includes(status)) {
        throw new Error(`subagent-codex: app-server returned invalid terminal turn status ${status}`);
      }
      const completion = turnCompletion;
      turnCompletion = undefined;
      completion.resolve({ params, order: order ?? nextOrder() });
    }
  };

  const commitTurnId = (id) => {
    if (pendingTurnId !== undefined && pendingTurnId !== id) {
      throw new Error('subagent-codex: turn/start response did not match the active turn');
    }
    activeTurnId = id;
    if (turnStartedEmittedForTurnId !== id) {
      turnStartedEmittedForTurnId = id;
      emitDiagnostic({ type: 'turnStarted', threadId: activeThreadId, turnId: id });
    }
    const deferredDiag = pendingDiagnostic;
    pendingDiagnostic = undefined;
    if (deferredDiag !== undefined) {
      recordDiagnostic(deferredDiag.request, deferredDiag.decision, deferredDiag.reason, deferredDiag.order);
    }
    const toReplay = [];
    for (const entry of earlyStreamNotifications.splice(0)) {
      if (entry.streamEvent.turnId === id) toReplay.push(entry);
    }
    for (const entry of earlyActivityNotifications.splice(0)) {
      if (entry.turnId === id && entry.method !== 'turn/started') {
        toReplay.push(entry);
      }
    }
    const earlyAnswers = earlyAnswersByTurnId.get(id) ?? [];
    earlyAnswersByTurnId.clear();
    for (const entry of earlyAnswers) {
      toReplay.push(entry);
    }
    const earlyTelemetry = earlyTelemetryByTurnId.get(id);
    earlyTelemetryByTurnId.clear();
    if (earlyTelemetry !== undefined) {
      toReplay.push(earlyTelemetry);
    }
    const earlyPlan = earlyPlanByTurnId.get(id);
    earlyPlanByTurnId.clear();
    if (earlyPlan !== undefined) {
      toReplay.push(earlyPlan);
    }
    const earlyDiff = earlyDiffByTurnId.get(id);
    earlyDiffByTurnId.clear();
    if (earlyDiff !== undefined) {
      toReplay.push(earlyDiff);
    }
    toReplay.sort((a, b) => a.order - b.order);
    for (const entry of toReplay) {
      if (entry.streamEvent) emitDiagnostic(entry.streamEvent);
      else handleNotification(entry.method, entry.params, entry.order);
    }
    const earlyCompletion = earlyTurnCompletions.get(id);
    earlyTurnCompletions.clear();
    if (earlyCompletion !== undefined) {
      handleNotification('turn/completed', earlyCompletion.params, earlyCompletion.order);
    }
  };

  const handleLine = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      emitDiagnostic({ type: 'malformed-frame' });
      return;
    }
    if (!isPlainObject(message)) return;
    const id = message.id;
    const method = message.method;

    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      const params = isPlainObject(message.params) ? message.params : {};
      void handleServerRequest(id, method, params);
      return;
    }

    if (typeof id === 'string' || typeof id === 'number') {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      waiter.cleanup();
      if (isPlainObject(message.error)) {
        const err = new CodexRpcError(
          typeof message.error.code === 'number' ? message.error.code : undefined,
          typeof message.error.message === 'string' ? message.error.message : 'JSON-RPC error',
          message.error.data,
          waiter.method,
        );
        waiter.reject(err);
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (typeof method === 'string') {
      const params = isPlainObject(message.params) ? message.params : {};
      try {
        handleNotification(method, params);
      } catch (error) {
        fail(toError(error));
      }
    }
  };

  const drainLines = () => {
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      bufferedBytes = Buffer.byteLength(buffer, 'utf8');
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
        fail(new CodexRpcError('FRAME_TOO_LARGE', `subagent-codex: JSON-RPC frame exceeded ${maxFrameBytes} bytes`));
        return;
      }
      handleLine(line);
      if (fatalError) return;
    }
    if (bufferedBytes > maxFrameBytes) {
      fail(new CodexRpcError('FRAME_TOO_LARGE', `subagent-codex: incomplete JSON-RPC frame exceeded ${maxFrameBytes} bytes`));
    }
  };

  const onData = (chunk) => {
    if (closed || fatalError) return;
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    buffer += text;
    bufferedBytes = Buffer.byteLength(buffer, 'utf8');
    drainLines();
  };

  const onStdoutEnd = () => {
    inputEnded = true;
    buffer += decoder.end();
    bufferedBytes = Buffer.byteLength(buffer, 'utf8');
    drainLines();
    fail(new Error('subagent-codex: app-server protocol stream closed'));
  };

  const onStdoutError = (err) => {
    fail(toError(err));
  };

  const onStdinError = (err) => {
    fail(toError(err));
  };

  const onWireAbort = () => {
    fail(abortError(wireSignal));
  };

  const ensureStarted = () => {
    if (started) return;
    started = true;
    stdout.on('data', onData);
    stdout.on('end', onStdoutEnd);
    stdout.on('error', onStdoutError);
    stdin.on('error', onStdinError);
    if (wireSignal) {
      if (wireSignal.aborted) {
        onWireAbort();
      } else {
        wireSignal.addEventListener('abort', onWireAbort, { once: true });
      }
    }
  };

  const request = (method, params, options = {}) => {
    ensureStarted();
    if (closed) return Promise.reject(new Error('subagent-codex: wire is closed'));
    if (fatalError) return Promise.reject(fatalError);

    const callSignal = normalizeSignal(options.signal);
    if (callSignal?.aborted) {
      return Promise.reject(abortError(callSignal));
    }

    const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
    const id = `req_${++reqSeq}_${randomUUID().slice(0, 8)}`;

    return new Promise((resolve, reject) => {
      let timer;
      let onAbort;
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (callSignal && onAbort) {
          callSignal.removeEventListener('abort', onAbort);
          onAbort = undefined;
        }
      };

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanup();
          const err = new CodexRpcError('ETIMEDOUT', `subagent-codex: app-server request "${method}" timed out after ${timeoutMs}ms`, undefined, method);
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      }

      if (callSignal) {
        onAbort = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanup();
          reject(abortError(callSignal));
        };
        callSignal.addEventListener('abort', onAbort, { once: true });
      }

      pending.set(id, { method, resolve, reject, cleanup });
      try {
        writeFrame({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        pending.delete(id);
        cleanup();
        reject(toError(error));
      }
    });
  };

  const collectOutput = () => {
    const selected = selectedAnswer()?.text;
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : [];
  };

  const close = () => {
    if (closed) return;
    closed = true;
    stdout.off('data', onData);
    stdout.off('end', onStdoutEnd);
    stdout.off('error', onStdoutError);
    stdin.off('error', onStdinError);
    if (wireSignal) wireSignal.removeEventListener('abort', onWireAbort);
    fail(new Error('subagent-codex: wire closed'));
  };

  const resetTurnState = (threadId, isCompact = false) => {
    activeThreadId = threadId;
    activeTurnId = undefined;
    pendingTurnId = undefined;
    compactMode = isCompact;
    compactedObserved = false;
    terminalObserved = false;
    earlyActivityNotifications = [];
    earlyStreamNotifications.length = 0;
    earlyTelemetryByTurnId.clear();
    earlyPlanByTurnId.clear();
    earlyDiffByTurnId.clear();
    earlyAnswersByTurnId.clear();
    earlyTurnCompletions.clear();
    lastHeartbeatByPhase.clear();
    turnStartedEmittedForTurnId = undefined;
    lastFinalAnswer = undefined;
    lastPartialAnswer = undefined;
    lastUnphasedAnswer = undefined;
    latestUsage = undefined;
    diagnostic = undefined;
    diagnosticOrder = 0;
    observationOrder = 0;
    failure = undefined;
    pendingDiagnostic = undefined;
  };

  const awaitTurnCompletion = async (completion, { signal: rawSignal, turnDeadline, turnTimeoutMs, timeoutMessage }) => {
    const turnSignal = normalizeSignal(rawSignal);
    try {
      if (turnSignal?.aborted) throw abortError(turnSignal);
      const races = [completion.promise];
      let onTurnAbort;
      let turnTimer;
      if (turnSignal) {
        races.push(new Promise((_resolve, reject) => {
          onTurnAbort = () => reject(abortError(turnSignal));
          turnSignal.addEventListener('abort', onTurnAbort, { once: true });
        }));
      }
      if (turnDeadline !== undefined) {
        const remainingMs = Math.max(1, turnDeadline - Date.now());
        races.push(new Promise((_resolve, reject) => {
          turnTimer = setTimeout(() => {
            const err = new CodexRpcError(
              'ETIMEDOUT',
              timeoutMessage ?? `subagent-codex: Codex turn timed out after ${turnTimeoutMs}ms`,
              undefined,
              'turn/completed',
            );
            if (activeThreadId && activeTurnId && !closed && !fatalError) {
              void request('turn/interrupt', { threadId: activeThreadId, turnId: activeTurnId }, { timeoutMs: 2000 }).catch(() => {});
            }
            reject(err);
          }, remainingMs);
        }));
      }
      try {
        return await Promise.race(races);
      } finally {
        if (onTurnAbort && turnSignal) turnSignal.removeEventListener('abort', onTurnAbort);
        if (turnTimer !== undefined) clearTimeout(turnTimer);
      }
    } catch (error) {
      if (turnCompletion === completion) turnCompletion = undefined;
      failure = error instanceof CodexRpcError && error.code === 'ETIMEDOUT'
        ? { stage: 'turn', category: 'timeout' }
        : { stage: 'turn', category: 'unknown' };
      throw error;
    }
  };

  return {
    async initialize(options = {}) {
      ensureStarted();
      const params = options.params ?? {
        clientInfo: {
          name: 'codex-subagent',
          title: 'Antigravity Codex Subagent',
          version: '0.5.0',
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      };
      const result = requireObject(await request('initialize', params, options), 'initialize response');
      writeFrame({ jsonrpc: '2.0', method: 'initialized' });
      await flushOutput();
      return result;
    },

    async readConfig(params = {}, options = {}) {
      const cleanParams = { includeLayers: false, ...requireObject(params, 'config/read params') };
      return requireObject(await request('config/read', cleanParams, options), 'config/read response');
    },

    async listModels(params = {}, options = {}) {
      const cleanParams = requireObject(params, 'model/list params');
      return requireObject(await request('model/list', cleanParams, options), 'model/list response');
    },

    async readAccountRateLimits(params = {}, options = {}) {
      const cleanParams = requireObject(params, 'account/rateLimits/read params');
      return requireObject(await request('account/rateLimits/read', cleanParams, options), 'account/rateLimits/read response');
    },

    async batchWriteConfig(params, options = {}) {
      const cleanParams = requireObject(params, 'config/batchWrite params');
      return requireObject(await request('config/batchWrite', cleanParams, options), 'config/batchWrite response');
    },

    async startThread(params, options = {}) {
      const res = requireObject(await request('thread/start', params, options), 'thread/start response');
      const thread = requireObject(res.thread, 'thread/start thread');
      const id = requireNonEmptyString(thread.id, 'thread/start thread id');
      if (params?.ephemeral === true && thread.ephemeral !== true) {
        throw new Error('subagent-codex: app-server did not create an ephemeral thread');
      }
      if (params?.ephemeral === false && thread.ephemeral === true) {
        throw new Error('subagent-codex: app-server unexpectedly created an ephemeral thread');
      }
      activeThreadId = id;
      return res;
    },

    async readThread(threadIdOrParams, options = {}) {
      const params = typeof threadIdOrParams === 'string'
        ? { threadId: threadIdOrParams, includeTurns: options.includeTurns ?? false }
        : requireObject(threadIdOrParams, 'thread/read params');
      const res = requireObject(await request('thread/read', params, options), 'thread/read response');
      const thread = requireObject(res.thread, 'thread/read thread');
      requireNonEmptyString(thread.id, 'thread/read thread id');
      return res;
    },

    async resumeThread(params, options = {}) {
      const cleanParams = { ...requireObject(params, 'thread/resume params') };
      delete cleanParams.ephemeral;
      const res = requireObject(await request('thread/resume', cleanParams, options), 'thread/resume response');
      const thread = requireObject(res.thread, 'thread/resume thread');
      const id = requireNonEmptyString(thread.id, 'thread/resume thread id');
      activeThreadId = id;
      return res;
    },

    async forkThread(params, options = {}) {
      const cleanParams = { ...requireObject(params, 'thread/fork params') };
      requireNonEmptyString(cleanParams.threadId, 'thread/fork threadId');
      const res = requireObject(await request('thread/fork', cleanParams, options), 'thread/fork response');
      const thread = requireObject(res.thread, 'thread/fork thread');
      const id = requireNonEmptyString(thread.id, 'thread/fork thread id');
      if (cleanParams.ephemeral === true && thread.ephemeral !== true) {
        throw new Error('subagent-codex: app-server did not create an ephemeral forked thread');
      }
      if (cleanParams.ephemeral === false && thread.ephemeral === true) {
        throw new Error('subagent-codex: app-server unexpectedly created an ephemeral forked thread');
      }
      activeThreadId = id;
      return res;
    },

    async startTurn(params, options = {}) {
      if (turnCompletion !== undefined) {
        throw new Error('subagent-codex: a turn is already active on this wire');
      }
      const turnParams = requireObject(params, 'turn/start params');
      const threadId = requireNonEmptyString(turnParams.threadId ?? activeThreadId, 'turn/start threadId');
      resetTurnState(threadId, false);

      const input = normalizeTurnInput(turnParams.input);
      const completion = Promise.withResolvers();
      turnCompletion = completion;
      // Avoid unhandled rejection if caller aborts before awaiting completion.
      completion.promise.catch(() => {});

      const turnTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : undefined;
      const rpcOptions = { signal: options.signal };
      if (turnTimeoutMs !== undefined && turnTimeoutMs < requestTimeoutMs) {
        rpcOptions.timeoutMs = turnTimeoutMs;
      }
      const turnDeadline = turnTimeoutMs !== undefined ? Date.now() + turnTimeoutMs : undefined;

      try {
        const res = requireObject(
          await request('turn/start', { ...turnParams, threadId, input }, rpcOptions),
          'turn/start response',
        );
        const turn = requireObject(res.turn, 'turn/start turn');
        commitTurnId(requireNonEmptyString(turn.id, 'turn/start turn id'));
      } catch (error) {
        turnCompletion = undefined;
        earlyTurnCompletions.clear();
        failure = { stage: 'turn-start', category: 'unknown' };
        throw error;
      }

      const completed = await awaitTurnCompletion(completion, {
        signal: options.signal,
        turnDeadline,
        turnTimeoutMs,
      });

      const terminal = requireObject(completed.params.turn, 'turn/completed turn');
      const status = terminal.status;
      if (status !== 'completed') {
        const parsed = extractTurnFailureInfo(terminal);
        failure = parsed.httpStatus === undefined
          ? { stage: 'turn', category: parsed.category }
          : { stage: 'turn', category: parsed.category, httpStatus: parsed.httpStatus };
        if (parsed.sandboxFailure) {
          recordDiagnostic('sandbox execution', 'failed', 'Codex reported a sandbox failure', completed.order);
        }
        if (parsed.maxTokens) {
          return {
            turnId: activeTurnId,
            status,
            turn: terminal,
            output: collectOutput(),
            stopReason: 'max-tokens',
            usage: latestUsage,
            diagnostic,
            failure,
          };
        }
        const detail = status === 'failed' ? `: ${parsed.category}` : '';
        throw new Error(`subagent-codex: Codex turn ended with status ${String(status)}${detail}`);
      }

      const output = collectOutput();
      if (output.length === 0) {
        failure = { stage: 'turn', category: 'invalid-result' };
        throw new Error('subagent-codex: Codex completed without an answer');
      }

      return {
        turnId: activeTurnId,
        status,
        turn: terminal,
        output,
        stopReason: 'completed',
        usage: latestUsage,
        diagnostic,
      };
    },

    async steerTurn(params, options = {}) {
      const steerParams = requireObject(params, 'turn/steer params');
      const threadId = requireNonEmptyString(steerParams.threadId ?? activeThreadId, 'turn/steer threadId');
      const expectedTurnId = requireNonEmptyString(steerParams.expectedTurnId ?? activeTurnId, 'turn/steer expectedTurnId');
      const input = normalizeTurnInput(steerParams.input);
      const res = requireObject(
        await request('turn/steer', { threadId, expectedTurnId, input }, options),
        'turn/steer response',
      );
      return {
        turnId: requireNonEmptyString(res.turnId, 'turn/steer turnId'),
      };
    },

    async compactThread(threadId, options = {}) {
      if (turnCompletion !== undefined) {
        throw new Error('subagent-codex: a turn is already active on this wire');
      }
      const id = requireNonEmptyString(threadId ?? activeThreadId, 'thread/compact/start threadId');
      resetTurnState(id, true);

      const completion = Promise.withResolvers();
      turnCompletion = completion;
      completion.promise.catch(() => {});

      const turnTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : undefined;
      const rpcOptions = { signal: options.signal };
      if (turnTimeoutMs !== undefined && turnTimeoutMs < requestTimeoutMs) {
        rpcOptions.timeoutMs = turnTimeoutMs;
      }
      const turnDeadline = turnTimeoutMs !== undefined ? Date.now() + turnTimeoutMs : undefined;

      try {
        try {
          requireObject(
            await request('thread/compact/start', { threadId: id }, rpcOptions),
            'thread/compact/start response',
          );
        } catch (error) {
          turnCompletion = undefined;
          earlyTurnCompletions.clear();
          failure = { stage: 'compact-start', category: 'unknown' };
          throw error;
        }

        const completed = await awaitTurnCompletion(completion, {
          signal: options.signal,
          turnDeadline,
          turnTimeoutMs,
          timeoutMessage: `subagent-codex: Codex compaction timed out after ${turnTimeoutMs}ms`,
        });

        const terminal = requireObject(completed.params.turn, 'turn/completed turn');
        const status = terminal.status;
        if (status !== 'completed') {
          const parsed = extractTurnFailureInfo(terminal);
          failure = parsed.httpStatus === undefined
            ? { stage: 'compact', category: parsed.category }
            : { stage: 'compact', category: parsed.category, httpStatus: parsed.httpStatus };
          const detail = status === 'failed' ? `: ${parsed.category}` : '';
          throw new Error(`subagent-codex: Codex compaction ended with status ${String(status)}${detail}`);
        }
        if (!activeTurnId || !compactedObserved) {
          failure = { stage: 'compact', category: 'invalid-result' };
          throw new Error('subagent-codex: Codex compaction completed without compaction confirmation');
        }

        return {
          turnId: activeTurnId,
          status,
          compacted: compactedObserved,
          usage: latestUsage,
          diagnostic,
        };
      } finally {
        compactMode = false;
      }
    },

    async archiveThread(threadId, options = {}) {
      const id = requireNonEmptyString(threadId, 'thread/archive threadId');
      return requireObject(await request('thread/archive', { threadId: id }, options), 'thread/archive response');
    },

    async interrupt(threadId = activeThreadId, turnId = activeTurnId) {
      if (closed || fatalError || !threadId || !turnId) return;
      try {
        await request('turn/interrupt', { threadId, turnId }, { timeoutMs: 2000 });
      } catch {
        // Best-effort remote cancellation.
      }
    },

    close,
    collectOutput,
    collectDiagnostic: () => diagnostic,
    collectFailure: () => failure,
    collectUsage: () => latestUsage,
    observedTurnStart: () => activeTurnId !== undefined || pendingTurnId !== undefined,
    endedBeforeTerminal: () => inputEnded && !terminalObserved,
    getThreadId: () => activeThreadId,
    getTurnId: () => activeTurnId,
  };
}
