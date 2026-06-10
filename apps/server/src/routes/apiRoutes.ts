import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import multer from "multer";
import type { AppHealth, DetachesContextExportResponse, DiagnosticItem, DiagnosticsResponse, NetworkTestResponse, NetworkTestStep, ToolDecisionActor, ToolTarget } from "@detaches/shared";
import { appConfig, publicServerBaseUrl } from "../config/appConfig.js";
import { settingsStore, runtimeConfig } from "../config/settingsStore.js";
import { sshTunnelService } from "../services/tunnel/sshTunnelService.js";
import { gatewayClient } from "../services/gateway/gatewayClient.js";
import { loadOrCreateDeviceIdentity } from "../services/gateway/deviceIdentityService.js";
import { listAgents } from "../services/gateway/agentDirectoryService.js";
import { fileTransferService } from "../services/files/fileTransferService.js";
import { buildChatClientContext, publicClientIdentity } from "../services/clientContextService.js";
import { toolBrokerService } from "../services/tools/toolBrokerService.js";
import { brokerTokenService } from "../services/tools/brokerTokenService.js";
import { openclawDetachesAdapterService } from "../services/adapters/openclawDetachesAdapterService.js";
import { contextExportService } from "../services/context/contextExportService.js";

const upload = multer({
  dest: path.join(appConfig.storageDir, "cache"),
  limits: { fileSize: appConfig.maxUploadMb * 1024 * 1024 }
});

export const apiRoutes = express.Router();

const execFileAsync = promisify(execFile);

function isLoopbackRequest(req: express.Request): boolean {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function buildContextExportBody(
  sessionKey: string,
  sessionMode: "main" | "device",
  includeSubmitToken: boolean
): Promise<DetachesContextExportResponse> {
  const rawClientContext = await buildChatClientContext(sessionMode, sessionKey);
  const cloned = cloneJson(rawClientContext);
  const detaches = cloned.detaches as { broker?: { submitToken?: string; submitTokenRedacted?: boolean } } | undefined;
  if (!detaches || typeof detaches !== "object") {
    throw new Error("detaches context was not generated.");
  }
  let brokerSubmitTokenRedacted = false;
  if (detaches?.broker?.submitToken) {
    if (!includeSubmitToken) {
      delete detaches.broker.submitToken;
      detaches.broker.submitTokenRedacted = true;
      brokerSubmitTokenRedacted = true;
    }
  }
  return {
    sessionKey,
    sessionMode,
    clientContext: cloned,
    detaches: detaches as DetachesContextExportResponse["detaches"],
    redacted: {
      brokerSubmitToken: brokerSubmitTokenRedacted
    }
  };
}

function tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<{ ok: boolean; message: string; durationMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    let settled = false;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, message, durationMs: Date.now() - startedAt });
    };
    socket.once("connect", () => finish(true, `TCP ${host}:${port} is reachable.`));
    socket.once("error", (error) => finish(false, error.message));
    socket.setTimeout(timeoutMs, () => finish(false, `TCP ${host}:${port} timed out after ${timeoutMs}ms.`));
  });
}

async function tailscalePingProbe(host: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("tailscale", ["ping", "--c", "1", "--timeout=3s", host], { timeout: 5000 });
    const output = `${stdout}${stderr}`.trim();
    const ok = output.includes("pong from") || output.includes("is local Tailscale IP");
    return { ok, message: output || "tailscale ping returned no output." };
  } catch (error) {
    const anyError = error as any;
    const output = `${anyError.stdout ?? ""}${anyError.stderr ?? ""}`.trim();
    const ok = output.includes("pong from") || output.includes("is local Tailscale IP");
    return { ok, message: output || anyError.message || "tailscale ping failed." };
  }
}

