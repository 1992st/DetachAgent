import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../apps/web/src/features/tools/toolQueuePresentation.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true
  }
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
const { shouldSurfaceApproval } = await import(moduleUrl);

const nowMs = Date.parse("2026-06-14T10:00:00.000+08:00");

function request(overrides = {}) {
  return {
    id: "AzQgjIPkb442-hadFqcA3",
    kind: "skill-verify",
    target: "local-user-machine",
    sessionKey: "agent:agent-radar-desk:detaches:d8cd48d4d2f7",
    agentId: "agent-radar-desk",
    reason: "verify detach-agent-relationship host skill",
    source: "api",
    payload: {
      skillName: "detach-agent-relationship",
      targetAgent: "openclaw",
      targetDir: "~/.openclaw/skills"
    },
    status: "pending",
    risk: { level: "safe", reasons: [] },
    createdAt: "2026-06-14T09:58:30.000+08:00",
    updatedAt: "2026-06-14T09:58:30.000+08:00",
    ...overrides
  };
}

assert.equal(
  shouldSurfaceApproval(request(), { requireRecent: true, nowMs }),
  true,
  "recent pending skill-verify requests should pop the Tool Queue approval UI"
);

assert.equal(
  shouldSurfaceApproval(request({ createdAt: "2026-06-14T09:40:00.000+08:00" }), { requireRecent: true, nowMs }),
  false,
  "old pending requests should stay in the queue without repeatedly popping"
);

assert.equal(
  shouldSurfaceApproval(request({ target: "remote-agent-host" }), { requireRecent: true, nowMs }),
  false,
  "unsupported skill-verify targets should not open an approval popup"
);

assert.equal(
  shouldSurfaceApproval(request({ status: "approved" }), { requireRecent: true, nowMs }),
  false,
  "non-pending requests should not open an approval popup"
);

console.log("tool-queue-popup-test passed");
