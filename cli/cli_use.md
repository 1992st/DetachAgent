# Detach Agent CLI 使用说明

## 基本要求

Detach Agent CLI 是 Detach Agent App 的伴生命令行入口，必须依赖 App 启动的本地 server。

CLI 不会演进为独立客户端，不直接连接 Gateway，不启动 Detach Agent App/server，也不维护独立配置文件。

使用 CLI 前，请先打开 Detach Agent App，并在 App 中完成 agent 连接。

默认连接地址：

```text
http://127.0.0.1:38888
```

## 全局参数

```bash
--base-url <url>
--json
```

环境变量：

```bash
DETACH_AGENT_BASE_URL=http://127.0.0.1:38888
```

优先级：

1. `--base-url`
2. `DETACH_AGENT_BASE_URL`
3. `http://127.0.0.1:38888`

`--base-url` 和 `DETACH_AGENT_BASE_URL` 只表示 Detach Agent App local server 地址，不是 Gateway 地址。

## 命令

```bash
detach-agent --version
detach-agent help

detach-agent agent status [--json]
detach-agent agent list [--json]
detach-agent agent send <agent-id-or-session-key> --message <text> [--local-control] [--wait] [--timeout-ms <ms>] [--json]
detach-agent agent listen <agent-id-or-session-key> [--run-id <runId>] [--timeout-ms <ms>] [--json] [--raw]
```

## 查看连接状态

```bash
detach-agent agent status
detach-agent agent status --json
```

## 查看 agent 列表

```bash
detach-agent agent list
detach-agent agent list --json
```

## 发送消息

```bash
detach-agent agent send agent-123 --message "hello"
detach-agent agent send agent-123 --message "run task" --wait --timeout-ms 600000
```

参数：

- `--message <text>`：发送的消息。
- `--local-control`：附带 Detach Agent local-control context。
- `--wait`：发送后等待 agent 返回数据。
- `--timeout-ms <ms>`：等待超时时间，默认 `120000`。传 `0` 表示不自动超时。
- `--json`：输出 JSON。

## 监听返回数据

```bash
detach-agent agent listen agent-123
detach-agent agent listen agent-123 --run-id run_abc --timeout-ms 0
```

参数：

- `--run-id <runId>`：只监听指定 run。
- `--timeout-ms <ms>`：监听超时时间，默认 `120000`。传 `0` 表示不自动超时。
- `--json`：输出收集到的事件 JSON。
- `--raw`：输出原始 WebSocket event。

## Windows

Windows 启动脚本通常是：

```powershell
detach-agent.cmd agent status
```

`.cmd` 是 Windows 命令脚本，作用类似 macOS/Linux 的 shell wrapper。

## macOS / Linux

```bash
detach-agent agent status
```

如果没有配置 PATH，请使用安装包或 App 设置页展示的完整 CLI 路径。

## 常见错误

App 未启动或本地 server 不可达：

```text
Detach Agent app server is unreachable at http://127.0.0.1:38888. Open Detach Agent App first.
```

退出码为 `3`。

监听超时：

```text
timedOut: true
```

退出码为 `1`。

## 退出码

- `0`：成功。
- `1`：操作失败或等待超时。
- `2`：参数错误。
- `3`：Detach Agent App local server 不可达。
- `4`：Gateway 连接、鉴权或配对问题。
- `5`：未找到指定 agent/session。
