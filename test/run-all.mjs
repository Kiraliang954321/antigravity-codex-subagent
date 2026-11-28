import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_WORK_DIR = path.join(os.tmpdir(), `codex-subagent-test-${Date.now()}`);
const MOCK_WRAPPER = path.join(PLUGIN_ROOT, 'test', 'mock-codex-wrapper.mjs');
const SERVER_PATH = path.join(PLUGIN_ROOT, 'mcp', 'server.mjs');
const UNIT_ONLY = process.argv.includes('--unit-only');

mkdirSync(TEST_WORK_DIR, { recursive: true });

const wireMod = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'mcp', 'codex-wire.mjs')).href);
const clientMod = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'mcp', 'codex-client.mjs')).href);
const storeMod = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'mcp', 'session-store.mjs')).href);
const pathGuardMod = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'mcp', 'local-path-guard.mjs')).href);

// Minimal valid 1x1 red PNG
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function isolatedJobsDirFor(storePath) {
  const baseName = (path.basename(storePath, path.extname(storePath)) || 'sessions')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = createHash('sha256')
    .update(clientMod.normalizeCwdPath(storePath))
    .digest('hex')
    .slice(0, 12);
  return path.join(path.dirname(storePath), 'jobs', `${baseName}-${hash}`);
}

function startMcpServer(extraEnv = {}, serverPath = SERVER_PATH) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: TEST_WORK_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });

  const pending = new Map();
  const notifications = [];
  let seq = 0;
  let stderr = '';
  const decoder = new StringDecoder('utf8');
  let buf = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.stdout.on('data', (chunk) => {
    buf += decoder.write(chunk);
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        else entry.resolve(msg.result);
      } else if (msg.id === undefined && typeof msg.method === 'string') {
        notifications.push(msg);
      }
    }
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  const callTool = (name, args = {}, meta = undefined) => request('tools/call', {
    name,
    arguments: args,
    ...(meta !== undefined ? { _meta: meta } : {}),
  });

  const stop = () => new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve();
    }, 8000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.stdin.end(); } catch {}
  });

  return {
    child,
    request,
    callTool,
    stop,
    getStderr: () => stderr,
    getNotifications: () => notifications,
  };
}

function toolText(res) {
  return (res?.content ?? []).map((c) => c.text ?? '').join('');
}

let passed = 0;
async function test(name, fn) {
  process.stdout.write(`  [RUN]  ${name} ... `);
  const t0 = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`PASS (${Date.now() - t0}ms)`);
  } catch (err) {
    console.log(`FAIL (${Date.now() - t0}ms)`);
    console.error(err);
    process.exitCode = 1;
    throw err;
  }
}

console.log('=== Part A: Unit, Mock MCP Server & v0.5.0 Feature Tests ===');

await test('1. codex-wire stale prior-turn isolation, 300+ early telemetry bursts preserving turn/completed, & turnTimeoutMs', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const diagnostics = [];
  const wire = wireMod.createCodexWire({
    stdin,
    stdout,
    permissionMode: 'never',
    onDiagnostic: (ev) => diagnostics.push(ev),
  });

  const sent = [];
  let inBuf = '';
  let turnCall = 0;
  stdin.on('data', (chunk) => {
    inBuf += chunk.toString('utf8');
    for (;;) {
      const nl = inBuf.indexOf('\n');
      if (nl < 0) break;
      const line = inBuf.slice(0, nl).trim();
      inBuf = inBuf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      sent.push(msg);

      if (msg.method === 'initialize') {
        assert.equal(msg.params.clientInfo.name, 'codex-subagent');
        assert.equal(msg.params.clientInfo.version, '0.5.0');
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
      } else if (msg.method === 'thread/start') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'th-1', ephemeral: false } } })}\n`);
      } else if (msg.method === 'turn/interrupt') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
      } else if (msg.method === 'turn/start') {
        turnCall += 1;
        if (turnCall === 1) {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 't1' } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th-1', turnId: 't1', item: { id: 'c1', type: 'commandExecution', status: 'declined' } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'th-1', turnId: 't1', tokenUsage: { last: { totalTokens: 111 }, modelContextWindow: 1000 } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th-1', turnId: 't1', item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: 'ans1' } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 't1', status: 'completed' } } })}\n`);
        } else if (turnCall === 2) {
          for (let i = 0; i < 300; i += 1) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'th-1', turnId: `hist-${i}`, tokenUsage: { last: { totalTokens: i }, modelContextWindow: 100000 } } })}\n`);
          }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th-1', turnId: 't1', item: { id: 'stale-c', type: 'commandExecution', status: 'declined' } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 't2', status: 'completed' } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 't2' } } })}\n`);
        } else if (turnCall === 3) {
          for (let i = 0; i < 300; i += 1) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'th-1', turnId: `hist-burst-${i}`, tokenUsage: { last: { totalTokens: i }, modelContextWindow: 100000 } } })}\n`);
          }
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th-1', turnId: 't3', item: { id: 'a3', type: 'agentMessage', phase: 'final_answer', text: 'ans3-survived-burst' } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'th-1', turnId: 't3', tokenUsage: { last: { totalTokens: 333 }, modelContextWindow: 3000 } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 't3', status: 'completed' } } })}\n`);
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 't3' } } })}\n`);
        } else if (turnCall === 4) {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 't4' } } })}\n`);
        }
      }
    }
  });

  await wire.initialize();
  await wire.startThread({ cwd: TEST_WORK_DIR, ephemeral: false });
  const r1 = await wire.startTurn({ threadId: 'th-1', input: [{ type: 'text', text: 'hello' }] });
  assert.equal(r1.output[0].text, 'ans1');
  assert.ok(wire.collectDiagnostic()?.includes('declined'));

  await assert.rejects(
    wire.startTurn({ threadId: 'th-1', input: [{ type: 'text', text: 'hello 2' }] }),
    /without an answer/,
  );

  diagnostics.length = 0;
  const r3 = await wire.startTurn({
    threadId: 'th-1',
    input: [{ type: 'text', text: 'hello 3' }, { type: 'localImage', path: 'C:\\tmp\\img.png' }],
  });
  assert.equal(r3.output[0].text, 'ans3-survived-burst');
  assert.equal(r3.diagnostic, undefined, 'diagnostic must reset on reused wire');
  assert.equal(r3.usage.totalTokens, 333);
  assert.deepEqual(diagnostics.filter((event) => event.type === 'itemCompleted' || event.type === 'answerItemSelected'), [
    { type: 'itemCompleted', threadId: 'th-1', turnId: 't3', itemId: 'a3', itemType: 'agentMessage', phase: 'final_answer' },
    { type: 'answerItemSelected', threadId: 'th-1', turnId: 't3', itemId: 'a3', phase: 'final_answer' },
  ]);
  const t3Req = sent.filter((m) => m.method === 'turn/start')[2];
  assert.deepEqual(t3Req.params.input[1], { type: 'localImage', path: 'C:\\tmp\\img.png' });

  await assert.rejects(
    wire.startTurn({ threadId: 'th-1', input: [{ type: 'text', text: 'hang' }] }, { timeoutMs: 200 }),
    (err) => err?.code === 'ETIMEDOUT',
  );
  assert.ok(sent.some((m) => m.method === 'turn/interrupt' && m.params?.turnId === 't4'));
  wire.close();
});

await test('2. Live telemetry concurrency, duplicate turn/started idempotency, privacy redaction, monotonic idleMs', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case2');
  mkdirSync(dir, { recursive: true });
  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
  });
  try {
    const init = await srv.request('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.serverInfo.version, '0.5.0');

    const runRes = await srv.callTool('subagent_codex', {
      description: 'Telemetry test run',
      prompt: JSON.stringify({ mode: 'telemetry_concurrent' }),
      cwd: dir,
      sessionKey: 'tel-sess',
      waitMs: 1000,
    });
    assert.ok(!runRes.isError, toolText(runRes));
    const runningText = toolText(runRes);
    assert.ok(!runningText.includes('SECRET_CMD_LEAK'), 'must not leak raw command');
    assert.ok(!runningText.includes('SECRET_DIFF'), 'must not leak diff');
    assert.ok(!runningText.includes('SECRET_ARG'), 'must not leak MCP args');
    assert.ok(!runningText.includes('SECRET_COMMENTARY'), 'must not leak commentary');
    assert.ok(!runningText.includes('/secret/'), 'must not leak paths');

    const payload = JSON.parse(runningText);
    assert.equal(payload.status, 'running');
    assert.ok(payload.threadId, 'threadId should be populated via onThreadKnown');
    assert.equal(payload.telemetry.currentActivity.kind, 'fileChange');
    assert.equal(payload.telemetry.activeCount, 1);
    assert.equal(payload.telemetry.recentActivities.length, 5);
    assert.deepEqual(payload.telemetry.tokenUsage, {
      totalTokens: 45000,
      modelContextWindow: 100000,
      utilizationPct: 45,
    });
    assert.ok(payload.telemetry.idleMs >= 400);

    const waitRes = await srv.callTool('subagent_codex_wait', { jobId: payload.jobId, waitMs: 5000 });
    assert.ok(!waitRes.isError, toolText(waitRes));
    assert.ok(toolText(waitRes).includes('tokens=45000/100000 (45%)'));
  } finally {
    await srv.stop();
  }
});

