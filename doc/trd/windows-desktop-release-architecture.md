# Windows Desktop Release Architecture

## Goal

The Windows release should be a user-installable Detaches Agent desktop app, not a developer workflow. The current Mac-first phase prepares the architecture, platform seams, Electron shell, and handoff material. A Windows machine or Windows CI runner is still required before the package can be called releasable.

## Current Runtime

The repository is a pnpm workspace:

- `apps/web`: React + Vite browser UI.
- `apps/server`: Node.js + Express + WebSocket local server.
- `packages/shared`: shared TypeScript contracts.
- `packages/openclaw-detaches-adapter`: adapter assets, CLI, skill manifests, and install bundle.

The browser talks only to the local server. The local server owns Gateway RPC, SSH tunnel management, uploads/downloads, terminal sessions, settings, and adapter distribution.

```text
Browser UI -> local Node server -> Gateway direct or SSH tunnel -> remote OpenClaw Gateway
```

## Windows Release Runtime

The Windows package adds `apps/desktop` as the release shell:

```text
Electron main process
  -> starts/stops local Node server
  -> loads packaged Vite Web UI
  -> owns window lifecycle, app data, logs, and crash notices

Vite Web UI
  -> talks to local server over HTTP/WebSocket

Node server
  -> owns all product logic
```

The server remains independently buildable and runnable. Electron is a distribution shell, not the home for product logic. This keeps dev mode, server smoke tests, and future non-desktop deployment paths intact.

## Responsibility Boundaries

- Electron main: desktop lifecycle only. It starts the server, opens the UI, passes app-data/resource paths, and reports local server crashes.
- Node server: all business behavior. Gateway, SSH, terminal, file transfer, settings, diagnostics, and adapter operations stay here.
- Web UI: product screens only. It should not know whether it is running in a browser tab or Electron, beyond optional platform display hints.

This boundary avoids mixing privileged desktop APIs with request/approval logic and makes Windows issues easier to isolate.

## Storage Directory

Server storage now resolves through `platformService.getAppDataDir()` and still honors `DETACHES_STORAGE_DIR`.

Default location:

- All desktop platforms: `~/.detach_agent`

This keeps development, desktop packaging, and future Windows handoff behavior aligned. Tests and CI can still set `DETACHES_STORAGE_DIR` to isolate temporary state.

## Platform Service

`apps/server/src/services/platform/platformService.ts` centralizes OS-specific behavior:

- `getPlatformInfo()`
- `getAppDataDir()`
- `getDefaultIdentityPath()`
- `resolveCommand("ssh" | "ssh-keygen" | "curl" | "openclaw")`
- `getDefaultShell()`
- `buildShellLaunch()`
- `buildInteractiveShellLaunch()`
- `normalizeLocalPath()`
- `normalizeRemotePosixPath()`
- `getPortOwner()`
- `chmodPrivateKeyBestEffort()`

Product code should not add new direct `process.platform` branches for shell/path/process/port behavior. Add or extend platform service methods instead.

## Build And Platform Selection

The common build, run, test, and packaging workflow is documented in `doc/trd/build-and-packaging.md`.

Key rule: `pnpm build` compiles common TypeScript/Vite output and does not choose an OS target. Runtime behavior is selected through `platformService` and `process.platform`. Windows installer packaging is explicitly selected with `pnpm package:win` and must be validated on Windows before release.

## Windows V1 Scope

Windows V1 targets the user machine running Detaches Agent:

- Windows 10/11 x64.
- Electron desktop app.
- Local Node server.
- Packaged Vite UI.
- Direct Gateway mode.
- SSH tunnel mode with local forward and reverse bridge.
- SSH key bootstrap.
- Local PowerShell terminal.
- Upload/download/file transfer.
- Adapter readiness and remote install command.
- Diagnostics for missing OpenSSH/curl, port conflicts, SSH failures, and server failures.

The remote OpenClaw/Gateway/agent host remains POSIX-first for V1. Remote install scripts, adapter readiness scripts, and remote file paths assume Linux/macOS shell behavior.

## Explicit Non-Goals For V1

- Remote agent host running Windows.
- iOS local runtime.
- Guaranteed Windows installer from a Mac-only build.
- Mandatory code signing.
- Mandatory auto-update.

Signing and auto-update metadata should be left easy to add to Electron Builder config, but they should not block the internal handoff build.

## iOS Direction

iOS should not reuse the desktop runtime directly. The desktop app owns local Node, SSH tunnel, PTY, and filesystem-heavy workflows. iOS should be designed later as a constrained client/control surface that connects to an existing gateway/server rather than trying to host the same runtime.

## Packaging Strategy

`apps/desktop/electron-builder.yml` defines the Windows NSIS target. The intended artifact is:

```text
detaches-agent-<version>-win-x64-setup.exe
```

The package should include:

- Electron runtime.
- Built `apps/web/dist`.
- Built `apps/server/dist`.
- Server package metadata.
- Shared package build output.
- Adapter package assets.
- Public docs and skill zip.

OpenSSH and curl are not bundled in the Mac-first phase. `platformService` already supports future bundled command lookup through `DETACHES_RESOURCES_DIR/bin/<platform>/`.

## Known Risks

- `node-pty` is a native dependency and must be built/validated on Windows.
- Windows OpenSSH availability varies by machine and PATH.
- PowerShell behavior must be tested interactively on Windows.
- Electron Builder/NSIS output must be installed and uninstalled on Windows.
- Unsigned installers may trigger SmartScreen.
- Firewall/security tools may affect local server and SSH tunnel behavior.
- Packaged asar paths may need adjustment after the first Windows package smoke.

## Mac-First Completion Criteria

The Mac phase is complete when:

- Platform service exists and is used by platform-coupled server services.
- Electron desktop skeleton exists.
- Root scripts exist for desktop dev and Windows packaging.
- Platform pure-logic tests pass on Mac.
- Architecture and Windows handoff docs exist.

It is not complete for Windows release until the Windows handoff runbook has been executed on Windows.
