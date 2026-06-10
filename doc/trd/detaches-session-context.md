# detaches_agent TRD - Session Context 与执行路由

## 背景

远端 OpenClaw agent 与用户对话时，容易把三个执行环境混在一起：

- 用户本机：运行 detaches_agent UI、Server、staging 文件和本机会话 terminal。
- 远端 agent host：OpenClaw agent 实际所在的远端电脑。
- Gateway 管理环境：OpenClaw Gateway 暴露的 workspace、artifacts、tools、environments 等能力。

单纯在用户消息末尾追加 prompt 可以缓解误解，但不是最终架构。agent 是否知道当前场景、工具是否能执行、文件是否真的传输成功，都必须由 detaches_agent 服务端和 Gateway adapter 共同证明。

## 当前实现

### Agent-side adapter 资产

`packages/openclaw-detaches-adapter` 提供第一版可放到远端 agent host 的协议资产：

- `adapter.manifest.json`：机器可读 capability、target、hard rules。
- `AGENT.md`：给远端 OpenClaw agent/skill 使用的操作说明。
- `bin/detaches-agent-adapter.mjs`：CLI，可打印 manifest、校验/诊断 `clientContext.detaches`、生成标准 `detaches-terminal` / `detaches-file-transfer` fenced request。

它本身不执行命令、不传输文件，也不绕过 detaches_agent UI 审批。它的作用是让真实 agent 机器拥有稳定、可测试、可安装的协议入口，后续再按 OpenClaw 官方 skill/plugin 目录规范包装。

`inspect-context` 是当前最小 agent-side skill 入口：远端 agent 可以把收到的 `clientContext.detaches` 保存为 JSON 后交给 CLI，得到 session identity、adapter readiness、capability target、requestable/unavailable 状态和 hard rules。它只输出机器可读诊断，不执行工具。

`terminal-request` / `file-transfer-request` 默认仍能输出 fenced block，兼容旧聊天文本解析；同时支持 `--format broker-event` 输出 Tool Broker `gateway-event` JSON envelope，也可以通过 `--submit-url <detaches_agent>/api/tools/events/gateway` 由 CLI 直接提交。结构化提交是当前替代文本 fenced block 的优先路径。

本地 server 暴露 adapter 分发接口：

- `GET /api/adapters/openclaw-detaches`：返回 manifest、文件清单、sha256、bundle 元信息和安装提示。
- `GET /api/adapters/openclaw-detaches/files/<path>`：下载白名单内的单个 adapter 文件。
- `GET /api/adapters/openclaw-detaches/bundle`：下载 `openclaw-detaches-adapter.tar.gz`。
- `GET /api/adapters/openclaw-detaches/install-plan?baseUrl=...&installDir=...`：生成给真实 agent host 执行的安装命令和验证命令。
- `GET /api/adapters/openclaw-detaches/readiness?target=...&installDir=...`：检查 adapter distribution 或指定安装目录是否完整。

这让远端 agent host 可以从 detaches_agent 获取同一份协议资产。它仍不是最终的 OpenClaw 原生 skill 安装器，但已经把“agent 需要知道当前 detaches 场景”从聊天 prompt 推进为可分发、可校验的 adapter 包。

安装计划只生成命令，不自动改远端机器。命令包含：

- 下载 detaches adapter bundle。
- 校验 sha256。
- 解包到指定 installDir。
- 运行 `detaches-agent-adapter manifest` 验证 adapter id。

当前 UI 可以把 install-plan 创建为待审批远端操作。`adapter-install` 请求：

- target 固定为 `remote-agent-host`。
- 风险等级固定为 `elevated`，审批必须带 `riskAccepted: true`。
- 审批后由 broker 在本机会话 terminal 写入 `curl local bundle | ssh remote shell` 命令。
- bundle 从本地 detaches_agent server 读取，经 SSH stdin 传到远端，因此不要求远端能访问用户本机 HTTP 端口。
- 远端安装/验证脚本优先用 manifest grep 校验 adapter id；如果远端 shell 能找到 `node`，再额外运行 CLI 校验。这样远端没有 node 时也能完成协议资产安装。
- 整个流程复用 Tool Broker 审批、审计、terminal replay 和结果回写。

readiness 接口给出 `ready` / `missing` / `invalid` / `error` 状态：

- 默认不传 `installDir` 时，检查本仓库内 adapter distribution 是否完整。
- 传入 `installDir` 时，检查该目录中的 `adapter.manifest.json`、`package.json` 和 CLI 文件。
- 返回 verify commands，可作为后续远端 SSH/agent-side skill 的健康检查脚本。
- 传 `probe=remote-ssh` 时，通过当前 SSH 配置在远端 agent host 执行只读检查脚本；不安装、不写文件、不改变远端状态。

