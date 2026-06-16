import assert from "node:assert/strict";
import { analyzeAgentConfig } from "../packages/shared/dist/agentConfigAssistant/index.js";

const profile = {
  id: "default",
  name: "Default",
  remoteHost: "100.0.0.1",
  remoteSshPort: 22,
  remoteUser: "",
  remoteIdentityPath: "",
  reverseBridgeRemoteHost: "127.0.0.1",
  reverseBridgeRemotePort: 38999,
  gatewayTransport: "direct",
  gatewayDirectHost: "100.0.0.1",
  gatewayDirectUrl: "",
  gatewayRemotePort: 18789,
  gatewayLocalPort: 18790,
  authMode: "token",
  remoteWorkspaceRoot: "~/.openclaw/workspace",
  publicBaseUrl: "",
  hasAuthToken: false,
  hasAuthPassword: false
};

function analyze(config, mainAgentAddress = "100.74.38.97") {
  return analyzeAgentConfig({
    agentType: "openclaw",
    configText: JSON.stringify(config),
    mainAgentAddress,
    existingProfile: profile
  });
}

{
  const result = analyze({
    gateway: { bind: "loopback", port: 18789, tailscale: { mode: "serve" }, auth: { mode: "token", token: "tok_secret_1234" } }
  }, "https://main-agent.tail09cff1.ts.net");
  assert.equal(result.status, "ready");
  assert.equal(result.proposedUpdate.gatewayDirectUrl, "https://main-agent.tail09cff1.ts.net");
  assert.equal(result.proposedUpdate.authMode, "token");
  assert.equal(result.proposedUpdate.authToken, "tok_secret_1234");
  assert.equal(result.detected.hasAuthToken, true);
}

{
  const result = analyze({
    gateway: { bind: "loopback", tailscale: { mode: "serve" }, auth: { mode: "password", password: "pw_secret_1234" } }
  }, "main-agent.tail09cff1.ts.net");
  assert.equal(result.status, "ready");
  assert.equal(result.proposedUpdate.gatewayDirectUrl, "https://main-agent.tail09cff1.ts.net");
  assert.equal(result.proposedUpdate.authMode, "password");
  assert.equal(result.proposedUpdate.authPassword, "pw_secret_1234");
}

{
  const result = analyze({
    gateway: { bind: "loopback", tailscale: { mode: "serve" }, auth: { mode: "token", token: "tok_secret_1234" } }
  }, "100.74.38.97");
  assert.equal(result.status, "needs_input");
  assert.equal(result.proposedUpdate.gatewayDirectUrl, "");
  assert.ok(result.findings.some((finding) => finding.level === "error" && /HTTPS 地址/.test(finding.message)));
}

{
  const result = analyze({
    gateway: { bind: "loopback", port: 18789, auth: { mode: "token", token: "loopback-token" } }
  }, "100.74.38.97");
  assert.equal(result.status, "ready");
  assert.equal(result.proposedUpdate.gatewayTransport, "ssh");
  assert.equal(result.proposedUpdate.remoteHost, "100.74.38.97");
  assert.equal(result.proposedUpdate.gatewayRemotePort, 18789);
  assert.equal(result.proposedUpdate.gatewayDirectUrl, "");
  assert.equal(result.proposedUpdate.authToken, "loopback-token");
  assert.ok(result.findings.some((finding) => /SSH tunnel/.test(finding.message)));
}

{
  const result = analyze({
    gateway: { bind: "tailnet", port: 19000, tailscale: { mode: "off" }, auth: { mode: "token", token: "tailnet-token" } }
  }, "100.74.38.97");
  assert.equal(result.status, "ready");
  assert.equal(result.proposedUpdate.gatewayDirectHost, "100.74.38.97");
  assert.equal(result.proposedUpdate.gatewayDirectUrl, "");
  assert.equal(result.proposedUpdate.gatewayRemotePort, 19000);
  assert.equal(result.proposedUpdate.authToken, "tailnet-token");
}

{
  const result = analyze({
    gateway: { bind: "lan", auth: { mode: "token", token: "lan-token" } }
  });
  assert.equal(result.status, "ready");
  assert.ok(result.findings.some((finding) => finding.level === "warning" && /监听 LAN\/所有可用网卡/.test(finding.message)));
}

{
  const result = analyze({
    gateway: { bind: "custom", customBindHost: "127.0.0.1", auth: { mode: "token", token: "loopback-token" } }
  });
  assert.equal(result.status, "needs_input");
  assert.ok(result.findings.some((finding) => finding.level === "error" && /Tailscale Serve HTTPS URL/.test(finding.message)));
}

{
  const result = analyze({
    gateway: { bind: "tailnet", auth: { mode: "token", token: { source: "env", id: "OPENCLAW_GATEWAY_TOKEN" } } }
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.proposedUpdate.authToken, undefined);
  assert.ok(result.findings.some((finding) => /无法从配置文件解析明文/.test(finding.message)));
}

{
  const result = analyzeAgentConfig({
    agentType: "openclaw",
    configText: "{nope",
    mainAgentAddress: "100.74.38.97",
    existingProfile: profile
  });
  assert.equal(result.status, "invalid");
}

{
  const result = analyzeAgentConfig({
    agentType: "codex",
    configText: "{}",
    mainAgentAddress: "100.74.38.97",
    existingProfile: profile
  });
  assert.equal(result.status, "unsupported");
}

console.log("agent-config-assistant-rules-test passed");
