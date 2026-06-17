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
- If the file should be saved on the Host/Main Agent machine, Host/Main Agent decides the destination path according to Host/Main Agent workspace/artifact rules.
- Request the transfer with one `main-agent-save-file` block or broker event.
- Do not request MD5; success is determined by detaches_agent's approved transfer runner exit status.
- detaches_agent will run local `rsync` or `scp` after user approval. If Host/Main Agent SSH/SFTP is not reachable, report that the transfer is unavailable; do not instruct the user to enable SSH only for this feature.
- Do not start an HTTP upload server, invent a curl upload method, or replace the protocol with `method=http-upload`. The only supported transfer methods for this request are `rsync` and `scp`.

Example:

```main-agent-save-file
{"fileId":"<file-id>","sourceLocalPath":"<absolute path from prompt>","displayName":"<name>","size":12345,"destination":{"host":"<main-agent-host>","port":22,"user":"<ssh-user>","path":"<absolute path chosen by Host/Main Agent>"},"methodPreference":"rsync","reason":"save staged file into Host/Main Agent workspace"}
```
