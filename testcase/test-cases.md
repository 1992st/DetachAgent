# detaches_agent 测试用例设计

## TC-001 构建与类型检查

目标：保证 monorepo 所有 TypeScript 项目可编译。

步骤：

1. 执行 `pnpm typecheck`。
2. 执行 `pnpm build`。

期望：

- 命令退出码为 0。
- web/server/shared 均无 TypeScript 错误。

## TC-002 Mock Gateway 后端烟测

目标：验证本地 server 对 Gateway 协议的主链路。

步骤：

1. 启动 mock OpenClaw Gateway。
2. 启动 detaches server。
3. 请求 `/api/settings`、`/api/health`、`/api/diagnostics`、`/api/agents`。
4. 上传文件。
5. 建立 `/api/chat/:sessionKey` WebSocket。
6. 加载历史、发送消息、停止生成。

期望：

- Gateway connect challenge 被正确响应。
- agent/session 列表正确返回。
- 文件上传返回 base64 attachment。
- `chat.send` 包含原始用户消息和 detaches_agent 接入上下文。
- abort 请求被转发。

## TC-003 Terminal 持久性

目标：验证每个对话窗口绑定一个不退出的本机 terminal。

步骤：

1. 连接 `/api/terminal/:sessionKey`。
2. 发送 `echo <proof>`。
3. 关闭 WebSocket。
4. 用同一个 sessionKey 重新连接。

期望：

- 第二次连接返回相同 terminalId。
- replay 中保留第一次输出。
- terminal 状态为 connected。

## TC-004 Agent 控制协议

目标：验证 agent 可通过 `detaches-terminal` 块请求本机控制。

步骤：

1. 构造 assistant 回复：

   ```text
   ```detaches-terminal
   {"command":"pwd","reason":"查看本机当前目录"}
   ```
   ```

2. UI 解析命令块。
3. 用户点击 Run。
4. 命令写入当前 session terminal。

期望：

- UI 展示审批卡。
- 未点击 Run 前不执行。
- 点击 Run 后 terminal 收到命令。

## TC-005 安全边界

目标：验证敏感文件和 workspace 边界。

步骤：

1. 检查 git status 中不包含 `storage/cache/settings.json`。
2. 请求下载 workspace 外路径，例如 `/etc/passwd`。

期望：

- settings、identity、upload 文件不进入 git。
- workspace 外下载被拒绝。
