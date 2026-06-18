# Remote Control Design

Remote control now uses the local Tool Broker boundary described in
`docs/main-agent-local-control-design.md`.

The important distinction is:

- `local-user-machine` terminal requests run in detaches_agent's local terminal
  after user approval. They do not use SSH and should not ask for SSH
  credentials.
- SSH is reserved for reverse bridge reachability, file transfer to the Main
  Agent machine, or an explicit SSH-login flow.

Required guardrails:

- explicit user approval
- audit log
- command timeout
- risk classification
- request-scoped password dialogs only when an SSH login or secret is actually
  needed
- output redaction

The current implementation already supports `detaches-terminal` requests through
`POST /api/tools/events/gateway` and fenced request extraction. It also supports
a v1 local interaction broker through `POST /api/interactions/events/gateway`
for request-scoped password prompts and other user-visible events.
