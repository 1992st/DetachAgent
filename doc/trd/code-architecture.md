# detaches_agent TRD - 代码架构

## Monorepo 结构

```text
detaches_agent/
  apps/
    server/        Node + TypeScript + Express + WebSocket
    web/           React + Vite
  packages/
    shared/        前后端共享类型
  docs/            早期设计文档和 HTML 说明
  doc/
    prd/           产品需求、待办、规划
    trd/           技术设计与代码架构
  testcase/        测试用例、工作流、全量测试脚本
  storage/         本地缓存、上传、下载、日志
```

## 后端

### 入口

- `apps/server/src/index.ts`
- 创建 Express app。
- 挂载 `/api` REST routes。
- 挂载 chat WebSocket。
- 挂载 terminal WebSocket。

### 配置

- `apps/server/src/config/appConfig.ts`
  - 读取 `.env.local` 和环境变量。
  - 提供默认 host、port、Gateway、SSH、storage 配置。
  - 提供 `publicServerBaseUrl()`，统一生成远端 adapter 可访问的 detaches_agent URL；优先使用 `DETACHES_PUBLIC_BASE_URL`，其次 `DETACHES_PUBLIC_HOST` / `TAILSCALE_IP` / server host。

- `apps/server/src/config/settingsStore.ts`
  - 保存 UI 修改后的连接配置。
  - 路径：`storage/cache/settings.json`。
  - token/password 不暴露给 public settings。
  - `publicBaseUrl` 可通过 UI 持久化，用于 Tool Broker gateway-event endpoint 和 staged file 下载 URL。

### Gateway

- `apps/server/src/services/gateway/gatewayClient.ts`
  - 维护 OpenClaw Gateway WebSocket。
  - 支持 connect challenge、health、agents.list、sessions.list、chat.history、chat.send、chat.abort。

- `apps/server/src/services/gateway/chatMapper.ts`
  - 把 Gateway `chat.history` 返回值转换成共享 `ChatMessage`。
  - 保留消息 `id`、`runId`、role、text、timestamp 和 raw payload，便于审计工具请求来源。

- `apps/server/src/services/clientContextService.ts`
  - 生成机器可读 `chat.send.clientContext.detaches` 和短可见 `[detaches_agent 接入上下文]`。
  - 每次聊天发送可自动创建一次性 `contextExport.consumeUrl`，让远端 agent-side adapter 直接 `doctor --url` 获取完整上下文。
  - 注入最近一次 remote-agent-host adapter readiness 快照，让 agent 能知道远端 adapter 是否已探测/安装。
  - readiness 只作为状态事实，不自动开放通用远端 terminal/file-transfer target。

- `apps/server/src/services/gateway/agentDirectoryService.ts`
  - 合并 Gateway agents 和 sessions。
  - 生成 UI agent summary。

- `apps/server/src/ws/chatSocket.ts`
  - 前端聊天 WebSocket：`/api/chat/:sessionKey`。
  - 按 sessionKey 过滤 Gateway chat event。
  - 发送用户消息时把完整 detaches 上下文放入 `clientContext.detaches`，消息文本只追加短兼容提示和附件提示。

### Terminal

- `apps/server/src/services/terminal/terminalService.ts`
  - 每个 `sessionKey` 管理一个本机 terminal。
  - 优先使用 `node-pty`。
  - 当前环境如 `node-pty` 不可用，会 fallback 到 pipe shell。
  - 保存 replay buffer。

- `apps/server/src/ws/terminalSocket.ts`
  - 前端 terminal WebSocket：`/api/terminal/:sessionKey`。
  - 支持 ready、data、status、error。
  - 支持 input 和 resize。

### Tool Broker