await test('3. Fail-closed approvalPolicy + sandbox + turn/start policy overrides + strict explicitModel verification', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case3');
  mkdirSync(dir, { recursive: true });
  const storePath = path.join(dir, 'sessions.json');
  const mockState = path.join(dir, 'mock');
  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    CODEX_MODEL: 'default-model',
  });
  try {
    const conflict = await srv.callTool('subagent_codex', {
      description: 'Conflict test',
      prompt: 'hi',
      cwd: dir,
      sessionKey: 'perm-sess',
      permissionMode: 'read-only',
      sandbox: 'workspace-write',
    });
    assert.equal(conflict.isError, true);
    const listAfterConflict = JSON.parse(toolText(await srv.callTool('subagent_codex_list_sessions', {})));
    assert.equal(listAfterConflict.sessions.length, 0);

    const t1 = await srv.callTool('subagent_codex', {
      description: 'Turn 1 read-only',
      prompt: JSON.stringify({ note: 't1' }),
      cwd: dir,
      sessionKey: 'perm-sess',
      permissionMode: 'read-only',
      model: 'model-a',
      reasoningEffort: 'low',
    });
    assert.ok(!t1.isError, toolText(t1));
    const body1 = JSON.parse(toolText(t1).split('\n\n[codex-thread')[0]);
    assert.equal(body1.sandbox.type, 'readOnly');
    assert.equal(body1.turnApprovalPolicy, 'never');
    assert.equal(body1.turnSandboxPolicy.type, 'readOnly');
    assert.equal(body1.turnModel, 'model-a');
    assert.equal(body1.effort, 'low');

    const t2 = await srv.callTool('subagent_codex', {
      description: 'Turn 2 workspace-write',
      prompt: JSON.stringify({ note: 't2' }),
      cwd: dir,
      sessionKey: 'perm-sess',
      sandbox: 'workspace-write',
    });
    assert.ok(!t2.isError, toolText(t2));
    const body2 = JSON.parse(toolText(t2).split('\n\n[codex-thread')[0]);
    assert.equal(body2.sandbox.type, 'workspaceWrite');
    assert.equal(body2.turnSandboxPolicy.type, 'workspaceWrite');
    assert.equal(body2.model, 'model-a');
    assert.equal(body2.excludeTurns, true);

    const t3 = await srv.callTool('subagent_codex', {
      description: 'Turn 3 switch model',
      prompt: JSON.stringify({ note: 't3' }),
      cwd: dir,
      sessionKey: 'perm-sess',
      model: 'model-b',
    });
    assert.ok(!t3.isError, toolText(t3));
    const body3 = JSON.parse(toolText(t3).split('\n\n[codex-thread')[0]);
    assert.equal(body3.model, 'model-b');
    assert.equal(body3.turnModel, 'model-b');
  } finally {
    await srv.stop();
  }

  const srvBadApproval = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    MOCK_CODEX_BAD_APPROVAL: 'on-request',
  });
  try {
    const badStart = await srvBadApproval.callTool('subagent_codex', {
      description: 'Bad approval start',
      prompt: 'hi',
      cwd: dir,
      permissionMode: 'read-only',
    });
    assert.equal(badStart.isError, true);
    assert.ok(toolText(badStart).includes('approvalPolicy'), toolText(badStart));

    const badResume = await srvBadApproval.callTool('subagent_codex', {
      description: 'Bad approval resume',
      prompt: 'hi',
      cwd: dir,
      sessionKey: 'perm-sess',
      permissionMode: 'read-only',
    });
    assert.equal(badResume.isError, true);
    assert.ok(toolText(badResume).includes('approvalPolicy'), toolText(badResume));
  } finally {
    await srvBadApproval.stop();
  }

  const srvBadSandbox = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    MOCK_CODEX_BAD_SANDBOX: 'omit',
  });
  try {
    const badWs = await srvBadSandbox.callTool('subagent_codex', {
      description: 'Omitted workspace-write sandbox',
      prompt: 'hi',
      cwd: dir,
      sandbox: 'workspace-write',
    });
    assert.equal(badWs.isError, true);
    assert.ok(toolText(badWs).includes('workspace-write sandbox'), toolText(badWs));
  } finally {
    await srvBadSandbox.stop();
  }

  const srvWrongModel = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    MOCK_CODEX_WRONG_MODEL: 'chosen-mini',
  });
  try {
    const badModelStart = await srvWrongModel.callTool('subagent_codex', {
      description: 'Wrong model start',
      prompt: 'hi',
      cwd: dir,
      model: 'chosen',
    });
    assert.equal(badModelStart.isError, true);
    assert.ok(toolText(badModelStart).includes('chosen'), toolText(badModelStart));

    const badModelResume = await srvWrongModel.callTool('subagent_codex', {
      description: 'Wrong model resume',
      prompt: 'hi',
      cwd: dir,
      sessionKey: 'perm-sess',
      model: 'chosen',
    });
    assert.equal(badModelResume.isError, true);
    assert.ok(toolText(badModelResume).includes('chosen'), toolText(badModelResume));

    const badReviewer = await srvWrongModel.callTool('subagent_codex', {
      description: 'Missing approvalsReviewer',
      prompt: 'hi',
      cwd: dir,
      permissionMode: 'approve-for-me',
      model: 'chosen-mini',
    });
    assert.equal(badReviewer.isError, true);
    assert.ok(toolText(badReviewer).includes('approvalsReviewer'), toolText(badReviewer));
  } finally {
    await srvWrongModel.stop();
  }
});

