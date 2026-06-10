import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const adapterDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(adapterDir, "bin", "detaches-agent-adapter.mjs");

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: adapterDir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const manifest = await run(["manifest"]);
assert.equal(manifest.code, 0);
const parsedManifest = JSON.parse(manifest.stdout);
assert.equal(parsedManifest.id, "detaches_agent.openclaw.adapter");
assert.equal(parsedManifest.targets["local-user-machine"].status, "supported");
assert.equal(parsedManifest.targets["remote-agent-host"].status, "reserved");
assert.equal(parsedManifest.cliCommands["inspect-context"].includes("routing warnings"), true);

const validContext = await run(["validate-context", "test/valid-context.json"]);
assert.equal(validContext.code, 0);
assert.deepEqual(JSON.parse(validContext.stdout), { ok: true });

const inspectedContext = await run(["inspect-context", "test/valid-context.json"]);
assert.equal(inspectedContext.code, 0);
const parsedInspection = JSON.parse(inspectedContext.stdout);
assert.equal(parsedInspection.ok, true);
assert.equal(parsedInspection.adapterId, "detaches_agent.openclaw.adapter");
assert.equal(parsedInspection.sessionKey, "agent:audio-process:main");
assert.equal(parsedInspection.files.staged.length, 1);
assert.equal(parsedInspection.files.staged[0].fileId, "file-123");
assert.equal(parsedInspection.files.staged[0].transfer.requestFence, "detaches-file-transfer");
assert.equal(parsedInspection.broker.gatewayEventEndpoint, "http://127.0.0.1:38888/api/tools/events/gateway");
assert.equal(parsedInspection.broker.idempotencyField, "sourceEventId");
assert.equal(parsedInspection.broker.requestFormats.includes("broker-event"), true);
assert.deepEqual(parsedInspection.targetSupport["local-user-machine"].supportedBy, ["terminal"]);
assert.equal(parsedInspection.targetSupport["local-user-machine"].requestable, true);
assert.deepEqual(parsedInspection.targetSupport["remote-agent-host"].unavailableBy, ["terminal"]);
assert.equal(parsedInspection.targetSupport["remote-agent-host"].requestable, false);
assert.equal(parsedInspection.warnings.some((warning) => /remote-agent-host is unavailable/.test(warning)), true);

const invalidContext = await run(["validate-context", "adapter.manifest.json"]);
assert.equal(invalidContext.code, 1);
assert.match(invalidContext.stderr, /missing required fields/);

const inspectedInvalidContext = await run(["inspect-context", "adapter.manifest.json"]);
assert.equal(inspectedInvalidContext.code, 1);
assert.equal(JSON.parse(inspectedInvalidContext.stdout).ok, false);

const terminalRequest = await run([
  "terminal-request",
  "--target",
  "local-user-machine",
  "--command",
  "pwd",
  "--reason",
  "check current directory"
]);
assert.equal(terminalRequest.code, 0);
assert.match(terminalRequest.stdout, /^```detaches-terminal/);
assert.match(terminalRequest.stdout, /"target":"local-user-machine"/);
assert.match(terminalRequest.stdout, /"command":"pwd"/);

const terminalBrokerEvent = await run([
  "terminal-request",
  "--target",
  "local-user-machine",
  "--command",
  "pwd",
  "--reason",
  "check current directory",
  "--format",
  "broker-event",
  "--session-key",
  "agent:audio-process:main",
  "--agent-id",
  "audio-process",
  "--source-event-id",
  "adapter-test-terminal-1"
]);
assert.equal(terminalBrokerEvent.code, 0);
const parsedTerminalBrokerEvent = JSON.parse(terminalBrokerEvent.stdout);
assert.equal(parsedTerminalBrokerEvent.kind, "terminal");
assert.equal(parsedTerminalBrokerEvent.source, "gateway-event");
assert.equal(parsedTerminalBrokerEvent.sourceEventId, "adapter-test-terminal-1");
assert.equal(parsedTerminalBrokerEvent.sessionKey, "agent:audio-process:main");
assert.equal(parsedTerminalBrokerEvent.payload.command, "pwd");

const fileRequest = await run([
  "file-transfer-request",
  "--file-id",
  "file-123",
  "--target",
  "remote-agent-host",
  "--remote-path",
  "docs/input.pdf",
  "--reason",
  "request reserved remote transfer"
]);
assert.equal(fileRequest.code, 0);
assert.match(fileRequest.stdout, /^```detaches-file-transfer/);
assert.match(fileRequest.stdout, /"target":"remote-agent-host"/);
assert.match(fileRequest.stdout, /"remotePath":"docs\/input.pdf"/);

