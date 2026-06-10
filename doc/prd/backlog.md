# detaches_agent PRD - 待办需求

## P0

### 文件上传与传输体验重构

- 文件名显示必须完整支持中文、全角符号和常见 Unicode 字符；当前上传后的上下文中中文文件名会被替换成 `_`，需要调整 filename sanitize/display 规则，避免破坏用户可读文件名。
- 附件状态必须按 `sessionKey`/agent 隔离；当前附件保存在全局 App state，导致在 agent A 上传文件后切到 agent B 仍能看到同一批附件和上下文。
- 文件上下文 UI 需要重新设计：
  - 默认折叠，只显示文件卡片、大小、状态、编辑入口。
  - 展开后用结构化表单/紧凑文本，不直接展示大段协议说明。
  - 用户编辑只影响本次发送，发送后恢复默认生成。
- 文件传输协议需要产品化为独立能力：
  - agent 通过 `detaches-file-transfer` 请求传输。
  - UI 显示独立审批卡。
  - 本地生成一次性下载 URL，传输成功后清理 staging 文件。
  - 明确失败、过期、重复下载、远端不可达等状态提示。
- 本地 staging 文件需要轻量清理策略：
  - 传输成功后立即删除。
  - 未发送/未传输文件按 TTL 清理。
  - UI 提供手动清理当前会话附件。
- 文件传输必须写入审计日志：
  - 记录上传、传输准备、一次性 URL 下载、cleanup、失败原因。
  - 保存路径：`storage/logs/file-transfer-audit.jsonl`。
  - UI 后续可展示“文件已被下载/已清理/未下载/失败”的真实状态。

### 执行环境路由

- 当前 agent 容易混淆“用户本机 terminal”和“远端 OpenClaw agent 所在机器”。
- 不采用单纯 prompt 注入作为最终方案；prompt 只能作为兼容层，真实能力必须沉到结构化 session context、服务端路由校验、Gateway adapter 和审计日志。
- 需要远端 agent-side skill / adapter，让真实 agent 机器也能读取 detaches 会话身份、用户设备身份和可请求 capability，但该 skill 不能绕过用户审批。
- tool request 必须声明目标环境：
  - `local-user-machine`：用户本机 detaches terminal。
  - `remote-agent-host`：OpenClaw agent 实际运行的远端机器。
  - `gateway-managed`：通过 Gateway 原生能力完成。
- UI 和后端必须在审批卡上显示目标环境，避免用户误以为命令跑在另一台机器。
- 如果当前目标环境不可用，agent 必须收到明确错误，而不是退化成在本机 terminal 执行。
- Gateway 流式事件必须按 `sessionKey` 或本会话 `runId` 过滤，不能因为事件缺少 sessionKey 就广播到当前聊天框。
- 文件归档类任务必须明确归档位置：
  - 用户本机归档。
  - 远端 agent 工作区归档。
  - Gateway 管理 workspace 归档。

### 执行审计日志

- 已有基础 Tool Broker 审计：
  - 记录每一次 agent 工具请求创建。
  - 记录 target、sessionKey、agentId、审批、拒绝、失败原因。
  - 保存路径：`storage/logs/tool-broker-audit.jsonl`。
- 后续还需要补齐：
  - 命令真正写入 terminal 的时间已可通过 `tool.approve` 与 `terminalId` 追踪，后续需要 UI 展示。
  - terminal 输出快照已可通过 `/api/tools/requests/:requestId/result` 查询，并 best-effort 回写 agent；后续需要完成检测和更稳定的摘要策略。
  - 用户审批 UI 的操作者身份。
  - 与聊天消息 id / runId 的关联。

### 命令风险提示

- 对危险命令进行提示：
  - `rm -rf`
  - `sudo`
  - 修改 shell/profile
  - 网络下载并执行脚本
  - 删除或覆盖 workspace 外文件
- 高风险命令需要二次确认。

### Terminal 状态强化

- UI 展示 terminal 是否 connected、exited、error。
- 支持重启当前 session terminal。
- 支持停止当前执行任务。

## P1

### Workspace 权限边界

- 为每个 session 创建独立工作目录。
- agent 默认只能操作该目录。
- 跨目录操作需要更高等级审批。

### Agent 控制结果回传

- terminal 执行完成后，把输出摘要回写到聊天上下文。
- 支持用户选择“把 terminal 输出发送给 agent”。

### 批量命令计划

- agent 可提交多步计划。
- UI 分步审批和执行。
- 每步执行后展示输出和下一步确认。

## P2

### 桌面应用打包

- Electron 或 Tauri 打包。
- 托盘常驻。
- 本地 Keychain 保存 token/password。

### 更完整终端体验

- 集成 xterm.js。
- 修复/替换当前环境中 `node-pty` fallback。
- 支持完整 TTY 程序。

### 远端 terminal 模式

- terminal target 支持：
  - `local`
  - `remote-ssh`
- 每个 agent 可选择控制本机或远端机器。
