<p align="center">
  <img src="./assets/logo.png" alt="Antigravity Codex Subagent Logo" width="128" />
</p>

# Antigravity Codex Subagent（`v0.5.0`）

[English](./README.md) | **简体中文**

面向 **Antigravity** 的独立 Node.js stdio MCP 服务器与 **MCP App 可视化插件**，通过 `@openai/codex` 官方 `app-server --stdio` JSON-RPC v2 协议将编码、排查或分析任务委托给独立的 OpenAI Codex 子代理执行，并内置可视化的 **Codex 监工台（Codex Monitor）**（支持侧边辅助面板 `+` 菜单和左侧全局导航栏）。

支持跨轮持久会话（`sessionKey` / `threadId`）、Gemini ↔ Codex 实时双边对话与遥测时间线、UI 界面实时纠偏（`steer`）、点击变更文件直达侧栏源码视图、协议级沙箱切换（`read-only` / `workspace-write` / `danger-full-access`）、本地多模态图片输入（`images`）、JSON Schema 结构化输出约束（`outputSchema`）、MCP `notifications/progress` 通知、上下文原地压缩（`compact`）、会话分叉（`fork`）、崩溃/重启恢复，以及按需开启的温池保活（Warm Worker Pool）。

## 前置要求

- **Node.js** `>= 20.0.0`
- 全局或在插件目录内安装 **Codex CLI（`@openai/codex`）**：
  ```bash
  npm install -g @openai/codex
  ```
- **Codex 登录认证**：执行 `codex login`（或配置 `OPENAI_API_KEY` / `~/.codex/config.toml`）。

## 安装步骤（Antigravity）

1. 将本仓库克隆到 Antigravity 的插件目录，并命名为 `codex-subagent`：
   - **macOS / Linux**：
     ```bash
     git clone https://github.com/Kiraliang954321/antigravity-codex-subagent.git ~/.gemini/config/plugins/codex-subagent
     ```
   - **Windows（PowerShell）**：
     ```powershell
     git clone https://github.com/Kiraliang954321/antigravity-codex-subagent.git "$env:USERPROFILE\.gemini\config\plugins\codex-subagent"
     ```
2. *（可选）* 如需覆盖默认模型、调整温池保活时间或配置代理，可编辑 `mcp_config.json`（如 `CODEX_MODEL`、`CODEX_WARM_IDLE_MS`、`CODEX_WRAPPER_PATH`，以及 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`）。
3. 在 Antigravity 中重新加载插件，使 `codex-subagent` MCP 服务与配套的 `skills/codex-subagent/SKILL.md` 生效。

## 提供的 MCP 工具

- `subagent_codex`：通过 `@openai/codex app-server --stdio` 向独立 Codex 子代理派发编码、代码评审或分析任务。支持：
  - **一次性或跨轮持久会话**（`sessionKey` / `threadId`），恢复会话时自动启用 `excludeTurns: true` 加速。
  - **协议级沙箱与权限预设切换**：支持按轮传入 `sandbox`（`"read-only"`、`"workspace-write"`、`"danger-full-access"`）与 `permissionMode`（`"never"`、`"read-only"`、`"approve-for-me"`、`"dangerously-bypass-approvals-and-sandbox"`），并在只读模式下执行 fail-closed 强约束。
  - **本地多模态图片输入**：通过 `images` 传入 `localImage`（在获取租约前预校验文件安全性与格式，单次最多 10 张、每张不超过 20MB）。
  - **结构化 JSON 输出约束**：通过 JSON Schema 参数 `outputSchema` 约束最终输出结构（仅用于 `action: "run"`）。
  - **上下文窗口占用提示**：返回尾部附带 `[codex-thread threadId=... resumed=... tokens=<used>/<window> (<pct>%)]`，占用达到 `>= 80%` 时自动追加 `[CONTEXT_WARNING]`。
  - **线程生命周期管理**：支持原地压缩（`action: "compact"`）、会话分叉（`action: "fork"`，需传 `targetSessionKey`，可选 `lastTurnId`）以及归档清理（`action: "close"`）。
- `subagent_codex_wait`：当 `subagent_codex` 超出同步等待窗口返回 `status: "running"`、`jobId` 及实时 `telemetry`（包含 `turnId`、`phase`、`lastActivityAt`、单调递增的 `idleMs`、`currentActivity`、`activeCount`、5 条 `recentActivities` 环形缓冲、`plan`、`diffSummary`、`tokenUsage`）时，继续轮询等待、运行中纠偏（`steer` + 可选 `images`）或取消任务。尚未认领的已结束任务回执会原子持久化到隔离的目录（`data/jobs/<store>-<hash>/<jobId>.json`，保留 30 分钟），确保跨越 MCP 服务重启仍可找回结果；当请求附带 `_meta.progressToken` 时还会按节流周期发送 MCP `notifications/progress`。
- `subagent_codex_list_sessions`：查看所有持久化 Codex 会话（`sessions`，含 `used` 与 `contextWindow`）以及运行中或待认领的后台任务（`activeJobs`，含实时遥测与磁盘恢复的待认领回执）。
- `subagent_codex_monitor`：唤出内置的 Antigravity **MCP App** 可视化监工台（`ui://codex-subagent/monitor.html`），也可直接从 Antigravity 右侧辅助面板的 **`+` 菜单**（`Codex Monitor`）或**左侧主导航栏**（`Codex Subagent`）无参启动。面板交互由 4 个仅对 UI 开放、对 Gemini 隐藏（`visibility: ["app"]`）的工具驱动（`codex_ui_list_conversations`、`codex_ui_get_conversation`、`codex_ui_steer`、`codex_ui_action`），既可实时观测过程与控制任务，又不会污染主对话上下文。

