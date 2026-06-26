import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { DEFAULT_OPENCLAW_REMOTE_HOST } from "../dist/config/appConfig.js";

const execFileAsync = promisify(execFile);

const gatewayPort = Number(process.env.SMOKE_GATEWAY_PORT ?? 19879);
const serverPort = Number(process.env.SMOKE_SERVER_PORT ?? 39888);
const host = "127.0.0.1";
const publicBaseUrl = `http://${host}:${serverPort}`;
const reverseBridgeBaseUrl = `http://${host}:${serverPort}`;
const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const smokeStorageDir = path.join(repoRoot, "storage-smoke");
const isWindows = process.platform === "win32";
const localTransferPath = isWindows ? path.join(smokeStorageDir, "downloads", "detaches-note.txt") : "/tmp/detaches-note.txt";
const brokerTransferPath = isWindows ? path.join(smokeStorageDir, "downloads", "detaches-note-via-broker.txt") : "/tmp/detaches-note-via-broker.txt";
const failingTransferPath = isWindows ? smokeStorageDir : "/tmp";
const retryTransferPath = isWindows ? path.join(smokeStorageDir, "downloads", "detaches-retry-after-failure.txt") : "/tmp/detaches-retry-after-failure.txt";
const terminalSmokeCommand = isWindows ? "Write-Output smoke-complete" : "printf 'smoke-complete\\n'";

