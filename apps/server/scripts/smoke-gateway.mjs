import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { DEFAULT_OPENCLAW_REMOTE_HOST } from "../dist/config/appConfig.js";

const gatewayPort = Number(process.env.SMOKE_GATEWAY_PORT ?? 19879);
const serverPort = Number(process.env.SMOKE_SERVER_PORT ?? 39888);
const host = "127.0.0.1";

const observed = {
  connect: null,
  methods: [],
  chatSend: null,
  abort: null
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 10000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function createMockGateway() {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "smoke-nonce", ts: Date.now() }
    }));

    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8"));
      if (frame.type !== "req") return;
      observed.methods.push(frame.method);

      if (frame.method === "connect") {
        observed.connect = frame.params;
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            server: { name: "mock-openclaw", version: "smoke" },
            features: {
              methods: [
                "health",
                "sessions.list",
                "chat.history",
                "chat.send",
                "chat.abort",
                "tools.invoke",
                "node.invoke",
                "agents.files.list",
                "agents.files.get",
                "agents.files.set",
                "artifacts.list",
                "artifacts.download",
                "environments.list",
                "environments.status"
              ]
            },
            snapshot: {
              presence: [],
              health: {
                ok: true,
                agents: [
                  { id: "agent-alpha", name: "Alpha Agent", model: { primary: "openai/gpt-5.4" }, agentRuntime: { id: "codex" } },
                  { id: "agent-gamma", name: "Gamma Agent", workspace: "/tmp/gamma", agentRuntime: { id: "openclaw" } }
                ]
              },
              uptimeMs: 1
            },
            auth: { role: "operator" },
            policy: { maxPayload: 16 * 1024 * 1024 }
          }
        }));
        return;
      }

      if (frame.method === "health") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true, service: "mock" } }));
        return;
      }

      if (frame.method === "sessions.list") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            sessions: [
              {
                key: "agent-alpha-session",
                agentId: "agent-alpha",
                title: "Alpha Agent",
                status: "available",
                updatedAt: Date.now(),
                items: [{ text: "ready" }]
              },
              {
                key: "agent-beta-session",
                agentId: "agent-beta",
                title: "Beta Agent",
                status: "idle",
                updatedAt: Date.now() - 1000,
                items: [{ text: "waiting" }]
              }
            ]
          }
        }));
        return;
      }

      if (frame.method === "agents.list") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            defaultId: "agent-alpha",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "agent-alpha", name: "Alpha Agent", model: { primary: "openai/gpt-5.4" }, agentRuntime: { id: "codex" } },
              { id: "agent-gamma", name: "Gamma Agent", workspace: "/tmp/gamma", agentRuntime: { id: "openclaw" } }
            ]
          }
        }));
        return;
      }

      if (frame.method === "agents.files.list") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            agentId: frame.params.agentId,
            workspace: `/tmp/openclaw/workspace/${frame.params.agentId}`,
            files: []
          }
        }));
        return;
      }

      if (frame.method === "chat.history") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            sessionKey: frame.params.sessionKey,
            messages: [
              { id: "h1", role: "assistant", content: [{ type: "text", text: "history ok" }], timestamp: Date.now() }
            ]
          }
        }));
        return;
      }

      if (frame.method === "chat.send") {
        observed.chatSend = frame.params;
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId: "run-smoke-1" } }));
        socket.send(JSON.stringify({
          type: "event",
          event: "chat",
          payload: { role: "assistant", text: `echo: ${frame.params.message}`, runId: "run-smoke-1" }
        }));
        return;
      }

      if (frame.method === "chat.abort") {
        observed.abort = frame.params;
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
        return;
      }

      socket.send(JSON.stringify({
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: "unknown_method", message: `unknown method: ${frame.method}` }
      }));
    });
  });

  return { server, wss };
}