## Codex 监工台可视化界面（`v0.5.0`）

在右侧辅助面板点击 **`+`** 菜单选择 **Codex Monitor**（单会话侧边栏），或在左侧导航栏点击 **Codex Subagent**（全局多会话管理视图）：

- **Gemini ↔ Codex 双边对话时间轴**：直观呈现派单 Prompt 与沙箱/模型/推理深度徽章、执行计划勾选清单、可折叠的推理思考与终端命令输出流、Unified Diff 预览、行内纠偏气泡，以及 Markdown 渲染的 Codex 最终答复。
- **心跳与上下文水位条**：实时展示执行阶段（思考中/执行命令/输出中）、耗时与心跳 `idleMs`，并在 Token 占用达到 `>= 80%` 时显示黄色告警与快捷**「立即压缩」**按钮。
- **UI 直接控场**：看 Codex 跑偏时可直接在底部发送纠偏指令（`Steer`）或**强停任务**（不抢占 Gemini 对后台回执的认领权）；闲置持久会话可一键执行**压缩上下文**、**分叉会话（Fork）**、**归档关闭**或**清理历史**。
- **Antigravity 原生联动**：点击 Diff 中受影响的工作区文件可直接在侧边栏打开源码（`com.google.antigravity/toggle-aux-pane`），也可按当前宿主能力一键将 Codex 结论**引用或发回 Gemini**；界面自动适配深浅色主题与中英文环境。

