# Cross-platform runtime notes

This document records what must change before the current `detaches_agent` stack can run cleanly on Windows and Linux as well as macOS.

## Current baseline

- Web UI: React + Vite, browser-only, mostly platform neutral.
- Local server: Node.js + TypeScript + Express + WebSocket.
- Remote transport: OpenSSH client process with local forward (`-L`) and reverse bridge (`-R`).
- File transfer: remote host pulls staged files with `curl` through the reverse bridge.
- Local terminal: `node-pty` when available, pipe fallback otherwise.
- Runtime settings: stored in `storage/cache/settings.json` and editable in the UI.

## What already works on Linux

Linux is the closest target because the current implementation already assumes POSIX shell behavior for remote commands.

Required checks:

- `ssh` is installed and in `PATH`.
- `curl` is installed on both local and remote sides when local-user-machine transfer is used.
- `node-pty` native package can install for the target distro/Node version.
- Local firewall allows the local server ports, normally `38888` and Vite's selected port.
- SSH server allows reverse forwarding for the configured `reverseBridgeRemotePort`.

Expected small changes:

- Replace macOS-oriented display strings such as "MacBook" with "local machine" everywhere.
- Avoid assuming `/Users/<name>` in prompts, validation, and defaults. Use `/home/<user>` or configured `remoteWorkspaceRoot`.
- Keep all shell snippets POSIX-compatible.

## What needs work for Windows

Windows can run the Web UI and Node server, but several runtime assumptions need explicit adapters.

### SSH client

Use the bundled Windows OpenSSH client when available:

```powershell
where.exe ssh
```

If `ssh.exe` is missing, the app should show an actionable diagnostic instead of failing later.

Implementation work:

- Add a platform-aware command resolver for `ssh`, `ssh-keygen`, and `curl`.
- Quote Windows paths safely when passing identity paths to `ssh.exe`.
- Normalize `~` expansion and drive-letter paths in settings.

### SSH key bootstrap

The existing password bootstrap writes an OpenSSH public key to the remote user's `authorized_keys`. That model is still valid, but local key paths differ.

Recommended Windows default:

```text
%USERPROFILE%\.ssh\detaches_agent_ed25519
```

Implementation work:

- Add Windows default identity path.
- Avoid POSIX-only `chmod` assumptions on local key files; use best-effort permissions on Windows.
- Keep remote `authorized_keys` setup POSIX because the remote agent host is usually Linux/macOS.

### Local terminal

`node-pty` supports Windows, but shell startup and command syntax differ.

Implementation work:

- Select shell by platform:
  - Windows: `powershell.exe` or `cmd.exe`
  - macOS/Linux: `$SHELL` or `/bin/bash`
- Do not run Windows commands through `shell -lc`.
- Add per-platform terminal command builders.
- Clearly label local terminal target as Windows/Linux/macOS in the UI.

### File paths

The app now distinguishes `local-user-machine` and `remote-agent-host`, but Windows local paths need stricter handling.

Implementation work:

- Use Node `path.win32` / `path.posix` intentionally instead of mixing separators.
- Keep `remote-agent-host` paths POSIX unless the remote host reports Windows.
- For `local-user-machine` transfer, validate Windows absolute paths such as `C:\Users\...\Downloads\file`.
- In prompts, never suggest a Windows path for `remote-agent-host` unless the remote host is known to be Windows.

### Process and port diagnostics

Current diagnostics use Unix tools in some places (`lsof`, `ps`, `kill`) during manual debugging. Product code should not depend on them for Windows.

Implementation work:

- Keep port probing in Node TCP code where possible.
- Replace process-owner diagnostics with platform-specific helpers:
  - macOS/Linux: `lsof`
  - Windows: `netstat -ano` plus optional process lookup
- Make process cleanup use tracked child PIDs instead of shell commands.

### Packaging

For a standard desktop app, use Electron or Tauri after the server/UI boundary is stable.

Implementation work:

- Package the Node server with the frontend build.
- Store settings in an OS app-data directory:
  - macOS: `~/Library/Application Support/detaches_agent`
  - Windows: `%APPDATA%\detaches_agent`
  - Linux: `$XDG_CONFIG_HOME/detaches_agent` or `~/.config/detaches_agent`
- Bundle or preflight `ssh.exe` and `curl.exe`.
- Add auto-start/stop lifecycle for the SSH tunnel when the app opens/closes.

## Recommended implementation order

1. Add `platformService`: OS detection, path defaults, command resolver, shell resolver.
2. Refactor SSH and terminal services to use `platformService`.
3. Add Windows path validation for local file transfer.
4. Add platform-specific diagnostics text in `/api/network/test`.
5. Run CI on macOS, Ubuntu, and Windows.
6. Package as a desktop app only after the above is stable.

## Test matrix

Minimum matrix before calling cross-platform support complete:

| Host OS | Gateway transport | Local terminal | File transfer target | Expected result |
| --- | --- | --- | --- | --- |
| macOS | SSH tunnel | zsh/bash | remote-agent-host | Pass |
| Linux | SSH tunnel | bash | remote-agent-host | Pass |
| Windows | SSH tunnel | PowerShell | remote-agent-host | Pass |
| Windows | SSH tunnel | PowerShell | local-user-machine | Windows absolute path accepted |
| macOS/Linux/Windows | direct | native shell | none | Gateway health passes when direct Gateway is reachable |

## Current risk summary

- Linux should be achievable with small fixes and validation.
- Windows needs a platform abstraction for shell, path, SSH binary discovery, and diagnostics before it should be considered supported.
- The remote OpenClaw agent host should remain POSIX-first until there is a real Windows Gateway host to test against.
