# detaches_agent PRD - 整体规划

## 阶段 1：本地可用闭环

目标：用户可以用本地 UI 与远端 OpenClaw agents 聊天，并让 agent 通过审批机制控制本机 terminal。

已完成：

- 多 agent 列表与聊天。
- 本机会话隔离。
- 文件上传与下载。
- 每会话本机持久 terminal。
- agent 命令请求审批卡。
- 基础网络诊断。

## 阶段 2：安全与可追溯

目标：让 agent 控制本机变得可审计、可撤销、可限制。

计划：

- terminal audit log。
- 风险命令检测。
- workspace 权限边界。
- 一键停止任务。
- terminal 输出回传给 agent。

## 阶段 3：远控与多设备

目标：把本机 UI 变成多设备 agent 控制台。

计划：

- 远端 terminal target。
- 多设备身份识别。
- 设备级权限策略。
- 会话转移和恢复。

## 阶段 4：标准应用

目标：作为可长期运行的标准桌面应用交付。

计划：

- Electron/Tauri 应用包。
- macOS Keychain。
- 后台常驻和自动重连。
- 自动更新。

## 长期方向

- 主 agent 负责思考和计划。
- detaches_agent 本地 UI 负责用户审批和设备侧执行。
- 每个 subagent 拥有独立 session、terminal、workspace 和私有执行上下文。
