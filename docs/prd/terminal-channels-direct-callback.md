# Detach Agent Terminal Channels and Direct Callback PRD

Status: Draft  
Version: 1.0  
Date: 2026-06-24

## Goal

Detach Agent must separate three terminal control channels so Main Agent local terminal requests are predictable, approval-gated, and installable without sharing SSH passwords.

- `gateway-terminal`: default long-term path. Main Agent calls the Detach Agent HTTP broker through the configured `publicBaseUrl`.
- `ssh-terminal`: advanced compatibility path. Detach Agent opens a reverse bridge with a user-provided Main Agent SSH key. It is disabled by default and may coexist with `gateway-terminal`.
- `chat-terminal`: permanent fallback. Main Agent emits a `detaches-terminal` fenced block in chat and Detach Agent parses it from message text.

All channels submit into Tool Queue. None may execute commands directly on Main Agent.

## Context Contract

Each session context may include `clientContext.detaches.terminalChannels`.

```json
{
  "preferred": "gateway-terminal",
  "gatewayTerminal": {
    "state": "ready",
    "baseUrl": "http://10.12.7.55:38888",
    "toolEventEndpoint": "http://10.12.7.55:38888/api/tools/events/gateway",
    "interactionEventEndpoint": "http://10.12.7.55:38888/api/interactions/events/gateway",
    "requiresApproval": true
  },
  "sshTerminal": {
    "state": "disabled",
    "message": "ssh-terminal is disabled by default."
  },
  "chatTerminal": {
    "state": "available",
    "requestFence": "detaches-terminal",
    "source": "text-extract",
    "requiresApproval": true
  }
}
```

Priority is fixed:

1. Use `gateway-terminal` when `publicBaseUrl` is configured and the callback test has passed.
2. Use `ssh-terminal` only when explicitly enabled and ready.
3. Use `chat-terminal` when HTTP broker access is unavailable.

When both gateway and SSH are ready, `gateway-terminal` remains preferred.

## UI Requirements

Connection settings includes a `Main Agent 回连本机` section.

- `publicBaseUrl` input.
- `选择本机回连 IP` button.
- `测试 gateway-terminal` button.
- Status text for ready, error, and chat fallback.

The IP selector recomputes candidates every time it opens.

- Show usable IPv4 addresses grouped as LAN, Tailscale, and public.
- Hide loopback, link-local, and virtual adapters by default.
- Auto-select the only usable IP.
- Recommend an IP close to the configured Main Agent IP when possible.
- Allow public IP selection with warning copy.

Advanced settings keeps SSH Reverse Bridge as `ssh-terminal`.

- Default disabled.
- Requires Main Agent SSH key path.
- Does not collect or save SSH passwords.
- Can run at the same time as `gateway-terminal`.

## Prompt and Skill Requirements

The readable session prompt must keep the existing machine boundary language and add a compact terminal channel block.

```text
terminalChannels.preferred: gateway-terminal
gateway-terminal: ready http://10.12.7.55:38888
ssh-terminal: disabled
chat-terminal: available fence=detaches-terminal
```

Routing rules:

- Never run `local-user-machine` commands in the Main Agent shell.
- Never ask for Detach Agent PC SSH credentials.
- Use HTTP broker only when the selected channel is ready.
- Use exactly one `detaches-terminal` fenced block when preferred is `chat-terminal` or the HTTP broker is unreachable.
- Do not try alternate IPs.
- Do not use `127.0.0.1` unless selected channel is `ssh-terminal`.

The `detach-agent-relationship` skill version is `1.1.0` and must preserve staged file save rules separately from terminal channel selection.

## Adapter CLI Requirements

`terminal-request` reads `terminalChannels.preferred`.

- `gateway-terminal` / `ssh-terminal`: build or submit a `gateway-event` terminal request.
- `chat-terminal`: emit a deterministic `detaches-terminal` fenced block.
- HTTP failure: print `DETACHES_ENDPOINT_UNREACHABLE` and emit the fallback fenced block.
- The CLI never executes the command locally.

`ping-channel` tests only the preferred HTTP channel. It does not try alternate IPs. If preferred is `chat-terminal`, no HTTP ping is required.

## Logging and Audit

Realtime logs should distinguish:

- `source=text-extract`, `channel=chat-terminal`, `fallback=true`
- `source=gateway-event`, `channel=gateway-terminal` or `ssh-terminal`

Server audit metadata should include:

- `terminalChannel`
- `fallbackMode`
- `preferredChannel`
- `callbackBaseUrl`

Canonical events:

- `terminal.channel.selected`
- `terminal.channel.fallback`
- `gateway-terminal.test.succeeded`
- `gateway-terminal.test.failed`
- `ssh-terminal.enabled`
- `ssh-terminal.disabled`
- `ssh-terminal.test.succeeded`
- `ssh-terminal.test.failed`

## Security

- Requests without a valid submit token return 401.
- Requests do not execute until the user approves them in Tool Queue.
- No SSH password is collected for `ssh-terminal`.
- Public callback URLs are selectable but risky; UI must make that visible.
