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
- 支持 `local-user-machine` 和 `remote-agent-host` 两类文件传输 target。
- `remote-agent-host` 文件传输通过当前 SSH 配置在远端执行 `curl`，从 detaches_agent reverse bridge 拉取 staging 文件。
- 远端文件写入限制在当前远端用户 home 或配置的 `remoteWorkspaceRoot` 内，避免误写其他用户目录。
- 文件传输请求必须经过 UI 审批；审批成功后会把工具执行结果回写给远端 agent。
- 下载远端文件时限制在配置 workspace 范围内。

### 本机持久 Terminal

- 每个聊天 `sessionKey` 绑定一个本机 terminal。
- terminal 在选择会话后自动创建或复用。
- terminal UI 默认隐藏，用户可点击 `Agent Terminal` 展开查看。
- WebSocket 断开后后端仍保留 terminal 进程和 replay buffer。
- 同一 session 重连后可看到历史输出。

### Agent 控制本机

- 后端会在 `chat.send.clientContext.detaches` 中发送机器可读会话上下文，包括 session、agentId、用户设备、staged files、Tool Broker endpoint、capability target 和一次性 context export URL。
- 用户消息中只保留短 `[detaches_agent 接入上下文]` 兼容提示，不再把完整 broker/capability 信息作为 prompt-only 主链路。
- 每次聊天发送会自动生成一次性 `contextExport.consumeUrl`，远端 OpenClaw agent host 安装 `detaches-agent` skill 后可直接执行：

```bash
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs doctor --url "$CONSUME_URL" --output-context /tmp/detaches-client-context.json
```

- `doctor` 输出当前 session 身份、可请求 target、blocked target、staged files、hard rules 和 broker-event 命令模板；它本身不执行工具、不绕过 UI 审批。
- 兼容层仍支持远端 agent 通过如下 fenced block 请求执行本机命令：

````text
```detaches-terminal
{"command":"pwd","reason":"查看用户本机当前工作目录"}
```
````

- 后端 Tool Broker 解析命令块或结构化 gateway-event 后显示审批卡。
- 用户点击 `Run` 后，请求才会写入当前会话对应 terminal。
- 用户可点击 `Reject` 拒绝执行。

### 连接与配置

- 支持保存多个远端服务 profile，并选择当前生效 profile。
- 支持配置远端 host、SSH user、SSH password、identity path、Gateway transport、Gateway token/password、Gateway 远端/本地端口、反向控制端口。
- SSH password 只用于一次性初始化免密登录，不持久保存。
- “用账号密码初始化免密”会生成/复用本地 OpenSSH key，把公钥写入远端 `authorized_keys`，再验证 key login。
- 支持直接 Gateway 或 SSH tunnel 连接模式。
- SSH tunnel 同时建立本地 Gateway forward 和远端 reverse bridge，使远端 agent host 可以通过 `127.0.0.1:<reverseBridgeRemotePort>` 访问本机 detaches_agent。
- 提供网络诊断视图，覆盖 SSH TCP、SSH tunnel、reverse bridge、本地 Gateway 端口和 Gateway health。

### 远端 Agent Host 适配

- 新增 `remote-agent-host` target，用于表达“工具动作发生在真实 OpenClaw agent 宿主机”。
- 文件上下文会动态注入当前远端用户、远端 host、远端 workspace 和推荐绝对路径，避免继续使用旧机器路径。
- Tool Broker 会过滤已完成或已转移的重复 file-transfer 卡片，减少 UI 重复提示。

## 非目标

- v0.1 不实现无审批自动执行。
- v0.1 不实现复杂权限沙箱。
- v0.1 不保证全屏 TUI 程序在 fallback terminal 中完美工作。
- v0.1 不做标准桌面应用打包。
- v0.1 不声明 Windows 已完整支持；跨平台迁移见 `doc/trd/cross-platform-runtime.md`。

## 验收证据

- `pnpm typecheck` 通过。
- `pnpm smoke` 通过。
- `pnpm build` 通过。
- terminal WebSocket 可执行本机命令并返回输出。
- 同一 terminal session 重连后 replay 中保留历史输出。
- 已实测 `jianlinpan@10.12.7.139` profile：SSH tunnel、reverse bridge、Gateway health 通过。
- 已实测文件传输到远端 `/home/jianlinpan/.openclaw/workspace/attachments/...` 成功。