const observed = {
  connect: null,
  methods: [],
  chatSend: null,
  chatSends: [],
  abort: null
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPath(value) {
  return value.replace(/\\/g, "/");
}

async function readJsonl(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForJsonl(filePath, predicate, timeoutMs = 5000) {
  const started = Date.now();
  let events = [];
  while (Date.now() - started < timeoutMs) {
    events = await readJsonl(filePath);
    if (predicate(events)) return events;
    await wait(100);
  }
  return events;
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
              { id: "h1", runId: "run-history-smoke-1", role: "assistant", content: [{ type: "text", text: "history ok" }], timestamp: Date.now() }
            ]
          }
        }));
        return;
      }

      if (frame.method === "chat.send") {
        observed.chatSend = frame.params;
        observed.chatSends.push(frame.params);
        if (frame.params.message?.includes("client-context-compat smoke") && frame.params.clientContext) {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: "invalid_params",
              message: "invalid chat.send params: at root: unexpected property 'clientContext'"
            }
          }));
          return;
        }
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId: "run-smoke-1" } }));
        socket.send(JSON.stringify({
          type: "event",
          event: "chat",
          payload: { sessionKey: frame.params.sessionKey, role: "assistant", text: `echo: ${frame.params.message}`, runId: "run-smoke-1" }
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
  await fs.rm(smokeStorageDir, { recursive: true, force: true });

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
      DETACHES_PUBLIC_HOST: "unused-public-host.invalid",
      DETACHES_PUBLIC_BASE_URL: publicBaseUrl,
      DETACHES_REVERSE_BRIDGE_REMOTE_HOST: host,
      DETACHES_REVERSE_BRIDGE_REMOTE_PORT: String(serverPort),
      DETACHES_STORAGE_DIR: smokeStorageDir,
      DETACHES_DISABLE_LEGACY_SETTINGS_MIGRATION: "1"
    }
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

  try {
    await waitForHttp(`http://${host}:${serverPort}/`);

    const settings = await requestJson("/api/settings");
    assert.equal(settings.remoteHost, DEFAULT_OPENCLAW_REMOTE_HOST);
    assert.equal(settings.publicBaseUrl, publicBaseUrl);
    assert.equal(settings.reverseBridgeRemoteHost, host);
    assert.equal(settings.reverseBridgeRemotePort, serverPort);
    assert.equal(settings.hasAuthToken, true);
    assert.equal(settings.activeProfileId, "default");
    assert.equal(settings.profiles.length, 1);
    assert.equal(settings.profiles[0].remoteHost, DEFAULT_OPENCLAW_REMOTE_HOST);

    const createdProfile = await requestJson("/api/settings/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Office Gateway", copyFromProfileId: "default", remoteHost: "10.12.7.139", gatewayDirectHost: "10.12.7.139" })
    });
    assert.equal(createdProfile.remoteHost, "10.12.7.139");
    const officeProfile = createdProfile.profiles.find((profile) => profile.name === "Office Gateway");
    assert.ok(officeProfile);
    assert.equal(createdProfile.activeProfileId, officeProfile.id);
    const defaultProfile = createdProfile.profiles.find((profile) => profile.id === "default");
    assert.ok(defaultProfile);
    const defaultProfileId = defaultProfile.id;
    const reactivatedDefault = await requestJson(`/api/settings/profiles/${defaultProfileId}/activate`, { method: "POST" });
    assert.equal(reactivatedDefault.activeProfileId, "default");
    const officeProfileId = officeProfile.id;
    const deletedProfile = await requestJson(`/api/settings/profiles/${officeProfileId}`, { method: "DELETE" });
    assert.equal(deletedProfile.profiles.some((profile) => profile.id === officeProfileId), false);
    assert.equal(deletedProfile.activeProfileId, "default");
    const emptyPasswordBootstrap = await fetch(`http://${host}:${serverPort}/api/settings/profiles/default/bootstrap-ssh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "" })
    });
    assert.equal(emptyPasswordBootstrap.status, 400);
    assert.match(await emptyPasswordBootstrap.text(), /SSH (user|password) is required/);

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
    const brokerCapabilities = await requestJson("/api/tools/broker/capabilities");
    assert.equal(brokerCapabilities.ok, true);
    assert.equal(brokerCapabilities.protocolVersion, 1);
    assert.equal(typeof brokerCapabilities.localMachine?.os, "string");
    assert.equal(typeof brokerCapabilities.localMachine?.commandDialect, "string");
    assert.equal(brokerCapabilities.gatewayEventEndpoint, `${reverseBridgeBaseUrl}/api/tools/events/gateway`);
    assert.equal(brokerCapabilities.requestFormats.includes("broker-event"), true);
    assert.equal(brokerCapabilities.contextExport.oneTime, true);
    assert.equal(brokerCapabilities.contextExport.adapterCommand, "context-fetch");
    assert.equal(brokerCapabilities.contextExport.doctorCommand, "doctor");
    assert.equal(brokerCapabilities.contextExport.createEndpoint, `${reverseBridgeBaseUrl}/api/context/exports`);
    const adapterCli = path.resolve(fileURLToPath(new URL("../../../packages/openclaw-detaches-adapter/bin/detaches-agent-adapter.mjs", import.meta.url)));
    const adapterProbe = await execFileAsync(process.execPath, [adapterCli, "broker-probe", publicBaseUrl]);
    assert.equal(JSON.parse(adapterProbe.stdout).ok, true);

    const agents = await requestJson("/api/agents");
    assert.equal(agents.agents.length, 3);
    assert.equal(agents.source, "gateway-agents-rpc+sessions");
    assert.deepEqual(agents.agents.map((agent) => agent.id).sort(), [
      "agent-alpha",
      "agent-beta",
      "agent-gamma"
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
    assert.match(assertPath(upload.file.localPath), /storage(?:-smoke)?\/uploads\/.+P100协议说明-示例\.txt$/);

    const rejectedDownload = await fetch(`http://${host}:${serverPort}/api/files/download?remotePath=${encodeURIComponent("/etc/passwd")}`);
    assert.equal(rejectedDownload.status, 400);
    assert.match(await rejectedDownload.text(), /outside the configured workspace/);

    const chatSessionKey = "agent:agent-alpha:main";
    const exportedContext = await requestJson(`/api/context/${encodeURIComponent(chatSessionKey)}?sessionMode=main`);
    assert.equal(exportedContext.sessionKey, chatSessionKey);
    assert.equal(exportedContext.sessionMode, "main");
    assert.equal(exportedContext.detaches.app, "detaches_agent");
    assert.equal(exportedContext.detaches.sessionKey, chatSessionKey);
    assert.equal(exportedContext.detaches.agentId, "agent-alpha");
    assert.equal(exportedContext.detaches.broker.submitToken, undefined);
    assert.equal(exportedContext.detaches.broker.submitTokenRedacted, true);
    assert.equal(exportedContext.redacted.brokerSubmitToken, true);
    const exportedContextWithToken = await requestJson(`/api/context/${encodeURIComponent(chatSessionKey)}?sessionMode=main&includeSubmitToken=true`);
    assert.equal(exportedContextWithToken.sessionKey, chatSessionKey);
    assert.equal(exportedContextWithToken.redacted.brokerSubmitToken, false);
    assert.equal(typeof exportedContextWithToken.detaches.broker.submitToken, "string");
    assert.equal(exportedContextWithToken.detaches.broker.submitTokenHeader, "Authorization");
    const contextExport = await requestJson("/api/context/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: chatSessionKey, sessionMode: "main" })
    });
    assert.equal(contextExport.sessionKey, chatSessionKey);
    assert.match(contextExport.consumeUrl, new RegExp(`^${reverseBridgeBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/context/exports/`));
    const consumedContextExport = await requestJson(contextExport.consumeUrl.replace(publicBaseUrl, ""));
    assert.equal(consumedContextExport.sessionKey, chatSessionKey);
    assert.equal(consumedContextExport.redacted.brokerSubmitToken, false);
    assert.equal(consumedContextExport.detaches.broker.submitToken, exportedContextWithToken.detaches.broker.submitToken);
    const consumedContextExportAgain = await fetch(contextExport.consumeUrl);
    assert.equal(consumedContextExportAgain.status, 404);
    assert.match(await consumedContextExportAgain.text(), /already consumed|invalid|expired/);

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
    assert.equal(history.payload.messages[0].runId, "run-history-smoke-1");

    const adapterInfo = await requestJson("/api/adapters/openclaw-detaches");
    assert.equal(adapterInfo.id, "detaches_agent.openclaw.adapter");
    assert.equal(adapterInfo.manifest.targets["local-user-machine"].status, "supported");
    assert.equal(adapterInfo.manifest.skill.manifest, "skill.manifest.json");
    assert.equal(adapterInfo.files.some((file) => file.path === "AGENT.md" && /^[a-f0-9]{64}$/.test(file.sha256)), true);
    assert.equal(adapterInfo.files.some((file) => file.path === "SKILL.md" && /^[a-f0-9]{64}$/.test(file.sha256)), true);
    assert.equal(adapterInfo.files.some((file) => file.path === "README.md" && /^[a-f0-9]{64}$/.test(file.sha256)), true);
    assert.equal(adapterInfo.files.some((file) => file.path === "skill.manifest.json" && /^[a-f0-9]{64}$/.test(file.sha256)), true);
    assert.match(adapterInfo.bundle.downloadUrl, /\/api\/adapters\/openclaw-detaches\/bundle$/);
    const adapterAgentDoc = await fetch(`http://${host}:${serverPort}/api/adapters/openclaw-detaches/files/${encodeURIComponent("AGENT.md")}`);
    assert.equal(adapterAgentDoc.status, 200);
    assert.match(await adapterAgentDoc.text(), /detaches_agent OpenClaw Adapter/);
    const adapterBundle = await fetch(`http://${host}:${serverPort}${adapterInfo.bundle.downloadUrl}`);
    assert.equal(adapterBundle.status, 200);
    assert.equal(adapterBundle.headers.get("content-type"), "application/gzip");
    assert.equal((await adapterBundle.arrayBuffer()).byteLength, adapterInfo.bundle.size);
    const adapterInstallPlan = await requestJson(`/api/adapters/openclaw-detaches/install-plan?baseUrl=${encodeURIComponent(`http://${host}:${serverPort}`)}&installDir=${encodeURIComponent("~/.detach_agent_smoke")}`);
    assert.equal(adapterInstallPlan.target, "remote-agent-host");
    assert.equal(adapterInstallPlan.adapterId, "detaches_agent.openclaw.adapter");
    assert.equal(adapterInstallPlan.workspaceDir, "~/.openclaw/workspace");
    assert.equal(adapterInstallPlan.bundleUrl, `http://${host}:${serverPort}/api/adapters/openclaw-detaches/bundle`);
    assert.equal(adapterInstallPlan.bundleSha256, adapterInfo.bundle.sha256);
    assert.equal(adapterInstallPlan.commands.some((command) => /curl -fL/.test(command)), true);
    assert.equal(adapterInstallPlan.commands.some((command) => /shasum -a 256/.test(command)), true);
    assert.equal(adapterInstallPlan.commands.some((command) => /grep -q/.test(command)), true);
    assert.equal(adapterInstallPlan.commands.some((command) => /expand_path/.test(command)), true);
    assert.equal(adapterInstallPlan.commands.some((command) => /skills\/detaches-agent\/SKILL\.md/.test(command)), true);
    assert.equal(adapterInstallPlan.commands.some((command) => /command -v node/.test(command)), true);
    assert.equal(adapterInstallPlan.commands.some((command) => /openclaw skills info detaches-agent --json/.test(command)), true);
    assert.equal(adapterInstallPlan.verifyCommands.some((command) => /detaches_agent\.openclaw\.adapter/.test(command)), true);
    assert.equal(adapterInstallPlan.verifyCommands.some((command) => /openclaw skills info detaches-agent --json/.test(command)), true);
    const adapterReadiness = await requestJson("/api/adapters/openclaw-detaches/readiness");
    assert.equal(adapterReadiness.target, "local-distribution");
    assert.equal(adapterReadiness.state, "ready");
    assert.equal(adapterReadiness.expectedAdapterId, "detaches_agent.openclaw.adapter");
    assert.equal(adapterReadiness.checks.every((check) => check.state === "ready"), true);
    assert.equal(adapterReadiness.checks.some((check) => check.id === "skill-manifest"), true);
    assert.equal(adapterReadiness.checks.some((check) => check.id === "openclaw-skill"), true);
    const missingAdapterReadiness = await requestJson(`/api/adapters/openclaw-detaches/readiness?target=remote-agent-host&installDir=${encodeURIComponent("/tmp/detaches-agent-missing-adapter-smoke")}`);
    assert.equal(missingAdapterReadiness.target, "remote-agent-host");
    assert.equal(missingAdapterReadiness.state, "missing");
    assert.equal(missingAdapterReadiness.checks.some((check) => check.id === "install-dir" && check.state === "missing"), true);
    const remoteProbeWithoutUser = await requestJson(`/api/adapters/openclaw-detaches/readiness?probe=remote-ssh&installDir=${encodeURIComponent("~/.detach_agent")}`);
    assert.equal(remoteProbeWithoutUser.target, "remote-agent-host");
    assert.equal(remoteProbeWithoutUser.probe, "remote-ssh");
    assert.equal(remoteProbeWithoutUser.state, "error");
    assert.equal(remoteProbeWithoutUser.checks.some((check) => check.id === "ssh-config" || check.id === "ssh"), true);

    chat.send(JSON.stringify({
      type: "send",
      message: "hello clean smoke",
      attachments: [upload.file],
      idempotencyKey: "smoke-default-clean"
    }));

    while (!observed.chatSends.some((item) => item.idempotencyKey === "smoke-default-clean")) {
      if (Date.now() - started > 8000) throw new Error("Timed out waiting for default clean chat send.");
      await wait(50);
    }
    const defaultCleanSend = observed.chatSends.find((item) => item.idempotencyKey === "smoke-default-clean");
    assert.equal(defaultCleanSend.sessionKey, chatSessionKey);
    assert.match(defaultCleanSend.message, /^hello clean smoke/);
    assert.doesNotMatch(defaultCleanSend.message, /\[\[DETACH_AGENT_FILE_STAGED\]\]/);
    assert.doesNotMatch(defaultCleanSend.message, /\[detaches_agent context\]/);
    assert.equal(defaultCleanSend.clientContext, undefined);
    assert.equal(defaultCleanSend.attachments, undefined);

    chat.send(JSON.stringify({
      type: "send",
      message: "hello smoke",
      attachments: [upload.file],
      includeLocalControlContext: true,
      includeStagedFileContext: true,
      activationReason: "file-transfer",
      localControlScope: "agent-alpha:device:smoke",
      idempotencyKey: "smoke-idempotency"
    }));

    while (!observed.chatSends.some((item) => item.idempotencyKey === "smoke-idempotency") || !messages.some((message) => message.type === "chat")) {
      if (Date.now() - started > 8000) throw new Error("Timed out waiting for chat send response.");
      await wait(50);
    }
    const userChatSend = observed.chatSends.find((item) => item.idempotencyKey === "smoke-idempotency");
    assert.equal(userChatSend.sessionKey, chatSessionKey);
    assert.match(userChatSend.message, /^hello smoke/);
    assert.match(userChatSend.message, /\[\[DETACH_AGENT_FILE_STAGED\]\]/);
    assert.match(userChatSend.message, /P100协议说明-示例\.txt/);
    assert.match(userChatSend.message, new RegExp(`fileId: ${upload.file.id}`));
    assert.match(userChatSend.message, /currentLocation: user-local-machine detaches_agent staging/);
    assert.match(userChatSend.message, /remotePath: not uploaded/);
    assert.match(userChatSend.message, /```main-agent-save-file/);
    assert.match(userChatSend.message, /"destination":\{/);
    assert.match(userChatSend.message, /\[detaches_agent context\]/);
    assert.match(userChatSend.message, /agentId: agent-alpha/);
    assert.match(userChatSend.message, /remoteAdapter: state=error/);
    assert.match(userChatSend.message, /contextExport\.consumeUrl: unavailable/);
    assert.doesNotMatch(userChatSend.message, /doctor --url/);
    assert.doesNotMatch(userChatSend.message, new RegExp(`toolBroker: gatewayEventEndpoint=${publicBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(userChatSend.idempotencyKey, "smoke-idempotency");
    assert.equal(userChatSend.clientContext?.app, "detaches_agent");
    assert.equal(userChatSend.clientContext?.detaches?.app, "detaches_agent");
    assert.equal(userChatSend.clientContext?.detaches?.version, 1);
    assert.equal(userChatSend.clientContext?.detaches?.sessionKey, chatSessionKey);
    assert.equal(userChatSend.clientContext?.detaches?.agentId, "agent-alpha");
    assert.equal(typeof userChatSend.clientContext?.detaches?.localMachine?.os, "string");
    assert.equal(typeof userChatSend.clientContext?.detaches?.localMachine?.commandDialect, "string");
    assert.equal(userChatSend.clientContext?.detaches?.adapterStatus?.remoteAgentHost?.state, "error");
    assert.equal(userChatSend.clientContext?.detaches?.files?.staged?.length, 1);
    assert.equal(userChatSend.clientContext?.detaches?.files?.staged?.[0]?.fileId, upload.file.id);
    assert.equal(userChatSend.clientContext?.detaches?.files?.staged?.[0]?.displayName, "P100协议说明-示例.txt");
    assert.equal(userChatSend.clientContext?.detaches?.files?.staged?.[0]?.currentLocation, "user-local-staging");
    assert.equal(userChatSend.clientContext?.detaches?.files?.staged?.[0]?.transfer?.requestFence, "detaches-file-transfer");
    assert.equal(userChatSend.clientContext?.detaches?.files?.staged?.[0]?.transfer?.defaultTarget, "main-agent-machine");
    assert.equal(userChatSend.clientContext?.detaches?.files?.staged?.[0]?.transfer?.supportedTargets?.includes("remote-agent-host"), true);
    assert.equal(userChatSend.clientContext?.detaches?.files?.staged?.[0]?.transfer?.supportedTargets?.includes("main-agent-machine"), true);
    assert.equal(userChatSend.clientContext?.detaches?.broker?.gatewayEventEndpoint, "");
    assert.equal(typeof userChatSend.clientContext?.detaches?.broker?.submitToken, "string");
    assert.equal(userChatSend.clientContext?.detaches?.broker?.submitToken, exportedContextWithToken.detaches.broker.submitToken);
    assert.equal(userChatSend.clientContext?.detaches?.broker?.submitTokenHeader, "Authorization");
    assert.equal(userChatSend.clientContext?.detaches?.broker?.requestFormats?.includes("broker-event"), true);
    assert.equal(userChatSend.clientContext?.detaches?.contextExport?.oneTime, true);
    assert.equal(userChatSend.clientContext?.detaches?.contextExport?.adapterCommand, "context-fetch");
    assert.equal(userChatSend.clientContext?.detaches?.contextExport?.doctorCommand, "doctor");
    assert.equal(userChatSend.clientContext?.detaches?.contextExport?.createdBy, "detaches-ui-loopback");
    assert.equal(userChatSend.clientContext?.detaches?.contextExport?.generatedForMessage, true);
    assert.equal(userChatSend.clientContext?.detaches?.contextExport?.consumeUrl, undefined);
    assert.equal(userChatSend.clientContext?.detaches?.capabilities?.some((capability) => capability.name === "terminal" && capability.supportedTargets.includes("local-user-machine")), true);
    assert.equal(userChatSend.clientContext?.routeContext?.origin?.provider, "detaches_agent");
    assert.equal(userChatSend.attachments, undefined);
    const cloudPromptLogPath = path.join(smokeStorageDir, "logs", "cloud-prompts.jsonl");
    const cloudPromptEvents = await waitForJsonl(
      cloudPromptLogPath,
      (events) => events.some((event) => event.event === "chat.send" && event.payload?.idempotencyKey === "smoke-idempotency")
    );
    const userPromptEvent = cloudPromptEvents.find((event) => event.event === "chat.send" && event.payload?.idempotencyKey === "smoke-idempotency");
    assert.equal(userPromptEvent.phase, "initial");
    assert.equal(userPromptEvent.method, "chat.send");
    assert.equal(userPromptEvent.sessionKey, chatSessionKey);
    assert.equal(userPromptEvent.includeClientContext, true);
    assert.equal(userPromptEvent.includeLocalControlContext, true);
    assert.equal(userPromptEvent.includeStagedFileContext, true);
    assert.equal(userPromptEvent.localControlScope, "agent-alpha:device:smoke");
    assert.equal(userPromptEvent.activationReason, "file-transfer");
    assert.match(userPromptEvent.payload.message, /^hello smoke/);
    assert.match(userPromptEvent.payload.message, /\[\[DETACH_AGENT_FILE_STAGED\]\]/);
    assert.match(userPromptEvent.payload.message, /\[detaches_agent context\]/);
    assert.equal(userPromptEvent.payload.clientContext.detaches.broker.submitToken, userChatSend.clientContext.detaches.broker.submitToken);
    assert.match(userPromptEvent.payload.clientContext.detaches.files.staged[0].transfer.remotePathRule, /main-agent-save-file request/);
    const decisionActor = {
      deviceId: userChatSend.clientContext.detaches.userDevice.deviceId,
      deviceIdShort: userChatSend.clientContext.detaches.userDevice.deviceIdShort,
      displayName: userChatSend.clientContext.detaches.userDevice.displayName,
      source: "detaches-ui"
    };
    const brokerSubmitToken = userChatSend.clientContext.detaches.broker.submitToken;

    const preparedTransfer = await requestJson("/api/files/transfer/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: upload.file.id, target: "local-user-machine", remotePath: localTransferPath })
    });
    assert.equal(preparedTransfer.fileId, upload.file.id);
    assert.equal(preparedTransfer.target, "local-user-machine");
    assert.equal(preparedTransfer.remotePath, localTransferPath);
    assert.match(preparedTransfer.downloadUrl, new RegExp(`^${publicBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/files/staged/`));
    assert.match(preparedTransfer.command, /curl(?:\.exe)? -fL/);
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
        payload: { command: terminalSmokeCommand }
      })
    });
    assert.equal(terminalTool.request.status, "pending");
    assert.equal(terminalTool.request.risk.level, "safe");
    const pendingToolList = await requestJson(`/api/tools/requests?sessionKey=${encodeURIComponent(chatSessionKey)}&agentId=agent-alpha&status=pending&limit=10`);
    assert.equal(pendingToolList.requests.some((request) => request.id === terminalTool.request.id), true);
    const approvedTerminalTool = await requestJson(`/api/tools/requests/${terminalTool.request.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: decisionActor })
    });
    assert.equal(approvedTerminalTool.request.status, "approved");
    assert.equal(approvedTerminalTool.request.lastDecision.actor.deviceIdShort, decisionActor.deviceIdShort);
    assert.equal(approvedTerminalTool.command, terminalSmokeCommand);
    assert.equal(approvedTerminalTool.execution.target, "local-user-machine");
    assert.equal(approvedTerminalTool.execution.sessionKey, chatSessionKey);
    assert.equal(approvedTerminalTool.execution.wroteToTerminal, true);
    assert.match(approvedTerminalTool.execution.terminalId, /.+/);
    let terminalToolResult = await requestJson(`/api/tools/requests/${terminalTool.request.id}/result`);
    while (!terminalToolResult.result.completed) {
      if (Date.now() - started > 12000) throw new Error("Timed out waiting for terminal tool completion marker.");
      await wait(100);
      terminalToolResult = await requestJson(`/api/tools/requests/${terminalTool.request.id}/result`);
    }
    assert.equal(terminalToolResult.result.requestId, terminalTool.request.id);
    assert.equal(terminalToolResult.result.executionId, approvedTerminalTool.execution.executionId);
    assert.equal(terminalToolResult.result.terminalId, approvedTerminalTool.execution.terminalId);
    assert.equal(terminalToolResult.result.sessionKey, chatSessionKey);
    assert.equal(terminalToolResult.result.completed, true);
    assert.equal(terminalToolResult.result.exitCode, 0);
    assert.match(terminalToolResult.result.forwardStatus, /pending|sent/);
    assert.match(terminalToolResult.result.output, /smoke-complete/);
    assert.equal(typeof terminalToolResult.result.output, "string");
    assert.equal(terminalToolResult.result.outputBytes >= 0, true);
    while (!observed.chatSends.some((item) => item.idempotencyKey === `detaches-tool-result:${approvedTerminalTool.execution.executionId}`)) {
      if (Date.now() - started > 12000) throw new Error("Timed out waiting for tool result forward.");
      await wait(50);
    }
    const forwardedToolResult = observed.chatSends.find((item) => item.idempotencyKey === `detaches-tool-result:${approvedTerminalTool.execution.executionId}`);
    assert.equal(forwardedToolResult.sessionKey, chatSessionKey);
    assert.match(forwardedToolResult.message, /detaches_agent 工具结果/);
    assert.match(forwardedToolResult.message, new RegExp(terminalTool.request.id));
    assert.equal(forwardedToolResult.clientContext?.toolResult, true);
    const forwardedTerminalToolResult = await requestJson(`/api/tools/requests/${terminalTool.request.id}/result`);
    assert.equal(forwardedTerminalToolResult.result.forwardStatus, "sent");
    assert.equal(typeof forwardedTerminalToolResult.result.forwardedAt, "string");
    const retriedTerminalToolForward = await requestJson(`/api/tools/requests/${terminalTool.request.id}/forward`, { method: "POST" });
    assert.equal(retriedTerminalToolForward.result.forwardStatus, "sent");
    const approvedToolList = await requestJson(`/api/tools/requests?sessionKey=${encodeURIComponent(chatSessionKey)}&agentId=agent-alpha&status=approved&limit=10`);
    assert.equal(approvedToolList.requests.some((request) => request.id === terminalTool.request.id), true);

    const toolStream = new WebSocket(`ws://${host}:${serverPort}/api/tools/stream?sessionKey=${encodeURIComponent(chatSessionKey)}&agentId=agent-alpha`);
    const toolStreamMessages = [];
    toolStream.on("message", (data) => {
      toolStreamMessages.push(JSON.parse(data.toString("utf8")));
    });
    await once(toolStream, "open");
    while (!toolStreamMessages.some((message) => message.type === "ready")) {
      if (Date.now() - started > 12000) throw new Error("Timed out waiting for tool stream ready.");
      await wait(50);
    }

    const rejectedGatewayToolEvent = await fetch(`http://${host}:${serverPort}/api/tools/events/gateway`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "terminal",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        sourceEventId: "gateway-tool-event-smoke-1",
        reason: "structured gateway tool event",
        payload: { command: "echo gateway-event" }
      })
    });
    assert.equal(rejectedGatewayToolEvent.status, 401);
    const gatewayToolEvent = await requestJson("/api/tools/events/gateway", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${brokerSubmitToken}` },
      body: JSON.stringify({
        kind: "terminal",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        sourceEventId: "gateway-tool-event-smoke-1",
        reason: "structured gateway tool event",
        payload: { command: "echo gateway-event" }
      })
    });
    assert.equal(gatewayToolEvent.request.source, "gateway-event");
    assert.equal(gatewayToolEvent.request.sourceEventId, "gateway-tool-event-smoke-1");
    const duplicateGatewayToolEvent = await requestJson("/api/tools/events/gateway", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${brokerSubmitToken}` },
      body: JSON.stringify({
        kind: "terminal",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        sourceEventId: "gateway-tool-event-smoke-1",
        reason: "duplicate structured gateway tool event",
        payload: { command: "echo gateway-event-again" }
      })
    });
    assert.equal(duplicateGatewayToolEvent.request.id, gatewayToolEvent.request.id);
    const adapterEventOutput = await execFileAsync(process.execPath, [
      adapterCli,
      "terminal-request",
      "--target",
      "local-user-machine",
      "--command",
      "echo adapter-event",
      "--reason",
      "adapter-generated structured event",
      "--format",
      "broker-event",
      "--session-key",
      chatSessionKey,
      "--agent-id",
      "agent-alpha",
      "--source-event-id",
      "adapter-tool-event-smoke-1",
      "--submit-token",
      brokerSubmitToken,
      "--submit-url",
      `${publicBaseUrl}/api/tools/events/gateway`
    ]);
    const adapterGeneratedToolEvent = JSON.parse(adapterEventOutput.stdout);
    assert.equal(adapterGeneratedToolEvent.request.source, "gateway-event");
    assert.equal(adapterGeneratedToolEvent.request.sourceEventId, "adapter-tool-event-smoke-1");
    assert.equal(adapterGeneratedToolEvent.request.payload.command, "echo adapter-event");
    const gatewayEventToolList = await requestJson(`/api/tools/requests?sessionKey=${encodeURIComponent(chatSessionKey)}&agentId=agent-alpha&status=pending&limit=50`);
    assert.equal(gatewayEventToolList.requests.filter((request) => request.sourceEventId === "gateway-tool-event-smoke-1").length, 1);
    assert.equal(gatewayEventToolList.requests.filter((request) => request.sourceEventId === "adapter-tool-event-smoke-1").length, 1);
    const hasToolStreamAction = (action) => toolStreamMessages.some((message) => message.type === "request" && message.action === action && message.request?.id === gatewayToolEvent.request.id);
    while (!hasToolStreamAction("created") || !hasToolStreamAction("ingested") || !hasToolStreamAction("duplicate")) {
      if (Date.now() - started > 12000) throw new Error(`Timed out waiting for tool stream request event: ${JSON.stringify(toolStreamMessages)}`);
      await wait(50);
    }
    assert.equal(hasToolStreamAction("created"), true);
    assert.equal(hasToolStreamAction("ingested"), true);
    assert.equal(hasToolStreamAction("duplicate"), true);
    toolStream.close();

    const elevatedTerminalTool = await requestJson("/api/tools/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "terminal",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        reason: "smoke elevated terminal risk",
        payload: { command: "chmod --help >/dev/null" }
      })
    });
    assert.equal(elevatedTerminalTool.request.status, "pending");
    assert.equal(elevatedTerminalTool.request.risk.level, "elevated");
    assert.match(elevatedTerminalTool.request.risk.reasons.join(" "), /elevated\.permissions/);
    const rejectedElevatedApprove = await fetch(`http://${host}:${serverPort}/api/tools/requests/${elevatedTerminalTool.request.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(rejectedElevatedApprove.status, 400);
    assert.match(await rejectedElevatedApprove.text(), /requires explicit confirmation/);
    const confirmedElevatedApprove = await requestJson(`/api/tools/requests/${elevatedTerminalTool.request.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ riskAccepted: true, actor: decisionActor })
    });
    assert.equal(confirmedElevatedApprove.request.status, "approved");
    assert.equal(confirmedElevatedApprove.request.lastDecision.riskAccepted, true);

    const adapterInstallTool = await requestJson("/api/tools/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "adapter-install",
        target: "remote-agent-host",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        reason: "smoke adapter install approval",
        payload: { installDir: "~/.detach_agent_smoke" }
      })
    });
    assert.equal(adapterInstallTool.request.status, "pending");
    assert.equal(adapterInstallTool.request.risk.level, "elevated");
    assert.match(adapterInstallTool.request.risk.reasons.join(" "), /Command Guard policy matched/);
    const adapterInstallWithoutConfirmation = await fetch(`http://${host}:${serverPort}/api/tools/requests/${adapterInstallTool.request.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(adapterInstallWithoutConfirmation.status, 400);
    assert.match(await adapterInstallWithoutConfirmation.text(), /requires explicit confirmation/);
    const adapterInstallConfirmed = await requestJson(`/api/tools/requests/${adapterInstallTool.request.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ riskAccepted: true, actor: decisionActor })
    });
    assert.equal(adapterInstallConfirmed.request.status, "failed");
    assert.match(adapterInstallConfirmed.message, /Remote SSH user is not configured/);

    const destructiveTerminalTool = await requestJson("/api/tools/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "terminal",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        reason: "smoke destructive terminal risk",
        payload: { command: "rm -rf /" }
      })
    });
    assert.equal(destructiveTerminalTool.request.status, "blocked");
    assert.equal(destructiveTerminalTool.request.risk.level, "destructive");
    assert.match(destructiveTerminalTool.request.error, /destructive\.rm-root/);

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
    const rejectedBlockedTool = await requestJson(`/api/tools/requests/${blockedTerminalTool.request.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: decisionActor })
    });
    assert.equal(rejectedBlockedTool.request.lastDecision.actor.source, "detaches-ui");

    const brokerUploadForm = new FormData();
    brokerUploadForm.append("sessionKey", chatSessionKey);
    brokerUploadForm.append("file", new Blob(["broker"], { type: "text/plain" }), "broker-transfer.txt");
    const brokerUpload = await requestJson("/api/files/upload", { method: "POST", body: brokerUploadForm });

    const brokerTransfer = await requestJson("/api/tools/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "file-transfer",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        reason: "smoke file broker",
        payload: { fileId: brokerUpload.file.id, remotePath: brokerTransferPath }
      })
    });
    assert.equal(brokerTransfer.request.status, "pending");
    assert.equal(brokerTransfer.request.risk.level, "elevated");
    const approvedBrokerTransfer = await requestJson(`/api/tools/requests/${brokerTransfer.request.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ riskAccepted: true, actor: decisionActor })
    });
    assert.equal(approvedBrokerTransfer.request.status, "succeeded");
    assert.match(approvedBrokerTransfer.command, /curl(?:\.exe)? -fL/);
    assert.match(approvedBrokerTransfer.command, /detaches-note-via-broker\.txt/);
    assert.equal(approvedBrokerTransfer.execution.wroteToTerminal, false);
    assert.ok(approvedBrokerTransfer.execution.terminalId);
    assert.equal(approvedBrokerTransfer.execution.completed, true);
    assert.equal(approvedBrokerTransfer.execution.exitCode, 0);
    assert.equal(approvedBrokerTransfer.execution.sessionKey, chatSessionKey);
    let brokerTransferResult = await requestJson(`/api/tools/requests/${brokerTransfer.request.id}/result`);
    while (!brokerTransferResult.result.completed) {
      if (Date.now() - started > 12000) throw new Error("Timed out waiting for broker transfer completion marker.");
      await wait(100);
      brokerTransferResult = await requestJson(`/api/tools/requests/${brokerTransfer.request.id}/result`);
    }
    assert.equal(brokerTransferResult.result.executionId, approvedBrokerTransfer.execution.executionId);
    assert.equal(brokerTransferResult.result.terminalId, approvedBrokerTransfer.execution.terminalId);
    assert.equal(brokerTransferResult.result.exitCode, 0);
    while (!observed.chatSends.some((item) => item.idempotencyKey === `detaches-tool-result:${approvedBrokerTransfer.execution.executionId}`)) {
      if (Date.now() - started > 12000) throw new Error("Timed out waiting for broker transfer result forward.");
      await wait(50);
    }

    const failingUploadForm = new FormData();
    failingUploadForm.append("sessionKey", chatSessionKey);
    failingUploadForm.append("file", new Blob(["retry-after-failure"], { type: "text/plain" }), "retry-after-failure.txt");
    const failingUpload = await requestJson("/api/files/upload", { method: "POST", body: failingUploadForm });
    const failingBrokerTransfer = await requestJson("/api/tools/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "file-transfer",
        target: "local-user-machine",
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        reason: "smoke file broker failure keeps staged file retryable",
        payload: { fileId: failingUpload.file.id, remotePath: failingTransferPath }
      })
    });
    assert.equal(failingBrokerTransfer.request.risk.level, "elevated");
    const approvedFailingBrokerTransfer = await requestJson(`/api/tools/requests/${failingBrokerTransfer.request.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ riskAccepted: true, actor: decisionActor })
    });
    assert.equal(approvedFailingBrokerTransfer.request.status, "failed");
    assert.equal(approvedFailingBrokerTransfer.execution.completed, true);
    assert.notEqual(approvedFailingBrokerTransfer.execution.exitCode, 0);
    assert.match(approvedFailingBrokerTransfer.request.error, /curl|Failed|directory|exited/i);
    const retryAfterFailure = await requestJson("/api/files/transfer/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileId: failingUpload.file.id,
        target: "local-user-machine",
        remotePath: retryTransferPath,
        sessionKey: chatSessionKey,
        agentId: "agent-alpha"
      })
    });
    assert.equal(retryAfterFailure.target, "local-user-machine");
    assert.match(retryAfterFailure.command, /detaches-retry-after-failure\.txt/);

    const extractedTools = await requestJson("/api/tools/requests/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: chatSessionKey,
        agentId: "agent-alpha",
        sourceMessageId: "message-smoke-tools-1",
        sourceRunId: "run-smoke-tools-1",
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
    assert.equal(extractedTools.requests[0].sourceMessageId, "message-smoke-tools-1");
    assert.equal(extractedTools.requests[0].sourceRunId, "run-smoke-tools-1");
    assert.equal(extractedTools.requests[0].payload.command, "echo broker-parse");
    assert.equal(extractedTools.requests[1].target, "remote-agent-host");
    assert.equal(extractedTools.requests[1].status, "blocked");

    const relativeRemoteTransfer = await fetch(`http://${host}:${serverPort}/api/files/transfer/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: upload.file.id, target: "remote-agent-host", agentId: "agent-alpha", remotePath: "docs/detaches-note.txt" })
    });
    assert.equal(relativeRemoteTransfer.status, 400);
    assert.match(await relativeRemoteTransfer.text(), /remotePath must be an absolute path/);

    const missingUserRemoteTransfer = await fetch(`http://${host}:${serverPort}/api/files/transfer/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: upload.file.id, target: "remote-agent-host", agentId: "agent-alpha", remotePath: "/tmp/openclaw/workspace/agent-alpha/docs/detaches-note.txt" })
    });
    assert.equal(missingUserRemoteTransfer.status, 400);
    assert.match(await missingUserRemoteTransfer.text(), /requires OPENCLAW_REMOTE_USER/);

    await requestJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicBaseUrl: "http://100.64.0.10:39888", remoteUser: "smoke-user" })
    });
    const preparedRemoteTransfer = await requestJson("/api/files/transfer/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: upload.file.id, target: "remote-agent-host", agentId: "agent-alpha", remotePath: "/tmp/openclaw/workspace/agent-alpha/docs/detaches-note.txt" })
    });
    assert.equal(preparedRemoteTransfer.target, "remote-agent-host");
    assert.equal(preparedRemoteTransfer.remotePath, "/tmp/openclaw/workspace/agent-alpha/docs/detaches-note.txt");
    assert.match(preparedRemoteTransfer.downloadUrl, new RegExp(`^${reverseBridgeBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/files/staged/`));
    assert.match(preparedRemoteTransfer.command, /ssh/);
    assert.match(preparedRemoteTransfer.command, /smoke-user@100\.74\.38\.97/);
    assert.match(preparedRemoteTransfer.command, /curl -fL/);
    assert.doesNotMatch(preparedRemoteTransfer.command, /100\.64\.0\.10:39888/);
    await requestJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicBaseUrl, remoteUser: "" })
    });

    const escapedRemoteTransfer = await fetch(`http://${host}:${serverPort}/api/files/transfer/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: upload.file.id, target: "remote-agent-host", agentId: "agent-alpha", remotePath: "/etc/passwd" })
    });
    assert.equal(escapedRemoteTransfer.status, 400);
    assert.match(await escapedRemoteTransfer.text(), /remotePath must be an absolute path inside the remote agent workspace/);

    const stagedDownload = await fetch(preparedTransfer.downloadUrl);
    assert.equal(stagedDownload.status, 200);
    assert.equal(await stagedDownload.text(), "hello");
    const repeatedDownload = await fetch(preparedTransfer.downloadUrl);
    assert.equal(repeatedDownload.status, 200);
    assert.equal(await repeatedDownload.text(), "hello");

    const auditPath = path.join(smokeStorageDir, "logs/file-transfer-audit.jsonl");
    const auditEvents = await waitForJsonl(auditPath, (events) => (
      events.some((event) => event.type === "transfer.download.cleanup" && event.fileId === upload.file.id && event.target === "local-user-machine" && event.deleted === false)
    ));
    assert.equal(auditEvents.some((event) => event.type === "upload" && event.fileId === upload.file.id), true);
    assert.equal(auditEvents.some((event) => event.type === "transfer.prepare" && event.fileId === upload.file.id && event.target === "local-user-machine" && event.remotePath === localTransferPath), true);
    assert.equal(auditEvents.some((event) => event.type === "transfer.download.start" && event.fileId === upload.file.id && event.target === "local-user-machine"), true);
    assert.equal(auditEvents.some((event) => event.type === "transfer.download.cleanup" && event.fileId === upload.file.id && event.target === "local-user-machine" && event.deleted === false), true);
    assert.equal(auditEvents.some((event) => event.type === "transfer.error" && event.fileId === upload.file.id && event.target === "remote-agent-host" && event.agentId === "agent-alpha" && event.workspace === "/tmp/openclaw/workspace/agent-alpha"), true);

    const toolAuditPath = path.join(smokeStorageDir, "logs/tool-broker-audit.jsonl");
    const toolAuditEvents = await waitForJsonl(toolAuditPath, (events) => (
      events.some((event) => event.type === "tool.result.forward" && event.status === "sent")
    ));
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.create" && event.request.kind === "terminal" && event.request.target === "local-user-machine"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.create" && event.request.kind === "terminal" && event.request.target === "remote-agent-host" && event.request.status === "blocked"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.create" && event.request.payload?.command === "echo broker-parse"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.ingest" && event.sourceEventId === "gateway-tool-event-smoke-1" && event.duplicate === false), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.ingest" && event.sourceEventId === "gateway-tool-event-smoke-1" && event.duplicate === true), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.approve" && event.command === terminalSmokeCommand && typeof event.terminalId === "string"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.approve" && event.actor?.deviceIdShort === decisionActor.deviceIdShort), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.create" && event.request.kind === "adapter-install" && event.request.target === "remote-agent-host" && event.request.risk?.level === "elevated"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.approve" && event.requestId === adapterInstallTool.request.id && event.status === "failed"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.reject" && event.actor?.source === "detaches-ui"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.approve" && /detaches-note-via-broker\.txt/.test(event.command || "") && typeof event.terminalId === "string"), true);
    assert.equal(toolAuditEvents.some((event) => event.type === "tool.result.forward" && event.status === "sent"), true);

    const compatMessageCountBefore = messages.filter((message) => message.type === "sent").length;
    chat.send(JSON.stringify({
      type: "send",
      message: "client-context-compat smoke",
      includeLocalControlContext: true,
      includeStagedFileContext: false,
      activationReason: "user-click",
      localControlScope: "agent-alpha:device:smoke",
      idempotencyKey: "smoke-client-context-compat"
    }));
    while (
      messages.filter((message) => message.type === "sent").length <= compatMessageCountBefore ||
      !observed.chatSends.some((item) => item.idempotencyKey === "smoke-client-context-compat" && !item.clientContext)
    ) {
      if (Date.now() - started > 12000) throw new Error("Timed out waiting for clientContext compatibility retry.");
      await wait(50);
    }
    const compatAttempts = observed.chatSends.filter((item) => item.idempotencyKey === "smoke-client-context-compat");
    assert.equal(compatAttempts.length, 2);
    assert.equal(compatAttempts[0].clientContext?.app, "detaches_agent");
    assert.equal(compatAttempts[1].clientContext, undefined);
    assert.match(compatAttempts[1].message, /\[detaches_agent compatibility context\]/);
    assert.match(compatAttempts[1].message, /contextExport\.consumeUrl: unavailable/);
    assert.doesNotMatch(compatAttempts[1].message, /doctor --url/);

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
