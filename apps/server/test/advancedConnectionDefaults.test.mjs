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
const packagedSkillZip = fs.readFileSync(path.join(repoRoot, "apps/web/public/skills/detach-agent-relationship.skill.zip"));
const agentTerminalServiceSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/agentTerminal/agentTerminalService.ts"), "utf8");
const terminalLeaseServiceSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/agentTerminal/terminalLeaseService.ts"), "utf8");
const terminalRunStoreSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/agentTerminal/terminalRunStore.ts"), "utf8");
const terminalStreamHubSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/agentTerminal/terminalStreamHub.ts"), "utf8");
const commandGuardServiceSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/tools/commandGuardService.ts"), "utf8");
const toolBrokerServiceSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/tools/toolBrokerService.ts"), "utf8");
const terminalServiceSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/terminal/terminalService.ts"), "utf8");
const adminTerminalServiceSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/terminal/adminTerminalService.ts"), "utf8");
const adminTerminalHelperSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/terminal/adminTerminalHelper.ts"), "utf8");
const terminalSocketSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/ws/terminalSocket.ts"), "utf8");
const terminalTypesSource = fs.readFileSync(path.join(repoRoot, "packages/shared/src/terminalTypes.ts"), "utf8");
const detachesContextTypesSource = fs.readFileSync(path.join(repoRoot, "packages/shared/src/detachesContextTypes.ts"), "utf8");
const terminalPanelSource = fs.readFileSync(path.join(repoRoot, "apps/web/src/features/terminal/TerminalPanel.tsx"), "utf8");
const webApiSource = fs.readFileSync(path.join(repoRoot, "apps/web/src/lib/api.ts"), "utf8");
const desktopMainSource = fs.readFileSync(path.join(repoRoot, "apps/desktop/src/main.ts"), "utf8");
const desktopDevScriptSource = fs.readFileSync(path.join(repoRoot, "apps/desktop/scripts/dev.mjs"), "utf8");
const windowsDevScriptSource = fs.readFileSync(path.join(repoRoot, "scripts/dev-windows.mjs"), "utf8");

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
  /terminal-run --host/,
  "readable terminal routing prompt should make terminal-run the primary gateway-terminal path"
);

assert.match(
  clientContextSource,
  /Do not ask for broker tokens or endpoint names for terminal commands/,
  "readable prompt should hide broker token and endpoint details from the primary terminal path"
);

assert.doesNotMatch(
  clientContextSource,
  /Authorization: Bearer broker\.submitToken/,
  "readable prompt should not teach Main Agent to construct raw terminal broker requests"
);

assert.doesNotMatch(
  clientContextSource,
  /gatewayTerminal\.toolEventEndpoint\/localControl\.toolEventEndpoint/,
  "fallback prompt should not expose raw terminal endpoint internals"
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
  /terminal-run --host/,
  "relationship skill should use terminal-run --host as the primary local terminal path"
);

assert.doesNotMatch(
  relationshipSkillSource,
  /POST <toolEventEndpoint>/,
  "relationship skill should not put raw broker HTTP in the primary terminal guidance"
);

assert.match(
  apiRoutesSource,
  /DETACHES_WRONG_ENDPOINT_FOR_TERMINAL/,
  "interaction endpoint should reject terminal-shaped payloads"
);

assert.match(
  apiRoutesSource,
  /\/agent-terminal\/runs/,
  "server should expose Agent Terminal Runtime run endpoints"
);

assert.match(
  apiRoutesSource,
  /\/agent-terminal\/sessions\/:terminalSessionId\/authorize/,
  "server should expose local UI authorization for pending Agent Terminal sessions"
);

assert.match(
  apiRoutesSource,
  /listener_ready/,
  "Agent Terminal health should expose listener_ready status"
);

assert.match(
  apiRoutesSource,
  /agent_terminal_api_ready/,
  "Agent Terminal health should expose agent_terminal_api_ready status"
);

assert.match(
  apiRoutesSource,
  /awaiting_agent_bootstrap/,
  "Agent Terminal health should expose awaiting_agent_bootstrap status"
);

assert.match(
  terminalLeaseServiceSource,
  /leaseToken:\s*nanoid\(48\)/,
  "Agent Terminal bootstrap should issue an opaque lease token"
);

