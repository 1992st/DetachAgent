# detaches_agent OpenClaw Adapter

This package is installed on the real OpenClaw agent host so the agent can understand a detaches_agent-mediated session without relying on ad hoc prompt text.

It does not execute commands or move files by itself. It validates session context, probes the detaches_agent broker, and emits or submits structured requests that still require user approval in the local detaches_agent UI.

## Files

- `AGENT.md`: Instructions for the OpenClaw agent.
- `adapter.manifest.json`: Machine-readable protocol and capability manifest.
- `skill.manifest.json`: Stable agent-side skill entry metadata.
- `bin/detaches-agent-adapter.mjs`: CLI used by the agent host.

## Basic Flow

1. Install this package on the remote OpenClaw agent host.
2. In detaches_agent, generate a one-time context URL for the selected session.
3. On the remote agent host, fetch and save the context:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs context-fetch "$DETACHES_CONTEXT_EXPORT_URL" --output /tmp/detaches-client-context.json
```

4. Inspect the context before requesting tools:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs inspect-context /tmp/detaches-client-context.json
```

5. Submit a structured broker request only when the context says the target is supported:

```sh
node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs terminal-request \
  --context /tmp/detaches-client-context.json \
  --target local-user-machine \
  --command pwd \
  --reason "check the user's local working directory" \
  --format broker-event \
  --source-event-id "$(date +%s)-pwd" \
  --submit
```

## Safety Rules

- Do not claim execution happened until detaches_agent returns approved tool output.
- Do not move requests from `remote-agent-host` or `gateway-managed` to `local-user-machine` as a fallback.
- Treat saved context files as sensitive because they can contain `broker.submitToken`.