async function runNetworkTest(): Promise<NetworkTestResponse> {
  const config = await runtimeConfig();
  const steps: NetworkTestStep[] = [];
  steps.push({
    id: "settings",
    label: "配置",
    state: "ok",
    message: `${config.gatewayTransport === "ssh" ? "SSH tunnel" : "Direct"} -> ${config.remoteHost}:${config.gatewayRemotePort}`,
    details: {
      remoteHost: config.remoteHost,
      remoteSshPort: config.remoteSshPort,
      gatewayTransport: config.gatewayTransport,
      gatewayDirectHost: config.gatewayDirectHost,
      gatewayLocalPort: config.gatewayLocalPort,
      gatewayRemotePort: config.gatewayRemotePort
    }
  });

  if (config.gatewayTransport === "ssh") {
    if (/^(100\.|[a-z0-9.-]+\.ts\.net$)/i.test(config.remoteHost)) {
      const tailscale = await tailscalePingProbe(config.remoteHost);
      steps.push({
        id: "tailscale-peer",
        label: "Tailscale peer",
        state: tailscale.ok ? "ok" : "error",
        message: tailscale.message,
        details: tailscale
      });
    }
    const ssh = await tcpProbe(config.remoteHost, config.remoteSshPort);
    steps.push({
      id: "ssh-tcp",
      label: "SSH 端口",
      state: ssh.ok ? "ok" : "error",
      message: ssh.message,
      details: ssh
    });
    const tunnel = await sshTunnelService.ensure();
    steps.push({
      id: "ssh-tunnel",
      label: "SSH 隧道",
      state: tunnel.ok ? "ok" : "error",
      message: tunnel.ok && tunnel.pid
        ? `SSH tunnel is listening on 127.0.0.1:${tunnel.localPort}.`
        : tunnel.message,
      details: tunnel
    });
    const owner = await sshTunnelService.localPortOwner(config.gatewayLocalPort);
    const localGateway = owner
      ? { ok: true, message: `127.0.0.1:${config.gatewayLocalPort} is listening (${owner.command} ${owner.pid}).`, owner }
      : { ok: false, message: `127.0.0.1:${config.gatewayLocalPort} is not listening.`, owner: null };
    steps.push({
      id: "local-gateway-port",
      label: "本地 Gateway 端口",
      state: localGateway.ok ? "ok" : "error",
      message: localGateway.message,
      details: localGateway
    });
  } else {
    const direct = await tcpProbe(config.gatewayDirectHost, config.gatewayRemotePort);
    steps.push({
      id: "direct-gateway-port",
      label: "直连 Gateway 端口",
      state: direct.ok ? "ok" : "error",
      message: direct.message,
      details: direct
    });
  }

  try {
    await gatewayClient.health();
    steps.push({
      id: "gateway-health",
      label: "Gateway health",
      state: "ok",
      message: "Gateway health check passed.",
      details: { hello: gatewayClient.getHello() }
    });
  } catch (error) {
    steps.push({
      id: "gateway-health",
      label: "Gateway health",
      state: "error",
      message: gatewayClient.getLastError() ?? (error instanceof Error ? error.message : String(error))
    });
  }

  return { steps, checkedAt: new Date().toISOString() };
}

async function checkHealth(): Promise<AppHealth> {
  const config = await runtimeConfig();
  const tunnel = config.gatewayTransport === "ssh"
    ? await sshTunnelService.ensure()
    : {
      ok: true,
      message: `Direct Gateway transport enabled: ${config.gatewayDirectHost}:${config.gatewayRemotePort}.`,
      localPort: config.gatewayLocalPort
    };
  let gatewayOk = false;
  let gatewayMessage = "Gateway not checked.";
  try {
    await gatewayClient.health();
    gatewayOk = true;
    gatewayMessage = "Gateway health check passed.";
  } catch (error) {
    gatewayMessage = gatewayClient.getLastError() ?? (error instanceof Error ? error.message : String(error));
  }
  const body: AppHealth = {
    server: { state: "ok", message: "Local server is running." },
    ssh: {
      state: config.gatewayTransport === "direct" ? "disabled" : tunnel.ok ? "ok" : "error",
      message: tunnel.message,
      details: tunnel
    },
    gateway: {
      state: gatewayOk ? "ok" : "error",
      message: gatewayMessage,
      details: { hello: gatewayClient.getHello(), lastError: gatewayClient.getLastError() }
    },
    config: {
      remoteHost: config.remoteHost,
      remoteSshPort: config.remoteSshPort,
      gatewayTransport: config.gatewayTransport,
      gatewayDirectHost: config.gatewayDirectHost,
      gatewayLocalPort: config.gatewayLocalPort,
      gatewayRemotePort: config.gatewayRemotePort,
      authMode: config.authMode
    },
    checkedAt: new Date().toISOString()
  };
  return body;
}

