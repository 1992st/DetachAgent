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
- `chat.send` 包含原始用户消息、detaches_agent 接入上下文和 `clientContext.detaches.files.staged`。
- abort 请求被转发。

## TC-002A OpenClaw detaches adapter

目标：验证远端 agent-side adapter 资产可读取、可校验、可诊断会话上下文、可探测 Tool Broker、可生成标准请求块、结构化 Tool Broker event，并可直接提交 event。

步骤：

1. 执行 `pnpm --filter @detaches/openclaw-detaches-adapter test`。
2. 读取 adapter manifest。
3. 校验一个合法 `clientContext.detaches`。
4. 用 `inspect-context` 输出 capability target 和路由告警。
5. 用 `broker-probe` 校验 mock broker capabilities endpoint。
6. 生成 `detaches-terminal` 请求块。
7. 生成 `detaches-file-transfer` 请求块。
8. 生成 `--format broker-event` JSON。
9. 用 `--submit-url` 向 mock detaches_agent endpoint 提交 broker-event。
10. 尝试未知 target。

期望：

- manifest 声明 `local-user-machine` 为 supported。
- manifest 声明 `remote-agent-host` / `gateway-managed` 为 reserved。
- 合法 context 校验通过。
- `inspect-context` 能识别 `local-user-machine` 可请求、`remote-agent-host` 不可请求。
- `broker-probe` 能识别 detaches_agent broker 协议并拒绝不匹配 endpoint。
- 请求块必须包含 fenced code block、target 和 reason。
- broker-event JSON 必须包含 `source: gateway-event`、`sourceEventId`、`sessionKey` 和 `payload`。
- `--submit-url` 必须 POST 同一份 broker-event，并输出服务端响应。
- 未知 target 被拒绝。

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