assert.match(
  terminalLeaseServiceSource,
  /pending_authorization/,
  "Agent Terminal first bootstrap should create a pending authorization session"
);

assert.match(
  terminalLeaseServiceSource,
  /terminalId:\s*sessionKey/,
  "Agent Terminal sessions should bind a terminalId for the reused local terminal"
);

assert.match(
  terminalLeaseServiceSource,
  /DETACHES_TERMINAL_BOOTSTRAP_REQUIRED/,
  "Agent Terminal should report bootstrap-required until the local UI authorizes the session"
);

assert.match(
  terminalLeaseServiceSource,
  /assertAllowedRemote/,
  "Agent Terminal bootstrap should check the configured Main Agent allowlist before creating sessions"
);

assert.match(
  terminalLeaseServiceSource,
  /config\.remoteHost/,
  "Agent Terminal allowlist should include the configured Main Agent remote host"
);

assert.match(
  terminalLeaseServiceSource,
  /config\.gatewayDirectHost/,
  "Agent Terminal allowlist should include the configured direct Gateway host"
);

assert.match(
  agentTerminalServiceSource,
  /terminalLeaseService\.bootstrap/,
  "Agent Terminal service should delegate lease/session bootstrap to terminalLeaseService"
);

assert.match(
  agentTerminalServiceSource,
  /terminalRunStore\.create/,
  "Agent Terminal service should persist runs through terminalRunStore"
);

assert.match(
  agentTerminalServiceSource,
  /terminalStreamHub\.subscribe/,
  "Agent Terminal service should stream through terminalStreamHub"
);

assert.match(
  agentTerminalServiceSource,
  /toolBrokerService\.reject/,
  "Agent Terminal pending cancel should reject the pending Tool Queue request"
);

assert.match(
  agentTerminalServiceSource,
  /terminalService\.interrupt/,
  "Agent Terminal running cancel or timeout should interrupt the local terminal"
);

assert.match(
  agentTerminalServiceSource,
  /activeRunLocks/,
  "Agent Terminal should hold an active-run lock per terminal session"
);

assert.match(
  agentTerminalServiceSource,
  /syncActiveRunsForSession/,
  "Agent Terminal should sync stale run state before accepting another command for the same session"
);

assert.match(
  agentTerminalServiceSource,
  /toolBrokerService\.failRequest/,
  "Agent Terminal timeout and cancel should mark the Tool Queue request failed"
);

assert.match(
  agentTerminalServiceSource,
  /terminalService\.reset/,
  "Agent Terminal timeout and cancel should recreate the user terminal when a command was already written"
);

assert.match(
  terminalRunStoreSource,
  /class TerminalRunStore/,
  "Agent Terminal should have a dedicated TerminalRunStore"
);

assert.match(
  terminalRunStoreSource,
  /eventTypeForStatus\(run\.status\)/,
  "Agent Terminal run creation should emit the real created status"
);

assert.match(
  terminalStreamHubSource,
  /class TerminalStreamHub/,
  "Agent Terminal should have a dedicated TerminalStreamHub"
);

assert.match(
  agentTerminalServiceSource,
  /toolBrokerService\.create/,
  "Agent Terminal runs should still enter the Tool Queue through Tool Broker"
);

assert.match(
  commandGuardServiceSource,
  /decision:\s*"block"/,
  "Command Guard should have a block decision"
);

assert.match(
  commandGuardServiceSource,
  /decision:\s*"require-confirmation"/,
  "Command Guard should require confirmation for elevated commands"
);

assert.match(
  terminalTypesSource,
  /export type TerminalPrivilege = "user" \| "administrator"/,
  "terminal info should distinguish user and administrator privilege"
);

assert.match(
  adminTerminalServiceSource,
  /\(this\.options\.platform \|\| platformService\.currentNodePlatform\(\)\) === "win32"/,
  "administrator terminal service should be Windows-only"
);

assert.match(
  adminTerminalServiceSource,
  /\$psi\.Verb = 'runas'/,
  "administrator terminal should launch through UAC with ShellExecute runas"
);