- `apps/server/src/services/tools/toolBrokerService.ts`
  - 记录 agent 请求的 `detaches-terminal` / `detaches-file-transfer` 工具调用。
  - 从 assistant 文本中解析 fenced request，生成服务端 `ToolRequestRecord`；也支持 `POST /api/tools/events/gateway` 写入结构化 Gateway tool event。
  - 分配服务端 `requestId`。
  - 记录 `source` / `sourceEventId`，对 Gateway/OpenClaw tool event 做幂等去重。
  - 记录 `sourceMessageId` / `sourceRunId`，让兼容文本解析出的工具请求能回溯到触发它的聊天消息。
  - 入队时执行基础风险分级：safe/elevated/destructive；destructive 会直接 blocked，elevated 在 UI 标记风险原因，审批 API 必须带 `riskAccepted: true`。
  - `adapter-install` 是 `remote-agent-host` 专用请求，固定 elevated 风险；审批后由 broker 写入本机会话 terminal 执行 SSH 安装命令，并进入同一审计/结果回写链路。
  - 阻断不可用 target，禁止把 `remote-agent-host` / `gateway-managed` 退化成本机执行。
  - 审批本机 terminal 请求时直接调用 `terminalService.runCommand` 写入会话 terminal。
  - 审批/拒绝时记录 `lastDecision`，包含 actor、decidedAt 和 riskAccepted，并同步写入审计日志。
  - 审批文件传输请求时复用 `fileTransferService.prepareTransfer` 生成一次性 curl 命令，并由 Broker 写入会话 terminal。
  - 写入命令时注入 start/end marker，记录 executionId、terminalId 和 terminal replay 起点；`/api/tools/requests/:requestId/result` 可查询输出快照、completed、exitCode 和工具结果回写状态。
  - 工具结果回写有 outbox 状态：`not-started` / `pending` / `sent` / `failed`。`POST /api/tools/requests/:requestId/forward` 可手动重试。
  - 当前仍通过 Gateway `chat.send` 把 `[detaches_agent 工具结果]` 快照回写到同一 session，让 agent 可继续推理；这是过渡层，最终应替换成 OpenClaw/Gateway 原生结构化 tool result。
  - 当前 request/execution 状态持久化到 `storage/cache/tool-broker-state.json`，服务重启后仍可查询请求、执行记录和回写状态。
  - `GET /api/tools/requests` 提供 broker 队列查询，支持 sessionKey、agentId、status、limit 过滤。
  - `GET /api/tools/broker/capabilities` 提供只读协议握手信息，供远端 adapter/skill 在提交请求前验证 broker endpoint、协议版本、request format、target 和 adapter id。
  - `WS /api/tools/stream` 推送 broker request created/updated/ingested/duplicate 事件。
  - 写入 `storage/logs/tool-broker-audit.jsonl`。

### Adapter Distribution

- `apps/server/src/services/adapters/openclawDetachesAdapterService.ts`
  - 读取 `packages/openclaw-detaches-adapter` 的 adapter manifest、skill manifest、OpenClaw `SKILL.md`、README、AGENT.md、CLI 和 package metadata。
  - 计算每个文件与 bundle 的 sha256。
  - 生成 `openclaw-detaches-adapter.tar.gz`，供真实 OpenClaw agent host 下载。

- API：
  - `GET /api/adapters/openclaw-detaches`
  - `GET /api/adapters/openclaw-detaches/files/<path>`
  - `GET /api/adapters/openclaw-detaches/bundle`
  - `GET /api/adapters/openclaw-detaches/install-plan`
  - `GET /api/adapters/openclaw-detaches/readiness`

- Install plan：
  - 生成给 `remote-agent-host` 执行的 shell 命令。
  - 包含 bundle 下载、sha256 校验、解包、chmod 和 manifest 验证。
  - 当前只返回计划，不直接 SSH 修改远端机器。

- Readiness：
  - 默认检查仓库内 adapter distribution 是否完整。
  - 传入 `installDir` 时检查目标目录中的 manifest、package version 和 CLI 文件。
  - 返回 ready/missing/invalid/error 与可在远端执行的 verify commands。
  - `probe=remote-ssh` 会使用当前 SSH 配置在远端运行只读检查脚本，用于证明真实 agent host 是否已经安装 adapter；该探测不安装、不修改远端文件。

### 文件

- `apps/server/src/services/files/fileTransferService.ts`
  - 上传文件本地 staging。
  - 生成一次性文件传输下载 URL。
  - 传输成功后清理 staging 文件。
  - 下载时限制 workspace 边界。

## 前端

### 入口

- `apps/web/src/app/App.tsx`
  - 管理整体状态：health、agents、diagnostics、selected agent、session mode、attachments。

### Agent 列表

- `apps/web/src/features/agents/AgentList.tsx`
  - 显示 Gateway agents。
  - 选择 agent 后由 App 计算 sessionKey。

### Chat

- `apps/web/src/features/chat/ChatPanel.tsx`
  - 建立 `/api/chat/:sessionKey` WebSocket。
  - 渲染历史、用户消息、assistant 流式消息。
  - 合并流式响应，避免重复打印。
  - 从 Gateway live chat payload 中提取 `runId`，并在兼容 fenced block 解析时传给 Tool Broker。
  - 把 assistant 文本交给 Tool Broker 解析，按返回的 `ToolRequestRecord` 渲染审批卡。
  - 保留消息内审批卡作为 fenced block 兼容入口。
  - 用户 Run/Transfer 后调用 Tool Broker 审批；Broker 在服务端写入 terminal，前端只展开 terminal 查看结果。

### Tool Queue

- `apps/web/src/features/tools/ToolQueuePanel.tsx`
  - 顶层 `工具队列` 页面，按当前 sessionKey/agentId 查询 `GET /api/tools/requests`。
  - 订阅 `/api/tools/stream`，收到 broker request 事件后刷新队列。
  - 承担主要审批、拒绝、结果回写重试和打开 terminal 操作，不依赖某条聊天消息存在。

### Terminal

- `apps/web/src/features/terminal/TerminalPanel.tsx`
  - 建立 `/api/terminal/:sessionKey` WebSocket。
  - 默认折叠隐藏。
  - 可展开查看输出、输入命令、复制输出、清屏。
  - 对审批卡只暴露 `reveal`，命令写入由服务端 Tool Broker 完成。

