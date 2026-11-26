# Antigravity Codex Subagent (`v0.4.0`)

**English** | [简体中文](./README.zh-CN.md)

Standalone Node.js stdio MCP server plugin for **Antigravity** that delegates tasks to an independent OpenAI Codex subagent over the official `@openai/codex` `app-server --stdio` JSON-RPC v2 protocol.

Supports persistent multi-turn threads (`sessionKey` / `threadId`), protocol-level sandbox switching (`read-only` / `workspace-write` / `danger-full-access`), multimodal local image inputs, JSON Schema `outputSchema`, live progress & streaming telemetry, MCP `notifications/progress`, mid-turn steering (`steer`), in-place context compaction (`compact`), thread branching (`fork`), crash/restart recovery, and an opt-in warm worker pool.

## Prerequisites

- **Node.js** `>= 20.0.0`
- **Codex CLI (`@openai/codex`)** installed globally or locally inside this plugin directory:
  ```bash
  npm install -g @openai/codex
  ```
- **Codex Authentication**: run `codex login` (or configure `OPENAI_API_KEY` / `~/.codex/config.toml`).

## Installation (Antigravity)

1. Clone this repository into Antigravity's plugins directory as `codex-subagent`:
   - **macOS / Linux**:
     ```bash
     git clone https://github.com/Kiraliang954321/antigravity-codex-subagent.git ~/.gemini/config/plugins/codex-subagent
     ```
   - **Windows (PowerShell)**:
     ```powershell
     git clone https://github.com/Kiraliang954321/antigravity-codex-subagent.git "$env:USERPROFILE\.gemini\config\plugins\codex-subagent"
     ```
