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
- `chat.send` 包含原始用户消息、短 detaches_agent 接入提示和完整 `clientContext.detaches`。
- `clientContext.detaches.contextExport.consumeUrl` 自动生成，并可被真实 `detaches-agent-adapter doctor --url` 消费；消费后 URL 失效。
- `doctor --url` 输出 session、agentId、broker 可用状态、staged files 和 broker-event 命令模板。
- abort 请求被转发。

## TC-002B 多 Agent 目录完整显示

目标：验证 Gateway snapshot 只返回 4 个 agent 时，后端优先使用 Gateway `agents.list` RPC 的权威列表；只有 RPC/snapshot 都没有 agent 时，才使用 SSH/CLI 发现作为兜底。

步骤：

1. 执行 `pnpm --filter @detaches/shared build && pnpm --filter @detaches/server build`。
2. 执行 `node testcase/agent-directory-full-list-test.mjs`。
3. 执行 `node testcase/agent-directory-gateway-rpc-authority-test.mjs`。

期望：

- Gateway `agents.list` RPC 有返回时，SSH/CLI 磁盘发现不会混入可聊天 agent 列表。
- Gateway RPC agent 与 session-only agent 可合并展示。
- RPC/snapshot 都没有 agent 时，SSH/CLI 发现可以作为 fallback。
- `global` session 不显示为聊天目标。
- RPC 主来源返回 source 为 `gateway-agents-rpc+sessions`。

## TC-002C Tool Queue pending 请求弹窗

目标：验证 Skill 请求进入 Tool Queue 后，UI 会主动弹出审批入口，而不是只静默更新右侧列表。

步骤：

1. 执行 `pnpm --filter @detaches/shared build && pnpm --filter @detaches/web typecheck`。
2. 执行 `node testcase/tool-queue-popup-test.mjs`。
3. 构造 `kind: skill-verify`、`target: local-user-machine`、`status: pending`、`source: api` 的最近请求。
4. 通过 `/api/tools/stream` 或刷新 Tool Queue 让前端收到该请求。

期望：

- 最近的 pending `skill-verify` 请求会触发 Tool Queue approval dialog。
- 旧 pending 请求保留在队列中，但不会反复弹窗。
- unsupported target 和非 pending 请求不会弹出审批框。
- 弹窗中的 Approve / Reject 复用 broker 原有审批接口和审计链路。

## TC-002D 普通用户直连 Main Agent Gateway

目标：验证网络与连接页面默认走 OpenClaw Gateway 直连方案，不要求 detaches_agent 所在 PC SSH 登录 Main Agent 电脑。

步骤：

1. 打开“网络与连接”页面。
2. 输入 Main Agent host、Gateway port、Gateway token/password 和 Public base URL。
3. 点击“保存并测试直连”。
4. 请求 `/api/settings`、`/api/network/test` 和 `/api/agents`。

期望：

- 新安装默认 `gatewayTransport` 为 `direct`。
- 页面主流程不要求 SSH user、SSH password 或 SSH identity。
- 保存后 detaches_agent 连接 `gatewayDirectHost:gatewayRemotePort`。
- `/api/agents` 通过 Gateway `agents.list` / `sessions.list` 获取 agent 列表。
- Main Agent 通过 `publicBaseUrl` 回连 detaches_agent 的 context export/tool broker 能力。
- SSH tunnel 仅保留为高级兼容选项，不作为普通用户推荐路径。
- Gateway health 返回 `pairing required` 时，网络测试只显示短提示，并在独立代码块中提供 `复制命令`。
- 复制命令在 Main Agent 主机上读取 `~/.openclaw/devices/pending.json` 和 `~/.openclaw/openclaw.json`，不依赖 `openclaw devices list --json` 的输出可被 JSON 解析。

## TC-002E Agent 配置导入助手

目标：验证“网络与连接 / SSH”页面的 `导入 Agent 配置` 助手可以基于规则解析 OpenClaw 配置，预览后保存当前 profile，并在应用后自动触发网络测试。

步骤：

1. 执行 `pnpm --filter @detaches/shared build && pnpm --filter @detaches/web typecheck`。
2. 执行 `node testcase/agent-config-assistant-rules-test.mjs`。
3. 打开“网络与连接”页面，点击 `导入 Agent 配置`。
4. 在 Agent 类型选择页确认 OpenClaw 可继续，其他类型显示 Coming soon。
5. 粘贴或上传 `~/.openclaw/openclaw.json`。
6. 输入 Main Agent 地址或 Tailscale Serve URL，点击 `分析配置`。
7. 检查预览中的 Gateway 模式、推荐连接方式、字段 diff、token/password 脱敏状态和风险提示。
8. 点击 `应用到当前配置`。

期望：

- `loopback + tailscale.mode=serve/funnel` 只接受 Tailscale Serve HTTPS URL，不把裸 IP 当成直连 URL。
- `tailnet`、`lan`、非 loopback `custom` 使用 `gatewayDirectHost + gatewayRemotePort`。
- `lan` 显示网络边界 warning。
- 明文 token/password 自动写入保存请求，但 UI 不展示完整明文。
- secret/env/file/exec 引用不复制 secret，并提示用户手动填写 Gateway 凭据。
- 非 loopback 且缺少 token/password/trusted-proxy 时不允许一键应用为完成。
- 应用前不会静默保存；应用后调用 `saveRemoteProfile()` 并触发网络测试。

## TC-002A OpenClaw detaches adapter

目标：验证远端 agent-side adapter 资产可读取、可校验、可通过 `doctor` 诊断会话上下文、可消费一次性 context export URL、可探测 Tool Broker、可生成标准请求块、结构化 Tool Broker event，并可直接提交 event。

步骤：

1. 执行 `pnpm --filter @detaches/openclaw-detaches-adapter test`。
2. 读取 adapter manifest。
3. 校验一个合法 `clientContext.detaches`。
4. 用 `doctor --context` 输出 agent-side runbook。
5. 用 `doctor --url` 消费一次性 context export URL，并可选保存 context。
6. 用 `inspect-context` 输出 capability target 和路由告警。
7. 用 `broker-probe` 校验 mock broker capabilities endpoint。
8. 生成 `detaches-terminal` 请求块。
9. 生成 `detaches-file-transfer` 请求块。
10. 生成 `--format broker-event` JSON。
11. 用 `--submit-url` 向 mock detaches_agent endpoint 提交 broker-event。
12. 尝试未知 target。

期望：

- manifest 声明 `local-user-machine` 为 supported。
- manifest 声明 `remote-agent-host` / `gateway-managed` 为 reserved。
- 合法 context 校验通过。
- `doctor` 能识别 `local-user-machine` 可请求、`remote-agent-host` 不可请求，并输出 broker-event 命令模板。
- `doctor --url` 消费一次性 context export URL 后，重复消费同一个 URL 必须失败。
- `broker-probe` 能识别 detaches_agent broker 协议并拒绝不匹配 endpoint。
- 请求块必须包含 fenced code block、target 和 reason。
- broker-event JSON 必须包含 `source: gateway-event`、`sourceEventId`、`sessionKey` 和 `payload`。
- `--context` 必须支持完整 `clientContext` 或 `clientContext.detaches`，并自动填充 `sessionKey`、`agentId` 和 broker submit token。
- `--context -` 必须支持从 stdin 读取完整 `clientContext`。
- `--submit-url` 必须 POST 同一份 broker-event，并输出服务端响应。
- gateway-event 提交缺少 per-session submit token 时必须返回 401。
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
