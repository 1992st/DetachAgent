# detaches_agent Architecture

`detaches_agent` is a local Web UI plus local Node proxy that connects this machine to a remote OpenClaw Gateway. The default development target is configured through `.env.local` or the UI `网络与 SSH` page.

The browser never talks to SSH or remote OpenClaw directly. It talks to the local server. The local server manages SSH port forwarding, Gateway WebSocket/RPC, file uploads, and downloads.

Main flow:

```text
Browser UI -> local Node server -> SSH tunnel -> remote OpenClaw Gateway
```

Gateway RPC is the main protocol. SSH/CLI is only used for the tunnel and diagnostics.
