# Main Agent Direct Gateway Connection

## Problem

detaches_agent should be usable by non-technical users after a first setup pass. The setup must not require the detaches_agent PC to SSH into the Main Agent computer.

The desired trust direction is:

- detaches_agent connects to the Main Agent OpenClaw Gateway over a normal Gateway endpoint.
- Main Agent can call back to detaches_agent through the configured public base URL for context export and tool broker actions.
- SSH from detaches_agent PC to Main Agent is not part of the default path.

## OpenClaw Evidence

OpenClaw supports changing the Gateway listener through config without source changes:

- `gateway.port`
- `gateway.bind`: `auto`, `lan`, `loopback`, `custom`, `tailnet`
- `gateway.customBindHost`
- `gateway.auth.mode`
- `gateway.auth.token` / `gateway.auth.password`
- `gateway.controlUi.allowedOrigins` for non-loopback Control UI deployments
- `gateway.tailscale.mode`: `off`, `serve`, `funnel`

Relevant source in `~/code/moltbot`:

- `src/gateway/server-runtime-config.ts`
- `src/gateway/net.ts`
- `src/config/config.gateway-tailscale-bind.test.ts`
- `src/config/schema.base.generated.ts`

OpenClaw refuses non-loopback Gateway binds without shared-secret auth or trusted-proxy auth. Tailscale Serve/Funnel requires a loopback Gateway bind and publishes through Tailscale instead.

## Product Decision

Use direct Gateway access as the normal setup path.

Recommended OpenClaw setup options:

1. Tailscale/private direct bind:

   ```json
   {
     "gateway": {
       "bind": "tailnet",
       "port": 18789,
       "auth": {
         "mode": "token",
         "token": "<secret>"
       }
     }
   }
   ```

2. Explicit Tailscale IP:

   ```json
   {
     "gateway": {
       "bind": "custom",
       "customBindHost": "100.x.x.x",
       "port": 18789,
       "auth": {
         "mode": "token",
         "token": "<secret>"
       }
     }
   }
   ```

3. Tailscale Serve:

   ```json
   {
     "gateway": {
       "bind": "loopback",
       "port": 18789,
       "tailscale": { "mode": "serve" },
       "auth": { "mode": "token", "token": "<secret>" }
     }
   }
   ```

detaches_agent then stores:

```json
{
  "gatewayTransport": "direct",
  "remoteHost": "100.x.x.x",
  "gatewayDirectHost": "100.x.x.x",
  "gatewayRemotePort": 18789,
  "authMode": "token",
  "publicBaseUrl": "http://100.y.y.y:38888"
}
```

## Regression Rule

The primary Network and Connection UI must not ask a normal user for SSH user, SSH password, or SSH identity. SSH tunnel may remain as an advanced compatibility option only.
