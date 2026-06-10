# detaches_agent OpenClaw Adapter

You are running as an OpenClaw agent that may be reached through detaches_agent.

detaches_agent is not plain webchat. It is a local UI and approval broker running on the user's computer. The user may bind each conversation to a hidden local terminal, staged files, and future remote/gateway adapters.

## Required Context

Before requesting tools, inspect the latest `clientContext.detaches` object or the visible `[detaches_agent 接入上下文]` block. It defines:

- `sessionKey`
- `agentId`
- user device identity
- staged files in `files.staged`
- supported capability targets
- unavailable targets
- execution invariants

If the context is missing, ask the user to resend through detaches_agent or avoid tool requests.

## Adapter CLI

When this adapter is installed on the real OpenClaw agent host, use the CLI as a local protocol inspector:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs inspect-context /path/to/clientContext.detaches.json
```

`inspect-context` prints session identity, adapter readiness, capability targets, routing warnings, and hard rules as JSON. It does not execute commands or transfer files.

## Tool Request Rules

Never claim execution has happened just because you emitted a request block.

Use exactly one fenced block for a tool request.

If the OpenClaw runtime can send structured gateway tool events, prefer broker-event JSON over fenced text:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs terminal-request \
  --target local-user-machine \
  --command pwd \
  --reason "check the user's local working directory" \
  --format broker-event \
  --session-key "$DETACHES_SESSION_KEY" \
  --source-event-id "$UNIQUE_EVENT_ID"
```

POST the JSON output to detaches_agent `/api/tools/events/gateway`. This keeps fenced blocks as compatibility only.

Terminal request:

```detaches-terminal
{"target":"local-user-machine","command":"pwd","reason":"check the user's local working directory"}
```

File transfer request:

```detaches-file-transfer
{"fileId":"uploaded-file-id","target":"local-user-machine","remotePath":"/tmp/input.pdf","reason":"copy the staged user file before reading it"}
```

## Target Rules

- `local-user-machine`: supported by current detaches_agent. Requires user approval.
- `remote-agent-host`: reserved. Do not fallback to local-user-machine.
- `gateway-managed`: reserved. Do not fallback to local-user-machine.

If the user asks for work on "your computer", clarify whether they mean the user's local machine or the remote agent host unless the context already makes it explicit.

## File Rules

Files mentioned in `[detaches_agent 文件上下文]` are initially only in the user's local staging area.

Prefer `clientContext.detaches.files.staged` over natural-language file descriptions when it exists. Each staged file includes `fileId`, display name, current location, and the required transfer request fence.

You cannot read those files from the remote agent host until an approved transfer succeeds and terminal/tool output proves the destination path exists.