### Settings / Diagnostics

- `apps/web/src/features/settings/SettingsPanel.tsx`
- `apps/web/src/features/connection/ConnectionBar.tsx`
- 提供连接配置、网络测试、relationship skill 安装说明和顶部紧凑健康摘要。
- 主聊天页不再挂载右侧 Diagnostics/File/Adapter 面板；聊天视图只保留 Agent 列表和 ChatPanel。

## 共享类型

- `packages/shared/src/*`
- 包括 agent、chat、terminal、connection、settings、file 类型。

## 关键协议

### 执行目标

当前版本的 `detaches-terminal` 实际控制的是用户本机 terminal，不等价于远端 OpenClaw agent 所在机器。后续能力不应只靠 prompt 说明来避免误解，而应引入 tool routing：

```text
tool request
  target: local-user-machine | remote-agent-host | gateway-managed
  action: terminal | file-transfer | ...
```

路由层负责检查目标环境是否可用、生成审批卡、执行对应 adapter，并把结果回写给 agent。UI 审批卡必须展示 target，避免“归档到你的电脑”这类语义被误执行到本机 staging workspace。

当前已加入服务端 Tool Broker 作为执行路由入口。UI 不再本地解析工具协议，也不再把 approved command 直接写入 terminal；它只把 assistant 文本交给 `/api/tools/requests/extract`，由服务端解析 fenced request、登记请求、阻断 target、审批后写入会话 terminal、记录 execution、查询/重试工具结果回写并写审计日志。后续应让 Gateway adapter 直接产生结构化 tool request 和 tool result，进一步减少文本协议依赖。

当前后端暴露 `/api/gateway/capabilities`，从 Gateway hello/features 中提炼可用能力。已观察到的候选能力包括：

- `tools.invoke`
- `node.invoke`
- `agents.files.*`
- `artifacts.*`
- `environments.*`

adapter 选择优先级应从 capability summary 推导：

- `gateway-managed`：优先使用 `agents.files.*` / `artifacts.*` / `tools.invoke`。
- `remote-agent-host`：优先评估 `node.invoke` / `environments.*`。
- `local-user-machine`：作为本机 fallback，但不能承接声明为远端的请求。

2026-06-11 探测记录：

- 真实 Gateway `tools.catalog` 暴露 `exec`、`read`、`write` 等工具，但 `tools.invoke` 的参数 schema 尚未从 Gateway 响应中确认；直接尝试 `name + command/input/params/path` 均被 schema 拒绝。
- `environments.list` 返回 `gateway` 环境，capabilities 包含 `agent.run`、`sessions`、`tools`、`workspace`。
- `agents.files.list` 可直接返回 agent 的真实 workspace，例如 `audio-process` 的 workspace 是 `/Volumes/zhangstExtern/openclaw/workspace/audio-process`。
- 因此第一阶段 adapter 不应先盲写 `tools.invoke` 执行逻辑；应优先用 `agents.files.*` 做 agent workspace 发现与文件归档路径校验。
- 执行类能力（如远端 shell）等确认 `tools.invoke` 或 `node.invoke` 参数协议后再接入。

### Agent 请求本机命令

````text
```detaches-terminal
{"target":"local-user-machine","command":"pwd","reason":"查看用户本机当前工作目录"}
```
````

### Agent 请求文件传输

````text
```detaches-file-transfer
{"fileId":"uploaded-file-id","target":"local-user-machine","remotePath":"/tmp/input.txt","reason":"需要读取用户上传文件"}
```
````

### Terminal WebSocket

Server events：

- `ready`
- `data`
- `status`
- `error`

Client events：

- `input`
- `resize`
- `ping`

## 已知技术限制

- 当前环境中 `node-pty` 可能失败，fallback shell 可执行普通命令，但不是完整 TTY。
- Gateway `chat.send` 已使用 `clientContext.detaches` 传递 detaches 上下文；自然语言消息只保留短兼容提示，不再承载完整 broker/capability 状态。
- 当前没有远端 agent host 的执行 adapter；`detaches-terminal` 和 `detaches-file-transfer` 只支持 `local-user-machine`。如果 agent 请求 `remote-agent-host` 或 `gateway-managed`，UI 必须显示不可用并阻断执行。
- Chat、terminal、file-transfer 的 UI 和协议解析目前集中在 `ChatPanel.tsx`，附件状态集中在 `App.tsx`，拓展性偏弱：
  - 附件缺少按 session 独立的 store，导致不同 agent 页面之间容易串状态。
  - 文件协议提示、审批卡、terminal 执行耦合在聊天组件里，后续增加更多 tool/capability 会继续膨胀。
  - 文件显示名和安全落盘名没有分层，sanitize 后的安全名被用于用户可见上下文，导致中文文件名可读性差。
  - 建议后续拆出 `features/attachments`、`features/toolRequests` 和 `services/stagedFiles`，让 ChatPanel 只负责消息渲染和组合。
