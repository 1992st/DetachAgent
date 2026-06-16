import assert from "node:assert/strict";
import { buildAgentDirectory, summaryFromConfiguredAgent, summaryFromSession } from "../apps/server/dist/services/gateway/agentDirectoryService.js";

const configured = ["main", "ai_stock", "lumi-writer", "agent-radar-desk"]
  .map((id) => summaryFromConfiguredAgent({
    id,
    name: id,
    agentRuntime: { id: "configured" },
    model: { primary: "gpt-test" }
  }))
  .filter(Boolean);

const cliAgents = ["win_stock", "ai-stockassistant"].map((id) => ({
  id,
  sessionKey: `agent:${id}:main`,
  title: id,
  status: "remote-disk",
  preview: `/home/test/.openclaw/agents/${id}`
}));

const sessions = [
  summaryFromSession({
    key: "agent:detached-executor:detaches:desktop",
    title: "detached-executor",
    status: "available",
    updatedAt: Date.parse("2026-06-14T10:00:00Z"),
    items: [{ text: "ready" }]
  }, 0),
  summaryFromSession({
    key: "agent:global:main",
    title: "global",
    status: "available"
  }, 1)
];

const result = buildAgentDirectory({ configured, sessions, configuredSource: "gateway-agents" });
const ids = result.agents.map((agent) => agent.id).sort();

assert.equal(result.agents.length, 5, "agent directory must merge Gateway agents and session-only agents instead of stopping at the 4 snapshot agents");
assert.deepEqual(ids, [
  "agent-radar-desk",
  "ai_stock",
  "detached-executor",
  "lumi-writer",
  "main"
]);
assert.equal(result.source, "gateway-agents+sessions");
assert(!ids.includes("global"), "global session should not appear as a chat target");

const cliFallback = buildAgentDirectory({ cliAgents });
assert.equal(cliFallback.source, "gateway-agents+sessions+ssh-cli");
assert.deepEqual(cliFallback.agents.map((agent) => agent.id).sort(), ["ai-stockassistant", "win_stock"]);

const rpcResult = buildAgentDirectory({
  configured,
  sessions,
  configuredSource: "gateway-agents-rpc"
});
assert.equal(rpcResult.source, "gateway-agents-rpc+sessions");

console.log("agent-directory-full-list-test passed");
