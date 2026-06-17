# Build And Packaging Guide

## Purpose

This document is the common build, run, test, and packaging guide for Detaches Agent. It covers local development on macOS/Linux, desktop development, and Windows installer packaging.

## Workspace

The repository is a pnpm workspace:

- `apps/web`: Vite + React web UI.
- `apps/server`: local Node.js server.
- `apps/desktop`: Electron desktop shell.
- `packages/shared`: shared TypeScript contracts.
- `packages/openclaw-detaches-adapter`: adapter CLI, manifests, skill assets, and tests.

Run all commands from the repository root unless noted otherwise:

```bash
cd <detaches_agent-repo>
```

## Install Dependencies

```bash
corepack enable
pnpm install
```

For reproducible CI or release builds:

```bash
pnpm install --frozen-lockfile
```

## Platform Selection

`pnpm build` does not choose a target OS. It compiles TypeScript and Vite output that still chooses platform-specific behavior at runtime.

Runtime platform selection is based on Node's `process.platform` through `platformService`:

- macOS: `darwin`
- Windows: `win32`
- Linux: `linux`

Examples:

- On macOS/Linux, the runtime uses `~/.detach_agent`, POSIX shell behavior, `ssh`, `ssh-keygen`, and `lsof`.
- On Windows, the runtime uses `~/.detach_agent`, PowerShell, `ssh.exe`, `ssh-keygen.exe`, and `netstat.exe`.
- Remote OpenClaw/agent host paths and install scripts remain POSIX-first for Windows V1.

Packaging is different from compiling. Windows packaging is explicitly selected with:

```bash
pnpm package:win
```

That runs Electron Builder with:

```bash
electron-builder --win nsis --x64
```

The Windows installer must be built and validated on Windows before it is considered releasable.

## Compile

Run type checks:

```bash
pnpm typecheck
```

Build server and web artifacts:

```bash
pnpm build
```

Build only the Electron desktop TypeScript entrypoints:

```bash
pnpm --filter @detaches/desktop build
```

## Run Development Stack

Run the browser-based development stack:

```bash
pnpm dev
```

Open:

```text
http://127.0.0.1:5173
```

The local server listens on:

```text
http://127.0.0.1:38888
```

`pnpm dev` starts only the local Detaches Agent server and web UI. It does not restart the remote OpenClaw Gateway. When `OPENCLAW_GATEWAY_TRANSPORT=ssh`, the local server may create or recreate its own local SSH tunnel process, but it does not restart the remote Gateway process.

## Linux Development Runtime

Linux V1 supports source/development usage, not Linux desktop installer packaging.

Recommended first validation targets:

- Ubuntu 22.04 x64
- Ubuntu 24.04 x64

Required Linux tools:

- Node.js 22 LTS
- Corepack / pnpm 9.15.9
- Git
- OpenSSH client: `ssh`, `ssh-keygen`
- `curl`
- `/bin/bash` or `/bin/sh`
- native build tools for `node-pty`, usually `python3`, `make`, and `g++`

Recommended optional tools:

- `tmux` for better local terminal persistence
- `lsof`, `ss`, or `netstat` for port-owner diagnostics

Linux setup:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Linux development run:

```bash
pnpm dev
```

Open:

```text
http://127.0.0.1:5173
```

Health check:

```bash
curl -fsS http://127.0.0.1:38888/api/health
```

Linux validation checklist:

- `pnpm --filter @detaches/server test`
- `pnpm --filter @detaches/openclaw-detaches-adapter test`
- `pnpm --filter @detaches/server smoke`
- direct Gateway health passes
- SSH tunnel mode establishes local `-L` and remote `-R`
- local terminal opens and can run a command
- upload, download, and file transfer paths work
- adapter local readiness and remote readiness work

Do not mark Linux as fully supported until this checklist passes on a real Linux machine or Linux CI runner.

## Run Electron Desktop In Development

First build server/web once:

```bash
pnpm build
```

Then use two terminals.

Terminal 1:

```bash
pnpm dev
```

Terminal 2:

```bash
pnpm desktop:dev
```

Desktop dev mode loads:

```text
http://127.0.0.1:5173
```

So the Vite dev server from `pnpm dev` must be running.

## Tests

Platform pure-logic and server test:

```bash
pnpm --filter @detaches/server test
```

Adapter tests:

```bash
pnpm --filter @detaches/openclaw-detaches-adapter test
```

Server smoke test:

```bash
pnpm --filter @detaches/server smoke
```

If a restricted environment returns `listen EPERM 127.0.0.1`, rerun the affected test in a normal local terminal because adapter and smoke tests bind local ports.

## Windows Installer Packaging

Use a Windows 10/11 x64 machine or Windows CI runner for real packaging.

Required tools:

- Node.js 22 LTS.
- pnpm 9.15.9 through Corepack.
- Git.
- PowerShell.
- Visual Studio Build Tools with MSVC C++ workload.
- Python for native Node builds.
- Windows OpenSSH Client.
- `curl.exe`.

Build flow:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm --filter @detaches/openclaw-detaches-adapter test
pnpm --filter @detaches/server test
pnpm --filter @detaches/server smoke
pnpm package:win
```

Expected artifact:

```text
release/
  detaches-agent-<version>-win-x64-setup.exe
```

Create a checksum before sharing:

```powershell
Get-FileHash release\detaches-agent-<version>-win-x64-setup.exe -Algorithm SHA256
```

## Release Script

The full Windows release script is:

```bash
pnpm release:win
```

It runs typecheck, build, adapter tests, server smoke, and Windows packaging. Use it on Windows for release candidates.

## What macOS Can And Cannot Close

macOS can verify:

- TypeScript compilation.
- Vite build.
- Server build.
- Electron shell TypeScript build.
- Platform pure-logic tests, including Windows path/shell config generation.
- Adapter tests and server smoke, if local port binding is allowed.

macOS cannot close:

- Windows `node-pty` native binary behavior.
- PowerShell terminal interactivity.
- Windows OpenSSH tunnel behavior.
- NSIS installer install/uninstall behavior.
- Windows firewall and SmartScreen behavior.
- Final Windows installer release readiness.

## Related Documents

- `doc/trd/windows-desktop-release-architecture.md`
- `doc/trd/windows-handoff-runbook.md`