2. *(Optional)* Customize `mcp_config.json` if you want to override `CODEX_MODEL`, `CODEX_WARM_IDLE_MS`, `CODEX_WRAPPER_PATH`, or forward proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`).
3. Reload plugins in Antigravity so the `codex-subagent` MCP server and its bundled `skills/codex-subagent/SKILL.md` are registered.

## Provided MCP Tools

- `subagent_codex`: Delegate a coding, review, or analysis task to an independent Codex subagent via `@openai/codex app-server --stdio`. Supports:
  - **Ephemeral or persistent multi-turn threads** (`sessionKey` / `threadId`) with `excludeTurns: true` resume optimization.
  - **Protocol-level sandbox & permission switching** via `sandbox` (`"read-only"`, `"workspace-write"`, `"danger-full-access"`) and `permissionMode` (`"never"`, `"read-only"`, `"approve-for-me"`, `"dangerously-bypass-approvals-and-sandbox"`), with fail-closed `read-only` enforcement.
  - **Multimodal local image inputs** via `images` (`localImage` blocks validated upfront up to 10 images / 20MB each before acquiring a lease).
  - **Structured output constraints** via JSON Schema `outputSchema` (`action: "run"`).
  - **Context window usage footer** (`[codex-thread threadId=... resumed=... tokens=<used>/<window> (<pct>%)]`) with automatic `[CONTEXT_WARNING]` at `>= 80%` utilization.
  - **Thread lifecycle operations**: in-place compaction (`action: "compact"`), thread branching (`action: "fork"` with `targetSessionKey` and optional `lastTurnId`), and archiving (`action: "close"`).
- `subagent_codex_wait`: Continue waiting for, steer (`steer` + optional `images`), or cancel a background Codex job when `subagent_codex` returns `status: "running"` with a `jobId` and live `telemetry` (`turnId`, `phase`, `lastActivityAt`, monotonic `idleMs`, `currentActivity`, `activeCount`, 5-item `recentActivities` ring buffer, `plan`, `diffSummary`, `tokenUsage`). Unclaimed settled job receipts are atomically persisted to an isolated per-store directory (`data/jobs/<store>-<hash>/<jobId>.json`, 30-minute TTL) so results survive MCP server restarts. Also emits throttled MCP `notifications/progress` when `_meta.progressToken` is supplied.
- `subagent_codex_list_sessions`: Inspect persistent Codex threads (`sessions`, including `used` and `contextWindow`) and active or unclaimed background jobs (`activeJobs`, including live telemetry and disk-persisted unclaimed receipts).

## Configuration (`mcp_config.json` `env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CODEX_MODEL` | unset (inherits `~/.codex/config.toml`) | Optional default Codex model for new sessions (resumed turns preserve their prior session model unless overridden per call). |
| `CODEX_REASONING_EFFORT` | unset (inherits `~/.codex/config.toml`) | Optional default reasoning effort (`low`, `medium`, `high`, `xhigh`). |
| `CODEX_DEFAULT_WAIT_MS` | `120000` | Default synchronous wait window in ms before returning `status: "running"` (`1000..150000`). |
| `CODEX_PERMISSION_MODE` | `never` | Default approval/sandbox preset (`never`, `read-only`, `approve-for-me`, `dangerously-bypass-approvals-and-sandbox`). |
| `CODEX_SANDBOX` | unset | Optional default sandbox override (`read-only`, `workspace-write`, `danger-full-access`). |
| `CODEX_WARM_IDLE_MS` | `0` in code (`180000` in default `mcp_config.json`) | Opt-in warm `app-server` worker idle TTL in ms. When `0`, each turn spawns a fresh process. When `> 0`, consecutive persistent turns with matching `(cwd, permissionMode, sandbox, model, config)` reuse the initialized worker and evict cleanly on config change, idle timeout, compact/fork, close, or shutdown. |
| `CODEX_EOF_GRACE_MS` | `6000` | Grace period waiting for clean child exit after closing stdin. |
| `CODEX_DISPOSE_GRACE_MS` | `3000` | Bounded grace period waiting after subprocess termination. |
| `CODEX_REQUEST_TIMEOUT_MS` | `30000` | Per-RPC request timeout in ms (inside `codex-wire.mjs`). |
| `CODEX_TURN_TIMEOUT_MS` | unset | Optional per-turn timeout in ms. |
| `CODEX_SESSION_TTL_MS` | `604800000` (7 days) | Idle persistent session expiration TTL. |
| `CODEX_MAX_SESSIONS` | `200` | Maximum tracked persistent sessions before LRU archiving. |
| `CODEX_SESSION_STORE_PATH` | `<plugin>/data/codex-subagent-sessions.json` | Isolated session registry path (`jobs/` sibling directory stores unclaimed settled job receipts). Keep separate from other harnesses sharing the same filename pattern to avoid `.lock` contention. |
| `CODEX_WRAPPER_PATH` | auto-resolved | Optional explicit path to `@openai/codex/bin/codex.js` (auto-resolves from local `node_modules`, standard global npm directories, or optional DSH profile). |
| `CODEX_ANCHOR_PATH` | unset | Optional directory anchor searched when resolving `@openai/codex`. |
| `CODEX_HOME` | unset | Optional Codex home directory override. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | unset (inherits environment) | Optional proxy settings forwarded to the spawned `codex app-server` child. |

## Architecture

- `mcp/server.mjs`: MCP stdio JSON-RPC server, tool schemas, job lifecycle, telemetry aggregation, and warm worker coordination.
- `mcp/codex-wire.mjs`: `@openai/codex app-server --stdio` JSON-RPC v2 framing, activity/delta heartbeats, plan/diff coalescing, and turn/thread RPC methods.
- `mcp/codex-client.mjs`: Subprocess lifecycle, `@openai/codex` binary resolution, thread config assertions, rollout JSONL validation, warm worker pool, `compact`, and `fork`.
- `mcp/session-store.mjs`: Persistent session registry with exclusive `.lock` fencing, uncertain reconciliation coordination, and atomic fork/lease transactions.
- `mcp/disk-job-store.mjs`: Per-store isolated disk job receipts and atomic single-claim recovery across MCP restarts.
- `mcp/local-path-guard.mjs`: Path/reparse/UNC/device/network-drive guards and multimodal `localImage` validation.
- `mcp/subprocess-adapter.mjs`: Cross-platform subprocess spawn/drain/tree-termination adapter (`taskkill /T /F` on Windows).

## Testing

Run offline unit, protocol, concurrency, and mock-MCP tests (no network or Codex login required):

```bash
npm run test:unit
```

Run the full automated suite (includes live `@openai/codex` E2E tests — requires an authenticated `@openai/codex` installation and network access):

```bash
npm test
```

## Resilience & Safety

- **Registry Isolation**: Keeps its own registry at `data/codex-subagent-sessions.json` (and unclaimed job receipts under `data/jobs/`) with an exclusive `.lock` file so concurrent harnesses never collide.
- **Uncertain Thread Reconciliation**: Interrupted threads left in `state: "uncertain"` after a crash or restart are probed read-only via `thread/read` + rollout JSONL validation (non-blocking background startup sweep with a 15-second budget, plus on-demand recovery in `acquire()` / `acquireFork()`), restoring intact threads to `ready`, cleaning archived/missing entries, and preserving `uncertain` on corrupt rollouts, `systemError`, or transient timeouts.
- **Windows Process-Tree Teardown & Local-Path Guard**: Subprocess termination executes `taskkill /pid <pid> /T /F` and waits for process-tree exit before allowing archive or worker replacement. Windows drive-type checks use `fsutil fsinfo drivetype` with PowerShell `[System.IO.DriveInfo]` fallback, rejecting UNC, device namespaces (`\\?\`, `\\.\`), mapped network drives, and remote reparse points before touching target paths.

## Acknowledgements

Portions of the `@openai/codex` `app-server` protocol client lifecycle and subprocess drain design were inspired by [`@deepseek-ai/dsh-subagent-codex`](https://github.com/deepseek-ai/deepseek-harness) (MIT License).

## License

[MIT](./LICENSE)
