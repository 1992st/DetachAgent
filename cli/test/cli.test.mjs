import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, resolveBaseUrl } from "../dist/index.js";

const cliSource = fs.readFileSync(path.join(import.meta.dirname, "../src/index.ts"), "utf8");
const cliUse = fs.readFileSync(path.join(import.meta.dirname, "../cli_use.md"), "utf8");

{
  const parsed = parseArgs(["agent", "send", "agent-1", "--message", "hello", "--wait", "--timeout-ms=600000"]);
  assert.deepEqual(parsed.positionals, ["agent", "send", "agent-1"]);
  assert.equal(parsed.flags.message, "hello");
  assert.equal(parsed.flags.wait, true);
  assert.equal(parsed.flags["timeout-ms"], "600000");
}

{
  assert.equal(resolveBaseUrl({}, { DETACH_AGENT_BASE_URL: "http://127.0.0.1:38888/" }), "http://127.0.0.1:38888");
  assert.equal(resolveBaseUrl({ "base-url": "http://localhost:3000/" }, { DETACH_AGENT_BASE_URL: "http://ignored" }), "http://localhost:3000");
}

assert.match(cliSource, /app companion CLI/, "CLI help should state it is an app companion CLI");
assert.doesNotMatch(cliSource, /agent serve/, "CLI should not expose a serve command");
assert.doesNotMatch(cliSource, /from "ws"/, "Packaged CLI should use the runtime WebSocket and not require bundled node_modules");
assert.match(cliUse, /CLI 不会演进为独立客户端/, "user docs should state CLI will not become standalone");
assert.match(cliUse, /Open Detach Agent App first/, "user docs should tell users to open the App when local server is unreachable");

console.log("cli tests passed");
