# 多 Agent 显示不全问题记录

## 问题

Agents 面板显示 `4 个可聊天目标`，但远端 OpenClaw agent 目录中实际存在更多 agent。用户点击刷新后仍只能看到 4 个，表现为 agent 同步缺失。

## 根因

前端 `AgentList` 会渲染 `/api/agents` 返回的完整数组，没有做 4 个截断。问题在后端 agent 目录构造：

- `listAgents()` 只读取 Gateway `hello.snapshot.health` 中的 snapshot agents。
- 按 OpenClaw 源码，`hello.snapshot.health` 不是完整 agent registry；真正的权威 RPC 是 `agents.list`，对应 OpenClaw 的 `listAgentsForGateway(cfg)`。
- `listAgentsForGateway(cfg)` 会合并 default agent、`cfg.agents.list`、state dir 下的 `agents/*`，并在显式配置 `agents.list` 时保留 scope boundary。
- 当 snapshot 有 4 个 agent 时，detaches_agent 把它误当成完整来源。
- `sessionsRaw` 变量没有调用 `gatewayClient.listSessions()` 填充，session-only agent 也不会进入目录。

因此 `/api/agents` 实际只返回 snapshot 的 4 个目标，UI 只是如实显示了后端的不完整结果。

## 解决方法

修改 `apps/server/src/services/gateway/agentDirectoryService.ts`：

- 优先调用 Gateway `agents.list` RPC 作为权威 agent 来源。
- 调用 `gatewayClient.listSessions(200)` 获取更多会话来源。
- 将 Gateway RPC agents 与 session-only agents 合并。
- 仅当 Gateway RPC 和 snapshot 都没有 agent 时，才使用 SSH/CLI 发现作为 fallback/diagnostic；避免把 OpenClaw scope boundary 外的磁盘目录显示成可聊天目标。
- 按 agent id 去重，保留 `global` session 过滤规则。
- 抽出 `buildAgentDirectory()` 纯函数，方便 testcase 覆盖目录合并行为。

修复后，snapshot 只有 4 个时会改用 Gateway `agents.list` 的权威结果；SSH 磁盘发现不再污染主列表。

## Testcase

新增：

- `testcase/agent-directory-full-list-test.mjs`
- `testcase/agent-directory-gateway-rpc-authority-test.mjs`

覆盖场景：

- Gateway RPC agents 与 session-only agent 合并。
- Gateway RPC 有结果时，SSH/CLI discovered agents 不进入主列表。
- RPC/snapshot 都没有 agent 时，SSH/CLI discovered agents 可作为 fallback。
- `global` session 被过滤。

期望：

- source 为 `gateway-agents-rpc+sessions`。
- SSH fallback source 为 `gateway-agents+sessions+ssh-cli`。
- `global` 不出现在聊天目标中。

验证命令：

```sh
pnpm --filter @detaches/shared build && pnpm --filter @detaches/server build
node testcase/agent-directory-full-list-test.mjs
node testcase/agent-directory-gateway-rpc-authority-test.mjs
```