async function requestJson(path, init) {
  const res = await fetch(`http://${host}:${serverPort}${path}`, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response for ${path}: ${text}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}: ${text}`);
  }
  return json;
}

async function main() {
  const mock = createMockGateway();
  mock.server.listen(gatewayPort, host);
  await once(mock.server, "listening");

  const server = spawn("node", ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DETACHES_SERVER_HOST: host,
      DETACHES_SERVER_PORT: String(serverPort),
      OPENCLAW_GATEWAY_TRANSPORT: "ssh",
      OPENCLAW_GATEWAY_LOCAL_PORT: String(gatewayPort),
      OPENCLAW_GATEWAY_REMOTE_PORT: String(gatewayPort),
      OPENCLAW_REMOTE_USER: "",
      OPENCLAW_AUTH_MODE: "token",
      OPENCLAW_AUTH_TOKEN: "smoke-token",
      DETACHES_PUBLIC_HOST: host,
      DETACHES_STORAGE_DIR: "./storage-smoke"
    }
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

  try {
    await waitForHttp(`http://${host}:${serverPort}/`);

    const settings = await requestJson("/api/settings");
    assert.equal(settings.remoteHost, DEFAULT_OPENCLAW_REMOTE_HOST);
    assert.equal(settings.hasAuthToken, true);

    const health = await requestJson("/api/health");
    assert.equal(health.server.state, "ok");
    assert.equal(health.gateway.state, "ok");
    assert.equal(observed.connect?.auth?.token, "smoke-token");
    assert.equal(observed.connect?.device?.nonce, "smoke-nonce");
    assert.equal(observed.connect?.client?.id, "openclaw-macos");

    const diagnostics = await requestJson("/api/diagnostics");
    assert.equal(diagnostics.health.gateway.state, "ok");
    assert.equal(diagnostics.items.some((item) => item.id === "ssh-user-missing"), true);

    const capabilities = await requestJson("/api/gateway/capabilities");
    assert.equal(capabilities.connected, true);
    assert.equal(capabilities.hasToolsInvoke, true);
    assert.equal(capabilities.hasNodeInvoke, true);
    assert.equal(capabilities.hasAgentsFiles, true);
    assert.equal(capabilities.hasArtifacts, true);
    assert.equal(capabilities.hasEnvironments, true);
    assert.equal(capabilities.candidateAdapters.includes("gateway-managed"), true);
    assert.equal(capabilities.candidateAdapters.includes("remote-agent-host"), true);
    assert.equal(capabilities.candidateAdapters.includes("local-user-machine"), true);

    const agents = await requestJson("/api/agents");
    assert.equal(agents.agents.length, 2);
    assert.equal(agents.source, "gateway-agents+sessions");
    assert.deepEqual(agents.agents.map((agent) => agent.sessionKey), [
      "agent:agent-alpha:main",
      "agent:agent-gamma:main"
    ]);

    const uploadForm = new FormData();
    uploadForm.append("sessionKey", "agent-alpha-session");
    uploadForm.append("file", new Blob(["hello"], { type: "text/plain" }), "P100协议说明-示例.txt");
    const upload = await requestJson("/api/files/upload", { method: "POST", body: uploadForm });
    assert.equal(upload.file.name, "P100协议说明-示例.txt");
    assert.equal(upload.file.displayName, "P100协议说明-示例.txt");
    assert.equal(upload.file.storageName, "P100协议说明-示例.txt");
    assert.equal(upload.file.mimeType, "text/plain");
    assert.equal(upload.file.contentBase64, undefined);
    assert.equal(upload.file.remotePath, undefined);
    assert.match(upload.file.localPath, /storage(?:-smoke)?\/uploads\/.+P100协议说明-示例\.txt$/);

    const rejectedDownload = await fetch(`http://${host}:${serverPort}/api/files/download?remotePath=${encodeURIComponent("/etc/passwd")}`);
    assert.equal(rejectedDownload.status, 400);
    assert.match(await rejectedDownload.text(), /outside the configured workspace/);

    const chatSessionKey = "agent:agent-alpha:main";
    const chat = new WebSocket(`ws://${host}:${serverPort}/api/chat/${encodeURIComponent(chatSessionKey)}`);
    const messages = [];
    chat.on("message", (data) => {
      messages.push(JSON.parse(data.toString("utf8")));
    });
    await once(chat, "open");

    const started = Date.now();
    while (!messages.some((message) => message.type === "history")) {
      if (Date.now() - started > 5000) throw new Error("Timed out waiting for chat history.");
      await wait(50);
    }
    const history = messages.find((message) => message.type === "history");
    assert.equal(history.payload.messages[0].text, "history ok");

    chat.send(JSON.stringify({
      type: "send",
      message: "hello smoke",
      attachments: [upload.file],
      idempotencyKey: "smoke-idempotency"
    }));

    while (!messages.some((message) => message.type === "sent") || !messages.some((message) => message.type === "chat")) {
      if (Date.now() - started > 8000) throw new Error("Timed out waiting for chat send response.");
      await wait(50);
    }
    assert.equal(observed.chatSend.sessionKey, chatSessionKey);
    assert.match(observed.chatSend.message, /^hello smoke/);
    assert.match(observed.chatSend.message, /detaches_agent 文件上下文/);
    assert.match(observed.chatSend.message, /P100协议说明-示例\.txt/);
    assert.match(observed.chatSend.message, new RegExp(`fileId: ${upload.file.id}`));
    assert.match(observed.chatSend.message, /currentLocation: 用户本机 detaches_agent staging 区/);
    assert.match(observed.chatSend.message, /remotePath: not uploaded/);
    assert.match(observed.chatSend.message, /detaches-file-transfer/);
    assert.match(observed.chatSend.message, /"target":"local-user-machine"/);
    assert.match(observed.chatSend.message, /detaches_agent 接入上下文/);
    assert.match(observed.chatSend.message, /agentId: agent-alpha/);
    assert.match(observed.chatSend.message, /terminal targets: supported=local-user-machine; unavailable=remote-agent-host,gateway-managed/);
    assert.match(observed.chatSend.message, /file-transfer targets: supported=local-user-machine; unavailable=remote-agent-host,gateway-managed/);
    assert.equal(observed.chatSend.idempotencyKey, "smoke-idempotency");
    assert.equal(observed.chatSend.clientContext?.app, "detaches_agent");
    assert.equal(observed.chatSend.clientContext?.detaches?.app, "detaches_agent");
    assert.equal(observed.chatSend.clientContext?.detaches?.version, 1);
    assert.equal(observed.chatSend.clientContext?.detaches?.sessionKey, chatSessionKey);
    assert.equal(observed.chatSend.clientContext?.detaches?.agentId, "agent-alpha");
    assert.equal(observed.chatSend.clientContext?.detaches?.capabilities?.some((capability) => capability.name === "terminal" && capability.supportedTargets.includes("local-user-machine")), true);
    assert.equal(observed.chatSend.clientContext?.routeContext?.origin?.provider, "detaches_agent");
    assert.equal(observed.chatSend.attachments, undefined);

    const preparedTransfer = await requestJson("/api/files/transfer/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: upload.file.id, target: "local-user-machine", remotePath: "/tmp/detaches-note.txt" })
    });
    assert.equal(preparedTransfer.fileId, upload.file.id);
    assert.equal(preparedTransfer.target, "local-user-machine");
    assert.equal(preparedTransfer.remotePath, "/tmp/detaches-note.txt");
    assert.match(preparedTransfer.downloadUrl, new RegExp(`^http://${host}:${serverPort}/api/files/staged/`));
    assert.match(preparedTransfer.command, /curl -fL/);
    assert.match(preparedTransfer.command, /detaches-note\.txt/);

    const terminalTool = await requestJson("/api/tools/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "terminal",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        reason: "smoke terminal broker",
        payload: { command: "pwd" }
      })
    });
    assert.equal(terminalTool.request.status, "pending");
    const approvedTerminalTool = await requestJson(`/api/tools/requests/${terminalTool.request.id}/approve`, { method: "POST" });
    assert.equal(approvedTerminalTool.request.status, "approved");
    assert.equal(approvedTerminalTool.command, "pwd");
    assert.equal(approvedTerminalTool.execution.target, "local-user-machine");
    assert.equal(approvedTerminalTool.execution.sessionKey, chatSessionKey);
    assert.equal(approvedTerminalTool.execution.wroteToTerminal, true);
    assert.match(approvedTerminalTool.execution.terminalId, /.+/);
    await wait(200);
    const terminalToolResult = await requestJson(`/api/tools/requests/${terminalTool.request.id}/result`);
    assert.equal(terminalToolResult.result.requestId, terminalTool.request.id);
    assert.equal(terminalToolResult.result.executionId, approvedTerminalTool.execution.executionId);
    assert.equal(terminalToolResult.result.terminalId, approvedTerminalTool.execution.terminalId);
    assert.equal(terminalToolResult.result.sessionKey, chatSessionKey);
    assert.equal(typeof terminalToolResult.result.output, "string");
    assert.equal(terminalToolResult.result.outputBytes >= 0, true);

    const blockedTerminalTool = await requestJson("/api/tools/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "terminal",
        target: "remote-agent-host",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        reason: "smoke blocked remote terminal",
        payload: { command: "pwd" }
      })
    });
    assert.equal(blockedTerminalTool.request.status, "blocked");
    assert.match(blockedTerminalTool.request.error, /cannot fallback/);

    const brokerTransfer = await requestJson("/api/tools/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "file-transfer",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        reason: "smoke file broker",
        payload: { fileId: upload.file.id, remotePath: "/tmp/detaches-note-via-broker.txt" }
      })
    });
    assert.equal(brokerTransfer.request.status, "pending");
    const approvedBrokerTransfer = await requestJson(`/api/tools/requests/${brokerTransfer.request.id}/approve`, { method: "POST" });
    assert.equal(approvedBrokerTransfer.request.status, "approved");
    assert.match(approvedBrokerTransfer.command, /curl -fL/);
    assert.match(approvedBrokerTransfer.command, /detaches-note-via-broker\.txt/);
    assert.equal(approvedBrokerTransfer.execution.wroteToTerminal, true);
    assert.equal(approvedBrokerTransfer.execution.sessionKey, chatSessionKey);
    const brokerTransferResult = await requestJson(`/api/tools/requests/${brokerTransfer.request.id}/result`);
    assert.equal(brokerTransferResult.result.executionId, approvedBrokerTransfer.execution.executionId);
    assert.equal(brokerTransferResult.result.terminalId, approvedBrokerTransfer.execution.terminalId);

    const extractedTools = await requestJson("/api/tools/requests/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        text: [
          "please run",
          "```detaches-terminal",
          "{\"target\":\"local-user-machine\",\"command\":\"echo broker-parse\",\"reason\":\"parse terminal\"}",
          "```",
          "```detaches-terminal",
          "{\"target\":\"remote-agent-host\",\"command\":\"pwd\",\"reason\":\"parse blocked remote\"}",
          "```"
        ].join("\n")
      })
    });
    assert.equal(extractedTools.requests.length, 2);
    assert.equal(extractedTools.requests[0].kind, "terminal");
    assert.equal(extractedTools.requests[0].status, "pending");
    assert.equal(extractedTools.requests[0].payload.command, "echo broker-parse");
    assert.equal(extractedTools.requests[1].target, "remote-agent-host");
    assert.equal(extractedTools.requests[1].status, "blocked");

    const validRemoteTransfer = await fetch(`http://${host}:${serverPort}/api/files/transfer/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: upload.file.id, target: "remote-agent-host", agentId: "agent-alpha", remotePath: "docs/detaches-note.txt" })
    });
    assert.equal(validRemoteTransfer.status, 400);
    assert.match(await validRemoteTransfer.text(), /remote-agent-host path is valid under \/tmp\/openclaw\/workspace\/agent-alpha/);

    const escapedRemoteTransfer = await fetch(`http://${host}:${serverPort}/api/files/transfer/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: upload.file.id, target: "remote-agent-host", agentId: "agent-alpha", remotePath: "/etc/passwd" })
    });
    assert.equal(escapedRemoteTransfer.status, 400);
    assert.match(await escapedRemoteTransfer.text(), /outside the remote agent workspace/);

    const stagedDownload = await fetch(preparedTransfer.downloadUrl);
    assert.equal(stagedDownload.status, 200);
    assert.equal(await stagedDownload.text(), "hello");
    const repeatedDownload = await fetch(preparedTransfer.downloadUrl);
    assert.equal(repeatedDownload.status, 404);

    const auditPath = path.resolve(new URL("../../..", import.meta.url).pathname, "storage-smoke/logs/file-transfer-audit.jsonl");
    const auditEvents = (await fs.readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(auditEvents.some((event) => event.type === "upload" && event.fileId === upload.file.id), true);
    assert.equal(auditEvents.some((event) => event.type === "transfer.prepare" && event.fileId === upload.file.id && event.target === "local-user-machine" && event.remotePath === "/tmp/detaches-note.txt"), true);
    assert.equal(auditEvents.some((event) => event.type === "transfer.download.start" && event.fileId === upload.file.id && event.target === "local-user-machine"), true);
    assert.equal(auditEvents.some((event) => event.type === "transfer.download.cleanup" && event.fileId === upload.file.id && event.target === "local-user-machine" && event.deleted === true), true);
    assert.equal(auditEvents.some((event) => event.type === "transfer.error" && event.fileId === upload.file.id && event.target === "remote-agent-host" && event.agentId === "agent-alpha" && event.workspace === "/tmp/openclaw/workspace/agent-alpha"), true);

    const toolAuditPath = path.resolve(new URL("../../..", import.meta.url).pathname, "storage-smoke/logs/tool-broker-audit.jsonl");
    const toolAuditEvents = (await fs.readFile(toolAuditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.create" && event.request.kind === "terminal" && event.request.target === "local-user-machine"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.create" && event.request.kind === "terminal" && event.request.target === "remote-agent-host" && event.request.status === "blocked"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.create" && event.request.payload?.command === "echo broker-parse"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.approve" && event.command === "pwd" && typeof event.terminalId === "string"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.approve" && /detaches-note-via-broker\.txt/.test(event.command || "") && typeof event.terminalId === "string"), true);

    chat.send(JSON.stringify({ type: "abort", runId: "run-smoke-1" }));
    while (!observed.abort) {
      if (Date.now() - started > 10000) throw new Error("Timed out waiting for abort request.");
      await wait(50);
    }
    assert.deepEqual(observed.abort, { sessionKey: chatSessionKey, runId: "run-smoke-1" });
    chat.close();

    console.log("smoke-gateway: ok");
  } catch (error) {
    console.error(serverOutput);
    throw error;
  } finally {
    server.kill("SIGTERM");
    mock.wss.close();
    mock.server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