## 配置说明（`mcp_config.json` `env`）

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CODEX_MODEL` | 未设置（继承 `~/.codex/config.toml`） | 新建会话的默认 Codex 模型；恢复既有会话时优先保留原会话模型，除非单次调用显式指定 `model`。 |
| `CODEX_REASONING_EFFORT` | 未设置（继承 `~/.codex/config.toml`） | 可选默认推理强度（`low`、`medium`、`high`、`xhigh`）。 |
| `CODEX_DEFAULT_WAIT_MS` | `120000` | 返回 `status: "running"` 前的默认同步等待窗口（毫秒，范围 `1000..150000`）。 |
| `CODEX_PERMISSION_MODE` | `never` | 默认审批/沙箱预设（`never`、`read-only`、`approve-for-me`、`dangerously-bypass-approvals-and-sandbox`）。 |
| `CODEX_SANDBOX` | 未设置 | 可选默认沙箱覆盖（`read-only`、`workspace-write`、`danger-full-access`）。 |
| `CODEX_WARM_IDLE_MS` | 代码默认 `0`（默认 `mcp_config.json` 为 `180000`） | 按需开启的 `app-server` 温池空闲存活时间（毫秒）。设为 `0` 时每轮冷启动新进程；`> 0` 时，连续持久会话在 `(cwd, permissionMode, sandbox, model, config)` 一致时复用已初始化的 worker，配置变化、空闲超时、`compact`/`fork`、`close` 或进程退出时自动安全回收。 |
| `CODEX_EOF_GRACE_MS` | `6000` | 关闭 stdin 后等待子进程自行退出的宽限时间（毫秒）。 |
| `CODEX_DISPOSE_GRACE_MS` | `3000` | 强制终止子进程树后等待退出收敛的宽限时间（毫秒）。 |
| `CODEX_REQUEST_TIMEOUT_MS` | `30000` | 单次 JSON-RPC 请求超时时间（毫秒，作用于 `codex-wire.mjs`）。 |
| `CODEX_TURN_TIMEOUT_MS` | 未设置 | 可选单轮对话超时时间（毫秒）。 |
| `CODEX_SESSION_TTL_MS` | `604800000`（7 天） | 闲置持久化会话的过期保留时长。 |
| `CODEX_MAX_SESSIONS` | `200` | 最大保留持久化会话数，超出后按 LRU 自动归档清理。 |
| `CODEX_SESSION_STORE_PATH` | `<plugin>/data/codex-subagent-sessions.json` | 隔离的会话注册表路径（同级 `jobs/` 目录保存未认领的已完成任务回执）。请勿与其他使用同名锁文件的客户端共用，避免 `.lock` 锁冲突。 |
| `CODEX_WRAPPER_PATH` | 自动探测 | 可选显式指定 `@openai/codex/bin/codex.js` 路径；未设置时按顺序自动探测本地 `node_modules`、标准全局 npm 目录以及可选 DSH 配置目录。 |
| `CODEX_ANCHOR_PATH` | 未设置 | 解析 `@openai/codex` 依赖时的可选附加搜索目录。 |
| `CODEX_HOME` | 未设置 | 可选覆盖 Codex CLI 的主目录。 |
| `CODEX_MONITOR_HTML` | `<plugin>/ui/dist/monitor.html` | 可选指定 MCP App 监控面板 HTML 路径（每次 `resources/read` 实时读取，便于本地开发调试 UI）。 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | 未设置（继承宿主环境） | 可选代理环境变量，会透传给启动的 `codex app-server` 子进程。 |

## 架构概览

- `mcp/server.mjs`：MCP stdio JSON-RPC 服务入口、MCP App 资源与视图入口注册（`ui://`）、工具 Schema 定义、后台任务调度、遥测聚合与温池协调。
- `mcp/codex-wire.mjs`：`@openai/codex app-server --stdio` JSON-RPC v2 帧解析、流式增量心跳、仅供 UI 消费的增量/Diff/操作明细事件、`plan`/`diff` 节流合并及线程/轮次 RPC 封装。
- `mcp/codex-client.mjs`：子进程生命周期管理、`@openai/codex` 路径解析、线程配置校验、rollout JSONL 完整性核验、温池、`compact` 与 `fork` 实现。
- `mcp/session-store.mjs`：带独占 `.lock` 保护的持久化会话注册表、`uncertain` 状态协调与原子 `fork`/租约事务。
- `mcp/disk-job-store.mjs`：按 store 隔离的磁盘任务回执存储及跨 MCP 重启的原子单次认领恢复。
- `mcp/transcript-store.mjs`：按 store 隔离的 UI 对话记录存储（`data/transcripts/`）、单调递增 `afterSeq` 增量拉取合并以及敏感凭据正则脱敏（`redactSecrets`）。
- `mcp/local-path-guard.mjs`：路径、重解析点、UNC/设备命名空间、网络驱动器防护与本地多模态图片校验。
- `mcp/subprocess-adapter.mjs`：跨平台子进程启动、管道排空与进程树终止适配（Windows 下使用 `taskkill /T /F`）。
- `ui/`：基于 `@modelcontextprotocol/ext-apps` 构建的 MCP App 前端源码，经 `esbuild` 打包为单文件 `ui/dist/monitor.html`（运行时零第三方 npm 依赖）。

## 测试

运行离线单元测试、协议并发与模拟 MCP 集成测试（无需联网及 Codex 登录）：

```bash
npm run test:unit
```

如需修改 `ui/src/` 下前端代码并重新打包单文件 `ui/dist/monitor.html`（需先执行 `npm install` 安装 `devDependencies`）：

```bash
npm run build:ui
```

运行完整自动化测试套件（包含真实 `@openai/codex` 端到端测试，需要本机已认证的 `@openai/codex` 与可用网络）：

```bash
npm test
```

## 容错与安全机制

- **注册表隔离**：维护独立的 `data/codex-subagent-sessions.json`（及 `data/jobs/` 下的任务回执），通过独占 `.lock` 文件保护并发读写，与其他工具链并行运行时互不冲突。
- **异常中断（`uncertain`）线程只读核对**：崩溃或重启后遗留在 `uncertain` 状态的线程，会通过 `thread/read` 与完整 rollout JSONL 校验进行只读核对（启动时后台非阻塞扫描且受 15 秒总预算控制，同时支持 `acquire()` / `acquireFork()` 按需即时恢复）：完好线程自动恢复为 `ready`，已归档或缺失线程清理出表，遇到损坏 rollout、`systemError` 或瞬时超时则保留 `uncertain` 防止误删。
- **Windows 进程树清理与本地路径防护**：终止子进程时会执行 `taskkill /pid <pid> /T /F` 并等待整棵进程树完全退出，随后才允许归档或替换 worker；Windows 驱动器类型检测使用快速 `fsutil fsinfo drivetype` 并以 PowerShell `[System.IO.DriveInfo]` 兜底，提前拒绝 UNC 路径、设备命名空间（`\\?\`、`\\.\`）、映射网络驱动器和远端重解析点。

## 致谢

本项目的 `@openai/codex` `app-server` 协议客户端生命周期与子进程管道排空设计参考了 [`@deepseek-ai/dsh-subagent-codex`](https://github.com/deepseek-ai/deepseek-harness)（MIT 协议）。

## 开源协议

[MIT](./LICENSE)
