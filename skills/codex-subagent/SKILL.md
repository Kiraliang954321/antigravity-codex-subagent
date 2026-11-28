---
name: codex-subagent
description: Delegate coding, debugging, review, or analysis tasks to an independent Codex subagent via the `subagent_codex` MCP tool over the official Codex app-server protocol, with optional persistent threads (`sessionKey` / `threadId`), sandbox controls (`sandbox` / `permissionMode`), local image inputs (`images`), JSON Schema `outputSchema`, live progress telemetry + turn steering (`steer`), in-place compaction (`action: "compact"`), thread branching (`action: "fork"`), and restart-resilient async job polling (`subagent_codex_wait`). Use when you want an independent second opinion from Codex, parallel deep code analysis, multimodal UI/code inspection, or multi-turn persistent Codex sessions.
---

# Codex Subagent (`subagent_codex`)

This plugin exposes the `codex-subagent` engine (`0.5.0`) to Antigravity through the `codex-subagent` MCP server over the official `@openai/codex` `app-server --stdio` JSON-RPC v2 protocol, including a built-in Antigravity MCP App settings panel (`ui://codex-subagent/settings.html`).

## Available Tools

### 1. `subagent_codex`

Delegates a self-contained task to `@openai/codex` (`app-server --stdio`) and returns its final response — or, if the run exceeds `waitMs`, keeps Codex running in the background and returns `status: "running"` with a `jobId` and live `telemetry` so Antigravity's MCP call timeout is never hit.

**Required arguments:**
- `cwd`: Absolute path to an existing directory for the child Codex run (for example, the active workspace root).
- `description` *(required when `action` is `"run"`; optional when `"close"`, `"compact"`, or `"fork"`)*: Short 3–5 word summary for display.
- `prompt` *(required when `action` is `"run"`; optional or `""` otherwise)*: Complete task instructions for `"run"`.

