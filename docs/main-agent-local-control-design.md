# Main Agent Local Control Design

This document defines how a Main Agent should control or interact with the
user's local PC through detaches_agent without confusing local terminal
execution, SSH login, and broker/context connectivity.

## Goals

- Do not artificially limit the Main Agent's ability to operate the user's PC.
- Require user participation only at the moment an SSH login or sensitive local
  secret is needed.
- Keep normal local terminal work as flexible as using a terminal directly.
- Provide a stable communication path from Main Agent to the local
  detaches_agent server.
- Avoid leaking long-lived secrets such as private keys or reusable passwords to
  the model transcript or remote agent workspace.

## Current Communication Path

The current stable path is the Tool Broker:

1. The local server builds `clientContext.detaches`.
2. The context contains:
   - `broker.gatewayEventEndpoint`
   - `broker.submitToken`
   - `broker.submitTokenHeader`
   - `contextExport.consumeUrl`
3. The Main Agent can submit structured tool events to:
   - `POST /api/tools/events/gateway`
4. The local UI receives tool events through:
   - `WS /api/tools/stream`
5. The user approves or rejects a request through:
   - `POST /api/tools/requests/:id/approve`
   - `POST /api/tools/requests/:id/reject`
6. Approved `terminal` requests run through `terminalService` in the
   per-session local terminal bound by `sessionKey`.

The current fallback path is a fenced request block in chat, for example:

```detaches-terminal
{"target":"local-user-machine","command":"df -h /","reason":"check local disk usage"}
```

The web client extracts this block and creates the same local broker request.

## Critical Boundary

`local-user-machine` terminal requests are not SSH.

For `target=local-user-machine`:

- The Main Agent must not SSH into the user's local PC.
- The Main Agent must not ask for the user's local SSH username, password, port,
  or key path.
- The command runs in a local terminal owned by detaches_agent after user
  approval.
- No SSH password is required for this path.

SSH is only needed for:

- a reverse bridge that lets the remote agent host reach the local broker or
  context export URL;
- transferring local staged files to the Main Agent machine;
- an explicit user-approved request to log in to some SSH target.

## Review Of "Send SSH Config To The Agent"

The idea:

> Each conversation binds a terminal. The local server keeps SSH config in
> memory: name, IP, key, terminal id. When the Main Agent needs terminal access,
> send that config to the agent and let the agent SSH by itself.

This is partially useful but should not be the primary design.

Good parts:

- Sending a non-secret connection descriptor can help the agent understand the
  topology.
- A terminal/session id is useful for correlating requests and results.
- The Main Agent can be more autonomous if it knows which route is available.

Problems:

- Sending private keys or reusable passwords to the agent is a secret leak.
- It bypasses the local approval/audit boundary.
- It turns normal local PC control into SSH, which is slower and less reliable
  than the local terminal broker.
- It makes the model responsible for password handling and SSH edge cases.
- It creates two execution paths with different audit semantics.

Recommended version:

- Send only a `connectionDescriptor`, never raw secrets:
  - `sessionKey`
  - `terminalId`
  - `broker endpoint`
  - requestable targets
  - whether an SSH route exists
  - whether user approval is required
- Keep secrets and SSH sessions inside detaches_agent.
- Let the Main Agent submit operations, not credentials.

## Recommended Stable Scheme: Local Interaction Broker

Generalize the Tool Broker into a "local interaction broker".

The Main Agent should call local broker APIs to request local actions or local
user input. The local server owns UI, approval, secrets, execution, and audit.

### Event Categories

- `terminal.run`: run a command in the bound local terminal.
- `credential.request`: ask the user for a password or secret.
- `file.transfer`: move staged local files.
- `context.export`: create or consume a one-time context.
- `ui.confirm`: ask the user to confirm a sensitive action.
- Future: `browser.open`, `notification.show`, `device.select`,
  `permission.request`.

### Stable API Shape

Reuse the existing gateway-event endpoint for tool-like events:

```http
POST /api/tools/events/gateway
Authorization: Bearer <session submit token>
Content-Type: application/json
```

Example terminal event:

