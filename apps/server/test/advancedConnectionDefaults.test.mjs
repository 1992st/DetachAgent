import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const appConfigSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/config/appConfig.ts"), "utf8");
const settingsStoreSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/config/settingsStore.ts"), "utf8");
const apiRoutesSource = fs.readFileSync(path.join(repoRoot, "apps/server/src/routes/apiRoutes.ts"), "utf8");

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

console.log("advancedConnectionDefaults: ok");
