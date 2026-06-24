# Gateway Terminal Agent Runtime

## Goal

Make gateway-terminal the stable default path for Main Agent control of the user's local terminal. Main Agent should not compose broker requests, copy tokens, choose endpoints, or consume `contextExport` for ordinary terminal commands. It should call:

```bash
node ~/.detach_agent/bin/detaches-agent-adapter.mjs terminal-run --host <Detach Agent callback address> --command "pwd" --reason "check workspace"
```

## Runtime Contract

- `terminal-run --host` bootstraps or refreshes an Agent Terminal lease through `/api/agent-terminal/bootstrap`.
- The adapter caches the lease under `~/.detach_agent/runtime/<host-hash>/terminal-session.json`.
- Runs are submitted through `/api/agent-terminal/runs` and always enter Detach Agent Tool Queue.
- The API waits for approval and terminal completion when `wait=true`.
- Long commands can stream `/api/agent-terminal/runs/:runId/stream` SSE events.
- `contextExport.consumeUrl` remains a compatibility path for old skill/adapter flows only.
- `interactionEventEndpoint` is not a terminal interface and rejects terminal-shaped payloads.

## Safety

All terminal sources pass through Command Guard before Tool Queue:

```text
gateway-terminal -> AgentTerminalService -> CommandGuard -> Tool Queue -> terminalService
chat-terminal -> text extract -> CommandGuard -> Tool Queue -> terminalService
ssh-terminal -> broker -> CommandGuard -> Tool Queue -> terminalService
```

Command Guard emits `allow`, `warn`, `require-confirmation`, or `block` with risk metadata. The default sealed behavior still requires user approval for execution.

## Status Model

Agent Terminal runs use these states: `queued`, `waiting_for_approval`, `approved`, `running`, `completed`, `rejected`, `blocked`, `failed`, `timeout`, and `cancelled`.

Completed runs return `output`, `outputTail`, `outputTruncated`, and `exitCode`; large output is capped in API responses while the local terminal replay remains available.

## Compatibility

The following paths remain supported but are not the primary gateway-terminal path:

- `context-fetch`
- `terminal-request --context`
- `detaches-terminal` fenced block
- `ssh-terminal` reverse bridge

Relationship skill version `1.2.0` is the first version that makes Agent Terminal Runtime the primary local terminal rule.
