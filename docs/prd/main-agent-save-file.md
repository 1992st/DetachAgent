# Main Agent Save File PRD

## Background

Files attached in detaches_agent live first in the user's local detaches_agent staging area. The Host/Main Agent cannot read `sourceLocalPath` directly. When the user asks to save one of those staged files to the Main Agent machine, the Main Agent should decide the final SSH/Linux user and destination path, while detaches_agent should perform the local-to-Main-Agent transfer after user approval.

The previous flow expanded a simple save operation into a long terminal script containing logging markers, remote `mkdir -p`, `rsync` or `scp`, remote `test -f`, and shell quoting. That made the command hard to inspect, fragile around spaces and interactive shells, and blurred the boundary between Main Agent file organization and detaches_agent transfer execution.

## Goals

- Main Agent decides the file's SSH/Linux user and semantic destination and emits one `main-agent-save-file` request.
- detaches_agent presents a clear approval UI showing source, destination, method, and reason.
- detaches_agent broker performs one structured `rsync` or `scp` transfer from the staged file to the requested destination path.
- SSH password entry happens through detaches_agent UI when needed and is not persisted.
- Transfer result is returned to Main Agent as structured JSON.
- Terminal remains available for ordinary commands and optional observation, but is not the execution protocol for saving files.

## Non-Goals

- No HTTP upload or curl POST fallback.
- No agent-generated `ssh`, `rsync`, `scp`, or shell scripts.
- No detaches_agent-side remote directory creation or remote file management.
- No hidden transfer of arbitrary local files outside the staged file registry.
- No claim that transfer success proves Main Agent's later semantic processing of the file.

## User Flow

1. User attaches a file in detaches_agent.
2. Main Agent receives `[[DETACH_AGENT_FILE_STAGED]]` context.
3. If the user asks to save the file, Main Agent chooses `destination.user` and a complete absolute `destination.path` according to Main Agent rules.
4. Main Agent emits one `main-agent-save-file` JSON request.
5. detaches_agent UI shows a Save request card with source, destination, method, and reason.
6. User approves or rejects.
7. Broker validates the staged file and starts transfer.
8. If SSH asks for a password, UI shows a one-time password prompt.
9. UI shows progress and final success or failure.
10. Broker forwards `[detaches_agent 工具结果]` JSON to Main Agent.

## Interface

The request schema remains stable:

```json
{
  "fileId": "...",
  "sourceLocalPath": "...",
  "displayName": "...",
  "size": 12345,
  "destination": {
    "user": "aispeech",
    "path": "/absolute/path/to/final-filename.ext"
  },
  "methodPreference": "rsync",
  "reason": "why this file should be saved to this Main Agent path"
}
```

The result is authoritative for transfer status:

```json
{
  "requestId": "...",
  "executionId": "...",
  "kind": "main-agent-save-file",
  "target": "main-agent-machine",
  "status": "succeeded",
  "completed": true,
  "transferStatus": "succeeded",
  "sourceLocalPath": "...",
  "destination": {
    "host": "...",
    "port": 22,
    "user": "...",
    "path": "/absolute/path/to/final-filename.ext"
  },
  "method": "rsync",
  "error": null,
  "outputTail": ""
}
```

## Technical Design

### Prompt and Skill Layer

Prompt text must constrain Main Agent to only choose the destination user/path and emit the JSON request. It must explicitly forbid generating commands, asking the user to run commands in terminal, creating alternate transfer routes, or retrying outside the broker after a failed tool result.

### Broker Layer

`ToolBrokerService` owns approval, request status, deduplication, destination normalization, and result forwarding. For `main-agent-save-file`, approval starts `mainAgentFileTransferService` directly and returns `wroteToTerminal: false`. The terminal command path is not used for this request kind.

Main Agent must choose `destination.user` and `destination.path`. `destination.host` and `destination.port` are optional hints; if omitted, invalid, or placeholder-like, detaches_agent fills them from its current Main Agent SSH/Gateway settings. `destination.user` is never filled from the detaches_agent profile.

### Transfer Service Layer

`mainAgentFileTransferService` owns transfer execution:

- Validate `fileId` and `sourceLocalPath` against the staged file registry.
- Validate `destination.path` is an absolute file path, not a directory.
- Resolve `user` from the request, and resolve `host`/`port` from the request or detaches_agent runtime config.
- Resolve local `rsync`, `scp`, and `ssh` executables.
- Generate `commandPreview` before running each transfer command.
- Run one transfer action using argv-style process spawning.
- Prefer `rsync`; fallback to `scp` when rsync is unavailable or incompatible.
- Detect password prompts and pause with `waiting-password`.
- Fail password waits after 3 minutes and clean up pending resolvers and temporary askpass files.
- Use askpass only for the current transfer and delete temporary secrets in `finally`.
- Determine success from the transfer process exit code.
- Return bounded, ANSI-stripped output tail for diagnosis.

The service must not run remote `mkdir -p` or remote `test -f`. If the target parent directory is missing or unwritable, transfer fails with a clear error. Main Agent is responsible for preparing or choosing an existing destination directory.

### UI Layer

The Save request card presents:

- Source file name, size, and staged source.
- Destination `user@host:port/path`.
- Transfer method.
- Main Agent reason.
- Current status, progress, speed, message, and error.

If password is required, UI displays a dedicated password dialog with connection details, file paths, command preview, and a 3-minute countdown. The password is used once and is not saved. The terminal is not automatically opened for save-file requests.

## Reliability and Security

- Do not inject multi-line scripts into zsh.
- Do not parse terminal markers to decide completion.
- Do not persist SSH passwords.
- Do not copy files outside the staged registry.
- Bound and sanitize output tails.
- Use request fingerprinting to avoid duplicate approval cards.
- Forward one structured result to Main Agent.
- If failed, instruct Main Agent to report the broker error and not invent alternative transfer methods.

## Acceptance Tests

- Save succeeds with key-based SSH auth.
- Save succeeds with password SSH auth after UI password entry.
- Path with spaces transfers correctly.
- Path with Chinese characters transfers correctly.
- Missing target parent directory fails without auto-creating it.
- Unresolvable host fails with a clear error.
- Missing local `rsync` falls back to `scp`.
- `main-agent-save-file` approval does not write a command into terminal.
- Failed tool result does not cause the agent to start HTTP upload or ask for manual scp.