**Optional arguments:**
- `sessionKey`: Task-scoped key matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Creates, resumes, compacts, forks, or closes a persistent Codex thread in the same `cwd`.
- `threadId`: Owned Codex thread UUID returned in `[codex-thread threadId=... resumed=...]` to resume, compact, fork, or close a specific thread.
- `action`: `"run"` (default), `"compact"` (compress long thread context in-place via `thread/compact/start`), `"fork"` (branch an existing thread into `targetSessionKey` via `thread/fork`), or `"close"` (archive in Codex and unregister).
- `targetSessionKey` *(required when `action` is `"fork"`)*: New `sessionKey` to bind to the forked persistent thread.
- `lastTurnId` *(optional when `action` is `"fork"`)*: Inclusive last `turnId` from the source thread to fork through.
- `model`: Optional model override. On resumed turns without an explicit `model` (and no live settings panel override), the session preserves its previous model; otherwise it falls back to `CODEX_MODEL` env (or inherits `~/.codex/config.toml` when unset).
- `permissionMode`: Optional approval/sandbox preset (`"never"`, `"read-only"`, `"approve-for-me"`, or `"dangerously-bypass-approvals-and-sandbox"`). `"read-only"` enforces `{ approvalPolicy: "never", sandbox: "read-only" }` fail-closed.
- `sandbox`: Optional protocol-level sandbox override (`"read-only"`, `"workspace-write"`, `"danger-full-access"`). Can be changed turn-by-turn on a persistent `sessionKey`. Conflicts with `permissionMode: "read-only"` when set to a non-read-only value.
- `images`: Optional array of up to 10 local image file paths (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`; `<= 20MB` each; absolute or relative to `cwd`) attached as `localImage` blocks alongside `prompt`.
- `outputSchema`: Optional JSON Schema object (`<= 64KB`) passed to `turn/start` to constrain Codex's final output (valid only when `action` is `"run"`).
- `waitMs`: Synchronous wait window in ms before returning `status: "running"` with a `jobId` and `telemetry` (default `120000`, clamped to `1000..150000`).
- `reasoningEffort`: Optional reasoning effort override (`"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"ultra"`).

### 2. `subagent_codex_wait`

Continues waiting for, steers mid-turn, or cancels a background Codex job started by `subagent_codex`. Settled unclaimed jobs are also persisted to `data/jobs/<store>-<hash>/<jobId>.json` (30-minute TTL, atomic single-claim) so results can still be recovered across MCP server restarts.

**Arguments:**
- `jobId` (required): The `jobId` returned when `subagent_codex` or `subagent_codex_wait` returned `status: "running"`.
- `waitMs` (optional): Max wait window before returning `status: "running"` again with refreshed `telemetry` (default `120000`, clamped to `1000..150000`).
- `steer` (optional): Steering instruction injected into the currently active turn via `turn/steer` (cannot be combined with `cancel: true`).
- `images` (optional): Local image paths attached to a `steer` message (only valid when `steer` is provided).
- `cancel` (optional boolean): Set `true` to abort and clean up the background run.

### 3. `subagent_codex_list_sessions`

Takes `{}` and lists both persistent Codex threads (`sessions`, including `used` / `contextWindow`) and any running or unclaimed background jobs (`activeJobs`, including live `telemetry` with `phase`, `plan`, `diffSummary`, `idleMs`, `tokenUsage`, and `persisted: true` receipts recovered from disk).

### 4. `subagent_codex_settings`

Opens the built-in Antigravity **MCP App** Codex Default Settings panel (`ui://codex-subagent/settings.html`), also directly launchable with `{}` from Antigravity's **left sidebar** (`Codex Subagent`). Reads and writes Codex global defaults (`~/.codex/config.toml`), dynamically syncs available models and per-model reasoning efforts (`model/list`), and displays live account usage quota bars (`account/rateLimits/read`, adapting to Plus 5-hour + weekly vs. Pro weekly-only plans). Takes no required arguments (`{}`).

## Usage Rules

1. **Handling long Codex runs, live telemetry, & steering (`status: "running"`):**
   - If `subagent_codex` returns `{"status": "running", "jobId": "...", "telemetry": {...}}`, inspect `telemetry` (`phase`, `idleMs`, `currentActivity`, `activeCount`, `recentActivities`, `plan`, `diffSummary`, `tokenUsage`) to judge progress without guessing. Do **not** abandon active runs; call `subagent_codex_wait` with that `jobId` until it completes.
   - If telemetry shows the run heading in the wrong direction, call `subagent_codex_wait` with `steer` (and optional `images`) to redirect the active turn without losing prior work.
   - For fast architectural planning or quick checks, set `reasoningEffort: "medium"` or `"high"` when `"xhigh"` is unnecessary.
2. **Protocol-level read-only reviews, structured output, & sandbox switching:**
   - For code reviews, architecture planning, or read-only audits, pass `sandbox: "read-only"` (or `permissionMode: "read-only"`). Add `outputSchema` when you need machine-validated JSON findings/contracts.
   - When moving from planning to backend implementation on the same `sessionKey`, pass `sandbox: "workspace-write"` (or omit `sandbox` to use CLI defaults), or branch cleanly via `action: "fork"`.
3. **Monitoring & compacting context window usage:**
   - Persistent thread replies end with `[codex-thread threadId=... resumed=... tokens=<used>/<window> (<pct>%)]` when Codex reports token telemetry.
   - If `[CONTEXT_WARNING]` appears (`>= 80%` context utilization), run `action: "compact"` on that `sessionKey` (or close and open a fresh `sessionKey`) before hitting `contextWindowExceeded`.
4. **Ephemeral vs. Persistent & crash recovery:**
   - Omit both `sessionKey` and `threadId` for one-off tasks; Codex runs an ephemeral thread that leaves no registry entry.
   - Do not send concurrent `run` requests for the same `sessionKey` or `threadId` (`CODEX_THREAD_BUSY`).
   - Interrupted `uncertain` threads are reconciled read-only via `thread/read` + rollout checks on startup and on-demand during `acquire()` / `acquireFork()`.
5. **Matching `cwd` & closing finished threads:**
   - Resuming, compacting, forking, or closing a persistent session requires the same `cwd` that originally created it (`CODEX_THREAD_CWD_MISMATCH` otherwise).
   - When finished, call `subagent_codex` with `{ action: "close", cwd, sessionKey }` (or `threadId`).
6. **Tool discovery:**
   - Antigravity registers the plugin's MCP server as `codex-subagent_codex-subagent`. Call `subagent_codex`, `subagent_codex_wait`, `subagent_codex_list_sessions`, or `subagent_codex_settings` via `call_mcp_tool` on `ServerName: "codex-subagent_codex-subagent"`.
