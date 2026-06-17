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
