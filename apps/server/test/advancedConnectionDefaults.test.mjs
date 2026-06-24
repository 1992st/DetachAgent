import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const appConfigSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/config/appConfig.ts"), "utf8");
const serverIndexSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/index.ts"), "utf8");
const settingsStoreSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/config/settingsStore.ts"), "utf8");
const apiRoutesSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/routes/apiRoutes.ts"), "utf8");
const clientContextSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/clientContextService.ts"), "utf8");
const sshTunnelSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/tunnel/sshTunnelService.ts"), "utf8");
const chatSocketSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/ws/chatSocket.ts"), "utf8");
const relationshipSkillSource = fs.readFileSync(path.join(repoRoot, "packages/openclaw-detaches-adapter/skills/detach-agent-relationship/SKILL.md"), "utf8");
const relationshipSkillTypesSource = fs.readFileSync(path.join(repoRoot, "packages/shared/src/relationshipSkillTypes.ts"), "utf8");
const relationshipSkillVersion = fs.readFileSync(path.join(repoRoot, "packages/openclaw-detaches-adapter/skills/detach-agent-relationship/VERSION"), "utf8").trim();

assert.match(
  appConfigSource,
  /mainAgentServiceEnabled:\s*boolEnv\("DETACHES_MAIN_AGENT_SERVICE_ENABLED",\s*false\)/,
  "Main Agent service config should default off"
);

assert.match(
  appConfigSource,
  /localSshBridgeEnabled:\s*boolEnv\("DETACHES_LOCAL_SSH_BRIDGE_ENABLED",\s*false\)/,
  "local SSH bridge config should default off"
);

assert.match(
  appConfigSource,
  /serverHost:\s*stringEnv\("DETACHES_SERVER_HOST",\s*"127\.0\.0\.1"\)/,
  "server should stay loopback-only until the user selects a callback IP or env override"
);

assert.match(
  serverIndexSource,
  /uniqueListenHosts\(\[primaryHost, callbackHost\]\)/,
  "server startup should add the selected gateway-terminal local IP as an extra listener"
);

assert.match(
  serverIndexSource,
  /const primaryHost = process\.env\.DETACHES_SERVER_HOST\?\.trim\(\) \|\| appConfig\.serverHost/,
  "server startup should keep loopback/env primary host for local UI compatibility"
);

assert.match(
  serverIndexSource,
  /function markListening\(host: string\)/,
  "server health should report only hosts that successfully started listening"
);

assert.match(
  settingsStoreSource,
  /mainAgentServiceEnabled:\s*appConfig\.mainAgentServiceEnabled/,
  "settings default profile should carry mainAgentServiceEnabled"
);

assert.match(
  settingsStoreSource,
  /localSshBridgeEnabled:\s*appConfig\.localSshBridgeEnabled/,
  "settings default profile should carry localSshBridgeEnabled"
);

assert.match(
  apiRoutesSource,
  /const shouldUseReverseBridge = sshTunnelEnabled \|\| config\.localSshBridgeEnabled;/,
  "network test should gate reverse bridge on ssh transport or explicit local bridge"
);

assert.match(
  apiRoutesSource,
  /config\.localSshBridgeEnabled\s*\?\s*await sshTunnelService\.ensureReverseBridge\(\)\s*:\s*await sshTunnelService\.status\(\)/s,
  "health check should not ensure reverse bridge when localSshBridgeEnabled is false"
);

assert.match(
  apiRoutesSource,
  /id:\s*"ssh-disabled"[\s\S]*默认直连 Gateway 模式未启用 SSH/,
  "network test should report SSH disabled instead of probing by default"
);

assert.match(
  clientContextSource,
  /gatewayConfigured && config\.gatewayTerminalLastStatus === "ok"/,
  "gateway-terminal should be preferred only after a successful callback test"
);

assert.match(
  clientContextSource,
  /const preferred: TerminalChannelName = gatewayReady \? "gateway-terminal" : sshReady \? "ssh-terminal" : "chat-terminal"/,
  "terminal channel priority should be gateway, then ssh, then chat fallback"
);

assert.match(
  clientContextSource,
  /Do not use interactionEventEndpoint for terminal commands/,
  "readable terminal routing prompt should not direct terminal commands to the interaction endpoint"
);

assert.match(
  clientContextSource,
  /fetch contextExport\.consumeUrl to obtain the machine-readable context with broker\.submitToken/,
  "readable prompt should explain where Main Agent obtains the broker submit token"
);

assert.match(
  apiRoutesSource,
  /buildContextExportBody\(record\.sessionKey, record\.sessionMode, true, record\.attachments\)/,
  "one-time context export consumption should include broker.submitToken for gateway-terminal"
);

assert.match(
  relationshipSkillSource,
  /Do not send terminal commands to `interactionEventEndpoint`/,
  "relationship skill should keep terminal and interaction endpoints separate"
);

assert.match(
  relationshipSkillSource,
  /POST <toolEventEndpoint>/,
  "relationship skill should include a raw HTTP terminal example for missing adapter installs"
);

assert.match(
  sshTunnelSource,
  /const passwordFallbackAllowed = options\.includeLocalForward;/,
  "ssh-terminal reverse bridge should not request SSH passwords"
);

assert.match(
  sshTunnelSource,
  /passwordFallbackAllowed && \(cachedPassword \|\| isPasswordAuthFailure\(firstAttempt\.stderr\)\)/,
  "password fallback should remain limited to the legacy local-forward SSH tunnel path"
);

assert.match(
  chatSocketSource,
  /DETACH_AGENT_RELATIONSHIP_SKILL_VERSION/,
  "relationship skill check should use the shared required skill version"
);

assert.match(
  chatSocketSource,
  /DETACH_AGENT_SKILL_STATUS: outdated/,
  "relationship skill check should surface outdated installations as install-needed"
);

assert.match(
  chatSocketSource,
  /DETACH_AGENT_SKILL_VERSION/,
  "relationship skill check should require Main Agent to return the installed version"
);

assert.match(
  relationshipSkillTypesSource,
  new RegExp(`DETACH_AGENT_RELATIONSHIP_SKILL_VERSION\\s*=\\s*"${relationshipSkillVersion.replaceAll(".", "\\.")}"`),
  "shared relationship skill version should match the packaged skill VERSION file"
);

console.log("advancedConnectionDefaults: ok");
