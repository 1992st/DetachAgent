import assert from "node:assert/strict";
import { buildAgentDirectory, summaryFromConfiguredAgent, summaryFromSession } from "../apps/server/dist/services/gateway/agentDirectoryService.js";

const gatewayAgents = ["main", "agent-radar-desk", "lumi-writer"]
  .map((id) => summaryFromConfiguredAgent({
    id,
    name: id,
    agentRuntime: { id: "pi" },
    model: { primary: "gpt-test" }
  }))
  .filter(Boolean);

const sshOnlyAgents = ["orphan-from-disk", "not-in-gateway-scope"].map((id) => ({
  id,
  sessionKey: `agent:${id}:main`,
  title: id,
  status: "remote-disk",
  preview: `/home/test/.openclaw/agents/${id}`
}));

const sessions = [
  summaryFromSession({
    key: "agent:agent-radar-desk:detaches:desktop",
    title: "agent-radar-desk",
    status: "available",
    updatedAt: Date.parse("2026-06-14T10:00:00Z")
  }, 0),
  summaryFromSession({
    key: "agent:session-only-worker:detaches:desktop",
    title: "session-only-worker",
    status: "available",
    updatedAt: Date.parse("2026-06-14T09:00:00Z")
  }, 1)
];

const result = buildAgentDirectory({
  configured: gatewayAgents,
  sessions,
  configuredSource: "gateway-agents-rpc"
});
const ids = result.agents.map((agent) => agent.id).sort();

assert.equal(result.source, "gateway-agents-rpc+sessions");
assert.deepEqual(ids, [
  "agent-radar-desk",
  "lumi-writer",
  "main",
  "session-only-worker"
]);

const fallback = buildAgentDirectory({
  configured: [],
  sessions: [],
  cliAgents: sshOnlyAgents
});
assert.equal(fallback.source, "gateway-agents+sessions+ssh-cli");
assert.deepEqual(fallback.agents.map((agent) => agent.id).sort(), [
  "not-in-gateway-scope",
  "orphan-from-disk"
]);

const rpcFailedFallback = buildAgentDirectory({
  configured: gatewayAgents,
  sessions,
  cliAgents: sshOnlyAgents,
  configuredSource: "gateway-agents"
});
assert.equal(rpcFailedFallback.source, "gateway-agents+sessions+ssh-cli");
assert.deepEqual(rpcFailedFallback.agents.map((agent) => agent.id).sort(), [
  "agent-radar-desk",
  "lumi-writer",
  "main",
  "not-in-gateway-scope",
  "orphan-from-disk",
  "session-only-worker"
]);

console.log("agent-directory-gateway-rpc-authority-test passed");