const fileBrokerEvent = await run([
  "file-transfer-request",
  "--file-id",
  "file-123",
  "--target",
  "local-user-machine",
  "--remote-path",
  "/tmp/input.pdf",
  "--reason",
  "request local transfer",
  "--format",
  "broker-event",
  "--session-key",
  "agent:audio-process:main",
  "--source-event-id",
  "adapter-test-file-1"
]);
assert.equal(fileBrokerEvent.code, 0);
const parsedFileBrokerEvent = JSON.parse(fileBrokerEvent.stdout);
assert.equal(parsedFileBrokerEvent.kind, "file-transfer");
assert.equal(parsedFileBrokerEvent.target, "local-user-machine");
assert.equal(parsedFileBrokerEvent.sourceEventId, "adapter-test-file-1");
assert.equal(parsedFileBrokerEvent.payload.fileId, "file-123");
assert.equal(parsedFileBrokerEvent.payload.remotePath, "/tmp/input.pdf");

let submittedBody = null;
const submitServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk.toString("utf8"); });
  req.on("end", () => {
    submittedBody = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ request: { id: "submitted-request", ...submittedBody } }));
  });
});
submitServer.listen(0, "127.0.0.1");
await once(submitServer, "listening");
const submitPort = submitServer.address().port;
const submittedBrokerEvent = await run([
  "terminal-request",
  "--target",
  "local-user-machine",
  "--command",
  "pwd",
  "--reason",
  "submit structured event",
  "--format",
  "broker-event",
  "--session-key",
  "agent:audio-process:main",
  "--source-event-id",
  "adapter-test-submit-1",
  "--submit-url",
  `http://127.0.0.1:${submitPort}/api/tools/events/gateway`
]);
submitServer.close();
assert.equal(submittedBrokerEvent.code, 0);
assert.equal(submittedBody.sourceEventId, "adapter-test-submit-1");
assert.equal(submittedBody.payload.command, "pwd");
assert.equal(JSON.parse(submittedBrokerEvent.stdout).request.id, "submitted-request");

const probeServer = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    ok: true,
    app: "detaches_agent",
    protocolVersion: 1,
    gatewayEventEndpoint: "http://127.0.0.1:38888/api/tools/events/gateway",
    eventSource: "gateway-event",
    idempotencyField: "sourceEventId",
    requestFormats: ["broker-event", "fence"],
    requestKinds: ["terminal", "file-transfer", "adapter-install"],
    targets: ["local-user-machine", "remote-agent-host", "gateway-managed"],
    approvalRequired: true,
    adapterId: "detaches_agent.openclaw.adapter"
  }));
});
probeServer.listen(0, "127.0.0.1");
await once(probeServer, "listening");
const probePort = probeServer.address().port;
const brokerProbe = await run(["broker-probe", `http://127.0.0.1:${probePort}`]);
probeServer.close();
assert.equal(brokerProbe.code, 0);
const parsedBrokerProbe = JSON.parse(brokerProbe.stdout);
assert.equal(parsedBrokerProbe.ok, true);
assert.equal(parsedBrokerProbe.capabilities.gatewayEventEndpoint, "http://127.0.0.1:38888/api/tools/events/gateway");

const badProbeServer = http.createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, app: "other_app", protocolVersion: 99 }));
});
badProbeServer.listen(0, "127.0.0.1");
await once(badProbeServer, "listening");
const badProbePort = badProbeServer.address().port;
const badBrokerProbe = await run(["broker-probe", `http://127.0.0.1:${badProbePort}`]);
badProbeServer.close();
assert.equal(badBrokerProbe.code, 1);
assert.equal(JSON.parse(badBrokerProbe.stdout).ok, false);

const unknownTarget = await run([
  "terminal-request",
  "--target",
  "mystery-machine",
  "--command",
  "pwd",
  "--reason",
  "bad target"
]);
assert.equal(unknownTarget.code, 1);
assert.match(unknownTarget.stderr, /Unknown target/);

console.log("openclaw-detaches-adapter: ok");