assert.match(
  adminTerminalServiceSource,
  /-EncodedCommand/,
  "administrator terminal UAC launcher should use an encoded elevated PowerShell script"
);

assert.match(
  adminTerminalServiceSource,
  /crypto\.randomBytes\(32\)\.toString\("base64url"\)/,
  "administrator helper handshake should use an opaque one-time token"
);

assert.match(
  adminTerminalServiceSource,
  /GLOBAL_ADMIN_SESSION_KEY = "local-admin-terminal"/,
  "administrator terminal should be one local-global helper, not one helper per chat session"
);

assert.match(
  apiRoutesSource,
  /\/terminal\/admin\/:sessionKey\/debug-launch/,
  "administrator terminal diagnostics should expose a local debug-launch endpoint"
);

assert.match(
  apiRoutesSource,
  /Administrator terminal diagnostics are only available from the local Detach Agent UI/,
  "administrator terminal diagnostics should remain loopback-only"
);

assert.match(
  adminTerminalHelperSource,
  /process\.platform !== "win32"/,
  "administrator helper should refuse non-Windows platforms"
);

assert.match(
  adminTerminalHelperSource,
  /spawn\(powerShellExe\(\)/,
  "administrator helper should own the elevated PowerShell PTY"
);

assert.match(
  terminalSocketSource,
  /privilege"\) === "administrator"/,
  "terminal websocket should route by privilege query parameter"
);

assert.match(
  terminalSocketSource,
  /adminTerminalService\.attachHelper\(socket, token, sessionKey\)/,
  "terminal websocket should accept elevated helper callbacks through token attach"
);

assert.match(
  terminalSocketSource,
  /管理员 terminal 是 UAC helper 维护的独立 session，不是把普通 terminal 原地升级/,
  "terminal websocket should document the admin/user routing boundary"
);

assert.match(
  toolBrokerServiceSource,
  /adminTerminalService\.isActive\(request\.sessionKey\)/,
  "Tool Broker should select the administrator backend only when the local UI enabled it"
);

assert.match(
  toolBrokerServiceSource,
  /async failRequest\(requestId: string, error: string\)/,
  "Tool Broker should expose an explicit failure path for timed-out gateway terminal requests"
);

assert.match(
  toolBrokerServiceSource,
  /Command Guard 和 Tool Queue 审批/,
  "Tool Broker should document that administrator terminal does not bypass approval"
);

assert.match(
  detachesContextTypesSource,
  /adminTerminal\?:/,
  "structured detaches context should expose administrator terminal state"
);

assert.match(
  clientContextSource,
  /Main Agent cannot enable it directly/,
  "readable context should tell Main Agent administrator terminal is controlled by local UI"
);

assert.match(
  terminalPanelSource,
  /ShieldCheck/,
  "terminal UI should show a distinct administrator shield icon"
);

assert.match(
  terminalPanelSource,
  /privilege/,
  "terminal UI websocket should request user or administrator privilege explicitly"
);

assert.match(
  terminalPanelSource,
  /灰色表示普通权限；蓝色表示管理员 helper 已连接/,
  "terminal UI should document gray versus blue administrator button state"
);

assert.match(
  terminalServiceSource,
  /reset\(sessionKey: string, reason: string\)/,
  "terminal service should be able to dispose a stuck PTY so the next command gets a new one"
);

assert.match(
  webApiSource,
  /LOCAL_SERVER_DISCONNECTED_MESSAGE = "local server disconnected"/,
  "web API should normalize Vite proxy/local server failures into a user-visible message"
);

assert.match(
  desktopMainSource,
  /startServerMonitor/,
  "desktop dev mode should monitor and restart the local server when a reused server disappears"
);

assert.match(
  desktopDevScriptSource,
  /chcp 65001 > nul/,
  "desktop dev script should switch Windows consoles to UTF-8 before logging"
);

assert.match(
  windowsDevScriptSource,
  /chcp 65001 > nul/,
  "Windows dev helper should switch consoles to UTF-8 before logging"
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

assert.match(
  packagedSkillZip.toString("latin1"),
  new RegExp(relationshipSkillVersion.replaceAll(".", "\\.")),
  "packaged relationship skill zip should contain the current skill version"
);

console.log("advancedConnectionDefaults: ok");