```json
{
  "source": "gateway-event",
  "sourceEventId": "agent-run-001",
  "kind": "terminal",
  "target": "local-user-machine",
  "sessionKey": "agent:main:detaches:<device>",
  "agentId": "main",
  "reason": "check local disk usage",
  "payload": {
    "command": "df -h /"
  }
}
```

For non-tool UI interactions, use the sibling endpoint rather than overloading
terminal requests:

```http
POST /api/interactions/events/gateway
Authorization: Bearer <session submit token>
Content-Type: application/json
```

Example password prompt:

```json
{
  "source": "gateway-event",
  "sourceEventId": "ssh-login-001",
  "kind": "credential.request",
  "sessionKey": "agent:main:detaches:<device>",
  "agentId": "main",
  "payload": {
    "title": "Main agent credential request",
    "prompt": "SSH password required for aispeech@172.16.153.227",
    "target": {
      "host": "172.16.153.227",
      "port": 22,
      "user": "aispeech"
    }
  }
}
```

The server should show a local UI dialog and return one of two result styles:

- Preferred: an opaque `credentialHandle` that only the local server can use.
- Explicit opt-in: a one-time secret response, only if the user approves
  revealing the secret to the remote Main Agent.

Default should be `credentialHandle`, not raw password.

## Password Dialog Logic

Password dialogs should be tied to a concrete request:

- target host/user/port
- purpose
- requesting agent/session
- timeout
- whether the password will stay local or be revealed

The UI copy must make the data path explicit:

- "Use locally only" for server-side SSH/file transfer/tunnel operations.
- "Reveal once to Main Agent" only for the rare case where the user explicitly
  allows the agent to receive the secret.

Default action should never reveal a reusable password to the model.

## Result Handling

The Main Agent should receive tool results, not hidden state.

For terminal requests:

- detaches_agent executes the command.
- detaches_agent captures output and completion marker.
- detaches_agent forwards a result message through `chat.send`.

For credential requests:

- if local-only, the agent receives `credentialHandle` or a status update;
- if reveal-once, the agent receives the secret once through the API response,
  and the request is audited.
- the adapter script waits at most 300000ms and returns
  `DETACHES_INTERACTION_TIMEOUT` if the user does not decide in time.
- this 300000ms limit applies only to generic `credential.request`
  interactions. Existing purpose-built transfer dialogs, such as
  `main-agent-save-file`, may keep their own shorter password timeout.

Defined script/API error codes:

- `DETACHES_CONTEXT_INVALID`
- `DETACHES_AUTH_REQUIRED`
- `DETACHES_ENDPOINT_UNREACHABLE`
- `DETACHES_PROTOCOL_ERROR`
- `DETACHES_INTERACTION_REJECTED`
- `DETACHES_INTERACTION_EXPIRED`
- `DETACHES_INTERACTION_TIMEOUT`

## Required Invariants

- `local-user-machine` terminal execution must not require SSH.
- Health checks must not trigger password prompts.
- Chat sends must not trigger password prompts.
- Network diagnostics may trigger SSH reverse bridge setup because the user
  explicitly asked to test connectivity.
- Password prompts must always be user-visible and request-scoped.
- Long-lived private keys should never be sent to the Main Agent.
- Fenced request fallback must remain available when the broker endpoint is not
  reachable.

## Implemented V1

- `detaches-terminal` remains the default local PC control path and does not use
  SSH.
- `POST /api/interactions/events/gateway` accepts `credential.request` and
  `ui.confirm` gateway events with the existing session submit token.
- `GET /api/interactions/:interactionId` returns the result and consumes a
  reveal-once secret after token verification.
- The server has an in-memory interaction broker with `sourceEventId`
  idempotency and WebSocket fanout over `/api/tools/stream`.
- The Web UI shows a request-scoped credential modal with local-handle and
  reveal-once actions.
- `detaches-agent-adapter.mjs credential-request --wait --timeout-ms 300000`
  submits the request and waits with bounded timeout.
- The relationship skill documents the script/API rules, address source, and
  error codes so the Main Agent does not guess local IP or use its own
  `127.0.0.1`.
