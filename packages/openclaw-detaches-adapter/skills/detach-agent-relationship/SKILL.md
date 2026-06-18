---
name: detach-agent-relationship
description: Use on the Host/Main Agent when a message is marked as coming from a Detach Agent and environment or role boundaries affect execution.
---

# Detach Agent Relationship

## Purpose

Use this skill only on the Host/Main Agent. It adds Detach Agent support without changing ordinary Main Agent conversations.

## When Active

Apply these rules only when a conversation was bootstrapped as a Detach Agent conversation, or when a message carries the `[[DETACH_AGENT]]` marker.

## Boundary Rules

- Detach Agent and Host/Main Agent are separate actors.
- They have separate machines, workspaces, tools, terminals, files, ports, browser state, running services, and memory.
- In Detach Agent context, ambiguous local references usually mean the Detach Agent environment.
- Host-side references mean the Host/Main Agent environment.
- Do not imply direct access across environments.
- Cross-environment work requires explicit handoff, pasted output, copied files, or user confirmation.
- If the target environment is unclear, ask before acting.

## User Local Terminal

Selection rule: use this path for ordinary commands on the user's local machine. Use `credential-request` only when a real password or secret is needed.

When the target is `local-user-machine`, request execution with exactly one `detaches-terminal` block or broker event.

- Do not SSH into the user's local machine.
- Do not ask for the user's local SSH username, password, port, or key path.
- Do not wrap local-user-machine commands in `ssh`.
- detaches_agent runs approved `local-user-machine` terminal requests in a local terminal on the user's machine.
- The user only approves the detaches_agent tool request; this local terminal path does not require an SSH password.

Example:

```detaches-terminal
{"target":"local-user-machine","command":"df -h /","reason":"check root disk usage on the user's local machine"}
```

## Local Interaction API

Selection rule: use this path only for user-visible local interactions such as password/secret entry. Do not use it for ordinary terminal commands.

The Host/Main Agent may trigger detaches_agent local UI events through the interaction API when the current detaches context provides it.

- The script/API call is made by the Host/Main Agent machine, not by the user's local machine.
- Do not use `127.0.0.1` unless that exact URL appears in the current context as reachable from the Host/Main Agent machine.
- Read the reachable server URL from `clientContext.detaches.localControl.interactionEventEndpoint` or `clientContext.detaches.broker.interactionEventEndpoint`.
- The detaches_agent server port is fixed by the context-provided URL, but the host/IP must come from the prompt/context because the Host/Main Agent and the user's PC are different machines.
- Use the same `broker.submitToken` as a bearer token.
- Use a unique `sourceEventId` for idempotency.
- Poll the interaction result for at most 300000ms. On timeout, report `DETACHES_INTERACTION_TIMEOUT`; do not keep waiting indefinitely.
- The 300000ms timeout applies to this `credential-request` script/API path only. It does not change other detaches_agent SSH transfer password waits.
- Do not ask the user to paste passwords into chat. For real SSH login credentials, request a local detaches_agent popup.

Preferred script:

```bash
node ~/.detach_agent/bin/detaches-agent-adapter.mjs credential-request \
  --context /tmp/detaches-client-context.json \
  --reason 'SSH login requires a password' \
  --prompt 'Enter the SSH password for this login' \
  --target-user '<ssh-user>' \
  --target-host '<ssh-host>' \
  --target-port '22' \
  --source-event-id 'credential:<unique-id>' \
  --wait \
  --timeout-ms 300000
```

The script prints JSON. Success has `ok: true` and `interaction.status: "resolved"`. The result is one of:

- `result.mode: "local-handle"` with `result.credentialHandle`: the secret remains in detaches_agent memory for future local operations.
- `result.mode: "reveal-once"` with `result.secret`: the secret was returned once to the Host/Main Agent. Treat it as sensitive and do not log it.

Defined error codes:

- `DETACHES_CONTEXT_INVALID`: context/session data is missing or invalid.
- `DETACHES_AUTH_REQUIRED`: the broker submit token is missing or rejected.
- `DETACHES_ENDPOINT_UNREACHABLE`: the Host/Main Agent machine cannot reach the context-provided detaches_agent URL.
- `DETACHES_PROTOCOL_ERROR`: the server response is malformed or unexpected.
- `DETACHES_INTERACTION_REJECTED`: the user dismissed/rejected the popup.
- `DETACHES_INTERACTION_EXPIRED`: detaches_agent expired the pending interaction.
- `DETACHES_INTERACTION_TIMEOUT`: the script waited 300000ms without a final user decision.

Raw API shape, if the adapter script is unavailable:

```http
POST <interactionEventEndpoint>
Authorization: Bearer <broker.submitToken>
Content-Type: application/json

{"kind":"credential.request","sessionKey":"<sessionKey>","agentId":"<agentId>","source":"gateway-event","sourceEventId":"credential:<unique-id>","reason":"SSH login requires a password","payload":{"title":"Main agent credential request","prompt":"Enter the SSH password for this login","target":{"user":"<ssh-user>","host":"<ssh-host>","port":22}}}
```

Then poll `GET <localControl.baseUrl>/api/interactions/<interactionId>?submitToken=<broker.submitToken>` until `resolved`, `rejected`, `expired`, or 300000ms elapses.

## Staged Files From Detach Agent

When a message contains `[[DETACH_AGENT_FILE_STAGED]]`, the listed file exists only on the Detach Agent user's machine.

- `sourceLocalPath` is an absolute path on the detaches_agent machine, not on the Host/Main Agent machine.
- Host/Main Agent must not claim it can read `sourceLocalPath` directly.
- If the file should be saved on the Host/Main Agent machine, Host/Main Agent decides the destination SSH/Linux user and path according to Host/Main Agent workspace/artifact rules.
- `destination.user` and `destination.path` are the core fields the Host/Main Agent must decide. `destination.host` and `destination.port` may be omitted; detaches_agent broker fills them from its current Main Agent SSH/Gateway settings.
- Do not put placeholders, examples, or "replace me" text into `destination.user`, `destination.host`, or `destination.port`. If `destination.user` is unknown, do not emit a save request.
- `destination.path` must be a complete absolute target file path, including the directory, final filename, and extension.
- `destination.path` must not be a directory path. Do not end at paths such as `screenshots/`, `docs/`, `_staging/`, or any folder-only location.
- If the correct archive category is unclear, ask the user for the file's purpose, or choose a clearly allowed generic file path such as a screenshots/attachments file path with a concrete sanitized filename. Do not invent a supplier/product/category staging folder without evidence.
- Request the transfer with one `main-agent-save-file` block or broker event.
- Do not generate `ssh`, `rsync`, `scp`, `curl`, HTTP upload, or terminal commands. Host/Main Agent only chooses the destination and emits the request.
- Do not ask detaches_agent to create remote directories, verify remote files, or manage the Host/Main Agent filesystem. Prepare the destination on the Host/Main Agent side or choose an existing destination path.
- Do not request MD5; success is determined by detaches_agent's approved structured transfer runner exit status.
- detaches_agent will run one local `rsync` or `scp` transfer after user approval. If SSH needs a password, detaches_agent UI will ask for it once and will not save it.
- Do not start an HTTP upload server, invent a curl upload method, or replace the protocol with `method=http-upload`. The only supported transfer methods for this request are `rsync` and `scp`.
- If a `[detaches_agent 工具结果]` message reports failure, report that result to the user and ask whether to retry after fixing the reported broker/SSH/path issue. Do not attempt alternative transfer methods outside the detaches_agent tool flow.

Example:

```main-agent-save-file
{"fileId":"<file-id>","sourceLocalPath":"<absolute path from prompt>","displayName":"<name>","size":12345,"destination":{"user":"aispeech","path":"/absolute/path/to/final-filename.ext"},"methodPreference":"rsync","reason":"save staged file into this concrete Host/Main Agent file path according to workspace rules"}
```
