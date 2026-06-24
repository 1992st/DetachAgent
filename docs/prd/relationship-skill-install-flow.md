# Relationship Skill Install Flow

## Goal

Keep the main chat page focused while still making `detach-agent-relationship` easy to discover, install, and verify when the Main Agent is missing it.

## Product Behavior

- The main page does not show the full install guide. It only shows a compact top-bar alert when the skill is checking, missing, or failed.
- The missing state uses an orange pulsing alert with the action label `安装 relationship skill`.
- The outdated state also uses the orange pulsing alert with the action label `更新 relationship skill`.
- Clicking the alert opens `连接设置` and scrolls to `Detach relationship skill 安装/更新` under the network test area.
- The settings section exposes install and verify actions, each with a Main Agent command and a prompt users can send to Main Agent.
- The skill guide must make clear that installation happens on the Main Agent machine, not merely on the Detach Agent UI machine.

## Session Detection Protocol

- On every new chat socket/session, the UI starts in `checking` and the server sends a short bootstrap prompt to Main Agent.
- The prompt asks for fixed response lines including version:
  - `DETACH_AGENT_SKILL_STATUS: ready`
  - `DETACH_AGENT_SKILL_VERSION: 1.1.0`
  - `DETACH_AGENT_SKILL_STATUS: missing`
  - `DETACH_AGENT_SKILL_VERSION: none`
  - `DETACH_AGENT_SKILL_STATUS: outdated`
  - `DETACH_AGENT_SKILL_VERSION: <installed-version>`
- The local server parses the Gateway response and emits `relationship-skill-status`.
- `ready` hides the alert. `missing` shows the orange install alert. `outdated` shows the orange update alert. `error` shows a red compact failure state.
- If Main Agent reports `ready` but omits the version, or reports a version lower than the current required skill version, the local server treats it as `outdated`.
- New session creation resets the status to `checking` so the first round can revalidate the current Main Agent environment.

## Requirements

- Keep install content in connection settings, below network testing.
- Do not reintroduce the previous right-column `Detach Skill` panel.
- Use `安装 relationship skill` as the main-page action copy.
- Use `更新 relationship skill` when the installed Main Agent skill version is below the required version.
- Preserve the existing manual install and verify command flow.
- Each relationship skill release must update `DETACH_AGENT_RELATIONSHIP_SKILL_VERSION` in shared code so server detection, install prompts, package install commands, and web copy stay in sync.
