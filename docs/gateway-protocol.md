# Gateway Protocol Notes

The first implementation mirrors the Gateway methods already used in `moltbot/apps`:

- `health`
- `sessions.list`
- `chat.history`
- `chat.send`
- `chat.abort`
- `sessions.reset`
- `sessions.compact`

The WebSocket client waits for a `connect.challenge` event, sends a `req` frame with method `connect` and role `operator`, then sends `req` frames and listens for `res` and `event` frames.

Connection transports:

- `direct`: connect to `ws://<gatewayDirectHost>:<gatewayRemotePort>`. This is intended for Tailscale/LAN when the Gateway is bound to a reachable interface.
- `ssh`: establish `127.0.0.1:<gatewayLocalPort> -> <gatewayRemoteHost>:<gatewayRemotePort>` via SSH, then connect to `ws://127.0.0.1:<gatewayLocalPort>`.

Events currently forwarded to the browser:

- `chat`
- `agent`
- `health`
- `tick`
- `seqGap`
