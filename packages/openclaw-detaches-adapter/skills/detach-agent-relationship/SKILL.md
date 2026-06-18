---
name: detach-agent-relationship
description: Use on the Host/Main Agent when a message is marked as coming from a Detach Agent and environment or role boundaries affect execution.
---

# Detach Agent Relationship

## Purpose

Use this skill only on the Host/Main Agent. It adds Detach Agent support without changing ordinary Main Agent conversations.

## When Active

Apply these rules only when a conversation was bootstrapped as a Detach Agent conversation, or when a message carries the `[[DETACH_AGENT]]` marker.

## Boundary Rules

- Detach Agent and Host/Main Agent are separate actors.
- They have separate machines, workspaces, tools, terminals, files, ports, browser state, running services, and memory.
- In Detach Agent context, ambiguous local references usually mean the Detach Agent environment.
- Host-side references mean the Host/Main Agent environment.
- Do not imply direct access across environments.
- Cross-environment work requires explicit handoff, pasted output, copied files, or user confirmation.
- If the target environment is unclear, ask before acting.

## Staged Files From Detach Agent

When a message contains `[[DETACH_AGENT_FILE_STAGED]]`, the listed file exists only on the Detach Agent user's machine.

- `sourceLocalPath` is an absolute path on the detaches_agent machine, not on the Host/Main Agent machine.
- Host/Main Agent must not claim it can read `sourceLocalPath` directly.
- If the file should be saved on the Host/Main Agent machine, Host/Main Agent decides the destination SSH/Linux user and path according to Host/Main Agent workspace/artifact rules.
- `destination.user` and `destination.path` are the core fields the Host/Main Agent must decide. `destination.host` and `destination.port` may be omitted; detaches_agent broker fills them from its current Main Agent SSH/Gateway settings.
- Do not put placeholders, examples, or "replace me" text into `destination.user`, `destination.host`, or `destination.port`. If `destination.user` is unknown, do not emit a save request.
- `destination.path` must be a complete absolute target file path, including the directory, final filename, and extension.
- `destination.path` must not be a directory path. Do not end at paths such as `screenshots/`, `docs/`, `_staging/`, or any folder-only location.
- If the correct archive category is unclear, ask the user for the file's purpose, or choose a clearly allowed generic file path such as a screenshots/attachments file path with a concrete sanitized filename. Do not invent a supplier/product/category staging folder without evidence.
- Request the transfer with one `main-agent-save-file` block or broker event.
- Do not generate `ssh`, `rsync`, `scp`, `curl`, HTTP upload, or terminal commands. Host/Main Agent only chooses the destination and emits the request.
- Do not ask detaches_agent to create remote directories, verify remote files, or manage the Host/Main Agent filesystem. Prepare the destination on the Host/Main Agent side or choose an existing destination path.
- Do not request MD5; success is determined by detaches_agent's approved structured transfer runner exit status.
- detaches_agent will run one local `rsync` or `scp` transfer after user approval. If SSH needs a password, detaches_agent UI will ask for it once and will not save it.
- Do not start an HTTP upload server, invent a curl upload method, or replace the protocol with `method=http-upload`. The only supported transfer methods for this request are `rsync` and `scp`.
- If a `[detaches_agent 工具结果]` message reports failure, report that result to the user and ask whether to retry after fixing the reported broker/SSH/path issue. Do not attempt alternative transfer methods outside the detaches_agent tool flow.

Example:

```main-agent-save-file
{"fileId":"<file-id>","sourceLocalPath":"<absolute path from prompt>","displayName":"<name>","size":12345,"destination":{"user":"aispeech","path":"/absolute/path/to/final-filename.ext"},"methodPreference":"rsync","reason":"save staged file into this concrete Host/Main Agent file path according to workspace rules"}
```
