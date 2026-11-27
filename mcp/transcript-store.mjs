import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { normalizeCwdPath } from './codex-client.mjs';
import { atomicWriteJsonFile } from './disk-job-store.mjs';

const IMMEDIATE_EVENTS = new Set(['delegation', 'steer', 'answer', 'compact', 'fork', 'cancel', 'closed']);
const TEXT_META = new Set(['title', 'lastPreview', 'latestPlan', 'latestDiffSummary', 'model']);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function resolveIsolatedTranscriptsDir(storePath) {
  const baseName = (path.basename(storePath, path.extname(storePath)) || 'sessions')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(path.dirname(storePath), 'transcripts', `${baseName}-${sha256(normalizeCwdPath(storePath)).slice(0, 12)}`);
}

export function canonicalConversationId({ sessionKey, threadId, jobId }) {
  if (typeof sessionKey === 'string' && sessionKey.trim()) return `session:${sessionKey}`;
  if (typeof threadId === 'string' && threadId.trim()) return `thread:${threadId}`;
  return `ephemeral:${jobId}`;
}

export function redactSecrets(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

function filename(conversationId) {
  return `conv-${sha256(conversationId).slice(0, 20)}.json`;
}

function validRecord(conv, name) {
  if (conv?.version !== 1 || typeof conv.conversationId !== 'string' || !conv.conversationId
    || filename(conv.conversationId) !== name || !['session', 'ephemeral'].includes(conv.kind)
    || typeof conv.title !== 'string' || typeof conv.status !== 'string'
    || !Number.isSafeInteger(conv.turnCount) || conv.turnCount < 0
    || !['sessionKey', 'threadId', 'cwd', 'model', 'lastPreview'].every((key) => conv[key] === null || typeof conv[key] === 'string')
    || (conv.latestDiffSummary !== null && !Array.isArray(conv.latestDiffSummary?.files))
    || !Number.isFinite(Date.parse(conv.createdAt)) || !Number.isFinite(Date.parse(conv.updatedAt))
    || !Number.isSafeInteger(conv.nextSeq) || conv.nextSeq < 0 || !Array.isArray(conv.events)) return false;
  const seqs = new Set();
  return conv.events.every((event) => {
    if (!Number.isSafeInteger(event?.seq) || event.seq <= 0 || event.seq > conv.nextSeq || seqs.has(event.seq)
      || typeof event.eventId !== 'string' || typeof event.type !== 'string'
      || !Number.isFinite(Date.parse(event.at))) return false;
    seqs.add(event.seq);
    return true;
  });
}

export function createTranscriptStore(transcriptsDir, {
  maxConversations = 60,
  maxEventsPerConversation = 400,
  maxTextChars = 32768,
  flushIntervalMs = 1500,
  logError = () => {},
} = {}) {
  const conversations = new Map();
  const dirty = new Set();
  const timers = new Map();
  const rawStreams = new WeakMap();

  const sanitize = (value) => {
    if (typeof value === 'string') return redactSecrets(value).slice(0, maxTextChars);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
    }
    return value;
  };

  const filePath = (id) => path.join(transcriptsDir, filename(id));
  const clearTimer = (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };

  const flushConversation = (id) => {
    clearTimer(id);
    if (!dirty.has(id)) return;
    try {
      atomicWriteJsonFile(filePath(id), conversations.get(id));
      dirty.delete(id);
    } catch (error) {
      logError(`failed to write transcript: ${error?.code ?? error?.name ?? 'unknown error'}`);
    }
  };

  const markDirty = (id, immediate = false) => {
    dirty.add(id);
    if (immediate) flushConversation(id);
    else {
      clearTimer(id);
      const timer = setTimeout(() => flushConversation(id), flushIntervalMs);
      timer.unref?.();
      timers.set(id, timer);
    }
  };

  const deleteConversation = (id) => {
    try {
      unlinkSync(filePath(id));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logError(`failed to delete transcript: ${error?.code ?? error?.name ?? 'unknown error'}`);
        return false;
      }
    }
    clearTimer(id);
    dirty.delete(id);
    conversations.delete(id);
    return true;
  };

  const evictIfNeeded = (protectedIds = new Set()) => {
    if (conversations.size <= maxConversations) return;
    const priority = (conv) => conv.status === 'closed'
      || (conv.kind === 'ephemeral' && conv.status !== 'running') ? 0 : 1;
    const candidates = [...conversations.values()]
      .filter((conv) => !protectedIds.has(conv.conversationId))
      .sort((left, right) => priority(left) - priority(right) || Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
    for (const conv of candidates) {
      if (conversations.size <= maxConversations) break;
      deleteConversation(conv.conversationId);
    }
  };

  const updateMeta = (id, meta) => {
    const conv = conversations.get(id);
    if (!conv) return;
    for (const key of ['sessionKey', 'threadId', 'cwd', 'status', 'turnCount', 'tokenUsage', ...TEXT_META]) {
      if (meta[key] !== undefined) conv[key] = TEXT_META.has(key) ? sanitize(meta[key]) : meta[key];
    }
    conv.updatedAt = new Date().toISOString();
    markDirty(id);
  };

  const metadata = ({ events, ...meta }) => structuredClone(meta);

  const ensureConversation = (id, meta = {}, protectedIds = []) => {
    if (!conversations.has(id)) {
      const now = new Date().toISOString();
      conversations.set(id, {
        version: 1, conversationId: id, kind: id.startsWith('ephemeral:') ? 'ephemeral' : 'session',
        title: redactSecrets(id), sessionKey: null, threadId: null, cwd: null, model: null, status: 'ready',
        createdAt: now, updatedAt: now, turnCount: 0, tokenUsage: null, latestPlan: null,
        latestDiffSummary: null, lastPreview: null, nextSeq: 0, events: [],
      });
      updateMeta(id, meta);
    }
    evictIfNeeded(new Set([...protectedIds, id]));
    return metadata(conversations.get(id));
  };

  const trimEvents = (conv) => {
    if (conv.events.length > maxEventsPerConversation) {
      conv.events.splice(0, conv.events.length - maxEventsPerConversation);
    }
  };

  const appendEvent = (id, { type, jobId, turnId, ...payload }) => {
    const conv = conversations.get(id);
    if (!conv) return;
    const at = new Date().toISOString();
    const event = { ...sanitize(payload), seq: ++conv.nextSeq, eventId: randomUUID(), at, type };
    if (jobId !== undefined) event.jobId = jobId;
    if (turnId !== undefined) event.turnId = turnId;
    conv.events.push(event);
    trimEvents(conv);
    conv.updatedAt = at;
    markDirty(id, IMMEDIATE_EVENTS.has(type));
  };

  const upsertStreamEvent = (id, { jobId, turnId, channel, itemId = null, delta }) => {
    const conv = conversations.get(id);
    if (!conv || typeof delta !== 'string' || !delta) return;
    const index = conv.events.findIndex((event) => event.type === 'stream' && event.jobId === jobId
      && event.turnId === turnId && event.channel === channel && (event.itemId ?? 'default') === (itemId ?? 'default'));
    const event = index < 0
      ? { eventId: randomUUID(), type: 'stream', jobId, turnId, channel, itemId, text: '' }
      : conv.events.splice(index, 1)[0];
    const raw = (rawStreams.get(event) ?? event.text) + delta;
    const text = redactSecrets(raw);
    event.text = text.length > maxTextChars ? text.slice(text.length - maxTextChars) : text;
    rawStreams.set(event, raw.length > maxTextChars ? event.text : raw);
    if (text.length > maxTextChars) event.truncated = true;
    event.seq = ++conv.nextSeq;
    event.at = new Date().toISOString();
    conv.events.push(event);
    trimEvents(conv);
    conv.updatedAt = event.at;
    markDirty(id);
  };

  let entries = [];
  try { entries = readdirSync(transcriptsDir, { withFileTypes: true }); } catch (error) {
    if (error?.code !== 'ENOENT') logError(`failed to list transcripts: ${error?.code ?? error?.name}`);
  }
  for (const entry of entries) {
    const { name } = entry;
    if (!entry.isFile() || !/^conv-[0-9a-f]{20}\.json$/.test(name)) continue;
    try {
      const conv = JSON.parse(readFileSync(path.join(transcriptsDir, name), 'utf8'));
      if (!validRecord(conv, name)) continue;
      conv.events.sort((left, right) => left.seq - right.seq);
      trimEvents(conv);
      conversations.set(conv.conversationId, conv);
    } catch {}
  }
  evictIfNeeded();

  return {
    ensureConversation,
    appendEvent,
    upsertStreamEvent,
    updateMeta,
    listConversations: () => [...conversations.values()].map(metadata),
    getConversation(id, { afterSeq = 0, limit = 200 } = {}) {
      const conv = conversations.get(id);
      if (!conv) return null;
      const available = conv.events.filter((event) => event.seq > afterSeq);
      const events = available.slice(0, limit);
      const hasMore = available.length > events.length;
      return {
        conversation: metadata(conv), events: structuredClone(events), hasMore,
        nextSeq: hasMore ? (events.at(-1)?.seq ?? afterSeq) : Math.max(afterSeq, conv.nextSeq),
        truncated: false,
      };
    },
    hasConversation: (id) => conversations.has(id),
    deleteConversation,
    flushAll() {
      for (const id of dirty) flushConversation(id);
    },
  };
}