await test('4. Non-blocking startup recovery + full rollout validation', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case4');
  const mockState = path.join(dir, 'mock');
  const sessionsDir = path.join(mockState, 'sessions');
  const archivedDir = path.join(mockState, 'archived_sessions');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(archivedDir, { recursive: true });

  const idIntact = randomUUID();
  const idArchived = randomUUID();
  const idMissing = randomUUID();
  const idMiddleCorrupt = randomUUID();
  const idWrongThread = randomUUID();
  const idSystemError = randomUUID();
  const idAmbiguousNotFound = randomUUID();
  const idTimeout = randomUUID();
  const idLazy = randomUUID();

  const writeRollout = (p, content) => writeFileSync(p, content, 'utf8');
  const saveMeta = (meta) => writeFileSync(path.join(mockState, `meta-${meta.id}.json`), JSON.stringify(meta, null, 2), 'utf8');

  const intactPath = path.join(sessionsDir, `rollout-${idIntact}.jsonl`);
  writeRollout(intactPath, `${JSON.stringify({ type: 'session_meta', payload: { id: idIntact } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } })}\n`);
  saveMeta({ id: idIntact, cwd: dir, model: 'mock-codex-model', path: intactPath, archived: false });

  const archivedPath = path.join(archivedDir, `rollout-${idArchived}.jsonl`);
  writeRollout(archivedPath, `${JSON.stringify({ type: 'session_meta', payload: { id: idArchived } })}\n`);
  saveMeta({ id: idArchived, cwd: dir, model: 'mock-codex-model', path: archivedPath, archived: true });

  const midCorruptPath = path.join(sessionsDir, `rollout-${idMiddleCorrupt}.jsonl`);
  writeRollout(midCorruptPath, `${JSON.stringify({ type: 'session_meta', payload: { id: idMiddleCorrupt } })}\n{broken-middle-json\n{"type":"tail","ok":true}\n`);
  saveMeta({ id: idMiddleCorrupt, cwd: dir, model: 'mock-codex-model', path: midCorruptPath, archived: false });

  const wrongThreadPath = path.join(sessionsDir, `rollout-${idWrongThread}.jsonl`);
  writeRollout(wrongThreadPath, `${JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } })}\n`);
  saveMeta({ id: idWrongThread, cwd: dir, model: 'mock-codex-model', path: wrongThreadPath, archived: false });

  const sysErrPath = path.join(sessionsDir, `rollout-${idSystemError}.jsonl`);
  writeRollout(sysErrPath, `${JSON.stringify({ type: 'session_meta', payload: { id: idSystemError } })}\n`);
  saveMeta({ id: idSystemError, cwd: dir, model: 'mock-codex-model', path: sysErrPath, archived: false, status: { type: 'systemError' } });

  saveMeta({ id: idAmbiguousNotFound, cwd: dir, model: 'mock-codex-model', path: intactPath, archived: false, simulateReadRpcError: 'generic endpoint not found' });

  const timeoutPath = path.join(sessionsDir, `rollout-${idTimeout}.jsonl`);
  writeRollout(timeoutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: idTimeout } })}\n`);
  saveMeta({ id: idTimeout, cwd: dir, model: 'mock-codex-model', path: timeoutPath, archived: false, simulateReadTimeout: true });

  const lazyPath = path.join(sessionsDir, `rollout-${idLazy}.jsonl`);
  writeRollout(lazyPath, '{bad');
  saveMeta({ id: idLazy, cwd: dir, model: 'mock-codex-model', path: lazyPath, archived: false });

  const nowIso = new Date().toISOString();
  const storePath = path.join(dir, 'sessions.json');
  writeFileSync(storePath, JSON.stringify({
    version: 1,
    sessions: [
      { sessionKey: 's-timeout', threadId: idTimeout, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
      { sessionKey: 's-intact', threadId: idIntact, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
      { sessionKey: 's-archived', threadId: idArchived, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
      { sessionKey: 's-missing', threadId: idMissing, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
      { sessionKey: 's-mid-corrupt', threadId: idMiddleCorrupt, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
      { sessionKey: 's-wrong-id', threadId: idWrongThread, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
      { sessionKey: 's-syserr', threadId: idSystemError, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
      { sessionKey: 's-ambig', threadId: idAmbiguousNotFound, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
      { sessionKey: 's-lazy', threadId: idLazy, cwd: dir, model: 'mock-codex-model', lastUsedAt: nowIso, used: null, size: null, state: 'uncertain' },
    ],
  }, null, 2), 'utf8');

  const tStart = Date.now();
  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    CODEX_REQUEST_TIMEOUT_MS: '800',
  });
  try {
    const init = await srv.request('initialize', { protocolVersion: '2024-11-05' });
    const initElapsed = Date.now() - tStart;
    assert.equal(init.serverInfo.version, '0.5.0');
    assert.ok(initElapsed < 700, `startup initialize (${initElapsed}ms) must not block on slow uncertain probes`);

    let byKey = {};
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const listed = JSON.parse(toolText(await srv.callTool('subagent_codex_list_sessions', {})));
      byKey = Object.fromEntries(listed.sessions.map((s) => [s.sessionKey, s]));
      if (byKey['s-intact']?.state === 'ready' && !byKey['s-archived'] && !byKey['s-missing']) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    assert.equal(byKey['s-intact']?.state, 'ready');
    assert.equal(byKey['s-intact']?.contextWindow, null);
    assert.equal(byKey['s-archived'], undefined);
    assert.equal(byKey['s-missing'], undefined);
    assert.equal(byKey['s-mid-corrupt']?.state, 'uncertain');
    assert.equal(byKey['s-wrong-id']?.state, 'uncertain');
    assert.equal(byKey['s-syserr']?.state, 'uncertain');
    assert.equal(byKey['s-ambig']?.state, 'uncertain');
    assert.equal(byKey['s-timeout']?.state, 'uncertain');

    writeRollout(lazyPath, `${JSON.stringify({ type: 'session_meta', payload: { id: idLazy } })}\n`);
    const lazyRes = await srv.callTool('subagent_codex', {
      description: 'Lazy uncertain resume',
      prompt: JSON.stringify({ note: 'lazy-ok' }),
      cwd: dir,
      sessionKey: 's-lazy',
    });
    assert.ok(!lazyRes.isError, toolText(lazyRes));
    assert.ok(toolText(lazyRes).includes(`threadId=${idLazy} resumed=true`));
  } finally {
    await srv.stop();
  }
});

await test('5. Isolated disk jobs per storePath, unified single-claim, graceful shutdown persistence, and TTL expiry', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case5');
  mkdirSync(dir, { recursive: true });
  const storePathA = path.join(dir, 'store-a.json');
  const storePathB = path.join(dir, 'store-b.json');
  const jobsDirA = isolatedJobsDirFor(storePathA);
  const mockState = path.join(dir, 'mock');

  let jobId;
  const srvA1 = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePathA,
    MOCK_CODEX_STATE_DIR: mockState,
  });
  const srvB = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePathB,
    MOCK_CODEX_STATE_DIR: mockState,
  });
  try {
    const runRes = await srvA1.callTool('subagent_codex', {
      description: 'Persist job test',
      prompt: JSON.stringify({ delayMs: 1300, note: 'SURVIVED_RESTART' }),
      cwd: dir,
      waitMs: 1000,
    });
    const running = JSON.parse(toolText(runRes));
    assert.equal(running.status, 'running');
    jobId = running.jobId;

    const receiptPath = path.join(jobsDirA, `${jobId}.json`);
    const deadline = Date.now() + 5000;
    while (!existsSync(receiptPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(existsSync(receiptPath), 'job receipt persisted to isolated jobsDir');

    const listB = JSON.parse(toolText(await srvB.callTool('subagent_codex_list_sessions', {})));
    assert.equal(listB.activeJobs.length, 0);
    const waitB = await srvB.callTool('subagent_codex_wait', { jobId });
    assert.equal(waitB.isError, true);
  } finally {
    await srvA1.stop();
    await srvB.stop();
  }

  const activeClaimPath = path.join(jobsDirA, `${randomUUID()}.json.${process.pid}.${randomUUID()}.claim`);
  writeFileSync(activeClaimPath, '{}', 'utf8');
  const expiredId = randomUUID();
  const expiredPath = path.join(jobsDirA, `${expiredId}.json`);
  writeFileSync(expiredPath, JSON.stringify({
    version: 1,
    jobId: expiredId,
    startedAt: Date.now() - 40 * 60 * 1000,
    settledAt: Date.now() - 35 * 60 * 1000,
    expiresAt: Date.now() - 5 * 60 * 1000,
    description: 'Expired job',
    cwd: dir,
    result: { content: [{ type: 'text', text: 'expired' }] },
  }), 'utf8');

  const srvA2 = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePathA,
    MOCK_CODEX_STATE_DIR: mockState,
  });
  try {
    const listed = JSON.parse(toolText(await srvA2.callTool('subagent_codex_list_sessions', {})));
    assert.equal(existsSync(expiredPath), false);
    assert.equal(existsSync(activeClaimPath), true);
    rmSync(activeClaimPath, { force: true });

    const found = listed.activeJobs.find((j) => j.jobId === jobId);
    assert.ok(found && found.status === 'completed_unclaimed' && found.persisted === true);

    const [w1, w2] = await Promise.all([
      srvA2.callTool('subagent_codex_wait', { jobId }),
      srvA2.callTool('subagent_codex_wait', { jobId }),
    ]);
    assert.equal([w1, w2].filter((r) => !r.isError).length, 1);
    assert.equal([w1, w2].filter((r) => r.isError).length, 1);
    assert.ok(toolText([w1, w2].find((r) => !r.isError)).includes('SURVIVED_RESTART'));
  } finally {
    await srvA2.stop();
  }
});

await test('6. Context window footer (unknown, 79.9%, exact 80% warning, max-tokens usage)', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case6');
  mkdirSync(dir, { recursive: true });
  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
  });
  try {
    const r0 = await srv.callTool('subagent_codex', {
      description: 'Unknown window',
      prompt: JSON.stringify({ usage: { totalTokens: 5000, modelContextWindow: null } }),
      cwd: dir,
      sessionKey: 'ctx-sess',
    });
    assert.ok(/\[codex-thread threadId=[^\]]+ resumed=false\]$/.test(toolText(r0)));

    const r1 = await srv.callTool('subagent_codex', {
      description: 'Just below 80',
      prompt: JSON.stringify({ usage: { totalTokens: 79999, modelContextWindow: 100000 } }),
      cwd: dir,
      sessionKey: 'ctx-sess',
    });
    assert.ok(toolText(r1).includes('tokens=79999/100000 (79.9%)'));
    assert.ok(!toolText(r1).includes('[CONTEXT_WARNING]'));

    const r2 = await srv.callTool('subagent_codex', {
      description: 'Exact 80 pct',
      prompt: JSON.stringify({ usage: { totalTokens: 80000, modelContextWindow: 100000 } }),
      cwd: dir,
      sessionKey: 'ctx-sess',
    });
    assert.ok(toolText(r2).includes('tokens=80000/100000 (80%)'));
    assert.ok(toolText(r2).includes('[CONTEXT_WARNING]'));

    const r3 = await srv.callTool('subagent_codex', {
      description: 'Max tokens hit',
      prompt: JSON.stringify({ mode: 'max_tokens', usage: { totalTokens: 100000, modelContextWindow: 100000 } }),
      cwd: dir,
    });
    assert.equal(r3.isError, true);
    assert.ok(toolText(r3).includes('Context usage: tokens=100000/100000 (100%)'));
  } finally {
    await srv.stop();
  }
});

await test('7. Multimodal images validation + Windows UNC/device rejection + action: "close" ergonomics', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case7');
  mkdirSync(dir, { recursive: true });
  const imgRel = 'sample.png';
  const imgAbs = path.join(dir, imgRel);
  writeFileSync(imgAbs, Buffer.from(PNG_1X1_BASE64, 'base64'));
  writeFileSync(path.join(dir, 'empty.png'), Buffer.alloc(0));
  writeFileSync(path.join(dir, 'note.txt'), 'hello');

  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
  });
  try {
    for (const badCwd of ['\\\\server\\share\\dir', '//server/share/dir', '\\\\?\\C:\\Windows', '\\\\.\\C:\\Windows']) {
      const res = await srv.callTool('subagent_codex', {
        description: 'Bad UNC cwd',
        prompt: 'hi',
        cwd: badCwd,
      });
      assert.equal(res.isError, true, `expected UNC/device cwd rejection for ${badCwd}`);
    }

    for (const bad of [
      ['missing.png'],
      ['empty.png'],
      ['note.txt'],
      [dir],
      ['https://example.com/a.png'],
      ['file:///C:/a.png'],
      ['data:image/png;base64,abc'],
      ['\\\\server\\share\\a.png'],
      ['//server/share/a.png'],
      ['\\\\?\\C:\\a.png'],
      ['\\\\.\\C:\\a.png'],
      ['\\root-rel.png'],
    ]) {
      const res = await srv.callTool('subagent_codex', {
        description: 'Bad image',
        prompt: 'inspect',
        cwd: dir,
        sessionKey: 'img-sess',
        images: bad,
      });
      assert.equal(res.isError, true, `expected rejection for ${JSON.stringify(bad)}`);
    }
    const listBefore = JSON.parse(toolText(await srv.callTool('subagent_codex_list_sessions', {})));
    assert.equal(listBefore.sessions.length, 0);

    const ok = await srv.callTool('subagent_codex', {
      description: 'Valid images',
      prompt: JSON.stringify({ note: 'with-images' }),
      cwd: dir,
      sessionKey: 'img-sess',
      images: [imgRel, imgAbs],
    });
    assert.ok(!ok.isError, toolText(ok));
    const parsed = JSON.parse(toolText(ok).split('\n\n[codex-thread')[0]);
    assert.equal(parsed.images.length, 2);

    const closeNew = await srv.callTool('subagent_codex', {
      action: 'close',
      cwd: dir,
      sessionKey: 'img-sess',
    });
    assert.ok(!closeNew.isError, toolText(closeNew));
    assert.equal(JSON.parse(toolText(closeNew)).closed, true);
  } finally {
    await srv.stop();
  }
});

await test('8. Opt-in warm pool reuse, current-turn rollout flush proof, config-signature eviction, and clean close', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case8');
  mkdirSync(dir, { recursive: true });
  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
    CODEX_WARM_IDLE_MS: '15000',
  });
  try {
    const r1 = await srv.callTool('subagent_codex', {
      description: 'Warm turn 1',
      prompt: JSON.stringify({ note: 'w1' }),
      cwd: dir,
      sessionKey: 'warm-sess',
    });
    assert.ok(!r1.isError, toolText(r1));
    const b1 = JSON.parse(toolText(r1).split('\n\n[codex-thread')[0]);

    const r2 = await srv.callTool('subagent_codex', {
      description: 'Warm turn 2',
      prompt: JSON.stringify({ note: 'w2' }),
      cwd: dir,
      sessionKey: 'warm-sess',
    });
    assert.ok(!r2.isError, toolText(r2));
    const b2 = JSON.parse(toolText(r2).split('\n\n[codex-thread')[0]);
    assert.equal(b2.pid, b1.pid);

    const r2b = await srv.callTool('subagent_codex', {
      description: 'Warm turn without task_complete',
      prompt: JSON.stringify({ note: 'w2b', skipRolloutTaskComplete: true }),
      cwd: dir,
      sessionKey: 'warm-sess',
    });
    assert.equal(r2b.isError, true);
    assert.ok(toolText(r2b).includes('task_complete'), toolText(r2b));

    const r3 = await srv.callTool('subagent_codex', {
      description: 'Warm turn 3 after fallback',
      prompt: JSON.stringify({ note: 'w3' }),
      cwd: dir,
      sessionKey: 'warm-sess',
    });
    assert.ok(!r3.isError, toolText(r3));
    const b3 = JSON.parse(toolText(r3).split('\n\n[codex-thread')[0]);
    assert.notEqual(b3.pid, b1.pid);

    const r4 = await srv.callTool('subagent_codex', {
      description: 'Warm turn 4 read-only',
      prompt: JSON.stringify({ note: 'w4' }),
      cwd: dir,
      sessionKey: 'warm-sess',
      sandbox: 'read-only',
    });
    assert.ok(!r4.isError, toolText(r4));
    const b4 = JSON.parse(toolText(r4).split('\n\n[codex-thread')[0]);
    assert.notEqual(b4.pid, b3.pid);
    assert.equal(b4.sandbox.type, 'readOnly');

    const closed = await srv.callTool('subagent_codex', {
      action: 'close',
      cwd: dir,
      sessionKey: 'warm-sess',
    });
    assert.ok(!closed.isError, toolText(closed));
    assert.equal(JSON.parse(toolText(closed)).closed, true);
  } finally {
    await srv.stop();
  }
});

await test('9. Session store: maxSessions reservation, close() rollback, TTL re-check during prune, & atomic stale lock takeover', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case9');
  mkdirSync(dir, { recursive: true });
  const storePath = path.join(dir, 'sessions.json');
  writeFileSync(`${storePath}.lock`, JSON.stringify({ pid: 99999999, startedAt: new Date(0).toISOString(), token: 'dead' }), 'utf8');
  let clock = 1_000_000;
  const store = await storeMod.openCodexSessionStore({ file: storePath, maxSessions: 1, ttlMs: 1000, now: () => clock });
  try {
    await assert.rejects(
      storeMod.openCodexSessionStore({ file: storePath }),
      (err) => err?.code === storeMod.CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
    );

    const lease1 = await store.acquire({ sessionKey: 'k1', cwd: dir });
    await assert.rejects(
      store.acquire({ sessionKey: 'k2', cwd: dir }),
      (err) => err?.code === storeMod.CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
    );
    lease1.release();

    const lease2 = await store.acquire({ sessionKey: 'k2', cwd: dir });
    const tid = randomUUID();
    await lease2.commit({ threadId: tid, model: 'mock-codex-model' });
    lease2.release();

    rmSync(storePath, { force: true });
    mkdirSync(storePath);
    await assert.rejects(
      store.close({ sessionKey: 'k2', cwd: dir }, async () => {}),
      (err) => err?.code === storeMod.CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
    );
    const row = await store.getOwnedThread({ sessionKey: 'k2', cwd: dir });
    assert.equal(row.state, 'ready');
    assert.equal(row.active, false);
    rmSync(storePath, { recursive: true, force: true });
  } finally {
    await store.dispose();
  }

  const storePath2 = path.join(dir, 'sessions-ttl.json');
  let t = 1_000_000;
  const store2 = await storeMod.openCodexSessionStore({ file: storePath2, maxSessions: 5, ttlMs: 1000, now: () => t });
  try {
    const la = await store2.acquire({ sessionKey: 'a', cwd: dir });
    await la.commit({ threadId: randomUUID(), model: 'm' });
    la.release();
    t += 10;
    const lb = await store2.acquire({ sessionKey: 'b', cwd: dir });
    await lb.commit({ threadId: randomUUID(), model: 'm' });
    lb.release();

    t += 5000;
    const archivedKeys = [];
    await store2.prune({
      archive: async (snap) => {
        archivedKeys.push(snap.sessionKey);
        if (snap.sessionKey === 'a') {
          const freshB = await store2.acquire({ sessionKey: 'b', cwd: dir });
          await freshB.commit({ model: 'm' });
          freshB.release();
        }
      },
    });
    assert.deepEqual(archivedKeys, ['a']);
    const bAfter = await store2.getOwnedThread({ sessionKey: 'b', cwd: dir });
    assert.equal(bAfter?.state, 'ready');
  } finally {
    await store2.dispose();
  }

  const peer = spawn(
    process.execPath,
    ['-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('peer process did not become ready in time')), 5000);
      const cleanup = () => {
        clearTimeout(timer);
        peer.stdout.off('data', onData);
        peer.off('error', onErr);
        peer.off('exit', onExit);
      };
      const onData = (chunk) => {
        out += chunk.toString('utf8');
        if (out.includes('READY')) {
          cleanup();
          resolve();
        }
      };
      const onErr = (err) => { cleanup(); reject(err); };
      const onExit = (code) => { cleanup(); reject(new Error(`peer exited early (${code})`)); };
      peer.stdout.on('data', onData);
      peer.once('error', onErr);
      peer.once('exit', onExit);
    });

    const storePath3 = path.join(dir, 'sessions-pid-reuse.json');
    writeFileSync(
      `${storePath3}.lock`,
      JSON.stringify({ pid: peer.pid, startedAt: new Date(Date.now() - 60_000).toISOString(), token: 'reused-pid' }),
      'utf8',
    );
    const store3 = await storeMod.openCodexSessionStore({ file: storePath3 });
    try {
      const lockOwner = JSON.parse(readFileSync(`${storePath3}.lock`, 'utf8'));
      assert.equal(lockOwner.pid, process.pid);
    } finally {
      await store3.dispose();
    }

    writeFileSync(
      `${storePath3}.lock`,
      JSON.stringify({ pid: peer.pid, startedAt: new Date().toISOString(), token: 'live-peer' }),
      'utf8',
    );
    await assert.rejects(
      storeMod.openCodexSessionStore({ file: storePath3 }),
      (err) => err?.code === storeMod.CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
    );
  } finally {
    if (peer.exitCode === null && peer.signalCode === null) {
      await new Promise((resolve) => {
        const tKill = setTimeout(resolve, 2000);
        peer.once('exit', () => {
          clearTimeout(tKill);
          resolve();
        });
        try {
          peer.kill();
        } catch {
          clearTimeout(tKill);
          resolve();
        }
      });
    }
  }
});

await test('12. Streaming delta heartbeats, turn/plan/updated, turn/diff/updated privacy, & MCP notifications/progress', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case12');
  mkdirSync(dir, { recursive: true });
  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
  });
  try {
    const runRes = await srv.callTool(
      'subagent_codex',
      {
        description: 'Stream plan diff test',
        prompt: JSON.stringify({ mode: 'stream_plan_diff' }),
        cwd: dir,
        sessionKey: 'stream-sess',
        waitMs: 1100,
      },
      { progressToken: 'prog-1' },
    );
    const runningText = toolText(runRes);
    assert.ok(!runningText.includes('SECRET_THOUGHT_DELTA'), 'must not leak reasoning delta');
    assert.ok(!runningText.includes('SECRET_CMD_DELTA_LINE'), 'must not leak command output delta');
    assert.ok(!runningText.includes('SECRET_DIFF_BODY'), 'must not leak raw diff content');

    const payload = JSON.parse(runningText);
    assert.equal(payload.status, 'running');
    assert.ok(['thinking', 'executing', 'streaming'].includes(payload.telemetry.phase), `unexpected phase=${payload.telemetry.phase}`);
    assert.ok(payload.telemetry.idleMs < 700, `streaming deltas should refresh idleMs (got ${payload.telemetry.idleMs})`);
    assert.equal(payload.telemetry.plan?.steps?.length, 2);
    assert.equal(payload.telemetry.plan?.steps?.[0]?.status, 'completed');
    assert.equal(payload.telemetry.diffSummary?.filesChangedCount, 1);
    assert.deepEqual(payload.telemetry.diffSummary?.files, ['src/app.mjs']);

    const waitRes = await srv.callTool(
      'subagent_codex_wait',
      { jobId: payload.jobId, waitMs: 5000 },
      { progressToken: 'prog-1' },
    );
    assert.ok(!waitRes.isError, toolText(waitRes));

    const progressMsgs = srv.getNotifications().filter((n) => n.method === 'notifications/progress');
    assert.ok(progressMsgs.length >= 1, 'should emit throttled MCP notifications/progress when progressToken is set');
    assert.equal(progressMsgs[0].params.progressToken, 'prog-1');

    // Non-integer numeric progressToken must NOT trigger progress notifications
    const floatRes = await srv.callTool(
      'subagent_codex',
      {
        description: 'Float progressToken ignored',
        prompt: JSON.stringify({ delayMs: 1200, note: 'float-pt' }),
        cwd: dir,
        waitMs: 1500,
      },
      { progressToken: 1.5 },
    );
    assert.ok(!floatRes.isError, toolText(floatRes));
    const floatProgress = srv.getNotifications().filter((n) => n.method === 'notifications/progress' && n.params.progressToken === 1.5);
    assert.equal(floatProgress.length, 0, 'fractional progressToken must be ignored per MCP spec');
  } finally {
    await srv.stop();
  }
});

await test('13. outputSchema validation, images count/size limits, and Windows fsutil drive-type cache', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case13');
  mkdirSync(dir, { recursive: true });
  const imgPath = path.join(dir, 'ok.png');
  writeFileSync(imgPath, Buffer.from(PNG_1X1_BASE64, 'base64'));
  const bigImgPath = path.join(dir, 'too-big.png');
  const fd = openSync(bigImgPath, 'w');
  ftruncateSync(fd, 20 * 1024 * 1024 + 1);
  closeSync(fd);

  // Verify fsutil drive-type helper on Windows
  if (process.platform === 'win32') {
    pathGuardMod.clearWindowsDriveTypeCache();
    const letter = path.win32.parse(dir).root[0];
    const dtype1 = pathGuardMod.getWindowsDriveType(letter);
    const dtype2 = pathGuardMod.getWindowsDriveType(letter);
    assert.equal(dtype1, 'Fixed');
    assert.equal(dtype2, 'Fixed');
  }

  // Max image count (>10) & max image size (>20MB) guardrails
  assert.throws(
    () => pathGuardMod.validateLocalImages(Array(11).fill('ok.png'), dir),
    /at most 10/,
  );
  assert.throws(
    () => pathGuardMod.validateLocalImages(['too-big.png'], dir),
    /maximum size of 20MB/,
  );

  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
  });
  try {
    // Reject outputSchema on close
    const badActionSchema = await srv.callTool('subagent_codex', {
      action: 'close',
      cwd: dir,
      sessionKey: 'nonexistent',
      outputSchema: { type: 'object' },
    });
    assert.equal(badActionSchema.isError, true);

    // Reject oversized outputSchema (>64KB)
    const hugeSchema = { type: 'object', description: 'x'.repeat(70_000) };
    const badHugeSchema = await srv.callTool('subagent_codex', {
      description: 'Huge schema',
      prompt: 'hi',
      cwd: dir,
      outputSchema: hugeSchema,
    });
    assert.equal(badHugeSchema.isError, true);

    // Valid outputSchema forwarded into turn/start
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['verdict'],
      properties: { verdict: { type: 'string' } },
    };
    const ok = await srv.callTool('subagent_codex', {
      description: 'Valid schema test',
      prompt: JSON.stringify({ note: 'schema-ok' }),
      cwd: dir,
      outputSchema: schema,
    });
    assert.ok(!ok.isError, toolText(ok));
    const parsed = JSON.parse(toolText(ok));
    assert.deepEqual(parsed.outputSchema, schema);
  } finally {
    await srv.stop();
  }
});

await test('14. Live subagent_codex_wait steering (with image) + non-destructive settled-job steer rejection', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case14');
  mkdirSync(dir, { recursive: true });
  const steerImg = path.join(dir, 'steer.png');
  writeFileSync(steerImg, Buffer.from(PNG_1X1_BASE64, 'base64'));

  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
  });
  try {
    // Live steer while turn is waiting
    const run1 = await srv.callTool('subagent_codex', {
      description: 'Steer target turn',
      prompt: JSON.stringify({ mode: 'wait_for_steer', maxWaitMs: 6000 }),
      cwd: dir,
      sessionKey: 'steer-sess',
      waitMs: 1000,
    });
    const running1 = JSON.parse(toolText(run1));
    assert.equal(running1.status, 'running');

    const steered = await srv.callTool('subagent_codex_wait', {
      jobId: running1.jobId,
      steer: 'Pivot to step B immediately',
      images: ['steer.png'],
      waitMs: 5000,
    });
    assert.ok(!steered.isError, toolText(steered));
    const body = JSON.parse(toolText(steered).split('\n\n[codex-thread')[0]);
    assert.equal(body.steeredInputs.length, 1);
    assert.equal(body.steeredInputs[0].text, 'Pivot to step B immediately');
    assert.equal(body.steeredInputs[0].images.length, 1);

    // Non-destructive error when steering an already-settled unclaimed job
    const run2 = await srv.callTool('subagent_codex', {
      description: 'Settled job for steer check',
      prompt: JSON.stringify({ delayMs: 1200, note: 'SETTLED_RESULT_PRESERVED' }),
      cwd: dir,
      waitMs: 1000,
    });
    const running2 = JSON.parse(toolText(run2));
    await new Promise((r) => setTimeout(r, 600));

    const badSteer = await srv.callTool('subagent_codex_wait', {
      jobId: running2.jobId,
      steer: 'too late',
    });
    assert.equal(badSteer.isError, true);
    assert.ok(toolText(badSteer).includes('already finished'), toolText(badSteer));

    // Must still be able to claim the settled result normally!
    const claimed = await srv.callTool('subagent_codex_wait', { jobId: running2.jobId, waitMs: 2000 });
    assert.ok(!claimed.isError, toolText(claimed));
    assert.ok(toolText(claimed).includes('SETTLED_RESULT_PRESERVED'), toolText(claimed));
  } finally {
    await srv.stop();
  }
});

await test('15. action: "compact" in-place compression + pre-start RPC rejection rollback', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case15');
  mkdirSync(dir, { recursive: true });
  const storePath = path.join(dir, 'sessions.json');
  const mockState = path.join(dir, 'mock');

  const srv1 = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
  });
  try {
    const startRes = await srv1.callTool('subagent_codex', {
      description: 'Initial high-token turn',
      prompt: JSON.stringify({ usage: { totalTokens: 85000, modelContextWindow: 100000 } }),
      cwd: dir,
      sessionKey: 'cmp-sess',
    });
    assert.ok(!startRes.isError, toolText(startRes));
    assert.ok(toolText(startRes).includes('[CONTEXT_WARNING]'));

    const cmpRes = await srv1.callTool('subagent_codex', {
      action: 'compact',
      cwd: dir,
      sessionKey: 'cmp-sess',
    });
    assert.ok(!cmpRes.isError, toolText(cmpRes));
    const cmpText = toolText(cmpRes);
    const cmpJson = JSON.parse(cmpText.split('\n\n[codex-thread')[0]);
    assert.equal(cmpJson.compacted, true);
    assert.equal(cmpJson.compactedEventObserved, true);
    assert.equal(cmpJson.used, 12000);
    assert.equal(cmpJson.contextWindow, 100000);
    assert.ok(cmpText.includes('tokens=12000/100000 (12%)'));

    const listed = JSON.parse(toolText(await srv1.callTool('subagent_codex_list_sessions', {})));
    assert.equal(listed.sessions[0].used, 12000);
    assert.equal(listed.sessions[0].state, 'ready');
  } finally {
    await srv1.stop();
  }

  // Verify pre-start compact rejection rolls state back from uncertain -> ready
  const srv2 = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    MOCK_CODEX_REJECT_COMPACT: '1',
  });
  try {
    const failCmp = await srv2.callTool('subagent_codex', {
      action: 'compact',
      cwd: dir,
      sessionKey: 'cmp-sess',
    });
    assert.equal(failCmp.isError, true);
    const listed = JSON.parse(toolText(await srv2.callTool('subagent_codex_list_sessions', {})));
    assert.equal(listed.sessions[0].state, 'ready', 'pre-start compact rejection must roll back to ready');
  } finally {
    await srv2.stop();
  }

  // Verify missing compaction confirmation fails closed without returning compacted: true
  const srv3 = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    MOCK_CODEX_OMIT_COMPACT_PROOF: '1',
  });
  try {
    const noProofCmp = await srv3.callTool('subagent_codex', {
      action: 'compact',
      cwd: dir,
      sessionKey: 'cmp-sess',
    });
    assert.equal(noProofCmp.isError, true, 'compact without confirmation must fail closed');
    assert.ok(toolText(noProofCmp).includes('confirmation'), toolText(noProofCmp));
  } finally {
    await srv3.stop();
  }

  // Verify stale-turn thread/compacted notification cannot count for current turn
  const srv4 = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    MOCK_CODEX_COMPACT_STALE_NOTIFY: '1',
  });
  try {
    const staleNotifyCmp = await srv4.callTool('subagent_codex', {
      action: 'compact',
      cwd: dir,
      sessionKey: 'cmp-sess',
    });
    assert.equal(staleNotifyCmp.isError, true, 'stale-turn thread/compacted must NOT validate current turn');
    assert.ok(toolText(staleNotifyCmp).includes('confirmation'), toolText(staleNotifyCmp));
  } finally {
    await srv4.stop();
  }

  // Verify live notification + missing rollout ContextCompaction evidence fails closed
  const srv5 = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: storePath,
    MOCK_CODEX_STATE_DIR: mockState,
    MOCK_CODEX_OMIT_COMPACT_ROLLOUT: '1',
  });
  try {
    const noRolloutCmp = await srv5.callTool('subagent_codex', {
      action: 'compact',
      cwd: dir,
      sessionKey: 'cmp-sess',
    });
    assert.equal(noRolloutCmp.isError, true, 'compact without turn-scoped rollout compaction record must fail closed');
    assert.ok(toolText(noRolloutCmp).includes('compaction evidence'), toolText(noRolloutCmp));
  } finally {
    await srv5.stop();
  }
});

await test('16. action: "fork" branching with lastTurnId, source protection under maxSessions=2, collision rejection, & independent turns', async () => {
  const dir = path.join(TEST_WORK_DIR, 'case16');
  mkdirSync(dir, { recursive: true });
  const srv = startMcpServer({
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
    CODEX_MAX_SESSIONS: '2',
  });
  try {
    const t1 = await srv.callTool('subagent_codex', {
      description: 'Base thread turn 1',
      prompt: JSON.stringify({ note: 'base-1' }),
      cwd: dir,
      sessionKey: 'base-sess',
    });
    assert.ok(!t1.isError, toolText(t1));
    const b1 = JSON.parse(toolText(t1).split('\n\n[codex-thread')[0]);

    // Seed an extra idle thread so maxSessions (2) is full, then verify conflicting fork fails WITHOUT pruning anything!
    const tExtra = await srv.callTool('subagent_codex', {
      description: 'Extra thread',
      prompt: JSON.stringify({ note: 'extra' }),
      cwd: dir,
      sessionKey: 'extra-sess',
    });
    assert.ok(!tExtra.isError, toolText(tExtra));

    // Target collision with existing key fails cleanly before pruning
    const dup = await srv.callTool('subagent_codex', {
      action: 'fork',
      cwd: dir,
      sessionKey: 'base-sess',
      targetSessionKey: 'base-sess',
    });
    assert.equal(dup.isError, true);
    assert.ok(toolText(dup).includes('CODEX_THREAD_SELECTOR_CONFLICT'), toolText(dup));
    const afterDupList = JSON.parse(toolText(await srv.callTool('subagent_codex_list_sessions', {})));
    assert.equal(afterDupList.sessions.length, 2, 'conflicting fork must not trigger LRU pruning');

    // Fork into branch-a: LRU prunes extra-sess (NOT base-sess even though base-sess is older!), protecting source thread!
    const forkRes = await srv.callTool('subagent_codex', {
      action: 'fork',
      cwd: dir,
      sessionKey: 'base-sess',
      targetSessionKey: 'branch-a',
      lastTurnId: b1.turnId,
      sandbox: 'read-only',
    });
    assert.ok(!forkRes.isError, toolText(forkRes));
    const forkReceipt = JSON.parse(toolText(forkRes).split('\n\n[codex-thread')[0]);
    assert.equal(forkReceipt.forked, true);
    assert.equal(forkReceipt.sourceThreadId, b1.threadId);
    assert.notEqual(forkReceipt.threadId, b1.threadId);
    assert.equal(forkReceipt.sessionKey, 'branch-a');

    // Run independent turn on forked sessionKey
    const branchRun = await srv.callTool('subagent_codex', {
      description: 'Forked branch turn',
      prompt: JSON.stringify({ note: 'on-branch-a' }),
      cwd: dir,
      sessionKey: 'branch-a',
      sandbox: 'read-only',
    });
    assert.ok(!branchRun.isError, toolText(branchRun));
    const branchBody = JSON.parse(toolText(branchRun).split('\n\n[codex-thread')[0]);
    assert.equal(branchBody.threadId, forkReceipt.threadId);
    assert.equal(branchBody.forkedFrom, b1.threadId);
    assert.equal(branchBody.lastTurnId, b1.turnId);

    // Cleanly close both sessions
    assert.equal(JSON.parse(toolText(await srv.callTool('subagent_codex', { action: 'close', cwd: dir, sessionKey: 'base-sess' }))).closed, true);
    assert.equal(JSON.parse(toolText(await srv.callTool('subagent_codex', { action: 'close', cwd: dir, sessionKey: 'branch-a' }))).closed, true);
  } finally {
    await srv.stop();
  }

  // Test fork returning an already-registered threadId (target ID collision must fail without overwriting!)
  const dir2 = path.join(TEST_WORK_DIR, 'case16b');
  mkdirSync(dir2, { recursive: true });
  const store2 = await storeMod.openCodexSessionStore({ file: path.join(dir2, 'sessions.json'), maxSessions: 5 });
  try {
    const idA = randomUUID();
    const idB = randomUUID();
    const la = await store2.acquire({ sessionKey: 'src', cwd: dir2 });
    await la.commit({ threadId: idA, model: 'm' });
    la.release();
    const lb = await store2.acquire({ sessionKey: 'existing', cwd: dir2 });
    await lb.commit({ threadId: idB, model: 'm' });
    lb.release();

    const forkLease = await store2.acquireFork({ sourceSessionKey: 'src', targetSessionKey: 'new-branch', cwd: dir2 });
    try {
      await assert.rejects(
        forkLease.markUncertain({ threadId: idB, model: 'm' }),
        (err) => err?.code === storeMod.CODEX_ERROR_CODES.SELECTOR_CONFLICT,
      );
      const existingRow = await store2.getOwnedThread({ sessionKey: 'existing', cwd: dir2 });
      assert.equal(existingRow?.threadId, idB);
      assert.equal(existingRow?.sessionKey, 'existing');
    } finally {
      forkLease.release();
    }

    // Also verify reserved active targetSessionKey fails with BUSY WITHOUT running prune(),
    // AND verify concurrent acquire() cannot steal a slot freed by acquireFork()'s prune()!
    const dir3 = path.join(TEST_WORK_DIR, 'case16c');
    mkdirSync(dir3, { recursive: true });
    const store4 = await storeMod.openCodexSessionStore({ file: path.join(dir3, 'sessions.json'), maxSessions: 3 });
    try {
      const l1 = await store4.acquire({ sessionKey: 'src', cwd: dir3 });
      await l1.commit({ threadId: randomUUID(), model: 'm' });
      l1.release();
      const l2 = await store4.acquire({ sessionKey: 'idle-other', cwd: dir3 });
      await l2.commit({ threadId: randomUUID(), model: 'm' });
      l2.release();
      const reserved = await store4.acquire({ sessionKey: 'busy-target', cwd: dir3 });
      let pruneCalled = false;
      try {
        await assert.rejects(
          store4.acquireFork({
            sourceSessionKey: 'src',
            targetSessionKey: 'busy-target',
            cwd: dir3,
            prune: async () => {
              pruneCalled = true;
            },
          }),
          (err) => err?.code === storeMod.CODEX_ERROR_CODES.BUSY,
        );
        assert.equal(pruneCalled, false, 'busy targetSessionKey must reject BEFORE pruning');
      } finally {
        reserved.release();
      }
    } finally {
      await store4.dispose();
    }

    const dir4 = path.join(TEST_WORK_DIR, 'case16d');
    mkdirSync(dir4, { recursive: true });
    const store5 = await storeMod.openCodexSessionStore({ file: path.join(dir4, 'sessions.json'), maxSessions: 2 });
    try {
      const l1 = await store5.acquire({ sessionKey: 'src', cwd: dir4 });
      await l1.commit({ threadId: randomUUID(), model: 'm' });
      l1.release();
      const l2 = await store5.acquire({ sessionKey: 'idle-victim', cwd: dir4 });
      await l2.commit({ threadId: randomUUID(), model: 'm' });
      l2.release();

      let racerRejected = false;
      const fl = await store5.acquireFork({
        sourceSessionKey: 'src',
        targetSessionKey: 'forked-winner',
        cwd: dir4,
        prune: async (opts) => {
          await store5.prune({
            archive: async () => {},
            ...opts,
          });
          // Right after pruning frees a slot, a concurrent run tries to steal it -> MUST fail!
          await assert.rejects(
            store5.acquire({ sessionKey: 'racer', cwd: dir4 }),
            (err) => err?.code === storeMod.CODEX_ERROR_CODES.STORAGE_UNAVAILABLE,
          );
          racerRejected = true;
        },
      });
      try {
        assert.equal(racerRejected, true);
        await fl.commit({ threadId: randomUUID(), model: 'm' });
      } finally {
        fl.release();
      }
    } finally {
      await store5.dispose();
    }
  } finally {
    await store2.dispose();
  }
});

function settingsEnv(dir, extra = {}) {
  return {
    CODEX_WRAPPER_PATH: MOCK_WRAPPER,
    CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
    CODEX_HOME: path.join(dir, 'mock'),
    CODEX_MODEL: '',
    CODEX_REASONING_EFFORT: '',
    CODEX_SETTINGS_HTML: '',
    MOCK_CODEX_STATE_DIR: path.join(dir, 'mock'),
    ...extra,
  };
}

function settingsPayload(result) {
  assert.ok(!result.isError, toolText(result));
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  return result.structuredContent;
}

await test('18. Settings resource discovery, HTML cache and size limits, and exact MCP tool metadata', async () => {
  const dir = path.join(TEST_WORK_DIR, 'settings-resource');
  const serverPath = path.join(dir, 'mcp', 'server.mjs');
  const defaultHtml = path.join(dir, 'ui', 'dist', 'settings.html');
  const override = path.join(dir, 'override.html');
  const uri = 'ui://codex-subagent/settings.html';
  const mimeType = 'text/html;profile=mcp-app';
  const maxBytes = 10 * 1024 * 1024;
  const first = '<!doctype html><title>Codex Settings</title><p>first</p>';
  const second = '<!doctype html><title>Codex Settings</title><p>other</p>';
  const timestamp = new Date('2025-01-01T00:00:00Z');
  const changed = new Date('2025-01-01T00:00:01Z');
  mkdirSync(path.dirname(defaultHtml), { recursive: true });
  cpSync(path.join(PLUGIN_ROOT, 'mcp'), path.dirname(serverPath), { recursive: true });
  writeFileSync(defaultHtml, first);
  utimesSync(defaultHtml, timestamp, timestamp);
  const checkLimit = async (srv, filename) => {
    writeFileSync(filename, first.padEnd(maxBytes - 1, ' ') + '!');
    const { contents } = await srv.request('resources/read', { uri });
    assert.equal(Buffer.byteLength(contents[0].text, 'utf8'), maxBytes);
    assert.ok(contents[0].text.endsWith('!'));
    const fd = openSync(filename, 'r+');
    try { ftruncateSync(fd, maxBytes + 1); } finally { closeSync(fd); }
    await assert.rejects(srv.request('resources/read', { uri }), /RPC error -32603/);
  };
  const srv = startMcpServer(settingsEnv(dir), serverPath);
  try {
    assert.deepEqual((await srv.request('initialize')).capabilities, { tools: {}, resources: {} });
    const { resources } = await srv.request('resources/list');
    assert.deepEqual(resources, [{
      uri, mimeType, name: 'Codex Subagent Settings',
      description: 'Configure default Codex model and reasoning effort synced with ~/.codex/config.toml.',
      _meta: { ui: { prefersBorder: false } },
    }]);
    const read = () => srv.request('resources/read', { uri });
    const { contents } = await read();
    assert.deepEqual(contents, [{ uri, mimeType, text: first, _meta: resources[0]._meta }]);
    assert.match(contents[0].text, /<!doctype html>/i);
    assert.match(contents[0].text, /Codex Settings/i);
    writeFileSync(defaultHtml, second);
    utimesSync(defaultHtml, timestamp, timestamp);
    assert.deepEqual((await read()).contents, contents, 'same path, mtime and size use cached HTML');
    utimesSync(defaultHtml, changed, changed);
    assert.equal((await read()).contents[0].text, second, 'a changed mtime invalidates the cache');
    writeFileSync(defaultHtml, second + '!');
    utimesSync(defaultHtml, changed, changed);
    assert.equal((await read()).contents[0].text, second + '!', 'a changed size invalidates the cache');
    await checkLimit(srv, defaultHtml);
    await assert.rejects(srv.request('resources/read', { uri: 'ui://codex-subagent/monitor.html' }), /RPC error -32602/);

    const { tools } = await srv.request('tools/list');
    assert.deepEqual(tools.map((tool) => tool.name), [
      'subagent_codex', 'subagent_codex_wait', 'subagent_codex_list_sessions', 'subagent_codex_settings',
      'codex_ui_get_settings', 'codex_ui_update_settings',
    ]);
    const open = tools.find((tool) => tool.name === 'subagent_codex_settings');
    assert.deepEqual(open.inputSchema, { type: 'object', additionalProperties: false, properties: {} });
    assert.deepEqual(open._meta, {
      ui: { resourceUri: uri }, 'com.google.antigravity/ui': { entrypoints: [{ type: 'global', title: 'Codex Subagent' }] },
    });
    const appTools = tools.filter((tool) => tool._meta?.ui?.visibility?.includes('app'));
    assert.deepEqual(appTools.map((tool) => tool.name), ['codex_ui_get_settings', 'codex_ui_update_settings']);
    for (const tool of appTools) assert.deepEqual(tool._meta.ui.visibility, ['app']);
    assert.deepEqual(Object.keys(appTools[1].inputSchema.properties), ['reset', 'codex']);
    for (const removed of [
      'subagent_codex_monitor', 'codex_ui_list_conversations', 'codex_ui_get_conversation', 'codex_ui_steer', 'codex_ui_action',
    ]) {
      await assert.rejects(srv.callTool(removed), /RPC error -32602/);
    }
    const opened = await srv.callTool(open.name);
    assert.equal(toolText(opened), 'Codex Subagent Settings');
    const { serverVersion, ...payload } = settingsPayload(opened);
    assert.match(serverVersion, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(payload, settingsPayload(await srv.callTool('codex_ui_get_settings', { syncCodex: false })));
    assert.equal(payload.codexConfig.synced, false);
    for (const invalid of [{ unknown: true }, [], null]) assert.equal((await srv.callTool(open.name, invalid)).isError, true);
    assert.equal(existsSync(path.join(dir, 'mock')), false, 'opening settings must not spawn Codex');
  } finally {
    await srv.stop();
  }

  const custom = startMcpServer(settingsEnv(dir, { CODEX_SETTINGS_HTML: ' ' + override + ' ' }));
  try {
    await assert.rejects(custom.request('resources/read', { uri }), /RPC error -32603/);
    for (const html of [first, second]) {
      writeFileSync(override, html);
      utimesSync(override, timestamp, timestamp);
      assert.equal((await custom.request('resources/read', { uri })).contents[0].text, html);
    }
    writeFileSync(override, ' \n');
    await assert.rejects(custom.request('resources/read', { uri }), /RPC error -32603/);
    await checkLimit(custom, override);
  } finally {
    await custom.stop();
  }

  if (existsSync(path.join(PLUGIN_ROOT, 'ui', 'dist', 'settings.html'))) {
    const packaged = startMcpServer(settingsEnv(dir));
    try {
      const { contents } = await packaged.request('resources/read', { uri });
      assert.match(contents[0].text, /<!doctype html>/i);
      assert.match(contents[0].text, /Codex Settings/i);
    } finally {
      await packaged.stop();
    }
  }
});

await test('19a. Account rate limits retry with legacy parameters', async () => {
  for (const code of [-32602, -32600]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const exit = Promise.withResolvers();
    const rateLimitParams = [];
    stdin.once('finish', () => exit.resolve({ exitCode: 0 }));
    stdin.on('data', (chunk) => {
      const { id, method, params } = JSON.parse(chunk.toString());
      if (id === undefined) return;
      let result = {};
      if (method === 'model/list') result = { data: [] };
      if (method === 'account/rateLimits/read') {
        rateLimitParams.push(params);
        if (params.excludeResetCreditDetails === true) {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'mock legacy parameters required' } }) + '\n');
          return;
        }
        result = {
          rateLimitsByLimitId: {
            other: { planType: ' PROLITE ', primary: { usedPercent: 12.34 } },
          },
        };
      }
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    });

    const snapshot = await clientMod.readCodexConfigAndModels({
      spawn: () => ({ stdin, stdout, pid: 1, done: exit.promise, waitForExit: async () => Boolean(await exit.promise) }),
      argv: ['mock'], cwd: TEST_WORK_DIR,
    });
    assert.deepEqual(rateLimitParams, [{ excludeResetCreditDetails: true }, {}]);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.rateLimits.available, true);
    assert.equal(snapshot.rateLimits.planType, 'prolite');
    assert.deepEqual(snapshot.rateLimits.windows, [{
      kind: 'weekly', usedPercent: 12.3, remainingPercent: 87.7, windowDurationMins: null, resetsAt: null,
    }]);
  }
});

await test('19. Settings sync and teardown, validated native writes, runtime defaults, and warm pool eviction', async () => {
  const dir = path.join(TEST_WORK_DIR, 'settings-config');
  mkdirSync(dir);
  const initial = { model: 'mock-codex-pro', reasoningEffort: 'low' };
  const environment = { model: 'environment-model', reasoningEffort: 'minimal' };
  const runtime = { model: 'mock-codex-fast', reasoningEffort: 'max' };
  const resumedRuntime = { model: 'mock-codex-mini', reasoningEffort: 'high' };
  const explicit = { model: 'explicit-model', reasoningEffort: 'xhigh' };
  const rpcLog = path.join(dir, 'config-rpc.jsonl');
  const env = settingsEnv(dir, {
    CODEX_WARM_IDLE_MS: '60000',
    CODEX_EOF_GRACE_MS: '6000',
    CODEX_DISPOSE_GRACE_MS: '6000',
    MOCK_CODEX_CONFIG_MODEL: initial.model,
    MOCK_CODEX_CONFIG_EFFORT: initial.reasoningEffort,
    MOCK_CODEX_CONFIG_RPC_LOG: rpcLog,
  });
  const configPath = path.join(env.MOCK_CODEX_STATE_DIR, 'mock-codex-config.json');
  const codexToml = path.join(env.CODEX_HOME, 'config.toml');
  const writesPath = path.join(env.MOCK_CODEX_STATE_DIR, 'mock-config-writes.txt');
  const rejectWrite = path.join(env.MOCK_CODEX_STATE_DIR, 'reject-config-write');
  const mockRateLimitsPath = path.join(env.MOCK_CODEX_STATE_DIR, 'mock-rate-limits.json');
  const rejectRateLimits = path.join(env.MOCK_CODEX_STATE_DIR, 'reject-rate-limits');
  const rpcCalls = () => existsSync(rpcLog) ? readFileSync(rpcLog, 'utf8').trim().split('\n').map((entry) => JSON.parse(entry)) : [];
  const methodsSince = (count) => rpcCalls().slice(count).map((entry) => entry.method);
  const assertSyncCalls = (count) => {
    const calls = rpcCalls().slice(count).map(({ method, cursor }) => `${method}:${cursor ?? ''}`).sort();
    assert.deepEqual(calls, ['account/rateLimits/read:', 'config/read:', 'initialize:', 'model/list:', 'model/list:2']);
  };
  const writeCount = () => existsSync(writesPath) ? Number(readFileSync(writesPath, 'utf8')) : 0;
  const nativeSettings = ({ model, reasoningEffort }) => ({ model, model_reasoning_effort: reasoningEffort });
  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));
  const get = async (srv, args) => settingsPayload(await srv.callTool('codex_ui_get_settings', args));
  const update = async (srv, patch) => settingsPayload(await srv.callTool('codex_ui_update_settings', patch));
  const snapshotSettings = ({ codexConfig: { model, reasoningEffort } }) => ({ model, reasoningEffort });
  const run = async (srv, expected, overrides = {}) => {
    const { res } = await callAndWait(srv, {
      description: 'Settings runtime defaults', prompt: '{}', cwd: dir,
      sessionKey: 'settings-session', permissionMode: 'read-only', ...overrides,
    });
    assert.ok(!res.isError, toolText(res));
    const text = toolText(res);
    const { model, turnModel, effort, pid } = JSON.parse(text.split('\n\n[codex-thread')[0]);
    assert.deepEqual({ model, turnModel, effort }, { model: expected.model, turnModel: expected.model, effort: expected.reasoningEffort });
    assert.ok(Number.isInteger(pid) && pid > 0);
    return { text, pid };
  };

  const srv = startMcpServer({ ...env, CODEX_MODEL: environment.model, CODEX_REASONING_EFFORT: environment.reasoningEffort });
  try {
    const cached = await get(srv, { syncCodex: false });
    assert.deepEqual(Object.keys(cached), ['codexConfig', 'defaults', 'effective', 'options', 'limits', 'rateLimits']);
    assert.equal(cached.codexConfig.synced, false);
    assert.equal(cached.rateLimits.available, false);
    assert.deepEqual(cached.effective, environment);
    assert.deepEqual(cached.options.models, []);
    assert.deepEqual(cached.limits, { maxModelLength: 128 });
    for (const invalid of [{ syncCodex: 'false' }, { extra: true }]) {
      assert.equal((await srv.callTool('codex_ui_get_settings', invalid)).isError, true);
    }
    assert.equal(existsSync(env.MOCK_CODEX_STATE_DIR), false);
    assert.deepEqual(rpcCalls(), []);

    const synced = await get(srv);
    assert.equal(synced.codexConfig.synced, true);
    assert.equal(synced.codexConfig.catalogAvailable, true);
    assert.equal(synced.codexConfig.error, null);
    assert.equal(synced.codexConfig.catalogDefaultModel, initial.model);
    assert.equal(synced.codexConfig.catalogDefaultReasoningEffort, 'low');
    assert.deepEqual(snapshotSettings(synced), initial);
    assert.deepEqual(synced.defaults, { ...initial, envModel: environment.model, envReasoningEffort: environment.reasoningEffort });
    assert.deepEqual(synced.effective, environment);
    assert.deepEqual(synced.options.reasoningEfforts, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.deepEqual(synced.options.models.map((entry) => entry.model), ['mock-codex-pro', 'mock-codex-fast', 'mock-codex-mini']);
    assert.equal(synced.options.models[0].displayName, 'Mock Codex Pro');
    assertSyncCalls(0);
    const rateLimits = synced.rateLimits;
    assert.equal(rateLimits.available, true);
    assert.equal(rateLimits.planType, 'plus');
    assert.equal(rateLimits.ordinaryUsageAllowed, true);
    assert.equal(rateLimits.windows.length, 2);
    const [{ resetsAt: fiveHourReset, ...fiveHour }, { resetsAt: weeklyReset, ...weekly }] = rateLimits.windows;
    assert.deepEqual(fiveHour, { kind: 'five_hour', usedPercent: 18, remainingPercent: 82, windowDurationMins: 300 });
    assert.deepEqual(weekly, { kind: 'weekly', usedPercent: 94, remainingPercent: 6, windowDurationMins: 10080 });
    assert.ok(Number.isInteger(fiveHourReset) && fiveHourReset > 0);
    assert.ok(Number.isInteger(weeklyReset) && weeklyReset > 0);
    assert.deepEqual(rateLimits.credits, { hasCredits: false, unlimited: false, balance: '0' });
    assert.equal(rateLimits.spendControlReached, false);
    assert.equal(rateLimits.rateLimitReachedType, null);
    assert.equal(rateLimits.error, null);
    assert.equal(new Date(rateLimits.updatedAt).toISOString(), rateLimits.updatedAt);
    for (const key of ['accountId', 'email', 'rateLimitResetCredits', 'rateLimitUpsell']) {
      assert.equal(Object.hasOwn(rateLimits, key), false);
    }
    assert.equal(JSON.stringify(synced).includes('mock-account-id-must-strip'), false);
    assert.equal(JSON.stringify(synced).includes('mock-reset-credit-1'), false);

    const external = { model: 'mock-codex-fast', reasoningEffort: 'medium' };
    writeFileSync(configPath, JSON.stringify(nativeSettings(external)));
    const beforeResync = rpcCalls().length;
    assert.deepEqual(await get(srv, { syncCodex: false }), synced);
    assert.equal(rpcCalls().length, beforeResync);
    const resynced = await get(srv, { syncCodex: true });
    assert.deepEqual(snapshotSettings(resynced), external);
    assertSyncCalls(beforeResync);

    await run(srv, environment);
    const pinned = { sessionKey: 'unchanged-signature', ...explicit };
    const pinnedBefore = await run(srv, explicit, pinned);
    assert.equal((await run(srv, explicit, pinned)).pid, pinnedBefore.pid);
    const beforeWrite = rpcCalls().length;
    const firstWrite = await update(srv, { codex: { model: ' mock-codex-fast ', reasoningEffort: ' max ' } });
    assert.deepEqual(firstWrite.effective, runtime);
    assert.deepEqual(snapshotSettings(firstWrite), runtime);
    assert.deepEqual(firstWrite.rateLimits, resynced.rateLimits);
    assert.equal(firstWrite.codexConfig.catalogDefaultReasoningEffort, 'medium');
    assert.equal(JSON.stringify(firstWrite).includes(path.basename(configPath)), false);
    assert.deepEqual(readConfig(), nativeSettings(runtime));
    assert.equal(writeCount(), 1);
    assert.deepEqual(methodsSince(beforeWrite), ['initialize', 'config/batchWrite', 'config/read']);
    assert.notEqual((await run(srv, explicit, pinned)).pid, pinnedBefore.pid, 'evict even when the worker signature did not change');

    const live = await run(srv, runtime);
    assert.match(live.text, /resumed=true/);
    const beforeUnchanged = rpcCalls().length;
    assert.deepEqual(await update(srv, { reset: false, codex: runtime }), firstWrite);
    assert.equal(writeCount(), 1);
    assert.deepEqual(methodsSince(beforeUnchanged), []);
    assert.equal((await run(srv, runtime)).pid, live.pid, 'unchanged settings keep the warm worker');

    const beforeSecondWrite = rpcCalls().length;
    const secondWrite = await update(srv, { codex: resumedRuntime });
    assert.deepEqual(secondWrite.rateLimits, resynced.rateLimits);
    assert.deepEqual(methodsSince(beforeSecondWrite), ['initialize', 'config/batchWrite', 'config/read']);
    const resumed = await run(srv, resumedRuntime);
    assert.match(resumed.text, /resumed=true/);
    assert.notEqual(resumed.pid, live.pid);
    assert.equal((await run(srv, resumedRuntime)).pid, resumed.pid);
    await run(srv, explicit, explicit);
    const beforeFailureWorker = await run(srv, resumedRuntime);

    const beforeInvalid = await get(srv, { syncCodex: false });
    const beforeInvalidCalls = rpcCalls().length;
    for (const patch of [
      null, [], true, { roles: {} }, { unknown: true }, { reset: 'true' }, { codex: null }, { codex: [] },
      { codex: { unknown: true } }, { codex: { model: 42 } }, { codex: { model: 'has space' } },
      { codex: { model: 'control\u0000character' } }, { codex: { model: 'format\u200Bcharacter' } },
      { codex: { model: 'm'.repeat(129) } }, { codex: { reasoningEffort: true } },
      { reset: true, codex: { reasoningEffort: 'not-in-catalog' } },
    ]) {
      assert.equal((await srv.callTool('codex_ui_update_settings', patch)).isError, true, JSON.stringify(patch));
    }
    assert.deepEqual(methodsSince(beforeInvalidCalls), []);
    assert.deepEqual(await get(srv, { syncCodex: false }), beforeInvalid);
    assert.deepEqual(readConfig(), nativeSettings(resumedRuntime));
    assert.equal(writeCount(), 2);

    writeFileSync(rejectWrite, '');
    const beforeFailure = rpcCalls().length;
    const failed = await srv.callTool('codex_ui_update_settings', { codex: runtime });
    assert.equal(failed.isError, true);
    assert.match(toolText(failed), /mock config write error/);
    assert.deepEqual(methodsSince(beforeFailure), ['initialize', 'config/batchWrite']);
    assert.deepEqual(await get(srv, { syncCodex: false }), beforeInvalid);
    assert.deepEqual(readConfig(), nativeSettings(resumedRuntime));
    assert.equal(writeCount(), 2);
    assert.equal((await run(srv, resumedRuntime)).pid, beforeFailureWorker.pid);
    rmSync(rejectWrite);

    const nowSec = Math.floor(Date.now() / 1000);
    try {
      writeFileSync(mockRateLimitsPath, JSON.stringify({
        planType: 'pro', primary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: nowSec + 86400 }, secondary: null,
      }));
      const proWeekly = (await get(srv)).rateLimits;
      assert.equal(proWeekly.planType, 'pro');
      assert.equal(proWeekly.windows.length, 1);
      assert.equal(proWeekly.windows[0].kind, 'weekly');
      assert.equal(proWeekly.windows[0].remainingPercent, 68);

      writeFileSync(mockRateLimitsPath, JSON.stringify({
        planType: 'pro', primary: { usedPercent: 0, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 },
      }));
      const proWithFiveHour = (await get(srv)).rateLimits;
      assert.equal(proWithFiveHour.windows.length, 1);
      assert.equal(proWithFiveHour.windows[0].kind, 'weekly');
      assert.equal(proWithFiveHour.windows[0].remainingPercent, 60);
    } finally {
      rmSync(mockRateLimitsPath, { force: true });
    }

    writeFileSync(rejectRateLimits, '');
    try {
      const beforeUnavailable = rpcCalls().length;
      const unavailable = await get(srv);
      assertSyncCalls(beforeUnavailable);
      assert.equal(unavailable.codexConfig.synced, true);
      assert.equal(unavailable.codexConfig.catalogAvailable, true);
      assert.equal(unavailable.codexConfig.error, null);
      assert.equal(unavailable.rateLimits.available, false);
      assert.match(unavailable.rateLimits.error, /mock rate limits unavailable/);
    } finally {
      rmSync(rejectRateLimits);
    }

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdin.on('data', (chunk) => {
      const request = JSON.parse(chunk.toString());
      if (request.id !== undefined) stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\n');
    });
    const exit = Promise.withResolvers();
    let terminated = false;
    const mockChild = {
      stdin, stdout, pid: 1, done: exit.promise,
      terminate: () => { terminated = true; exit.resolve({ code: 0 }); },
      waitForExit: (signal) => {
        assert.equal(stdin.writableEnded, true);
        return terminated ? Promise.resolve(false)
          : new Promise((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }));
      },
    };
    const start = performance.now();
    await assert.rejects(clientMod.writeCodexUserConfig({
      spawn: () => mockChild, argv: ['mock'], cwd: dir, model: runtime.model, eofGraceMs: 6000, disposeGraceMs: 6000,
    }), (error) => error.facts?.stage === 'teardown' && /disposeGraceMs=2000/.test(error.cause?.message));
    assert.ok(performance.now() - start < 4000, 'config RPC teardown must not wait for the full EOF grace');
  } finally {
    await srv.stop();
  }

  const restarted = startMcpServer(env);
  try {
    assert.equal((await get(restarted, { syncCodex: false })).codexConfig.synced, false);
    const session = { sessionKey: 'native-after-restart' };
    const native = await run(restarted, resumedRuntime, session);
    assert.equal((await run(restarted, resumedRuntime, session)).pid, native.pid);
    assert.deepEqual(snapshotSettings(await get(restarted)), resumedRuntime);

    const refreshed = { ...resumedRuntime, reasoningEffort: 'medium' };
    writeFileSync(configPath, JSON.stringify(nativeSettings(refreshed)));
    writeFileSync(codexToml, 'model_reasoning_effort = "medium"\n');
    const afterMtimeChange = await run(restarted, refreshed, session);
    assert.notEqual(afterMtimeChange.pid, native.pid, 'config.toml mtime must invalidate a matching worker');
    assert.deepEqual(snapshotSettings(await get(restarted)), refreshed);

    const cleared = await update(restarted, { codex: { reasoningEffort: '  ' } });
    assert.deepEqual(snapshotSettings(cleared), { model: refreshed.model, reasoningEffort: null });
    assert.equal(writeCount(), 3);
    assert.equal((await update(restarted, { codex: { model: null } })).codexConfig.model, null);
    assert.equal(writeCount(), 4);
    await update(restarted, { codex: runtime });
    const resetSession = { sessionKey: 'reset-eviction', ...explicit };
    const beforeResetWorker = await run(restarted, explicit, resetSession);
    const beforeReset = rpcCalls().length;
    const reset = await update(restarted, { reset: true });
    assert.equal(writeCount(), 6);
    assert.deepEqual(readConfig(), { model: null, model_reasoning_effort: null });
    assert.deepEqual(snapshotSettings(reset), { model: null, reasoningEffort: null });
    assert.equal(reset.codexConfig.synced, true);
    assert.deepEqual(reset.effective, initial);
    assert.equal(reset.rateLimits.available, true);
    assert.deepEqual(methodsSince(beforeReset).slice(0, 3), ['initialize', 'config/batchWrite', 'config/read']);
    assertSyncCalls(beforeReset + 3);
    assert.notEqual((await run(restarted, explicit, resetSession)).pid, beforeResetWorker.pid);
    await run(restarted, { model: 'mock-codex-model', reasoningEffort: null }, { sessionKey: 'fresh-after-reset' });
  } finally {
    await restarted.stop();
  }
});

if (!UNIT_ONLY) {
  console.log('\n=== Part B: Live @openai/codex Integration Smoke Tests ===');
} else {
  console.log('\n=== Part B: Skipped (--unit-only) ===');
}

function livePassThroughEnv() {
  const env = {};
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'CODEX_MODEL',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function callAndWait(srv, args) {
  let res = await srv.callTool('subagent_codex', args);
  let sawRunning = false;
  let runningPayload = null;
  for (let i = 0; i < 20; i += 1) {
    if (res.isError) return { res, sawRunning, runningPayload };
    const txt = toolText(res);
    let parsed;
    try { parsed = JSON.parse(txt); } catch { parsed = null; }
    if (parsed?.status === 'running' && parsed.jobId) {
      sawRunning = true;
      runningPayload = parsed;
      res = await srv.callTool('subagent_codex_wait', { jobId: parsed.jobId, waitMs: 60000 });
      continue;
    }
    return { res, sawRunning, runningPayload };
  }
  throw new Error('live smoke exceeded poll iterations');
}

if (!UNIT_ONLY) {
  await test('10. Live @openai/codex cold mode: read-only + telemetry + localImage + footer + ergonomic close', async () => {
    const dir = path.join(TEST_WORK_DIR, 'live-cold');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'pixel.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));

    const srv = startMcpServer({
      CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
      CODEX_WARM_IDLE_MS: '0',
      ...livePassThroughEnv(),
    });
    try {
      const t1 = await callAndWait(srv, {
        description: 'Live smoke turn 1',
        prompt: 'Do not run any shell commands. Simply reply with "PONG_TURN1" and remember the secret codeword "COBALT-77" for the next turn.',
        cwd: dir,
        sessionKey: 'live-cold-smoke',
        permissionMode: 'read-only',
        reasoningEffort: 'low',
        waitMs: 1000,
      });
      assert.ok(!t1.res.isError, toolText(t1.res));
      const txt1 = toolText(t1.res);
      assert.ok(txt1.includes('PONG_TURN1'), `missing PONG_TURN1: ${txt1}`);
      assert.ok(/\[codex-thread threadId=[0-9a-f-]+ resumed=false tokens=\d+\/\d+ \([0-9.]+%\)\]/.test(txt1), `missing enriched footer: ${txt1}`);

      const t2 = await callAndWait(srv, {
        description: 'Live smoke turn 2 image',
        prompt: 'Do not run any shell commands. Reply with the exact secret codeword from our previous turn and confirm you received the attached image.',
        cwd: dir,
        sessionKey: 'live-cold-smoke',
        permissionMode: 'read-only',
        reasoningEffort: 'low',
        images: ['pixel.png'],
        waitMs: 60000,
      });
      assert.ok(!t2.res.isError, toolText(t2.res));
      const txt2 = toolText(t2.res);
      assert.ok(txt2.includes('COBALT-77'), `failed to recall COBALT-77: ${txt2}`);
      assert.ok(/\[codex-thread threadId=[0-9a-f-]+ resumed=true tokens=\d+\/\d+ \([0-9.]+%\)\]/.test(txt2), `missing resumed footer: ${txt2}`);

      const closed = await srv.callTool('subagent_codex', {
        action: 'close',
        cwd: dir,
        sessionKey: 'live-cold-smoke',
      });
      assert.ok(!closed.isError, toolText(closed));
      assert.equal(JSON.parse(toolText(closed)).closed, true);
    } finally {
      await srv.stop();
    }
  });

  await test('11. Live @openai/codex warm pool mode: 2-turn reuse + task_complete rollout proof + clean Windows archive', async () => {
    const dir = path.join(TEST_WORK_DIR, 'live-warm');
    mkdirSync(dir, { recursive: true });

    const srv = startMcpServer({
      CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
      CODEX_WARM_IDLE_MS: '60000',
      ...livePassThroughEnv(),
    });
    try {
      const t1 = await callAndWait(srv, {
        description: 'Live warm turn 1',
        prompt: 'Do not run any shell commands. Reply "WARM1_OK" and remember the codeword "AMBER-42".',
        cwd: dir,
        sessionKey: 'live-warm-smoke',
        permissionMode: 'read-only',
        reasoningEffort: 'low',
        waitMs: 60000,
      });
      assert.ok(!t1.res.isError, toolText(t1.res));
      assert.ok(toolText(t1.res).includes('WARM1_OK'), toolText(t1.res));

      const t2 = await callAndWait(srv, {
        description: 'Live warm turn 2',
        prompt: 'Do not run any shell commands. Reply with the exact codeword from the previous turn.',
        cwd: dir,
        sessionKey: 'live-warm-smoke',
        permissionMode: 'read-only',
        reasoningEffort: 'low',
        waitMs: 60000,
      });
      assert.ok(!t2.res.isError, toolText(t2.res));
      assert.ok(toolText(t2.res).includes('AMBER-42'), toolText(t2.res));
      assert.ok(toolText(t2.res).includes('resumed=true'), toolText(t2.res));

      const closed = await srv.callTool('subagent_codex', {
        action: 'close',
        cwd: dir,
        sessionKey: 'live-warm-smoke',
      });
      assert.ok(!closed.isError, toolText(closed));
      assert.equal(JSON.parse(toolText(closed)).closed, true);

      const listed = JSON.parse(toolText(await srv.callTool('subagent_codex_list_sessions', {})));
      assert.equal(listed.sessions.length, 0);
    } finally {
      await srv.stop();
    }
  });

  await test('17. Live @openai/codex v0.4.0 E2E: outputSchema + fork + compact + clean archive', async () => {
    const dir = path.join(TEST_WORK_DIR, 'live-v04');
    mkdirSync(dir, { recursive: true });

    const srv = startMcpServer({
      CODEX_SESSION_STORE_PATH: path.join(dir, 'sessions.json'),
      CODEX_WARM_IDLE_MS: '60000',
      ...livePassThroughEnv(),
    });
    try {
      // 1. outputSchema constrained JSON answer
      const t1 = await callAndWait(srv, {
        description: 'Live schema + base session',
        prompt: 'Do not run any shell commands. Return status="PASS" and remember codeword="RUBY-91".',
        cwd: dir,
        sessionKey: 'live-v04-base',
        permissionMode: 'read-only',
        reasoningEffort: 'low',
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'codeword'],
          properties: {
            status: { type: 'string' },
            codeword: { type: 'string' },
          },
        },
        waitMs: 60000,
      });
      assert.ok(!t1.res.isError, toolText(t1.res));
      const json1 = JSON.parse(toolText(t1.res).split('\n\n[codex-thread')[0]);
      assert.equal(json1.status, 'PASS');
      assert.equal(json1.codeword, 'RUBY-91');

      // 2. Fork into a branch & confirm branch inherits memory
      const forked = await srv.callTool('subagent_codex', {
        action: 'fork',
        cwd: dir,
        sessionKey: 'live-v04-base',
        targetSessionKey: 'live-v04-fork',
        permissionMode: 'read-only',
      });
      assert.ok(!forked.isError, toolText(forked));
      const forkReceipt = JSON.parse(toolText(forked).split('\n\n[codex-thread')[0]);
      assert.equal(forkReceipt.forked, true);

      const branchTurn = await callAndWait(srv, {
        description: 'Live forked recall',
        prompt: 'Do not run any shell commands. Simply reply with the exact codeword from before.',
        cwd: dir,
        sessionKey: 'live-v04-fork',
        permissionMode: 'read-only',
        reasoningEffort: 'low',
        waitMs: 60000,
      });
      assert.ok(!branchTurn.res.isError, toolText(branchTurn.res));
      assert.ok(toolText(branchTurn.res).includes('RUBY-91'), toolText(branchTurn.res));

      // 3. Compact base thread in-place
      const compacted = await callAndWait(srv, {
        action: 'compact',
        cwd: dir,
        sessionKey: 'live-v04-base',
        permissionMode: 'read-only',
        waitMs: 60000,
      });
      assert.ok(!compacted.res.isError, toolText(compacted.res));
      const cmpReceipt = JSON.parse(toolText(compacted.res).split('\n\n[codex-thread')[0]);
      assert.equal(cmpReceipt.compacted, true);

      // 4. Clean archive both threads
      const c1 = await srv.callTool('subagent_codex', { action: 'close', cwd: dir, sessionKey: 'live-v04-base' });
      const c2 = await srv.callTool('subagent_codex', { action: 'close', cwd: dir, sessionKey: 'live-v04-fork' });
      assert.ok(!c1.isError && JSON.parse(toolText(c1)).closed === true, toolText(c1));
      assert.ok(!c2.isError && JSON.parse(toolText(c2)).closed === true, toolText(c2));
    } finally {
      await srv.stop();
    }
  });
}

console.log(`\nALL ${passed} TESTS PASSED!`);
try {
  rmSync(TEST_WORK_DIR, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 });
} catch {
  // Ignore transient post-exit Windows handle delay.
}
