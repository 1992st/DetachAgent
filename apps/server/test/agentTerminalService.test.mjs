import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "detaches-agent-terminal-"));
process.env.DETACHES_STORAGE_DIR = storageDir;
process.env.DETACHES_DISABLE_LEGACY_SETTINGS_MIGRATION = "1";

const { agentTerminalService } = await import("../dist/services/agentTerminal/agentTerminalService.js");
const { toolBrokerService } = await import("../dist/services/tools/toolBrokerService.js");

try {
  await assert.rejects(
    agentTerminalService.bootstrap({
      remoteAddress: "127.0.0.1",
      sessionKey: "test-gateway-terminal",
      agentId: "test-agent"
    }),
    (error) => error?.code === "DETACHES_TERMINAL_BOOTSTRAP_REQUIRED",
    "first bootstrap should create a pending local authorization request"
  );

  const sessions = await agentTerminalService.listSessions();
  const pending = sessions.sessions.find((session) => session.sessionKey === "test-gateway-terminal");
  assert.ok(pending, "pending session should be persisted after bootstrap-required response");
  const authorized = await agentTerminalService.authorizeSession(pending.terminalSessionId);

  const timeout = await agentTerminalService.createRun({
    leaseToken: authorized.leaseToken,
    waitMs: 10,
    request: {
      command: "echo timeout",
      reason: "runtime test timeout",
      sourceEventId: "runtime-test-timeout"
    }
  });
  assert.equal(timeout.status, "timeout", "waiting approval should time out when waitMs elapses");
  assert.equal(timeout.code, "DETACHES_TERMINAL_TIMEOUT", "timeout response should carry the terminal timeout code");
  assert.ok(timeout.run.requestId, "timeout run should still be linked to the Tool Queue request");
  const timedOutRequest = await toolBrokerService.request(timeout.run.requestId);
  assert.equal(timedOutRequest.status, "failed", "timeout should mark the Tool Queue request failed");
  assert.match(timedOutRequest.error || "", /Timed out after 10ms/, "Tool Queue failure should keep the timeout reason");

  const active = await agentTerminalService.createRun({
    leaseToken: authorized.leaseToken,
    waitMs: 0,
    request: {
      command: "echo active",
      reason: "runtime test active lock",
      sourceEventId: "runtime-test-active"
    }
  });
  assert.equal(active.status, "waiting_for_approval", "first active run should wait for approval");
  assert.ok(active.run.requestId, "active run should have one Tool Queue request");

  const busy = await agentTerminalService.createRun({
    leaseToken: authorized.leaseToken,
    waitMs: 0,
    request: {
      command: "echo blocked",
      reason: "runtime test active lock busy",
      sourceEventId: "runtime-test-busy"
    }
  });
  assert.equal(busy.status, "failed", "second run for same session should not enter the same active PTY");
  assert.equal(busy.code, "DETACHES_TERMINAL_BUSY", "busy response should be machine-readable");
  assert.equal(busy.run.requestId, undefined, "busy response should not create a second Tool Queue request");
  assert.match(busy.message || "", new RegExp(active.run.runId), "busy message should identify the active run");

  const cancelled = await agentTerminalService.cancel(active.run.runId);
  assert.equal(cancelled.status, "cancelled", "cancel should release the active run");
  const activeRequest = await toolBrokerService.request(active.run.requestId);
  assert.equal(activeRequest.status, "rejected", "pending cancel should reject the Tool Queue request");

  console.log("agentTerminalService: ok");
} finally {
  await fs.rm(storageDir, { recursive: true, force: true });
}
