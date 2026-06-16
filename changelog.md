# Changelog

## 2026-06-16

本次变更围绕 detaches_agent 与 OpenClaw Main Agent 的连接、agent 列表完整性、Tool Queue 审批体验、实时日志可用性和 agent-side adapter 能力进行了集中修复。

### Main Agent Gateway 连接

- 默认连接策略从 SSH tunnel 调整为 Direct Gateway，避免普通用户必须让 detaches_agent 所在 PC SSH 登录 Main Agent 电脑。
- `网络与连接` 页面新增 `Gateway URL / Tailscale Serve` 输入，用于支持 OpenClaw 的：

  ```json
  {
    "gateway": {
      "bind": "loopback",
      "tailscale": { "mode": "serve" }
    }
  }
  ```

- 当用户填写 `https://...ts.net` 时，detaches_agent 会自动转换为 `wss://...ts.net` 连接 Gateway。
- 保留旧的 `gatewayDirectHost + gatewayRemotePort` 直连方式，支持 `bind=tailnet`、`bind=lan` 或自定义监听地址。
- 网络测试的配置行改为显示实际连接目标：
  - Direct URL 模式显示 resolved Gateway URL。
  - Host/port 模式显示 `gatewayDirectHost:gatewayRemotePort`。
  - SSH tunnel 模式显示远端 SSH/Gateway 目标。
- Gateway 连接失败时清理旧 hello snapshot，避免旧的本机 Gateway 缓存误导诊断结果。
- Direct 模式下不再偷偷用 SSH/CLI 磁盘发现补齐 agent 列表，避免出现“列表很多但不能正常通行”的假阳性。
- 新增 Main Agent 配置说明折叠区，基于当前 UI 输入生成 OpenClaw 配置示例：
  - Tailscale Serve + loopback。
  - Tailnet 直连。
  - Custom bind 高级配置。
  - detaches_agent 当前对应配置。

### Agent 列表完整性

- `/api/agents` 优先调用 Gateway `agents.list` RPC 作为权威 agent 来源。
- 增加 `sessions.list` 合并逻辑，补齐 session-only agent。
- 修复原先只读取 Gateway hello snapshot 导致只显示 4 个 agent 的问题。
- 保留 `global` session 过滤，避免非 agent 会话出现在可聊天目标列表。
- SSH/CLI agent 发现仅作为 Gateway 不可用时的兼容 fallback，并且 direct 模式下禁用该 fallback。
- 新增 agent 目录合并测试：
  - `testcase/agent-directory-full-list-test.mjs`
  - `testcase/agent-directory-gateway-rpc-authority-test.mjs`

### Tool Queue 审批弹窗

- `ToolQueuePanel` 增加 pending 请求弹窗。
- WebSocket 收到 `created` 或 `ingested` 的可审批请求时自动弹出确认 UI。
- 页面刷新时，对最近 5 分钟内的新 pending 请求补弹一次。
- 支持 `skill-install` 和 `skill-verify` 请求进入统一 Tool Broker 审批链路。
- 弹窗复用原有 approve/reject 接口，保留审计、风险确认和状态同步。
- 新增测试：
  - `testcase/tool-queue-popup-test.mjs`

### 实时日志与调试体验

- 扩大实时 log 控制台高度，避免只显示少量最近日志。
- 顶部增加调试 terminal/快捷入口相关 UI 样式，便于在当前会话中快速查看执行状态。
- 新增本机 terminal app 枚举和打开接口，用于从 UI 进入本机终端工具。

### detaches context 与 Tool Broker

- context export 文案调整为强调 `contextExport.consumeUrl`，让远端 agent 优先消费机器可读上下文。
- Tool Broker 扩展请求类型，支持：
  - `terminal`
  - `file-transfer`
  - `adapter-install`
  - `skill-install`
  - `skill-verify`
- Adapter 文档、manifest 和 CLI 能力更新，完善 agent-side 消费 detaches context、提交 broker event 和执行诊断的路径。

### 网络与安全边界

- 明确普通用户主流程不要求 SSH user、SSH password 或 SSH identity。
- SSH tunnel 仍保留为高级兼容选项。
- 文档记录 OpenClaw 源码确认的 Gateway 配置能力：
  - `gateway.bind`
  - `gateway.customBindHost`
  - `gateway.port`
  - `gateway.auth`
  - `gateway.tailscale.mode`
- 记录 OpenClaw 约束：
  - `tailscale.mode=serve/funnel` 时 Gateway 必须绑定 loopback。
  - 非 loopback 监听必须配置 token/password 或 trusted-proxy。

### 文档与测试记录

- 新增问题记录：
  - `doc/trd/main-agent-direct-gateway.md`
  - `doc/trd/multi-agent-display-incomplete.md`
  - `doc/trd/tool-queue-popup-missing.md`
- 更新 `testcase/test-cases.md`：
  - `TC-002B 多 Agent 目录完整显示`
  - `TC-002C Tool Queue pending 请求弹窗`
  - `TC-002D 普通用户直连 Main Agent Gateway`

### 验证命令

已执行并通过：

```sh
pnpm --filter @detaches/shared build
pnpm --filter @detaches/server build
pnpm --filter @detaches/web typecheck
node testcase/agent-directory-full-list-test.mjs
node testcase/agent-directory-gateway-rpc-authority-test.mjs
node testcase/tool-queue-popup-test.mjs
pnpm --filter @detaches/server smoke
```
