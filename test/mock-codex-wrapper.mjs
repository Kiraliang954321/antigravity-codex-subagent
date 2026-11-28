import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const stateDir = process.env.MOCK_CODEX_STATE_DIR;
if (!stateDir) {
  process.stderr.write('MOCK_CODEX_STATE_DIR is required\n');
  process.exit(2);
}

const sessionsDir = path.join(stateDir, 'sessions');
const archivedDir = path.join(stateDir, 'archived_sessions');
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(archivedDir, { recursive: true });

const SANDBOX_MAP = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'workspace-write': { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  'danger-full-access': { type: 'dangerFullAccess' },
};

const configPath = path.join(stateDir, 'mock-codex-config.json');
const configWritesPath = path.join(stateDir, 'mock-config-writes.txt');
const effortOption = (reasoningEffort, description) => ({ reasoningEffort, description });
const defaultModels = [
  {
    id: 'mock-codex-pro', model: 'mock-codex-pro', displayName: 'Mock Codex Pro',
    description: 'Balanced flagship coding model.', hidden: false, isDefault: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      effortOption('low', 'Fast responses'), effortOption('medium', 'Balanced reasoning'),
      effortOption('high', 'Deep reasoning'), effortOption('xhigh', 'Extra high reasoning'),
      effortOption('max', 'Maximum reasoning'), effortOption('ultra', 'Maximum with delegation'),
    ],
  },
  {
    id: 'mock-codex-fast', model: 'mock-codex-fast', displayName: 'Mock Codex Fast',
    description: 'Quick turnaround for everyday edits.', hidden: false, isDefault: false, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      effortOption('low', 'Fast'), effortOption('medium', 'Balanced'), effortOption('high', 'Thorough'),
      effortOption('xhigh', 'Extra high'), effortOption('max', 'Max'),
    ],
  },
  {
    id: 'mock-codex-mini', model: 'mock-codex-mini', displayName: 'Mock Codex Mini',
    description: 'Lightweight model for quick checks.', hidden: false, isDefault: false, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      effortOption('low', 'Fast'), effortOption('medium', 'Balanced'), effortOption('high', 'Thorough'),
    ],
  },
];

function saveMockConfig(cfg) {
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(cfg), 'utf8');
  renameSync(temporaryPath, configPath);
}

function loadMockConfig() {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const seed = {
    model: process.env.MOCK_CODEX_CONFIG_MODEL || null,
    model_reasoning_effort: process.env.MOCK_CODEX_CONFIG_EFFORT || null,
  };
  try {
    writeFileSync(configPath, JSON.stringify(seed), { encoding: 'utf8', flag: 'wx' });
    return seed;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return JSON.parse(readFileSync(configPath, 'utf8'));
  }
}

function metaPath(threadId) {
  return path.join(stateDir, `meta-${threadId}.json`);
}

