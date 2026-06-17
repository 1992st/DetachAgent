# Windows Handoff Runbook

## Purpose

Use this document when a Windows machine or Windows CI runner is available. The Mac-first phase prepares code, architecture, and scripts, but Windows release closure must happen on Windows.

For the common compile, run, test, and packaging commands, see `doc/trd/build-and-packaging.md`. This runbook focuses on Windows handoff and release validation.

## Required Windows Environment

- Windows 10/11 x64, or a Windows Server runner.
- Git.
- Node.js 22 LTS.
- pnpm 9.15.9 through Corepack.
- PowerShell.
- Visual Studio Build Tools with MSVC C++ workload.
- Python available to native Node builds.
- Windows OpenSSH Client, including `ssh.exe` and `ssh-keygen.exe`.
- `curl.exe`.

Recommended checks:

```powershell
node --version
corepack --version
git --version
where.exe powershell
where.exe ssh
where.exe ssh-keygen
where.exe curl
```

## Build From A Fresh Checkout

```powershell
git clone <repo-url> detaches_agent
cd detaches_agent
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm --filter @detaches/openclaw-detaches-adapter test
pnpm --filter @detaches/server test
pnpm --filter @detaches/server smoke
pnpm package:win
```

Expected release artifact:

```text
release/
  detaches-agent-0.1.0-win-x64-setup.exe
```

Before sharing the package, also create:

```powershell
Get-FileHash release\detaches-agent-0.1.0-win-x64-setup.exe -Algorithm SHA256
```

Record the hash in:

```text
release/detaches-agent-0.1.0-win-x64-setup.exe.sha256
```

## Expected Future Release Metadata

Create `release/build-metadata.json` during the Windows release pass. Include:

- package version
- git commit hash
- build time
- Node version
- pnpm version
- Electron version
- Windows version
- whether the installer was signed

Create `release/smoke-report.json` with the smoke checklist result.

## Install And Launch Checklist

Run this on a clean Windows user profile when possible:

- Install `detaches-agent-<version>-win-x64-setup.exe`.
- Confirm Start Menu shortcut exists.
- Confirm desktop shortcut exists if selected.
- Launch Detaches Agent.
- Confirm Electron window opens.
- Confirm local server starts.
- Open server health from UI or `http://127.0.0.1:38888/api/health`.
- Confirm storage directory is created under `~/.detach_agent`.
- Close the window and confirm server exits.
- Reopen and confirm settings persist.
- Uninstall and confirm application files are removed.
- Confirm user settings are not accidentally deleted unless the uninstaller explicitly asks.

## Functional Acceptance Checklist

### Direct Gateway

- Configure direct Gateway settings.
- Run UI health/diagnostics.
- Confirm `sessions.list`, `chat.history`, `chat.send`, and `chat.abort` continue to work.

### SSH Tunnel

- Configure remote host, SSH port, user, key path, Gateway remote/local ports, and reverse bridge port.
- Run network diagnostics.
- Confirm local forward `-L` is listening.
- Confirm remote reverse bridge `-R` can reach the local Detaches Agent server.
- Confirm port conflict messages are actionable.

### SSH Bootstrap

- Use password bootstrap to generate or reuse:

```text
%USERPROFILE%\.ssh\detaches_agent_ed25519
```

- Confirm public key is written to remote `~/.ssh/authorized_keys`.
- Confirm key login is verified.

### Terminal

- Open a local terminal session from the UI.
- Confirm PowerShell starts.
- Type a command and verify output.
- Resize the terminal and verify no crash.

### Files

- Upload a file.
- Transfer to `local-user-machine` using a Windows absolute path, for example:

```text
C:\Users\<user>\Downloads\detaches-test.txt
```

- Transfer to `remote-agent-host` using a POSIX path inside the remote workspace/home.
- Download a remote file from the configured remote workspace.

### Adapter

- Check local adapter readiness.
- Run remote readiness over SSH.
- Generate remote install command.
- Execute the remote install flow on the POSIX remote host.
- Confirm relationship skill zip and public docs are available in the packaged app.

### Missing Dependency Diagnostics

Temporarily test or simulate:

- `ssh.exe` missing.
- `ssh-keygen.exe` missing.
- `curl.exe` missing.
- Gateway port already occupied.
- SSH authentication failure.
- Remote host unreachable.

The app must show a clear error instead of crashing.

## Mac-Covered Work

The Mac phase should already cover:

- TypeScript compile for server/web/desktop.
- Web build.
- Server build.
- Platform pure-logic tests:
  - Windows `~/.detach_agent` storage path.
  - Windows default SSH key path.
  - Windows local absolute path validation.
  - POSIX remote path normalization.
  - PowerShell launch config.
- Documentation and packaging scripts.

## Windows-Only Work

These cannot be closed on Mac:

- `node-pty` Windows native binary install/rebuild.
- PowerShell terminal interactivity.
- OpenSSH tunnel behavior on Windows.
- NSIS install/uninstall behavior.
- SmartScreen/security software behavior.
- Windows firewall interaction.
- Packaged `resourcesPath`/asar behavior.
- Final installer artifact validation.

## Troubleshooting

### `node-pty` rebuild fails

- Confirm Visual Studio Build Tools are installed.
- Confirm Python is available.
- Run:

```powershell
pnpm rebuild node-pty --filter @detaches/server
```

- If Electron runtime needs a native rebuild, test with Electron Builder's native dependency rebuild enabled before changing app code.

### `ssh.exe` or `ssh-keygen.exe` not found

- Install Windows OpenSSH Client from Windows Optional Features.
- Reopen PowerShell.
- Verify:

```powershell
where.exe ssh
where.exe ssh-keygen
```

### `curl.exe` not found

- Verify:

```powershell
where.exe curl
```

- If missing, repair PATH or install curl. Future releases may bundle curl under `resources/bin/win32`.

### PowerShell policy issues

The app launches PowerShell with:

```text
-NoLogo -NoExit -ExecutionPolicy Bypass
```

If a corporate policy still blocks execution, capture the exact message in the smoke report.

### Electron Builder or NSIS download fails

- Check network/proxy settings.
- Re-run `pnpm package:win`.
- If CI is used, cache Electron and Electron Builder downloads.

### Port is occupied

- Check:

```powershell
netstat -ano -p tcp | findstr :38888
netstat -ano -p tcp | findstr :18790
```

- Stop the owning process or change the configured port.

## Release Decision

Do not mark the Windows package releasable until:

- The installer is built on Windows.
- The installer has been installed on Windows.
- The functional acceptance checklist is complete.
- Known failures are documented in `smoke-report.json`.