function classifyGatewayAuth(message: string): DiagnosticItem | null {
  const normalized = message.toLowerCase();
  if (normalized.includes("token missing") || normalized.includes("auth token missing")) {
    return {
      id: "gateway-token-missing",
      severity: "error",
      title: "Gateway token required",
      message,
      action: "Set the Gateway token in the UI settings panel or OPENCLAW_AUTH_TOKEN. On the gateway host, check openclaw config get gateway.auth.token or OPENCLAW_GATEWAY_TOKEN."
    };
  }
  if (normalized.includes("token mismatch") || normalized.includes("auth token mismatch")) {
    return {
      id: "gateway-token-mismatch",
      severity: "error",
      title: "Gateway token mismatch",
      message,
      action: "Verify gateway.auth.token or OPENCLAW_GATEWAY_TOKEN on the gateway host, then save the matching token locally."
    };
  }
  if (normalized.includes("password")) {
    return {
      id: "gateway-password-auth",
      severity: "error",
      title: "Gateway password auth issue",
      message,
      action: "If this Gateway uses password auth, set auth mode to password in the settings panel. Token auth is preferred for this UI."
    };
  }
  if (normalized.includes("pairing required") || normalized.includes("device") && normalized.includes("required")) {
    const identity = loadOrCreateDeviceIdentity();
    return {
      id: "gateway-pairing-required",
      severity: "warning",
      title: "Gateway pairing required",
      message,
      action: `Approve this device from an already paired OpenClaw client, or approve the pending request on the gateway host. Device ID: ${identity.deviceId}`,
      details: { deviceId: identity.deviceId }
    };
  }
  return null;
}

function diagnosticsFromHealth(health: AppHealth): DiagnosticItem[] {
  const items: DiagnosticItem[] = [];
  if (health.ssh.state === "error") {
    const message = health.ssh.message;
    const normalized = message.toLowerCase();
    if (normalized.includes("remote_user") || normalized.includes("not configured")) {
      items.push({
        id: "ssh-user-missing",
        severity: "warning",
        title: "SSH user is not configured",
        message,
        action: "Set SSH user and identity in the settings panel. If a local Gateway is already exposed on the configured local port, chat can still work without SSH."
      });
    } else if (normalized.includes("host key verification failed")) {
      items.push({
        id: "ssh-host-key",
        severity: "error",
        title: "SSH host key verification failed",
        message,
        action: `Run ssh-keygen -R ${health.config.remoteHost}, then reconnect after confirming the host key is expected.`
      });
    } else {
      items.push({
        id: "ssh-tunnel-failed",
        severity: "error",
        title: "SSH tunnel failed",
        message,
        action: "Verify SSH user, key path, host, port, remote SSH reachability, and that the local tunnel port is not owned by a non-ssh process."
      });
    }
  }

  if (health.ssh.state === "disabled" && health.config.gatewayTransport === "direct") {
    items.push({
      id: "gateway-direct",
      severity: "info",
      title: "Direct Gateway transport",
      message: `Connecting directly to ${health.config.gatewayDirectHost}:${health.config.gatewayRemotePort}.`,
      action: "Use this mode when the remote Gateway allows Tailscale/LAN access. Switch back to SSH tunnel if the Gateway only binds to remote loopback."
    });
  }

  if (health.gateway.state === "error") {
    const authItem = classifyGatewayAuth(health.gateway.message);
    items.push(authItem ?? {
      id: "gateway-unavailable",
      severity: "error",
      title: "Gateway is unavailable",
      message: health.gateway.message,
      action: health.config.gatewayTransport === "direct"
        ? `Verify OpenClaw Gateway is listening on ${health.config.gatewayDirectHost}:${health.config.gatewayRemotePort}, Tailscale ACLs allow this port, and host firewall rules allow inbound TCP.`
        : `Verify OpenClaw Gateway is running on the remote host at 127.0.0.1:${health.config.gatewayRemotePort} and the local tunnel points to port ${health.config.gatewayLocalPort}.`
    });
  }

  if (!items.length) {
    items.push({
      id: "ready",
      severity: "info",
      title: "Connection ready",
      message: "Local server, SSH tunnel, and Gateway health check passed."
    });
  }
  return items;
}

apiRoutes.get("/health", async (_req, res) => {
  const body = await checkHealth();
  res.json(body);
});

apiRoutes.get("/diagnostics", async (_req, res) => {
  const health = await checkHealth();
  const body: DiagnosticsResponse = {
    items: diagnosticsFromHealth(health),
    health,
    checkedAt: new Date().toISOString()
  };
  res.json(body);
});