### 结构化 manifest

服务端通过 `apps/server/src/services/clientContextService.ts` 生成 `DetachesSessionContext`：

- `sessionKey`
- `agentId`
- 用户设备身份
- 最近一次 remote-agent-host adapter readiness 快照
- 本次消息附带的 staged file 清单
- Tool Broker 结构化事件入口
- 可用 capability 列表
- 每个 capability 的 `supportedTargets` 与 `unavailableTargets`
- 必须遵守的执行不变量

这份 manifest 会同时进入两条链路：

- `chat.send.clientContext.detaches`：给 Gateway/agent runtime 使用的结构化上下文。
- 用户消息中的 `[detaches_agent 接入上下文]`：兼容当前 agent 只能阅读自然语言上下文的场景。

两者来自同一份数据，避免 UI、后端和 agent 看到不一致的能力说明。

`adapterStatus.remoteAgentHost` 只表达最近一次探测事实，例如 `ready`、`missing`、`error`。它不自动开放通用远端 terminal/file-transfer 能力；agent 仍必须依据 capability target 和 Tool Broker 支持情况发起受控请求。

`files.staged` 是本次消息附件的结构化清单，包含 `fileId`、显示名、MIME、大小、本地 staging 位置和默认 `detaches-file-transfer` 请求方式。可见 `[detaches_agent 文件上下文]` 仍作为兼容层保留，但 agent-side adapter/skill 应优先读取 `clientContext.detaches.files.staged`。

`broker.gatewayEventEndpoint` 是 adapter/skill 发起结构化待审批请求的入口，对应 `/api/tools/events/gateway`。adapter CLI 的 `--submit-url` 应优先使用这个值，`sourceEventId` 负责幂等。该 endpoint 来自 `publicBaseUrl` 配置，远端 agent host 访问不到 `127.0.0.1` 时应在设置页填入 Tailscale/LAN/反向代理地址。

`GET /api/tools/broker/capabilities` 是配套握手接口，adapter CLI 的 `broker-probe` 会校验 `app`、`protocolVersion`、`eventSource`、`idempotencyField`、`requestFormats` 和 `adapterId` 后再允许把该 endpoint 当作可信 broker 使用。

`broker.submitToken` 是当前服务生命周期内按 `sessionKey` 生成的轻量提交令牌。`POST /api/tools/events/gateway` 必须带 `Authorization: Bearer <submitToken>` 或 body/payload 中的 `submitToken`，否则返回 401。它不是最终身份系统，但能避免公开 broker endpoint 被任意来源直接塞入待审批请求。

adapter CLI 的 request 命令支持 `--context <clientContext-or-detaches.json>`，也支持 `--context -` 从 stdin 读取；既可以传完整 `clientContext`，也可以只传 `clientContext.detaches` 子对象。CLI 会自动提取 `sessionKey`、`agentId`、`broker.gatewayEventEndpoint` 和 `broker.submitToken`。默认只生成 broker-event JSON；加 `--submit` 时才使用 context 中的 endpoint 直接提交。显式命令行参数仍可覆盖 context 字段。

### Gateway 参数兼容

Gateway 曾拒绝顶层 `routeContext` 参数，所以当前只把 detaches 信息放入 `clientContext` 字段，不再向 `chat.send` 顶层添加未知字段。

### 事件路由

`apps/server/src/ws/chatSocket.ts` 会按以下优先级过滤 Gateway 流式事件：

1. payload/frame 内包含当前 `sessionKey`，允许显示。
2. payload/frame 内包含其他 `sessionKey`，拒绝显示。
3. 没有 `sessionKey` 时，必须包含当前会话已知的 `runId`，才允许显示。
4. 既没有 `sessionKey` 也没有已知 `runId`，拒绝显示。

这样可以减少“其他 agent 的流式回复出现在当前聊天框”的问题。

### 执行目标

当前 capability 明确建模为：

```text
local-user-machine   已支持，本机 detaches terminal / staging 文件
remote-agent-host    预留，需 Gateway adapter 或远端 agent-side skill
gateway-managed      预留，需 Gateway 原生文件/工具/artifact adapter
```

`remote-agent-host` 文件传输目前只做到：

- 通过 `agents.files.list(agentId)` 获取真实 agent workspace。
- 校验目标路径不能越出 workspace。
- 在真实传输 adapter 完成前拒绝执行，并写入审计日志。

### Tool request broker

