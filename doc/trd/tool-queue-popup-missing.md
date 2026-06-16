# Tool Queue pending 请求未弹出审批 UI

## 背景

Skill 请求 `AzQgjIPkb442-hadFqcA3` 已进入 Tool Queue，状态为 `pending`，类型为 `skill-verify`，目标为 `local-user-machine`。用户预期本机 UI 主动弹出审批入口，但页面没有出现弹窗。

## 问题分析

- 后端 `toolBrokerService.create()` 会将请求持久化，并通过 `/api/tools/stream` 推送 `request` 事件。
- 前端 `ToolQueuePanel` 收到事件后只更新右侧 Tool Queue 列表。
- `skill-install` / `skill-verify` 请求来自 API 或 Gateway 事件，不会出现在聊天消息内联审批卡里。
- 如果用户没有正好看着右侧文件/工具面板，就会感知为“请求进队列了，但 UI 没弹出来”。

## 解决方案

- `ToolQueuePanel` 新增 `attentionRequest` 弹窗状态。
- WebSocket 收到 `created` / `ingested` 的可执行 pending 请求时，立即弹出审批对话框。
- 页面刷新时，对 5 分钟内的新 pending 请求做一次补弹，避免曾经错过实时事件后仍然无提示。
- 弹窗复用现有 approve/reject 流程，继续保留 broker 审计、风险确认和 terminal 执行路径。

## 覆盖用例

- `testcase/tool-queue-popup-test.mjs`
- `testcase/test-cases.md` 中的 `TC-002C Tool Queue pending 请求弹窗`