apiRoutes.post("/network/test", async (_req, res) => {
  res.json(await runNetworkTest());
});

apiRoutes.get("/settings", async (_req, res) => {
  res.json(await settingsStore.publicSettings());
});

apiRoutes.get("/client", (_req, res) => {
  res.json(publicClientIdentity());
});

apiRoutes.get("/context/:sessionKey", async (req, res) => {
  const sessionKey = String(req.params.sessionKey || "").trim();
  const sessionMode = req.query.sessionMode === "main" ? "main" : "device";
  const includeSubmitToken = req.query.includeSubmitToken === "true" || req.query.includeSubmitToken === "1";
  if (!sessionKey) {
    res.status(400).json({ error: "sessionKey is required." });
    return;
  }
  if (includeSubmitToken && !isLoopbackRequest(req)) {
    res.status(403).json({ error: "includeSubmitToken is only allowed from loopback requests." });
    return;
  }

  try {
    res.json(await buildContextExportBody(sessionKey, sessionMode, includeSubmitToken));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/context/exports", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "context exports can only be created from loopback requests." });
    return;
  }
  const sessionKey = String(req.body?.sessionKey || "").trim();
  const sessionMode = req.body?.sessionMode === "main" ? "main" : "device";
  if (!sessionKey) {
    res.status(400).json({ error: "sessionKey is required." });
    return;
  }
  try {
    const record = contextExportService.create({ sessionKey, sessionMode });
    res.json({
      sessionKey: record.sessionKey,
      sessionMode: record.sessionMode,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      consumeUrl: `${publicServerBaseUrl(await runtimeConfig())}/api/context/exports/${encodeURIComponent(record.token)}`
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/context/exports/:token", async (req, res) => {
  const record = contextExportService.consume(String(req.params.token || ""));
  if (!record) {
    res.status(404).json({ error: "context export token is invalid, expired, or already consumed." });
    return;
  }
  try {
    res.json(await buildContextExportBody(record.sessionKey, record.sessionMode, true));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.put("/settings", async (req, res) => {
  await settingsStore.update(req.body ?? {});
  gatewayClient.disconnect();
  sshTunnelService.stop();
  res.json(await settingsStore.publicSettings());
});

apiRoutes.get("/gateway/status", async (_req, res) => {
  try {
    await gatewayClient.connect();
    res.json({ ok: true, hello: gatewayClient.getHello(), health: await gatewayClient.health() });
  } catch (error) {
    res.status(503).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/gateway/capabilities", async (_req, res) => {
  try {
    res.json(await gatewayClient.capabilitySummary());
  } catch (error) {
    res.status(503).json({ connected: false, error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/adapters/openclaw-detaches", async (_req, res) => {
  try {
    res.json(await openclawDetachesAdapterService.info());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/adapters/openclaw-detaches/bundle", async (_req, res) => {
  try {
    const bundle = await openclawDetachesAdapterService.bundle();
    res.setHeader("Content-Type", bundle.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${bundle.fileName}"`);
    res.send(bundle.buffer);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/adapters/openclaw-detaches/install-plan", async (req, res) => {
  try {
    const baseUrl = typeof req.query.baseUrl === "string" ? req.query.baseUrl : undefined;
    const installDir = typeof req.query.installDir === "string" ? req.query.installDir : undefined;
    const workspaceDir = typeof req.query.workspaceDir === "string" ? req.query.workspaceDir : undefined;
    res.json(await openclawDetachesAdapterService.installPlan({ baseUrl, installDir, workspaceDir }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/adapters/openclaw-detaches/readiness", async (req, res) => {
  try {
    const installDir = typeof req.query.installDir === "string" ? req.query.installDir : undefined;
    const workspaceDir = typeof req.query.workspaceDir === "string" ? req.query.workspaceDir : undefined;
    const target = req.query.target === "remote-agent-host" || req.query.target === "local-distribution"
      ? req.query.target
      : undefined;
    const probe = req.query.probe === "remote-ssh" ? "remote-ssh" : "local-fs";
    res.json(probe === "remote-ssh"
      ? await openclawDetachesAdapterService.remoteReadiness({ installDir, workspaceDir })
      : await openclawDetachesAdapterService.readiness({ installDir, workspaceDir, target }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/adapters/openclaw-detaches/files/*", async (req, res) => {
  try {
    const params = req.params as Record<string, string | string[] | undefined>;
    const rawFilePath = params[0] ?? params[""];
    const filePath = Array.isArray(rawFilePath) ? rawFilePath.join("/") : rawFilePath || "";
    const file = await openclawDetachesAdapterService.file(filePath);
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${path.basename(file.path)}"`);
    res.send(file.buffer);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/agents", async (_req, res) => {
  try {
    res.json(await listAgents());
  } catch (error) {
    res.status(503).json({ agents: [], source: "fallback", error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/files/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Missing file." });
    return;
  }
  try {
    const file = await fileTransferService.saveUpload(req.file);
    res.json({ file });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function parseToolTarget(value: unknown): ToolTarget {
  if (value === "remote-agent-host" || value === "gateway-managed" || value === "local-user-machine") {
    return value;
  }
  return "local-user-machine";
}

function isToolRequestStatus(value: string): value is "pending" | "approved" | "rejected" | "blocked" | "started" | "failed" {
  return value === "pending"
    || value === "approved"
    || value === "rejected"
    || value === "blocked"
    || value === "started"
    || value === "failed";
}

function parseToolDecisionActor(value: unknown): ToolDecisionActor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    deviceId: typeof record.deviceId === "string" ? record.deviceId.trim() : undefined,
    deviceIdShort: typeof record.deviceIdShort === "string" ? record.deviceIdShort.trim() : undefined,
    displayName: typeof record.displayName === "string" ? record.displayName.trim() : undefined,
    source: record.source === "detaches-ui" || record.source === "api" || record.source === "unknown" ? record.source : "api"
  };
}

function extractBrokerSubmitToken(req: express.Request): string {
  const auth = req.header("authorization") || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  if (typeof req.body.submitToken === "string") return req.body.submitToken.trim();
  if (req.body.payload && typeof req.body.payload === "object" && !Array.isArray(req.body.payload)) {
    const payload = req.body.payload as Record<string, unknown>;
    if (typeof payload.submitToken === "string") return payload.submitToken.trim();
  }
  return "";
}

apiRoutes.post("/files/transfer/prepare", async (req, res) => {
  try {
    const fileId = String(req.body.fileId || "");
    const remotePath = String(req.body.remotePath || "");
    const target = parseToolTarget(req.body.target);
    const agentId = typeof req.body.agentId === "string" ? req.body.agentId.trim() : undefined;
    const sessionKey = typeof req.body.sessionKey === "string" ? req.body.sessionKey.trim() : undefined;
    if (!fileId || !remotePath) {
      res.status(400).json({ error: "Missing fileId or remotePath." });
      return;
    }
    res.json(await fileTransferService.prepareTransfer({ fileId, target, remotePath, agentId, sessionKey }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/tools/requests", async (req, res) => {
  try {
    const kind = req.body.kind === "file-transfer" ? "file-transfer" : req.body.kind === "terminal" ? "terminal" : req.body.kind === "adapter-install" ? "adapter-install" : null;
    const target = parseToolTarget(req.body.target);
    const sessionKey = typeof req.body.sessionKey === "string" ? req.body.sessionKey.trim() : "";
    const agentId = typeof req.body.agentId === "string" ? req.body.agentId.trim() : undefined;
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : undefined;
    const payload = req.body.payload && typeof req.body.payload === "object" && !Array.isArray(req.body.payload)
      ? req.body.payload
      : {};
    if (!kind || !sessionKey) {
      res.status(400).json({ error: "Missing kind or sessionKey." });
      return;
    }
    res.json({ request: await toolBrokerService.create({ kind, target, sessionKey, agentId, reason, source: "api", payload }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/tools/events/gateway", async (req, res) => {
  try {
    const kind = req.body.kind === "file-transfer" ? "file-transfer" : req.body.kind === "terminal" ? "terminal" : req.body.kind === "adapter-install" ? "adapter-install" : null;
    const target = parseToolTarget(req.body.target);
    const sessionKey = typeof req.body.sessionKey === "string" ? req.body.sessionKey.trim() : "";
    const sourceEventId = typeof req.body.sourceEventId === "string" ? req.body.sourceEventId.trim() : "";
    const agentId = typeof req.body.agentId === "string" ? req.body.agentId.trim() : undefined;
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : undefined;
    const payload = req.body.payload && typeof req.body.payload === "object" && !Array.isArray(req.body.payload)
      ? req.body.payload
      : {};
    if (!kind || !sessionKey || !sourceEventId) {
      res.status(400).json({ error: "Missing kind, sessionKey, or sourceEventId." });
      return;
    }
    if (!brokerTokenService.verify(sessionKey, extractBrokerSubmitToken(req))) {
      res.status(401).json({ error: "Invalid or missing broker submit token." });
      return;
    }
    res.json(await toolBrokerService.ingestGatewayEvent({
      kind,
      target,
      sessionKey,
      agentId,
      reason,
      source: "gateway-event",
      sourceEventId,
      payload
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/tools/broker/capabilities", async (_req, res) => {
  const config = await runtimeConfig();
  res.json({
    ok: true,
    app: "detaches_agent",
    protocolVersion: 1,
    gatewayEventEndpoint: `${publicServerBaseUrl(config)}/api/tools/events/gateway`,
    eventSource: "gateway-event",
    idempotencyField: "sourceEventId",
    submitTokenRequired: true,
    submitTokenHeader: "Authorization",
    requestFormats: ["broker-event", "fence"],
    requestKinds: ["terminal", "file-transfer", "adapter-install"],
    contextExport: {
      createEndpoint: `${publicServerBaseUrl(config)}/api/context/exports`,
      consumeEndpointPattern: `${publicServerBaseUrl(config)}/api/context/exports/{token}`,
      createdBy: "detaches-ui-loopback",
      consumedBy: "remote-agent-host",
      oneTime: true,
      ttlSeconds: 300,
      adapterCommand: "context-fetch"
    },
    targets: ["local-user-machine", "remote-agent-host", "gateway-managed"],
    approvalRequired: true,
    adapterId: "detaches_agent.openclaw.adapter"
  });
});

apiRoutes.get("/tools/requests", async (req, res) => {
  try {
    const sessionKey = typeof req.query.sessionKey === "string" ? req.query.sessionKey.trim() : undefined;
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId.trim() : undefined;
    const status = typeof req.query.status === "string" && isToolRequestStatus(req.query.status) ? req.query.status : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    res.json(await toolBrokerService.list({ sessionKey, agentId, status, limit }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/tools/requests/extract", async (req, res) => {
  try {
    const text = typeof req.body.text === "string" ? req.body.text : "";
    const sessionKey = typeof req.body.sessionKey === "string" ? req.body.sessionKey.trim() : "";
    const agentId = typeof req.body.agentId === "string" ? req.body.agentId.trim() : undefined;
    const sourceMessageId = typeof req.body.sourceMessageId === "string" ? req.body.sourceMessageId.trim() : undefined;
    const sourceRunId = typeof req.body.sourceRunId === "string" ? req.body.sourceRunId.trim() : undefined;
    if (!text || !sessionKey) {
      res.status(400).json({ error: "Missing text or sessionKey." });
      return;
    }
    res.json(await toolBrokerService.extractFromText({ text, sessionKey, agentId, sourceMessageId, sourceRunId }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/tools/requests/:requestId/approve", async (req, res) => {
  try {
    const riskAccepted = req.body && typeof req.body === "object" && req.body.riskAccepted === true;
    const actor = parseToolDecisionActor(req.body?.actor);
    res.json(await toolBrokerService.approve(req.params.requestId, { riskAccepted, actor }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/tools/requests/:requestId/result", async (req, res) => {
  try {
    res.json(await toolBrokerService.result(req.params.requestId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/tools/requests/:requestId/forward", async (req, res) => {
  try {
    res.json(await toolBrokerService.retryForward(req.params.requestId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/tools/requests/:requestId/reject", async (req, res) => {
  try {
    const actor = parseToolDecisionActor(req.body?.actor);
    res.json({ request: await toolBrokerService.reject(req.params.requestId, { actor }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/files/staged/:fileId", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    const file = await fileTransferService.consumeStagedDownload(req.params.fileId, token);
    res.download(file.localPath, file.name, async (error) => {
      if (!error) await file.cleanup();
    });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/files/download", async (req, res) => {
  const remotePath = String(req.query.remotePath || "");
  if (!remotePath) {
    res.status(400).json({ error: "Missing remotePath." });
    return;
  }
  try {
    const file = await fileTransferService.downloadRemote(remotePath);
    res.download(file.localPath, file.name, async () => {
      try {
        await fs.unlink(file.localPath);
      } catch {
        // Ignore cleanup errors.
      }
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