服务端 `/api/tools/requests/extract` 负责解析 assistant 文本中的 `detaches-terminal` / `detaches-file-transfer` fenced block，并生成 `ToolRequestRecord`。前端只渲染 broker 返回的请求状态，不再维护自己的协议解析器。兼容文本解析路径会带上 `sourceMessageId` / `sourceRunId`，用于把工具请求回溯到具体聊天消息或 run。

`chat.history` 和 live chat payload 中的 `runId` 会被映射到共享 `ChatMessage.runId`。当某条 assistant 消息里包含兼容 fenced block 工具请求时，UI 会同时把 `sourceMessageId` 和 `sourceRunId` 交给 Broker，避免只知道“哪条消息触发”，却不知道“哪个 Gateway run 触发”。

结构化 Gateway 事件入口：

- `POST /api/tools/events/gateway`
- 输入字段与 `ToolRequestCreateInput` 一致，额外要求 `source: "gateway-event"` 和 `sourceEventId`。
- `sourceEventId` 用于幂等，同一 Gateway/OpenClaw tool event 重放时不会生成重复审批卡。
- 这是替代文本 fenced block 的目标入口；adapter CLI 的 `--format broker-event` 会生成该入口需要的 JSON；`/extract` 只保留为兼容旧 agent 输出的过渡路径。

Broker 队列查询：

- `GET /api/tools/requests`
- 支持 `sessionKey`、`agentId`、`status`、`limit` 过滤。
- UI 可从 broker 队列恢复请求状态；后续 Gateway/OpenClaw 原生 tool event 也应写入同一个队列，而不是继续依赖 assistant 文本解析。

Broker 事件订阅：

- `WS /api/tools/stream?sessionKey=...&agentId=...`
- 服务端在 request created/updated/ingested/duplicate 时推送 request event。
- UI 收到事件后刷新 broker 队列，避免只靠轮询或重新渲染聊天消息发现待审批请求。

审批后由 Tool Broker 在服务端调用会话 terminal 写入命令；前端不再直接把 approved command 写入 terminal，只负责展示 terminal 输出。

执行结果查询：

- `GET /api/tools/requests/:requestId/result`
- 返回 `executionId`、`terminalId`、`sessionKey`、terminal replay 输出切片、`completed`、`exitCode`、`capturedAt`、`forwardStatus`、`forwardError`、`forwardedAt`。
- Tool Broker 会通过有状态 outbox 把 `[detaches_agent 工具结果]` 快照回写到同一 session。当前回写通道仍是 Gateway `chat.send`，不是最终的 Gateway 原生 tool result。
- Tool Broker 通过注入 `__DETACHES_TOOL_START__` / `__DETACHES_TOOL_END__` marker 判断命令是否结束。

审批入口：

- `POST /api/tools/requests/:requestId/approve`
- `POST /api/tools/requests/:requestId/reject`
- `POST /api/tools/requests/:requestId/forward`

审计文件：

- `storage/logs/tool-broker-audit.jsonl`

状态文件：

- `storage/cache/tool-broker-state.json`
- 保存 broker request、terminal execution、tool result forward 状态。它是当前状态快照，不替代审计日志。

## 下一步目标

### 远端 agent-side skill

更合理的最终形态是在真实 agent 机器上提供 detaches/openclaw skill 或 adapter。当前仓库已提供 `packages/openclaw-detaches-adapter` 作为最小协议包，下一步需要按真实 OpenClaw skill/plugin 规范安装，让 agent runtime 原生知道：

- 当前对话来自 detaches_agent。
- 当前用户设备是谁。
- 哪些工具可以请求、哪些必须审批。
- 文件如何从用户本机 staging 被拉取到 agent workspace。
- terminal/文件操作结果如何回写。

该 skill 不应绕过 detaches_agent 审批；它只负责让远端 agent host 拥有可验证、可审计的本地能力入口。

### Adapter 优先级

1. `gateway-managed`：优先确认 `agents.files.*`、`artifacts.*`、`tools.invoke` 的 schema。
2. `remote-agent-host`：确认 `node.invoke` / `environments.*` 是否可安全执行远端命令。
3. agent-side skill：如果 Gateway 不提供足够执行能力，则由远端 OpenClaw skill 暴露标准协议。
4. `local-user-machine`：始终只代表用户本机，不承接远端请求。

## 验收点

- `chat.send` 发送时包含 `clientContext.detaches`。
- agent 可见消息包含同源渲染的 detaches session context。
- Gateway 流式事件不会因缺少 sessionKey 而默认广播到所有聊天框。
- 声明为不可用 target 的工具请求不会被本机 fallback 执行。
- `remote-agent-host` 路径校验使用真实 agent workspace，而不是用户输入猜测。
