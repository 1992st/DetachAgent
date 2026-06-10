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

- `apps/server/src/config/settingsStore.ts`
  - 保存 UI 修改后的连接配置。
  - 路径：`storage/cache/settings.json`。
  - token/password 不暴露给 public settings。

### Gateway

- `apps/server/src/services/gateway/gatewayClient.ts`
  - 维护 OpenClaw Gateway WebSocket。
  - 支持 connect challenge、health、agents.list、sessions.list、chat.history、chat.send、chat.abort。

- `apps/server/src/services/gateway/agentDirectoryService.ts`
  - 合并 Gateway agents 和 sessions。
  - 生成 UI agent summary。

- `apps/server/src/ws/chatSocket.ts`
  - 前端聊天 WebSocket：`/api/chat/:sessionKey`。
  - 按 sessionKey 过滤 Gateway chat event。
  - 发送用户消息时追加 detaches_agent 接入上下文和 terminal 控制协议说明。

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
  - 解析 `detaches-terminal` 命令块并渲染审批卡。
  - 解析 `detaches-file-transfer` 文件传输请求并渲染审批卡。
  - 用户 Run 后调用 TerminalPanel 写入命令。

### Terminal

- `apps/web/src/features/terminal/TerminalPanel.tsx`
  - 建立 `/api/terminal/:sessionKey` WebSocket。
  - 默认折叠隐藏。
  - 可展开查看输出、输入命令、复制输出、清屏。
  - 暴露 `runCommand` 给 ChatPanel 审批卡使用。

### Settings / Diagnostics

- `apps/web/src/features/settings/SettingsPanel.tsx`
- `apps/web/src/features/connection/DiagnosticsPanel.tsx`
- 提供连接配置和网络诊断。

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
- Gateway `chat.send` 参数校验严格，不能传自定义 `routeContext`，所以 detaches 上下文采用 message 注入方式。
- 当前没有远端 agent host 的执行 adapter；`detaches-terminal` 和 `detaches-file-transfer` 只支持 `local-user-machine`。如果 agent 请求 `remote-agent-host` 或 `gateway-managed`，UI 必须显示不可用并阻断执行。
- Chat、terminal、file-transfer 的 UI 和协议解析目前集中在 `ChatPanel.tsx`，附件状态集中在 `App.tsx`，拓展性偏弱：
  - 附件缺少按 session 独立的 store，导致不同 agent 页面之间容易串状态。
  - 文件协议提示、审批卡、terminal 执行耦合在聊天组件里，后续增加更多 tool/capability 会继续膨胀。
  - 文件显示名和安全落盘名没有分层，sanitize 后的安全名被用于用户可见上下文，导致中文文件名可读性差。
  - 建议后续拆出 `features/attachments`、`features/toolRequests` 和 `services/stagedFiles`，让 ChatPanel 只负责消息渲染和组合。
