# detaches_agent

Local Web UI and proxy server for connecting this machine to a remote OpenClaw Gateway.

## Quick Start

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`.

The local server listens on `127.0.0.1:38888` and can reach the remote OpenClaw Gateway either directly over Tailscale/LAN or through an SSH tunnel.
Connection settings can also be edited from the `网络与 SSH` page in the UI. Runtime settings are stored locally in `storage/cache/settings.json` with file mode `0600`; saved tokens and passwords are never returned to the browser, only `hasAuthToken` / `hasAuthPassword` flags are exposed.

## Required Local Config

Edit `.env.local` before connecting to the remote machine:

```text
OPENCLAW_REMOTE_HOST=100.74.38.97
OPENCLAW_GATEWAY_TRANSPORT=ssh
OPENCLAW_GATEWAY_DIRECT_HOST=100.74.38.97
OPENCLAW_GATEWAY_REMOTE_PORT=18789
OPENCLAW_GATEWAY_LOCAL_PORT=18790
OPENCLAW_REMOTE_USER=<ssh-user>
OPENCLAW_REMOTE_IDENTITY_PATH=<absolute-path-to-private-key>
OPENCLAW_AUTH_MODE=token
OPENCLAW_AUTH_TOKEN=<gateway-token-if-required>
```

Use `OPENCLAW_GATEWAY_TRANSPORT=direct` when the Gateway allows Tailscale/LAN access. Use `OPENCLAW_GATEWAY_TRANSPORT=ssh` when the Gateway only binds to remote loopback and should be reached through `ssh -L`.

For SSH tunnel mode, the remote OpenClaw Gateway should be reachable on the remote host at `127.0.0.1:18789`.
Use a local tunnel port such as `18790` to avoid accidentally connecting to a local Gateway that already owns `18789`.

For OpenClaw Gateway builds that enforce pairing/auth, provide the Gateway token in `.env.local` or in the UI settings panel. The client implements the v3 `connect.challenge` device-signature handshake and then sends token/password auth when configured.

## Verify

```bash
pnpm typecheck
pnpm build
pnpm smoke
curl -fsS http://127.0.0.1:38888/api/health
```

The UI `网络与 SSH` page also has a `测试网络` button that checks SSH reachability, tunnel state, local Gateway port, and Gateway health.

If `OPENCLAW_REMOTE_USER` is missing, `/api/health` intentionally reports SSH as disabled. This keeps the UI usable for configuration and diagnostics.
`pnpm smoke` starts a mock OpenClaw Gateway and the real local server, then verifies Gateway challenge/auth, `health`, `sessions.list`, `chat.history`, `chat.send`, `chat.abort`, and attachment payload mapping end to end.

## Current Scope

- Gateway RPC: `health`, `sessions.list`, `chat.history`, `chat.send`, `chat.abort`.
- Files: local upload cache, inline Gateway chat attachments using base64 payloads, plus best-effort SFTP to the remote OpenClaw workspace.
- Remote control: UI and service modules are reserved, but real control is not enabled until approval/audit/timeout boundaries are implemented.
