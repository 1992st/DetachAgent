---
name: detaches-agent
description: Understand and operate detaches_agent mediated sessions through a one-time context export and approval broker.
metadata: { "openclaw": { "emoji": "🔌", "skillKey": "detaches-agent" } }
---

# detaches_agent Session Bridge

Use this skill when the conversation includes `clientContext.detaches`, `[detaches_agent 接入上下文]`, or a one-time detaches_agent context export URL.

detaches_agent is a local UI and approval broker running on the user's computer. It can bind a conversation to a hidden local terminal, staged files, and a Tool Broker. This skill does not execute tools directly and must not bypass detaches_agent approval.

## Required Flow

1. Inspect the latest `clientContext.detaches` or ask the user to generate a one-time context URL in the detaches_agent OpenClaw Adapter panel.
2. On the real OpenClaw agent host, fetch the full context:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs context-fetch "$DETACHES_CONTEXT_EXPORT_URL" --output /tmp/detaches-client-context.json
```

3. Run the agent-side doctor before requesting tools:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs doctor --context /tmp/detaches-client-context.json
```

4. If you need raw diagnostics, inspect the context:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs inspect-context /tmp/detaches-client-context.json
```

5. Prefer structured broker events over fenced text:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs terminal-request \
  --context /tmp/detaches-client-context.json \
  --target local-user-machine \
  --command pwd \
  --reason "check the user's local working directory" \
  --format broker-event \
  --source-event-id "$UNIQUE_EVENT_ID" \
  --submit
```

## Hard Rules

- Never claim a command, file read, transfer, download, archive, or modification happened until detaches_agent returns approved tool output.
- Never change `remote-agent-host` or `gateway-managed` requests to `local-user-machine` as a fallback.
- Treat saved context files as sensitive because they can contain `broker.submitToken`.
- Files staged by detaches_agent are initially on the user's local machine, not on the remote agent host.
