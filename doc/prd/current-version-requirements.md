# detaches_agent v0.1 PRD - 已实现需求归档

## 版本目标

v0.1 的目标是提供一个本地 Web UI，使用户可以通过本地服务连接远端 OpenClaw Gateway，与多个远端 agent 聊天，并为每个聊天会话绑定一个本机持久 terminal。远端 agent 可以通过约定格式请求控制用户电脑，但必须由用户在 UI 中审批后执行。

## 已实现范围

### 多 Agent 聊天

- 本地 Web UI 通过本地 Node Server 连接远端 OpenClaw Gateway。
- UI 支持显示远端 agent 列表。
- 用户可选择不同 agent 进入聊天。
- 支持 Gateway health、agent list、chat history、chat send、chat abort。

### 会话隔离

- 默认使用本机 detaches 会话：`agent:<agentId>:detaches:<deviceIdShort>`。
- UI 支持在“本机会话”和“主会话”之间切换。
- 本机会话避免污染远端 `agent:<agentId>:main`。

### 文件能力

- 支持聊天附件上传。
- 本地缓存上传文件。
- 如果远端 SFTP 可用，可上传到配置的远端 workspace。
- 下载远端文件时限制在配置 workspace 范围内。

### 本机持久 Terminal

- 每个聊天 `sessionKey` 绑定一个本机 terminal。
- terminal 在选择会话后自动创建或复用。
- terminal UI 默认隐藏，用户可点击 `Agent Terminal` 展开查看。
- WebSocket 断开后后端仍保留 terminal 进程和 replay buffer。
- 同一 session 重连后可看到历史输出。

### Agent 控制本机

- 后端会在发送给远端 agent 的用户消息后追加 detaches_agent 接入上下文。
- 远端 agent 可通过如下格式请求执行本机命令：

````text
```detaches-terminal
{"command":"pwd","reason":"查看用户本机当前工作目录"}
```
````

- UI 解析命令块后显示审批卡。
- 用户点击 `Run` 后，命令才会写入当前会话对应 terminal。
- 用户可点击 `Reject` 拒绝执行。

### 连接与配置

- 支持配置远端 host、SSH user、identity path、Gateway transport、Gateway token/password。
- 支持直接 Gateway 或 SSH tunnel 连接模式。
- 提供网络诊断视图。

## 非目标

- v0.1 不实现无审批自动执行。
- v0.1 不实现复杂权限沙箱。
- v0.1 不保证全屏 TUI 程序在 fallback terminal 中完美工作。
- v0.1 不做标准桌面应用打包。

## 验收证据

- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- terminal WebSocket 可执行本机命令并返回输出。
- 同一 terminal session 重连后 replay 中保留历史输出。
- Git 初始提交：`a981cff Initial detaches_agent v0.1`。
