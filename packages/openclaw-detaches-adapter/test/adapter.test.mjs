import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
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