function loadMeta(threadId) {
  const p = metaPath(threadId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function saveMeta(meta) {
  writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf8');
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

const activeThreads = new Map();
const activeTurns = new Map();
let turnCounter = 0;

function parseDirective(input) {
  const textBlock = (input ?? []).find((b) => b.type === 'text');
  const raw = textBlock?.text ?? '';
  try {
    return JSON.parse(raw);
  } catch {
    return { mode: 'echo', text: raw };
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function handleRequest(msg) {
  const { id, method, params = {} } = msg;
  const rpcLog = process.env.MOCK_CODEX_CONFIG_RPC_LOG;
  if (rpcLog && ['initialize', 'config/read', 'config/batchWrite', 'model/list', 'account/rateLimits/read'].includes(method)) {
    appendFileSync(rpcLog, JSON.stringify({ method, cursor: params.cursor ?? null }) + '\n');
  }

  if (method === 'initialize') {
    sendResult(id, { userAgent: 'mock-codex/0.166.0', clientInfo: params.clientInfo ?? null });
    return;
  }
  if (method === 'initialized') return;

  if (method === 'config/read') {
    const cfg = loadMockConfig();
    sendResult(id, {
      config: { model: cfg.model ?? null, model_reasoning_effort: cfg.model_reasoning_effort ?? null },
      origins: {},
    });
    return;
  }

  if (method === 'config/batchWrite') {
    if (process.env.MOCK_CODEX_CONFIG_WRITE_FAIL === '1' || existsSync(path.join(stateDir, 'reject-config-write'))) {
      sendError(id, -32603, 'mock config write error');
      return;
    }
    const cfg = loadMockConfig();
    for (const { keyPath, value } of params.edits ?? []) {
      if (keyPath === 'model' || keyPath === 'model_reasoning_effort') {
        cfg[keyPath] = typeof value === 'string' ? (value.trim() || null) : null;
      }
    }
    saveMockConfig(cfg);
    const writes = existsSync(configWritesPath) ? Number(readFileSync(configWritesPath, 'utf8')) : 0;
    writeFileSync(configWritesPath, String(writes + 1), 'utf8');
    const overridden = process.env.MOCK_CODEX_CONFIG_OVERRIDDEN === '1';
    sendResult(id, {
      status: overridden ? 'okOverridden' : 'ok',
      filePath: configPath,
      version: 'sha256:mock',
      overriddenMetadata: overridden ? {
        effectiveValue: cfg.model, message: 'Overridden by test layer',
        overridingLayer: { name: { type: 'sessionFlags' }, version: '1' },
      } : null,
    });
    return;
  }

  if (method === 'model/list') {
    const entries = process.env.MOCK_CODEX_MODELS_JSON ? JSON.parse(process.env.MOCK_CODEX_MODELS_JSON) : defaultModels;
    const models = params.includeHidden === true ? entries : entries.filter((entry) => entry.hidden !== true);
    const offset = Number(params.cursor ?? 0);
    const end = offset + (params.limit ?? 2);
    sendResult(id, { data: models.slice(offset, end), nextCursor: end < models.length ? String(end) : null });
    return;
  }

  if (method === 'account/rateLimits/read') {
    if (process.env.MOCK_CODEX_RATE_LIMITS_FAIL === '1' || existsSync(path.join(stateDir, 'reject-rate-limits'))) {
      sendError(id, -32601, 'mock rate limits unavailable');
      return;
    }

    const mockRateLimitsPath = path.join(stateDir, 'mock-rate-limits.json');
    const mockJson = existsSync(mockRateLimitsPath)
      ? readFileSync(mockRateLimitsPath, 'utf8') : process.env.MOCK_CODEX_RATE_LIMITS_JSON;
    const nowSec = Math.floor(Date.now() / 1000);
    const defaultSnap = {
      planType: 'plus',
      ordinaryUsageAllowed: true,
      primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: nowSec + 15840 },
      secondary: { usedPercent: 94, windowDurationMins: 10080, resetsAt: nowSec + 259200 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      spendControlReached: false,
      rateLimitReachedType: null,
    };
    const { rawEnvelope, ...snapshot } = (mockJson ? JSON.parse(mockJson) : null) ?? defaultSnap;
    if (rawEnvelope === true) {
      sendResult(id, snapshot);
      return;
    }

    const { ordinaryUsageAllowed, ...bucket } = snapshot;
    sendResult(id, {
      ordinaryUsageAllowed: ordinaryUsageAllowed ?? null,
      rateLimits: bucket,
      rateLimitsByLimitId: { codex: bucket },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{
          id: 'mock-reset-credit-1', resetType: 'codexRateLimits', status: 'available',
          grantedAt: nowSec - 100, expiresAt: nowSec + 86400, title: 'Full reset', description: 'Mock reset credit',
        }],
      },
      accountId: 'mock-account-id-must-strip',
      rateLimitUpsell: null,
    });
    return;
  }

  if (method === 'thread/start') {
    const cfg = loadMockConfig();
    const threadId = randomUUID();
    const ephemeral = Boolean(params.ephemeral);
    const rolloutPath = ephemeral ? null : path.join(sessionsDir, `rollout-${threadId}.jsonl`);
    if (rolloutPath) {
      writeFileSync(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`, 'utf8');
    }

    const sandboxMode = params.sandbox;
    let sandboxPolicy = sandboxMode ? (SANDBOX_MAP[sandboxMode] ?? SANDBOX_MAP['workspace-write']) : SANDBOX_MAP['workspace-write'];
    if (process.env.MOCK_CODEX_BAD_SANDBOX === 'omit') {
      sandboxPolicy = undefined;
    } else if (process.env.MOCK_CODEX_BAD_SANDBOX === 'mismatch') {
      sandboxPolicy = SANDBOX_MAP['workspace-write'];
    }

    let approvalPolicy = params.approvalPolicy ?? 'never';
    if (process.env.MOCK_CODEX_BAD_APPROVAL === 'on-request') {
      approvalPolicy = 'on-request';
    } else if (process.env.MOCK_CODEX_BAD_APPROVAL === 'omit') {
      approvalPolicy = undefined;
    }

    let model = params.model ?? cfg.model ?? 'mock-codex-model';
    const reasoningEffort = params.config?.model_reasoning_effort ?? cfg.model_reasoning_effort ?? null;
    if (process.env.MOCK_CODEX_WRONG_MODEL) {
      model = process.env.MOCK_CODEX_WRONG_MODEL;
    }

    const meta = {
      id: threadId,
      cwd: params.cwd,
      model,
      reasoningEffort,
      ephemeral,
      path: rolloutPath,
      archived: false,
      approvalPolicy,
      sandbox: sandboxPolicy,
      turns: [],
      lastStartParams: params,
    };
    if (!ephemeral) saveMeta(meta);
    activeThreads.set(threadId, meta);

    sendResult(id, {
      thread: {
        id: threadId,
        cwd: meta.cwd,
        ephemeral,
        path: rolloutPath,
        archived: false,
        status: { type: 'idle' },
        turns: [],
      },
      model: meta.model,
      cwd: meta.cwd,
      ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
      ...(sandboxPolicy !== undefined ? { sandbox: sandboxPolicy } : {}),
    });
    return;
  }

  if (method === 'thread/read') {
    const meta = activeThreads.get(params.threadId) ?? loadMeta(params.threadId);
    if (!meta) {
      sendError(id, -32600, `no rollout found for thread id ${params.threadId}`);
      return;
    }
    if (meta.simulateReadTimeout) {
      return;
    }
    if (meta.simulateReadRpcError) {
      sendError(id, -32600, meta.simulateReadRpcError);
      return;
    }
    sendResult(id, {
      thread: {
        id: meta.id,
        cwd: meta.cwd,
        ephemeral: meta.ephemeral ?? false,
        path: meta.path,
        archived: Boolean(meta.archived),
        status: meta.status ?? { type: 'idle' },
        turns: [],
      },
    });
    return;
  }

  if (method === 'thread/resume') {
    const meta = activeThreads.get(params.threadId) ?? loadMeta(params.threadId);
    if (!meta) {
      sendError(id, -32600, `no rollout found for thread id ${params.threadId}`);
      return;
    }
    if (meta.archived) {
      sendError(id, -32600, `thread ${params.threadId} is archived`);
      return;
    }
    const cfg = loadMockConfig();
    meta.reasoningEffort = params.config?.model_reasoning_effort ?? cfg.model_reasoning_effort ?? meta.reasoningEffort ?? null;
    if (params.model !== undefined && params.model !== null) {
      meta.model = params.model;
    }
    if (process.env.MOCK_CODEX_WRONG_MODEL) {
      meta.model = process.env.MOCK_CODEX_WRONG_MODEL;
    }
    let approvalPolicy = params.approvalPolicy !== undefined && params.approvalPolicy !== null
      ? params.approvalPolicy
      : (meta.approvalPolicy ?? 'never');
    if (process.env.MOCK_CODEX_BAD_APPROVAL === 'on-request') {
      approvalPolicy = 'on-request';
    } else if (process.env.MOCK_CODEX_BAD_APPROVAL === 'omit') {
      approvalPolicy = undefined;
    }
    meta.approvalPolicy = approvalPolicy;

    let sandboxPolicy = params.sandbox
      ? (SANDBOX_MAP[params.sandbox] ?? SANDBOX_MAP['workspace-write'])
      : SANDBOX_MAP['workspace-write'];
    if (process.env.MOCK_CODEX_BAD_SANDBOX === 'omit') {
      sandboxPolicy = undefined;
    } else if (process.env.MOCK_CODEX_BAD_SANDBOX === 'mismatch') {
      sandboxPolicy = SANDBOX_MAP['workspace-write'];
    }
    meta.sandbox = sandboxPolicy;
    meta.lastResumeParams = params;
    saveMeta(meta);
    activeThreads.set(meta.id, meta);

    sendResult(id, {
      thread: {
        id: meta.id,
        cwd: meta.cwd,
        ephemeral: false,
        path: meta.path,
        archived: false,
        status: { type: 'idle' },
        turns: [],
      },
      model: meta.model,
      cwd: meta.cwd,
      ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
      ...(sandboxPolicy !== undefined ? { sandbox: sandboxPolicy } : {}),
    });
    return;
  }

  if (method === 'thread/fork') {
    const source = activeThreads.get(params.threadId) ?? loadMeta(params.threadId);
    if (!source) {
      sendError(id, -32600, `no rollout found for thread id ${params.threadId}`);
      return;
    }
    if (source.archived) {
      sendError(id, -32600, `thread ${params.threadId} is archived`);
      return;
    }
    const newThreadId = process.env.MOCK_CODEX_FORK_COLLIDE_ID || randomUUID();
    const newRolloutPath = path.join(sessionsDir, `rollout-${newThreadId}.jsonl`);
    writeFileSync(
      newRolloutPath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: newThreadId, forkedFrom: source.id, lastTurnId: params.lastTurnId ?? null } })}\n`,
      'utf8',
    );
    const cfg = loadMockConfig();
    const model = params.model ?? source.model ?? cfg.model ?? 'mock-codex-model';
    const reasoningEffort = params.config?.model_reasoning_effort ?? source.reasoningEffort ?? cfg.model_reasoning_effort ?? null;
    const approvalPolicy = params.approvalPolicy ?? source.approvalPolicy ?? 'never';
    const sandboxPolicy = params.sandbox
      ? (SANDBOX_MAP[params.sandbox] ?? SANDBOX_MAP['workspace-write'])
      : (source.sandbox ?? SANDBOX_MAP['workspace-write']);
    const forkedMeta = {
      id: newThreadId,
      cwd: params.cwd ?? source.cwd,
      model,
      reasoningEffort,
      ephemeral: Boolean(params.ephemeral),
      path: newRolloutPath,
      archived: false,
      approvalPolicy,
      sandbox: sandboxPolicy,
      forkedFrom: source.id,
      lastTurnId: params.lastTurnId ?? null,
      turns: [],
    };
    saveMeta(forkedMeta);
    activeThreads.set(newThreadId, forkedMeta);

    sendResult(id, {
      thread: {
        id: newThreadId,
        cwd: forkedMeta.cwd,
        ephemeral: false,
        path: newRolloutPath,
        archived: false,
        status: { type: 'idle' },
        turns: [],
      },
      model: forkedMeta.model,
      modelProvider: 'openai',
      serviceTier: null,
      disabledPluginIds: [],
      cwd: forkedMeta.cwd,
      instructionSources: [],
      approvalPolicy,
      approvalsReviewer: params.approvalsReviewer ?? 'user',
      sandbox: sandboxPolicy,
      reasoningEffort: null,
    });
    return;
  }

  if (method === 'thread/compact/start') {
    if (process.env.MOCK_CODEX_REJECT_COMPACT === '1') {
      sendError(id, -32600, 'compaction temporarily unavailable');
      return;
    }
    const meta = activeThreads.get(params.threadId) ?? loadMeta(params.threadId);
    if (!meta) {
      sendError(id, -32600, `no rollout found for thread id ${params.threadId}`);
      return;
    }
    const turnId = `compact_${++turnCounter}_${randomUUID().slice(0, 6)}`;
    sendResult(id, {});
    sendNotification('turn/started', {
      threadId: meta.id,
      turn: { id: turnId, status: 'inProgress', items: [] },
    });
    await sleep(Number(process.env.MOCK_CODEX_COMPACT_DELAY_MS ?? 120));
    const omitNotification = process.env.MOCK_CODEX_OMIT_COMPACT_PROOF === '1' || process.env.MOCK_CODEX_COMPACT_STALE_NOTIFY === '1';
    const omitRolloutCompaction = process.env.MOCK_CODEX_OMIT_COMPACT_PROOF === '1' || process.env.MOCK_CODEX_OMIT_COMPACT_ROLLOUT === '1';
    if (process.env.MOCK_CODEX_COMPACT_STALE_NOTIFY === '1') {
      sendNotification('thread/compacted', { threadId: meta.id, turnId: 'stale-old-turn' });
    }
    if (meta.path) {
      const records = [];
      if (!omitRolloutCompaction) {
        records.push(JSON.stringify({ type: 'compacted', payload: { message: '' } }));
        records.push(JSON.stringify({
          type: 'event_msg',
          payload: { type: 'item_completed', thread_id: meta.id, turn_id: turnId, item: { type: 'ContextCompaction', id: `cmp-${turnId}` } },
        }));
      }
      if (process.env.MOCK_CODEX_OMIT_COMPACT_PROOF !== '1') {
        records.push(JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: turnId, root_turn_id: turnId },
        }));
      }
      if (records.length > 0) {
        const prev = existsSync(meta.path) ? readFileSync(meta.path, 'utf8') : '';
        writeFileSync(meta.path, `${prev}${records.join('\n')}\n`, 'utf8');
      }
    }
    if (!omitNotification) {
      sendNotification('item/completed', {
        threadId: meta.id,
        turnId,
        item: { id: `cmp-${turnId}`, type: 'contextCompaction' },
      });
      sendNotification('thread/compacted', { threadId: meta.id, turnId });
    }
    sendNotification('thread/tokenUsage/updated', {
      threadId: meta.id,
      turnId,
      tokenUsage: {
        last: { totalTokens: 12000 },
        modelContextWindow: 100000,
      },
    });
    sendNotification('turn/completed', {
      threadId: meta.id,
      turn: { id: turnId, status: 'completed' },
    });
    return;
  }

  if (method === 'thread/archive') {
    const meta = activeThreads.get(params.threadId) ?? loadMeta(params.threadId);
    if (!meta) {
      sendError(id, -32600, `no rollout found for thread id ${params.threadId}`);
      return;
    }
    if (!meta.archived) {
      const dest = path.join(archivedDir, `rollout-${meta.id}.jsonl`);
      if (meta.path && existsSync(meta.path)) {
        renameSync(meta.path, dest);
      }
      meta.path = dest;
      meta.archived = true;
      saveMeta(meta);
    }
    sendResult(id, {});
    return;
  }

  if (method === 'turn/steer') {
    const turnState = activeTurns.get(params.expectedTurnId);
    if (!turnState || turnState.threadId !== params.threadId || turnState.completed) {
      sendError(id, -32600, 'activeTurnNotSteerable');
      return;
    }
    const steerText = (params.input ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const steerImages = (params.input ?? []).filter((b) => b.type === 'localImage').map((b) => b.path);
    turnState.steeredInputs.push({ text: steerText, images: steerImages });
    sendResult(id, { turnId: params.expectedTurnId });
    turnState.resolveSteer?.();
    return;
  }

  if (method === 'turn/interrupt') {
    sendResult(id, {});
    return;
  }

  if (method === 'turn/start') {
    const meta = activeThreads.get(params.threadId) ?? loadMeta(params.threadId);
    if (!meta) {
      sendError(id, -32600, `no rollout found for thread id ${params.threadId}`);
      return;
    }
    const cfg = loadMockConfig();
    const turnId = `turn_${++turnCounter}_${randomUUID().slice(0, 6)}`;
    const directive = parseDirective(params.input);

    const turnState = {
      threadId: meta.id,
      turnId,
      completed: false,
      steeredInputs: [],
      resolveSteer: null,
    };
    activeTurns.set(turnId, turnState);

    sendResult(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
    sendNotification('turn/started', {
      threadId: meta.id,
      turn: { id: turnId, status: 'inProgress', items: [] },
    });

    if (directive.mode === 'hang_turn') {
      return;
    }

    if (directive.mode === 'wait_for_steer') {
      await new Promise((resolve) => {
        turnState.resolveSteer = resolve;
        setTimeout(resolve, directive.maxWaitMs ?? 8000);
      });
      if (directive.afterSteerDelayMs) await sleep(directive.afterSteerDelayMs);
    } else if (directive.mode === 'stream_plan_diff') {
      await sleep(300);
      sendNotification('item/reasoning/summaryTextDelta', {
        threadId: meta.id,
        turnId,
        itemId: 'r-1',
        delta: 'SECRET_THOUGHT_DELTA',
        summaryIndex: 0,
      });
      sendNotification('turn/plan/updated', {
        threadId: meta.id,
        turnId,
        explanation: 'Inspecting files',
        plan: [
          { step: 'Read target config', status: 'completed' },
          { step: 'Apply safe fix', status: 'inProgress' },
        ],
      });
      await sleep(600);
      sendNotification('item/commandExecution/outputDelta', {
        threadId: meta.id,
        turnId,
        itemId: 'cmd-1',
        delta: 'SECRET_CMD_DELTA_LINE',
      });
      sendNotification('turn/diff/updated', {
        threadId: meta.id,
        turnId,
        diff: 'diff --git a/src/app.mjs b/src/app.mjs\n--- a/src/app.mjs\n+++ b/src/app.mjs\n@@ -1 +1 @@\n+SECRET_DIFF_BODY\n',
      });
      await sleep(600);
      sendNotification('item/agentMessage/delta', {
        threadId: meta.id,
        turnId,
        itemId: 'msg-delta',
        delta: 'streaming...',
      });
      await sleep(200);
    } else if (directive.mode === 'telemetry_concurrent') {
      sendNotification('item/started', {
        threadId: meta.id,
        turnId,
        item: { id: 'item-1', type: 'commandExecution', command: 'echo SECRET_CMD_LEAK', cwd: '/secret/dir' },
      });
      sendNotification('item/started', {
        threadId: meta.id,
        turnId,
        item: { id: 'item-2', type: 'fileChange', changes: [{ path: '/secret/file.ts', diff: 'SECRET_DIFF' }] },
      });
      sendNotification('turn/started', {
        threadId: meta.id,
        turn: { id: turnId, status: 'inProgress', items: [] },
      });
      sendNotification('item/completed', {
        threadId: meta.id,
        turnId,
        item: { id: 'item-1', type: 'commandExecution', status: 'completed', command: 'echo SECRET_CMD_LEAK' },
      });
      sendNotification('item/started', {
        threadId: meta.id,
        turnId,
        item: { id: 'item-3', type: 'mcpToolCall', tool: 'secret_tool', arguments: { key: 'SECRET_ARG' } },
      });
      sendNotification('item/completed', {
        threadId: meta.id,
        turnId,
        item: { id: 'item-3', type: 'mcpToolCall', status: 'completed' },
      });
      sendNotification('item/started', {
        threadId: meta.id,
        turnId,
        item: { id: 'item-4', type: 'agentMessage', phase: 'commentary', text: 'SECRET_COMMENTARY' },
      });
      sendNotification('item/completed', {
        threadId: meta.id,
        turnId,
        item: { id: 'item-4', type: 'agentMessage', phase: 'commentary', text: 'SECRET_COMMENTARY' },
      });
      sendNotification('thread/tokenUsage/updated', {
        threadId: meta.id,
        turnId,
        tokenUsage: {
          last: { totalTokens: 45000 },
          modelContextWindow: 100000,
        },
      });
      await sleep(300);
      process.stderr.write('noisy stderr heartbeat that must not reset idleMs\n');
      await sleep(1100);
      sendNotification('item/completed', {
        threadId: meta.id,
        turnId,
        item: { id: 'item-2', type: 'fileChange', status: 'completed' },
      });
    } else if (directive.delayMs) {
      await sleep(directive.delayMs);
    }

    if (directive.usage !== undefined) {
      sendNotification('thread/tokenUsage/updated', {
        threadId: meta.id,
        turnId,
        tokenUsage: {
          last: { totalTokens: directive.usage.totalTokens },
          modelContextWindow: directive.usage.modelContextWindow,
        },
      });
    }

    if (directive.mode === 'max_tokens') {
      turnState.completed = true;
      sendNotification('item/completed', {
        threadId: meta.id,
        turnId,
        item: { id: 'msg-partial', type: 'agentMessage', phase: 'partial_answer', text: 'partial before limit' },
      });
      sendNotification('turn/completed', {
        threadId: meta.id,
        turn: {
          id: turnId,
          status: 'failed',
          error: { message: 'context exceeded', codexErrorInfo: 'contextWindowExceeded' },
        },
      });
      return;
    }

    const answerPayload = {
      pid: process.pid,
      threadId: meta.id,
      turnId,
      model: meta.model,
      approvalPolicy: meta.approvalPolicy,
      sandbox: meta.sandbox,
      turnApprovalPolicy: params.approvalPolicy ?? null,
      turnSandboxPolicy: params.sandboxPolicy ?? null,
      turnModel: params.model ?? null,
      effort: params.effort ?? meta.reasoningEffort ?? cfg.model_reasoning_effort ?? null,
      outputSchema: params.outputSchema ?? null,
      forkedFrom: meta.forkedFrom ?? null,
      lastTurnId: meta.lastTurnId ?? null,
      excludeTurns: meta.lastResumeParams?.excludeTurns ?? null,
      lastResumeSandboxParam: meta.lastResumeParams?.sandbox ?? null,
      images: (params.input ?? []).filter((b) => b.type === 'localImage').map((b) => b.path),
      steeredInputs: turnState.steeredInputs,
      note: directive.note ?? null,
    };

    if (!meta.ephemeral && meta.path && !directive.skipRolloutTaskComplete) {
      const line = `${JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turnId, root_turn_id: turnId },
      })}\n`;
      const prev = existsSync(meta.path) ? readFileSync(meta.path, 'utf8') : '';
      writeFileSync(meta.path, prev + line, 'utf8');
    }

    turnState.completed = true;
    sendNotification('item/completed', {
      threadId: meta.id,
      turnId,
      item: {
        id: `msg-${turnId}`,
        type: 'agentMessage',
        phase: 'final_answer',
        text: JSON.stringify(answerPayload),
      },
    });
    sendNotification('turn/completed', {
      threadId: meta.id,
      turn: { id: turnId, status: 'completed' },
    });
    return;
  }

  sendError(id, -32601, `Unknown method ${method}`);
}

const decoder = new StringDecoder('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += decoder.write(chunk);
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    void handleRequest(msg);
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
process.stdin.resume();
