import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const rootPackage = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
const waitForServer = fs.readFileSync(path.join(repoRoot, "scripts/wait-for-server.mjs"), "utf8");
const settingsPanel = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/settings/SettingsPanel.tsx"), "utf8");
const chatPanel = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/chat/ChatPanel.tsx"), "utf8");
const connectionBar = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/connection/ConnectionBar.tsx"), "utf8");
const app = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/App.tsx"), "utf8");
const skillInstallPanel = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/skills/SkillInstallPanel.tsx"), "utf8");
const css = fs.readFileSync(path.join(repoRoot, "apps/web/src/styles/global.css"), "utf8");
const preview = fs.readFileSync(path.join(repoRoot, "docs/main-agent-advanced-settings-preview.html"), "utf8");

assert.match(settingsPanel, /高级配置/, "settings page should expose an advanced configuration entry");
assert.match(rootPackage, /wait-for-server\.mjs && pnpm --filter @detaches\/web dev/, "dev script should wait for the API server before starting Vite");
assert.match(waitForServer, /\/api\/health/, "wait-for-server should poll the local API health endpoint");
assert.match(settingsPanel, /Main Agent 服务信息/, "advanced settings should include Main Agent service information");
assert.match(settingsPanel, /Main Agent 回连本机/, "settings should include gateway-terminal callback settings");
assert.match(settingsPanel, /选择本机回连 IP/, "settings should expose callback IP selection");
assert.match(settingsPanel, /测试 gateway-terminal/, "settings should expose gateway-terminal test action");
assert.match(settingsPanel, /保存配置并重启 Detach Agent 后生效/, "settings should warn when selected callback IP needs a server restart");
assert.match(settingsPanel, /启用 ssh-terminal \/ reverse bridge/, "advanced settings should include the ssh-terminal bridge checkbox");
assert.match(settingsPanel, /localSshBridgeEnabled:\s*false/, "quick direct setup should disable local SSH bridge");

assert.match(chatPanel, /bootstrap-relationship-skill-check/, "ChatPanel should send the relationship skill bootstrap check");
assert.match(chatPanel, /sendRelationshipSkillCheck/, "ChatPanel should centralize relationship skill check sending");
assert.match(chatPanel, /relationshipSkillCheckNonce/, "ChatPanel should allow New session to explicitly trigger skill checking");
assert.match(chatPanel, /Date\.now\(\)\.toString\(36\)/, "relationship skill checks should use unique idempotency keys");
assert.match(chatPanel, /isRelationshipSkillCheckMessage/, "ChatPanel should hide bootstrap skill check messages from visible chat");
assert.match(connectionBar, /relationship-skill-alert/, "ConnectionBar should render the relationship skill alert");
assert.match(connectionBar, /Relationship skill 未安装/, "ConnectionBar should show missing skill copy");
assert.match(connectionBar, /Relationship skill 需更新/, "ConnectionBar should show outdated skill copy");
assert.match(connectionBar, /更新 relationship skill/, "ConnectionBar should expose an update action for outdated skill");
assert.match(app, /relationshipSkillStatus/, "App should own relationship skill status state");
assert.match(app, /relationshipSkillInstalledVersion/, "App should keep the installed relationship skill version");
assert.match(app, /relationshipSkillRequiredVersion/, "App should keep the required relationship skill version");
assert.match(app, /relationshipSkillCheckNonce/, "New session should explicitly trigger the relationship skill check");
assert.match(app, /relationshipSkillPromptOpen/, "skill action should open the copyable prompt dialog");
assert.match(app, /RelationshipSkillPromptDialog/, "App should render a relationship skill prompt dialog");
assert.match(app, /navigator\.clipboard\.writeText\(relationshipSkillInstallPrompt\)/, "prompt dialog should copy the install/update prompt");
assert.match(skillInstallPanel, /DETACH_AGENT_RELATIONSHIP_SKILL_VERSION/, "Skill install panel should use the shared required skill version");
assert.match(skillInstallPanel, /export const relationshipSkillInstallPrompt/, "Skill install panel should export the shared install/update prompt");
assert.match(skillInstallPanel, /安装或更新 OpenClaw relationship skill 到当前要求版本/, "Skill install panel should give Main Agent an update prompt");
assert.match(skillInstallPanel, /detaches-agent-adapter\.mjs/, "Skill install prompt should also install the adapter CLI helper");

assert.match(css, /@keyframes skill-alert-pulse/, "CSS should include the orange breathing alert animation");
assert.match(css, /relationship-skill-prompt-dialog/, "CSS should style the relationship skill prompt dialog");
assert.match(preview, /Main Agent 高级配置预览/, "static HTML preview should exist");
assert.match(preview, /Relationship skill 未安装/, "static HTML preview should show the missing skill reminder");

console.log("relationshipSkillUi: ok");
