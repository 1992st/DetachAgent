# Adversarial Review

## Findings fixed in this pass

- Gateway frames must use OpenClaw protocol `type: "req"` / `type: "res"`, not generic `request` / `response`.
- Gateway connect is a `req` frame with method `connect`; the connect payload is not a standalone top-level `connect` frame.
- OpenClaw Gateway sends `connect.challenge`; this client now creates a persistent Ed25519 device identity, signs the v3 payload, and sends the device signature with `client.id = "openclaw-macos"` / `mode = "ui"`.
- Chat attachments must match OpenClaw's `OpenClawChatAttachmentPayload`: `{ type, mimeType, fileName, content }`, where `content` is base64. Uploads now keep a local cached file, optionally SFTP to workspace, and send inline Gateway attachments when chatting.
- Runtime connection settings should be editable without restarting the app. The UI now persists remote host, ports, SSH user/key, auth mode, token/password, and workspace root in `storage/cache/settings.json`.
- Production server startup was broken by the original TypeScript output path (`dist/apps/server/src/index.js` vs `dist/index.js`). The server `tsconfig` now uses `rootDir: "src"`, and `pnpm build` emits `apps/server/dist/index.js`.
- A mock-Gateway smoke test now exercises the real local server over HTTP and WebSocket. It verifies `connect.challenge`, token auth forwarding, device nonce forwarding, `health`, `sessions.list`, `chat.history`, `chat.send`, `chat.abort`, and OpenClaw-compatible attachment payloads.
- `/api/diagnostics` now mirrors the useful OpenClaw macOS `RemoteGatewayProbe` classification style for common operator-facing failures: missing SSH user, SSH host-key failure, tunnel failure, missing/mismatched Gateway token, password auth issues, pairing required, and generic Gateway unavailability.
- The UI project should treat Gateway RPC as the primary protocol and avoid remote CLI as a runtime dependency.
- macOS remote-control capabilities already exist in the reference OpenClaw app as `MacNodeModeCoordinator` + `MacNodeRuntime`; this project should not reimplement screen/system/browser control in Node first.

## Remaining risks

- Full live chat verification still requires valid SSH credentials and a Gateway token/password for `100.114.139.72`. The latest local handshake reached the remote Gateway auth layer and returned `unauthorized: gateway token missing`, which confirms the protocol/device-identity path but blocks `sessions.list` and `chat.send` until credentials are supplied.
- File artifact download is still SFTP-based and constrained to the configured workspace root. A native Gateway artifact/download RPC should replace this when the remote API is confirmed.
- The current WebSocket chat event renderer is intentionally tolerant; once a live Gateway is available, event payload mapping should be tightened against real `chat` event samples.

## Verification evidence

- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `pnpm smoke`: passed. The smoke test starts a mock OpenClaw Gateway plus the real local server and proves HTTP/WS behavior through the same server routes used by the UI.
- Browser desktop check at `1440x900`: rendered header, left agent panel, center chat, and right settings/files/control panel without console errors.
- Browser mobile check at `390x844`: no horizontal overflow, agent error state visible, composer remains inside viewport.
- Live local Gateway check without credentials: reached Gateway auth and returned `unauthorized: gateway token missing (provide gateway auth token)`. This is a credential blocker for real remote chat, not a local protocol failure.
- Live `/api/diagnostics` without credentials: returned actionable `ssh-user-missing` and `gateway-token-missing` items.

## macOS code directly useful from OpenClaw/moltbot

- `MacNodeModeCoordinator.swift`: connects as `role=node`, advertises caps and commands.
- `MacNodeRuntime.swift`: handles `canvas.*`, `browser.proxy`, `camera.*`, `location.get`, `screen.snapshot`, `screen.record`, `system.run`, `system.which`, `system.notify`, and exec approvals.
- `MacNodeScreenCommands.swift`: defines `screen.snapshot` and `screen.record`.
- `ExecApproval*`: provides approval and allowlist patterns for `system.run`.

Recommended next implementation path for remote control: run the OpenClaw macOS node on the PC and let this UI remain the operator client. Avoid duplicating macOS permissions, screen capture, and approval logic in this web project.
