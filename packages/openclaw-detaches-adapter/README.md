# detaches_agent OpenClaw Adapter

This package is installed on the real OpenClaw agent host so the agent can understand a detaches_agent-mediated session without relying on ad hoc prompt text.

It does not execute commands or move files by itself. It validates session context, probes the detaches_agent broker, and emits or submits structured requests that still require user approval in the local detaches_agent UI.

## Runtime Requirements

- Language/runtime: JavaScript ESM (`.mjs`) running on Node.js.
- Recommended Node.js version: Node 18+ so the built-in `fetch` API is available.
- npm dependencies: none. The CLI uses Node built-ins (`fs`, `path`, `url`) plus built-in `fetch`.
- Install location on the Detach Agent runtime machine: `~/.detach_agent/`.

## Files

- `AGENT.md`: Instructions for the OpenClaw agent.
- `SKILL.md`: Workspace skill entry copied to `~/.openclaw/workspace/skills/detaches-agent/SKILL.md`.
- `adapter.manifest.json`: Machine-readable protocol and capability manifest.
- `skill.manifest.json`: Stable agent-side skill entry metadata.
- `skills/detach-agent-relationship/`: Host/Main Agent relationship skill source.
- `bin/detaches-agent-adapter.mjs`: CLI used by the Detach Agent runtime machine.

The distributable relationship skill zip used by the web app lives at
`apps/web/public/skills/detach-agent-relationship.skill.zip`. User-facing manual
install instructions live at `docs/relationship-skill/install.md`.

## Basic Flow

1. Install this package on the remote OpenClaw agent host.
2. In detaches_agent, generate a one-time context URL for the selected session.
3. On the remote agent host, run the agent-side doctor. Prefer the one-step URL flow when a fresh export URL is available:

```sh
node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --url "$DETACHES_CONTEXT_EXPORT_URL" --output-context /tmp/detaches-client-context.json
```

4. If you already saved the context, run doctor against the file:

```sh
node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --context /tmp/detaches-client-context.json
```

Use `context-fetch` only when you need to fetch or print the context without generating a runbook.

5. Inspect the raw context diagnostics when needed:

```sh
node ~/.detach_agent/bin/detaches-agent-adapter.mjs inspect-context /tmp/detaches-client-context.json
```

6. Submit a structured broker request only when the doctor/context says the target is supported:

```sh
node ~/.detach_agent/bin/detaches-agent-adapter.mjs terminal-request \
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
