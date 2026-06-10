# moltbot Reference

Reference files inspected:

- `/Users/zhangshutong/code/moltbot/apps/ios/Sources/Gateway/GatewayConnectConfig.swift`
- `/Users/zhangshutong/code/moltbot/apps/ios/Sources/Chat/IOSGatewayChatTransport.swift`
- `/Users/zhangshutong/code/moltbot/apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/RemoteTunnelManager.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/RemotePortTunnel.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/RemoteGatewayProbe.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/GatewayConnection.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/SessionData.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/NodeMode/MacNodeRuntime.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/NodeMode/MacNodeScreenCommands.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/NodeServiceManager.swift`
- `/Users/zhangshutong/code/moltbot/apps/macos/Sources/OpenClaw/NodePairingApprovalPrompter.swift`

The TypeScript implementation borrows the protocol shape and behavior, not Swift code.

## Findings

- Gateway WebSocket protocol uses `req` / `res` frames and a `connect.challenge` event before the `connect` request.
- `sessions.list`, `chat.history`, `chat.send`, and `chat.abort` are first-class Gateway RPC methods in the macOS client path.
- Remote probe UX in `RemoteGatewayProbe.swift` distinguishes token missing, token mismatch, gateway token not configured, password auth, setup-code expiry, and pairing required. `detaches_agent` mirrors the useful user-facing classification in `/api/diagnostics`.
- macOS already has directly usable remote-control node code:
  - `MacNodeModeCoordinator` connects as `role=node` and advertises capabilities/commands.
  - `MacNodeRuntime` handles `canvas.*`, `browser.proxy`, `camera.*`, `location.get`, `screen.snapshot`, `screen.record`, `system.run`, `system.which`, `system.notify`, and exec approval commands.
  - `MacNodeScreenCommands` defines the screen capture/record commands.
  - `NodePairingApprovalPrompter` and node pairing RPCs provide the approval model that remote control should reuse.

## Design consequence

For the next remote-control phase, `detaches_agent` should stay an operator UI and call OpenClaw Gateway `node.*` / `node.invoke` flows. It should not reimplement macOS screen capture, browser control, camera, location, or command execution in this Node server.
