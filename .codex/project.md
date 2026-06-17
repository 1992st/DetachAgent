# Detach Agent Project Notes

## Project Path

This is the main Detach Agent code repository:

```text
/Users/zhangshutong/code/detaches_agent
```

Use this repository for code changes, tests, builds, commits, and runtime work.

The old documentation/package workspace has been moved beside this repository as
a local reference backup only:

```text
/Users/zhangshutong/code/detaches_agent_local_docs
```

Do not treat `detaches_agent_local_docs` as the active code project and do not
commit it into this repository.

## Architecture Maintenance Rule

Code architecture must keep Detach Agent, Host/Main Agent, and remote PC control
boundaries explicit:

- Detach Agent is the local web UI, approval broker, and proxy layer.
- The Main Agent can request approved actions through Detach Agent to control a
  local or remote PC.
- `detach-agent-relationship` is installed on the Host/Main Agent side.
- Detach Agent sends one bootstrap prompt when a detached window is created, then
  uses a short marker for later messages.
- Detach Agent runtime/tooling and Host/Main Agent runtime/tooling must remain
  conceptually separate.
- Skill installation and remote terminal/tool execution are separate flows with
  separate UI states and approval semantics.

## Important Paths

- Main app source: `apps/`
- Shared types: `packages/shared/`
- OpenClaw adapter package: `packages/openclaw-detaches-adapter/`
- Relationship Skill source:
  `packages/openclaw-detaches-adapter/skills/detach-agent-relationship/`
- App-distributed Relationship Skill zip:
  `apps/web/public/skills/detach-agent-relationship.skill.zip`
- User-facing Relationship Skill install guide:
  `docs/relationship-skill/install.md`
- Browser-accessible install guide:
  `apps/web/public/docs/relationship-skill/install.md`
- Product/technical requirements: `doc/prd/` and `doc/trd/`
- Architecture and integration docs: `docs/`
- Tests and scenario checks: `testcase/`

## Documentation Rules

Documentation must be written from the actual product problem, not from generic
principles.

- Start with the user problem and current UI/product failure.
- Keep language short and concrete.
- Every requirement must include a reason, target user behavior, and acceptance
  check.
- UI requirements must include a layout description precise enough to implement.
- Separate product flow, information architecture, visual layout, interaction
  states, and acceptance criteria.
- If a section does not change implementation decisions or review criteria,
  remove it.
- When skill packaging, install scope, upgrade rules, or install UX changes,
  update `docs/relationship-skill/install.md` and the browser-accessible copy.

## Validation Commands

Run relevant checks from the repository root:

```bash
pnpm typecheck
pnpm build
pnpm --filter @detaches/openclaw-detaches-adapter test
pnpm smoke
```

For Relationship Skill package changes, also verify that the source files match
the distributable zip:

```bash
unzip -l apps/web/public/skills/detach-agent-relationship.skill.zip
```
