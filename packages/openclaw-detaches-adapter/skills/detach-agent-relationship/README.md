# Detach Agent Relationship

Host-side skill for recognizing Detach Agent conversations without changing ordinary Main Agent behavior.

## Runtime Boundary

- `SKILL.md` contains the runtime rules.
- This skill is active only for Detach Agent conversations or messages marked with `[[DETACH_AGENT]]`.
- It does not contain install prompts, window bootstrap prompts, provider registries, or product roadmap text.

## Packaging

The complete skill package must contain:

```text
detach-agent-relationship/
  SKILL.md
  VERSION
  README.md
  CHANGELOG.md
```

Update `VERSION` whenever `SKILL.md` behavior changes.
