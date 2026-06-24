import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const settingsPanel = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/settings/SettingsPanel.tsx"), "utf8");
const chatPanel = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/chat/ChatPanel.tsx"), "utf8");
const connectionBar = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/connection/ConnectionBar.tsx"), "utf8");
const app = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/App.tsx"), "utf8");
const css = fs.readFileSync(path.join(repoRoot, "apps/web/src/styles/global.css"), "utf8");
const preview = fs.readFileSync(path.join(repoRoot, "docs/main-agent-advanced-settings-preview.html"), "utf8");

assert.match(settingsPanel, /高级配置/, "settings page should expose an advanced configuration entry");
assert.match(settingsPanel, /Main Agent 服务信息/, "advanced settings should include Main Agent service information");
assert.match(settingsPanel, /连接本机 SSH \/ reverse bridge/, "advanced settings should include the local SSH bridge checkbox");
assert.match(settingsPanel, /localSshBridgeEnabled:\s*false/, "quick direct setup should disable local SSH bridge");

assert.match(chatPanel, /bootstrap-relationship-skill-check/, "ChatPanel should send the relationship skill bootstrap check");
assert.match(chatPanel, /isRelationshipSkillCheckMessage/, "ChatPanel should hide bootstrap skill check messages from visible chat");
assert.match(connectionBar, /relationship-skill-alert/, "ConnectionBar should render the relationship skill alert");
assert.match(connectionBar, /Relationship skill 未安装/, "ConnectionBar should show missing skill copy");
assert.match(app, /relationshipSkillStatus/, "App should own relationship skill status state");
assert.match(app, /relationship-skill-install/, "missing skill action should target the install panel");

assert.match(css, /@keyframes skill-alert-pulse/, "CSS should include the orange breathing alert animation");
assert.match(preview, /Main Agent 高级配置预览/, "static HTML preview should exist");
assert.match(preview, /Relationship skill 未安装/, "static HTML preview should show the missing skill reminder");

console.log("relationshipSkillUi: ok");
