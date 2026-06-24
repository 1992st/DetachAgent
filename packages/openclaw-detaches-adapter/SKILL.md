---
name: detaches-agent
description: Understand and operate detaches_agent mediated sessions through Agent Terminal Runtime and the local approval broker.
metadata: { "openclaw": { "emoji": "🔌", "skillKey": "detaches-agent" } }
---

# detaches_agent Session Bridge

Use this skill when the conversation includes `clientContext.detaches`, `[detaches_agent 接入上下文]`, an Agent Terminal Runtime host, or a one-time detaches_agent context export URL.

detaches_agent is a local UI and approval broker running on the user's computer. It can bind a conversation to a hidden local terminal, staged files, and a Tool Broker. This skill does not execute tools directly and must not bypass detaches_agent approval.

## Required Flow

1. For ordinary `local-user-machine` terminal commands, use Agent Terminal Runtime with the Detach Agent callback host/IP. The adapter owns bootstrap, lease refresh, approval waiting, execution waiting, output, and exitCode:

```sh
node ~/.detach_agent/bin/detaches-agent-adapter.mjs terminal-run \
  --host "$DETACH_AGENT_HOST" \
  --command "pwd" \
  --reason "check the user's local working directory"
```

2. If the run is waiting for approval or still running, keep waiting or use the runtime stream command; do not claim completion until detaches_agent returns final output:

```sh
node ~/.detach_agent/bin/detaches-agent-adapter.mjs terminal-stream \
  --host "$DETACH_AGENT_HOST" \
  --run-id "$RUN_ID"
```

3. Use `context-fetch`, `doctor`, and `terminal-request --context` only for compatibility or troubleshooting when the runtime host is unavailable:

```sh
node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --context /tmp/detaches-client-context.json
```

4. If every HTTP runtime path is unavailable, fall back to exactly one fenced `detaches-terminal` block and wait for Detach Agent approval:

```detaches-terminal
{"target":"local-user-machine","command":"pwd","reason":"check the user's local working directory"}
```

## Hard Rules

- Never claim a command, file read, transfer, download, archive, or modification happened until detaches_agent returns approved tool output.
- Never change `remote-agent-host` or `gateway-managed` requests to `local-user-machine` as a fallback.
- Never use or describe `interactionEventEndpoint` for terminal commands.
- Do not ask the user for broker tokens, endpoint internals, Detach Agent PC SSH credentials, or manual local terminal execution.
- Treat saved context files as sensitive because compatibility paths can contain `broker.submitToken`.
- Files staged by detaches_agent are initially on the user's local machine, not on the remote agent host.
