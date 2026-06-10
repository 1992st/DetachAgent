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
- `bin/detaches-agent-adapter.mjs`：CLI，可打印 manifest、校验 `clientContext.detaches`、生成标准 `detaches-terminal` / `detaches-file-transfer` fenced request。

它本身不执行命令、不传输文件，也不绕过 detaches_agent UI 审批。它的作用是让真实 agent 机器拥有稳定、可测试、可安装的协议入口，后续再按 OpenClaw 官方 skill/plugin 目录规范包装。

### 结构化 manifest

服务端通过 `apps/server/src/services/clientContextService.ts` 生成 `DetachesSessionContext`：

- `sessionKey`
- `agentId`
- 用户设备身份
- 可用 capability 列表
- 每个 capability 的 `supportedTargets` 与 `unavailableTargets`
- 必须遵守的执行不变量

这份 manifest 会同时进入两条链路：

- `chat.send.clientContext.detaches`：给 Gateway/agent runtime 使用的结构化上下文。
- 用户消息中的 `[detaches_agent 接入上下文]`：兼容当前 agent 只能阅读自然语言上下文的场景。

两者来自同一份数据，避免 UI、后端和 agent 看到不一致的能力说明。

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

服务端 `/api/tools/requests/extract` 负责解析 assistant 文本中的 `detaches-terminal` / `detaches-file-transfer` fenced block，并生成 `ToolRequestRecord`。前端只渲染 broker 返回的请求状态，不再维护自己的协议解析器。

审批后由 Tool Broker 在服务端调用会话 terminal 写入命令；前端不再直接把 approved command 写入 terminal，只负责展示 terminal 输出。

执行结果查询：

- `GET /api/tools/requests/:requestId/result`
- 返回 `executionId`、`terminalId`、`sessionKey`、terminal replay 输出切片、`capturedAt`。
- 当前结果是输出快照，不代表命令已经自然结束；后续需要补完成检测和输出摘要回写 agent。

审批入口：

- `POST /api/tools/requests/:requestId/approve`
- `POST /api/tools/requests/:requestId/reject`

审计文件：

- `storage/logs/tool-broker-audit.jsonl`

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
