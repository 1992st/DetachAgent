import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";

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
            features: { methods: ["health", "sessions.list", "chat.history", "chat.send", "chat.abort"] },
            snapshot: { presence: [], health: { ok: true }, uptimeMs: 1 },
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
      DETACHES_STORAGE_DIR: "./storage-smoke"
    }
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

  try {
    await waitForHttp(`http://${host}:${serverPort}/`);

    const settings = await requestJson("/api/settings");
    assert.equal(settings.remoteHost, "100.114.139.72");
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

    const agents = await requestJson("/api/agents");
    assert.equal(agents.agents.length, 4);
    assert.equal(agents.source, "gateway-agents+sessions");
    assert.deepEqual(agents.agents.map((agent) => agent.sessionKey), [
      "agent:agent-alpha:main",
      "agent:agent-gamma:main",
      "agent-alpha-session",
      "agent-beta-session"
    ]);

    const uploadForm = new FormData();
    uploadForm.append("sessionKey", "agent-alpha-session");
    uploadForm.append("file", new Blob(["hello"], { type: "text/plain" }), "note.txt");
    const upload = await requestJson("/api/files/upload", { method: "POST", body: uploadForm });
    assert.equal(upload.file.name, "note.txt");
    assert.equal(upload.file.mimeType, "text/plain");
    assert.equal(upload.file.contentBase64, Buffer.from("hello").toString("base64"));
    assert.equal(upload.file.remotePath, undefined);

    const rejectedDownload = await fetch(`http://${host}:${serverPort}/api/files/download?remotePath=${encodeURIComponent("/etc/passwd")}`);
    assert.equal(rejectedDownload.status, 400);
    assert.match(await rejectedDownload.text(), /outside the configured workspace/);

    const chat = new WebSocket(`ws://${host}:${serverPort}/api/chat/${encodeURIComponent("agent-alpha-session")}`);
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
    assert.equal(observed.chatSend.sessionKey, "agent-alpha-session");
    assert.equal(observed.chatSend.message, "hello smoke");
    assert.equal(observed.chatSend.idempotencyKey, "smoke-idempotency");
    assert.deepEqual(observed.chatSend.attachments, [
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "note.txt",
        content: Buffer.from("hello").toString("base64")
      }
    ]);

    chat.send(JSON.stringify({ type: "abort", runId: "run-smoke-1" }));
    while (!observed.abort) {
      if (Date.now() - started > 10000) throw new Error("Timed out waiting for abort request.");
      await wait(50);
    }
    assert.deepEqual(observed.abort, { sessionKey: "agent-alpha-session", runId: "run-smoke-1" });
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
