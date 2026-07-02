import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import multer from "multer";
import type { AppHealth, DetachesContextExportResponse, DiagnosticItem, DiagnosticsResponse, InteractionKind, InteractionStatus, NetworkTestResponse, NetworkTestStep, TerminalChannelName, ToolDecisionActor, ToolRequestKind, ToolTarget, UploadedFileRef } from "@detaches/shared";
import { appConfig, reverseBridgeBaseUrl } from "../config/appConfig.js";
import { settingsStore, runtimeConfig } from "../config/settingsStore.js";
import { sshTunnelService } from "../services/tunnel/sshTunnelService.js";
import { gatewayClient } from "../services/gateway/gatewayClient.js";
import { loadOrCreateDeviceIdentity } from "../services/gateway/deviceIdentityService.js";
import { listAgents } from "../services/gateway/agentDirectoryService.js";
import { fileTransferService } from "../services/files/fileTransferService.js";
import { mainAgentFileTransferService } from "../services/files/mainAgentFileTransferService.js";
import { buildChatClientContext, publicClientIdentity } from "../services/clientContextService.js";
import { toolBrokerService } from "../services/tools/toolBrokerService.js";
import { brokerTokenService } from "../services/tools/brokerTokenService.js";
import { openclawDetachesAdapterService } from "../services/adapters/openclawDetachesAdapterService.js";
import { contextExportService } from "../services/context/contextExportService.js";
import { bootstrapSshIdentity } from "../services/ssh/sshBootstrapService.js";
import { sshCredentialSessionService } from "../services/ssh/sshCredentialSessionService.js";
import { localTerminalAppService } from "../services/terminal/localTerminalAppService.js";
import { adminTerminalService } from "../services/terminal/adminTerminalService.js";
import { resolveDirectGatewayUrl } from "../services/gateway/gatewayClient.js";
import { platformService } from "../services/platform/platformService.js";
import { buildLocalMachineContext } from "../services/platform/localMachineContext.js";
import { cloudPromptLogService } from "../services/gateway/cloudPromptLogService.js";
import { interactionBrokerService } from "../services/interactions/interactionBrokerService.js";
import { callbackAddressService } from "../services/callback/callbackAddressService.js";
import { agentTerminalService } from "../services/agentTerminal/agentTerminalService.js";
import { libraryService } from "../services/library/libraryService.js";

const upload = multer({
  dest: path.join(appConfig.storageDir, "cache"),
  limits: { fileSize: appConfig.maxUploadMb * 1024 * 1024 }
});
const uploadSingleFile = upload.single("file");

export const apiRoutes = express.Router();

const execFileAsync = promisify(execFile);
const DEFAULT_FILEBROWSER_PORT = 8002;

apiRoutes.get("/terminal/apps", async (_req, res) => {
  try {
    res.json(await localTerminalAppService.list());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/terminal/apps/:appId/open", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Opening local terminal apps is only allowed from the local machine." });
    return;
  }
  try {
    res.json(await localTerminalAppService.open(req.params.appId));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/terminal/admin/:sessionKey/status", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Administrator terminal status is only available from the local Detach Agent UI." });
    return;
  }
  res.json(adminTerminalService.status(decodeURIComponent(req.params.sessionKey)));
});

apiRoutes.post("/terminal/admin/:sessionKey/enable", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Administrator terminal can only be enabled from the local Detach Agent UI." });
    return;
  }
  try {
    res.json(await adminTerminalService.enable(decodeURIComponent(req.params.sessionKey)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/terminal/admin/:sessionKey/disable", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Administrator terminal can only be disabled from the local Detach Agent UI." });
    return;
  }
  try {
    res.json(await adminTerminalService.disable(decodeURIComponent(req.params.sessionKey)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/terminal/admin/:sessionKey/debug-launch", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Administrator terminal diagnostics are only available from the local Detach Agent UI." });
    return;
  }
  res.json(adminTerminalService.debugLaunch(decodeURIComponent(req.params.sessionKey)));
});

apiRoutes.post("/agent-terminal/bootstrap", async (req, res) => {
  try {
    res.json(await agentTerminalService.bootstrap({
      remoteAddress: req.socket.remoteAddress || "",
      sessionKey: typeof req.body?.sessionKey === "string" ? req.body.sessionKey : undefined,
      agentId: typeof req.body?.agentId === "string" ? req.body.agentId : undefined,
      displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined
    }));
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.post("/agent-terminal/sessions", async (req, res) => {
  try {
    res.json(await agentTerminalService.bootstrap({
      remoteAddress: req.socket.remoteAddress || "",
      sessionKey: typeof req.body?.sessionKey === "string" ? req.body.sessionKey : undefined,
      agentId: typeof req.body?.agentId === "string" ? req.body.agentId : undefined,
      displayName: typeof req.body?.displayName === "string" ? req.body.displayName : undefined
    }));
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.get("/agent-terminal/sessions", async (_req, res) => {
  try {
    res.json(await agentTerminalService.listSessions());
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.get("/agent-terminal/sessions/:terminalSessionId", async (req, res) => {
  try {
    res.json({ terminalSession: await agentTerminalService.session(req.params.terminalSessionId) });
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.post("/agent-terminal/sessions/:terminalSessionId/revoke", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Agent terminal sessions can only be revoked from the local Detach Agent UI." });
    return;
  }
  try {
    res.json({ terminalSession: await agentTerminalService.revokeSession(req.params.terminalSessionId) });
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.post("/agent-terminal/sessions/:terminalSessionId/authorize", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Agent terminal sessions can only be authorized from the local Detach Agent UI." });
    return;
  }
  try {
    res.json(await agentTerminalService.authorizeSession(req.params.terminalSessionId));
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.post("/agent-terminal/runs", async (req, res) => {
  try {
    const wait = req.query.wait === "true" || req.query.wait === "1";
    const timeoutMs = wait ? parsePositiveInt(req.query.timeoutMs, 120_000, 10 * 60 * 1000) : 0;
    res.json(await agentTerminalService.createRun({
      leaseToken: extractBearerToken(req),
      waitMs: timeoutMs,
      request: {
        command: String(req.body?.command || ""),
        reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
        workingDirectory: typeof req.body?.workingDirectory === "string" ? req.body.workingDirectory : null,
        sourceEventId: typeof req.body?.sourceEventId === "string" ? req.body.sourceEventId : undefined
      }
    }));
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.get("/agent-terminal/runs/:runId", async (req, res) => {
  try {
    await agentTerminalService.assertRunLease(req.params.runId, extractBearerToken(req));
    const wait = req.query.wait === "true" || req.query.wait === "1";
    const timeoutMs = wait ? parsePositiveInt(req.query.timeoutMs, 120_000, 10 * 60 * 1000) : 0;
    res.json(wait ? await agentTerminalService.wait(req.params.runId, timeoutMs) : await agentTerminalService.run(req.params.runId));
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.get("/agent-terminal/runs/:runId/stream", async (req, res) => {
  try {
    await agentTerminalService.assertRunLease(req.params.runId, extractBearerToken(req));
  } catch (error) {
    sendAgentTerminalError(res, error);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const cleanup = await agentTerminalService.stream(req.params.runId, (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }).catch((error) => {
    res.write(`event: failed\n`);
    res.write(`data: ${JSON.stringify({ type: "failed", error: error instanceof Error ? error.message : String(error) })}\n\n`);
    return undefined;
  });
  const interval = setInterval(() => {
    void agentTerminalService.run(req.params.runId).catch(() => undefined);
  }, 750);
  req.on("close", () => {
    clearInterval(interval);
    cleanup?.();
  });
});

apiRoutes.post("/agent-terminal/runs/:runId/cancel", async (req, res) => {
  try {
    await agentTerminalService.assertRunLease(req.params.runId, extractBearerToken(req));
    res.json(await agentTerminalService.cancel(req.params.runId));
  } catch (error) {
    sendAgentTerminalError(res, error);
  }
});

apiRoutes.get("/logs/cloud-prompts", async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 100, 500);
    res.json(await cloudPromptLogService.list(limit));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/library/config", async (_req, res) => {
  try {
    res.json(await libraryService.config());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/library/servers", async (req, res) => {
  try {
    res.json(await libraryService.saveServer({
      id: typeof req.body?.id === "string" ? req.body.id : undefined,
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      host: String(req.body?.host || ""),
      port: req.body?.port,
      agentRootPath: String(req.body?.agentRootPath || "")
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/library/servers/:id/activate", async (req, res) => {
  try {
    res.json(await libraryService.activateServer(req.params.id));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/library/servers/:id/test", async (req, res) => {
  try {
    res.json(await libraryService.testServer(req.params.id));
  } catch (error) {
    const withConfig = error as Error & { config?: unknown };
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
      config: withConfig.config
    });
  }
});

apiRoutes.get("/library/servers/:id/list", async (req, res) => {
  try {
    res.json(await libraryService.listDirectory(req.params.id, typeof req.query.path === "string" ? req.query.path : ""));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/library/servers/:id/resolve", async (req, res) => {
  try {
    res.json(await libraryService.resolvePath(req.params.id, String(req.body?.absolutePath || "")));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/library/servers/:id/check-url", async (req, res) => {
  try {
    res.json(await libraryService.checkUrl(req.params.id, String(req.body?.relativePath || "")));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function isLoopbackRequest(req: express.Request): boolean {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function extractBearerToken(req: express.Request): string {
  const auth = req.header("authorization") || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return "";
}

function sendAgentTerminalError(res: express.Response, error: unknown): void {
  const anyError = error as Error & { code?: string };
  const code = anyError.code || "DETACHES_TERMINAL_INTERNAL_ERROR";
  const status = code === "DETACHES_TERMINAL_LEASE_REVOKED" || code === "DETACHES_TERMINAL_LEASE_EXPIRED" ? 401 : 400;
  res.status(status).json({ ok: false, code, error: anyError.message || String(error) });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(typeof raw === "string" ? raw : "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parsePort(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function sanitizeFileServiceHost(value: string): string | null {
  const host = value.trim();
  if (!host || host.length > 253) return null;
  if (/^https?:\/\//i.test(host) || host.includes("/") || host.includes("?") || host.includes("#")) return null;
  if (host.includes("@") || host.includes(":")) return null;
  return host;
}

function describeFileServiceFetchError(error: unknown, host: string, port: number): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `File Browser connection timed out after 5000ms: ${host}:${port}.`;
  }
  const anyError = error as Error & {
    code?: string;
    cause?: {
      code?: string;
      errno?: number;
      address?: string;
      port?: number;
      message?: string;
    };
  };
  const code = anyError.cause?.code || anyError.code;
  const address = anyError.cause?.address || host;
  const causePort = anyError.cause?.port || port;
  if (code === "ECONNREFUSED") return `Connection refused: ${address}:${causePort}. 请确认 File Browser 已启动并监听该端口。`;
  if (code === "ETIMEDOUT") return `Connection timed out: ${address}:${causePort}. 请确认服务器 IP、端口和防火墙规则。`;
  if (code === "ENOTFOUND") return `Host not found: ${host}. 请确认 IP 或域名。`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `Host unreachable: ${address}:${causePort}. 请确认当前机器能访问 Main Agent 所在网络。`;
  const causeMessage = anyError.cause?.message;
  if (code || causeMessage) return `${code ? `${code}: ` : ""}${causeMessage || anyError.message}`;
  return anyError.message || String(error);
}

async function assertLikelyFileBrowser(response: Response): Promise<void> {
  const contentType = response.headers.get("content-type") || "";
  if (response.status >= 500) throw new Error(`File Browser responded with HTTP ${response.status}.`);
  if (!response.ok && response.status !== 401 && response.status !== 403) {
    throw new Error(`File Browser responded with HTTP ${response.status}.`);
  }
  if (!/text\/html|text\/plain|application\/json/i.test(contentType)) return;
  const body = (await response.text()).slice(0, 64 * 1024);
  // File Browser 的根页面通常会暴露产品名；如果端口返回了别的 Web 服务，提前提示用户换端口或安装服务。
  if (body && !/file\s*browser|filebrowser/i.test(body)) {
    throw new Error("服务有 HTTP 响应，但不像 File Browser。请确认端口指向的是 filebrowser/filebrowser 服务。");
  }
}

async function markFileServiceTested(input: {
  type: "filebrowser";
  host: string;
  port: number;
  status: "ok" | "error";
  error: string;
  checkedAt: string;
}): Promise<void> {
  const settings = await settingsStore.publicSettings();
  await settingsStore.updateProfile(settings.activeProfileId, {
    fileServiceType: input.type,
    fileServiceHost: input.host,
    fileServicePort: input.port,
    fileServiceLastStatus: input.status,
    fileServiceLastTestedAt: input.checkedAt,
    fileServiceLastError: input.error
  });
}

async function buildContextExportBody(
  sessionKey: string,
  sessionMode: "main" | "device",
  includeSubmitToken: boolean,
  attachments: UploadedFileRef[] = []
): Promise<DetachesContextExportResponse> {
  const rawClientContext = await buildChatClientContext(sessionMode, sessionKey, attachments);
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

async function reverseBridgeProbe(): Promise<{ ok: boolean; message: string; details?: unknown }> {
  const config = await runtimeConfig();
  if (!config.remoteUser) {
    return { ok: false, message: "Remote SSH user is not configured; cannot probe reverse bridge." };
  }
  const probeUrl = `${reverseBridgeBaseUrl(config)}/api/ping`;
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-p",
    String(config.remoteSshPort),
    ...(config.remoteIdentityPath ? ["-i", config.remoteIdentityPath] : []),
    `${config.remoteUser}@${config.remoteHost}`,
    `curl -fsS --max-time 8 ${probeUrl} >/dev/null`
  ];
  try {
    const ssh = await platformService.resolveCommand("ssh");
    if (ssh.available === false) {
      return { ok: false, message: `SSH client is not available. Expected command: ${ssh.command}.` };
    }
    await execFileAsync(ssh.command, [...ssh.argsPrefix, ...args], { timeout: 15000 });
    return {
      ok: true,
      message: `Remote agent host can reach detaches_agent through ${reverseBridgeBaseUrl(config)}.`
    };
  } catch (error) {
    const anyError = error as any;
    const output = `${anyError.stdout ?? ""}${anyError.stderr ?? ""}`.trim();
    return {
      ok: false,
      message: output || anyError.message || "Remote reverse bridge probe failed.",
      details: { code: anyError.code, signal: anyError.signal }
    };
  }
}

async function runNetworkTest(): Promise<NetworkTestResponse> {
  const config = await runtimeConfig();
  const steps: NetworkTestStep[] = [];
  const sshTunnelEnabled = config.gatewayTransport === "ssh";
  const shouldCheckMainAgentSsh = config.mainAgentServiceEnabled || sshTunnelEnabled || config.localSshBridgeEnabled;
  const shouldUseReverseBridge = sshTunnelEnabled || config.localSshBridgeEnabled;
  const directGatewayUrl = resolveDirectGatewayUrl(config.gatewayDirectUrl, config.gatewayDirectHost, config.gatewayRemotePort);
  steps.push({
    id: "settings",
    label: "配置",
    state: "ok",
    message: config.gatewayTransport === "ssh"
      ? `SSH tunnel -> ${config.remoteHost}:${config.gatewayRemotePort}`
      : `Direct -> ${directGatewayUrl}`,
    details: {
      remoteHost: config.remoteHost,
      remoteSshPort: config.remoteSshPort,
      mainAgentServiceEnabled: config.mainAgentServiceEnabled,
      localSshBridgeEnabled: config.localSshBridgeEnabled,
      gatewayTransport: config.gatewayTransport,
      gatewayDirectHost: config.gatewayDirectHost,
      gatewayDirectUrl: config.gatewayDirectUrl,
      resolvedGatewayUrl: directGatewayUrl,
      gatewayLocalPort: config.gatewayLocalPort,
      gatewayRemotePort: config.gatewayRemotePort,
      reverseBridgeRemoteHost: config.reverseBridgeRemoteHost,
      reverseBridgeRemotePort: config.reverseBridgeRemotePort
    }
  });

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
  if (shouldCheckMainAgentSsh) {
    const ssh = await tcpProbe(config.remoteHost, config.remoteSshPort);
    steps.push({
      id: "ssh-tcp",
      label: "SSH 端口",
      state: ssh.ok ? "ok" : "error",
      message: ssh.message,
      details: ssh
    });
  } else {
    steps.push({
      id: "ssh-disabled",
      label: "SSH 高级链路",
      state: "disabled",
      message: "默认直连 Gateway 模式未启用 SSH，不检查 Main Agent SSH 或本机 SSH 回连。"
    });
  }

  if (shouldUseReverseBridge) {
    const reverseTunnel = sshTunnelEnabled
      ? await sshTunnelService.ensure()
      : await sshTunnelService.ensureReverseBridge();
    steps.push({
      id: "ssh-reverse-bridge",
      label: "SSH 反向桥",
      state: reverseTunnel.ok ? "ok" : "error",
      message: reverseTunnel.ok && reverseTunnel.pid
        ? `SSH reverse bridge is active at ${reverseTunnel.reverseBrokerUrl}.`
        : reverseTunnel.message,
      details: reverseTunnel
    });
    if (reverseTunnel.ok) {
      const reverseBridge = await reverseBridgeProbe();
      steps.push({
        id: "reverse-bridge",
        label: "远端反向控制入口",
        state: reverseBridge.ok ? "ok" : "error",
        message: reverseBridge.message,
        details: reverseBridge
      });
    }
  }

  if (config.gatewayTransport === "ssh") {
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
    const directUrlConfigured = Boolean(config.gatewayDirectUrl.trim());
    const direct = directUrlConfigured ? null : await tcpProbe(config.gatewayDirectHost, config.gatewayRemotePort);
    steps.push({
      id: "direct-gateway-port",
      label: directUrlConfigured ? "直连 Gateway URL" : "直连 Gateway 端口",
      state: directUrlConfigured ? "ok" : direct?.ok ? "ok" : "error",
      message: directUrlConfigured ? `Using ${directGatewayUrl}; Gateway health will verify the WebSocket endpoint.` : direct?.message ?? "Direct Gateway port was not checked.",
      details: directUrlConfigured ? { url: directGatewayUrl } : direct
    });
  }

  try {
    await gatewayClient.quickHealth();
    steps.push({
      id: "gateway-health",
      label: "Gateway health",
      state: "ok",
      message: "Gateway health check passed.",
      details: { hello: gatewayClient.getHello() }
    });
  } catch (error) {
    const message = gatewayClient.getLastError() ?? (error instanceof Error ? error.message : String(error));
    const authItem = classifyGatewayAuth(message);
    steps.push({
      id: "gateway-health",
      label: "Gateway health",
      state: "error",
      message: authItem ? `${authItem.message}. ${authItem.action}` : message,
      details: authItem ?? { message }
    });
  }

  return { steps, checkedAt: new Date().toISOString() };
}

async function checkHealth(): Promise<AppHealth> {
  const config = await runtimeConfig();
  const shouldUseReverseBridge = config.gatewayTransport === "ssh" || config.localSshBridgeEnabled;
  const tunnel = config.gatewayTransport === "ssh"
    ? await sshTunnelService.ensure()
    : config.localSshBridgeEnabled
      ? await sshTunnelService.ensureReverseBridge()
      : await sshTunnelService.status();
  let gatewayOk = false;
  let gatewayMessage = "Gateway not checked.";
  try {
    await gatewayClient.quickHealth();
    gatewayOk = true;
    gatewayMessage = "Gateway health check passed.";
  } catch (error) {
    gatewayMessage = gatewayClient.getLastError() ?? (error instanceof Error ? error.message : String(error));
  }
  const body: AppHealth = {
    server: { state: "ok", message: "Local server is running." },
    ssh: {
      state: !shouldUseReverseBridge ? "disabled" : tunnel.ok ? "ok" : "error",
      message: shouldUseReverseBridge ? tunnel.message : "SSH tunnel / reverse bridge is disabled by default.",
      details: tunnel
    },
    gateway: {
      state: gatewayOk ? "ok" : "error",
      message: gatewayMessage,
      details: { hello: gatewayClient.getHello(), lastError: gatewayClient.getLastError() }
    },
    agentTerminal: buildAgentTerminalHealth(config),
    config: {
      remoteHost: config.remoteHost,
      remoteSshPort: config.remoteSshPort,
      mainAgentServiceEnabled: config.mainAgentServiceEnabled,
      localSshBridgeEnabled: config.localSshBridgeEnabled,
      gatewayTransport: config.gatewayTransport,
      gatewayDirectHost: config.gatewayDirectHost,
      gatewayLocalPort: config.gatewayLocalPort,
      gatewayRemotePort: config.gatewayRemotePort,
      reverseBridgeRemoteHost: config.reverseBridgeRemoteHost,
      reverseBridgeRemotePort: config.reverseBridgeRemotePort,
      authMode: config.authMode,
      serverHost: config.serverHost,
      serverPort: config.serverPort,
      serverListenHosts: config.serverListenHosts.length ? config.serverListenHosts : [config.serverHost],
      publicBaseUrl: config.publicBaseUrl,
      gatewayTerminalLocalIp: config.gatewayTerminalLocalIp,
      gatewayTerminalLastStatus: config.gatewayTerminalLastStatus,
      gatewayTerminalLastError: config.gatewayTerminalLastError
    },
    checkedAt: new Date().toISOString()
  };
  return body;
}

function buildAgentTerminalHealth(config: Awaited<ReturnType<typeof runtimeConfig>>): AppHealth["agentTerminal"] {
  const listenerHosts = config.serverListenHosts.length ? config.serverListenHosts : [config.serverHost];
  const selectedHost = config.gatewayTerminalLocalIp || callbackAddressService.hostFromBaseUrl(config.publicBaseUrl);
  const listenerReady = Boolean(selectedHost && listenerHosts.includes(selectedHost));
  const apiReady = Boolean(config.publicBaseUrl && config.gatewayTerminalLastStatus === "ok" && listenerReady);
  return {
    state: apiReady ? "ok" : config.publicBaseUrl ? "error" : "disabled",
    message: config.publicBaseUrl
      ? apiReady
        ? `Agent Terminal API is ready at ${config.publicBaseUrl}. Awaiting or using Main Agent terminal-run bootstrap.`
        : config.gatewayTerminalLastError || "Callback address is configured but listener/API is not fully ready."
      : "Agent Terminal API is disabled until publicBaseUrl is configured.",
    details: {
      publicBaseUrl: config.publicBaseUrl,
      listenerHosts,
      listener_ready: listenerReady,
      agent_terminal_api_ready: apiReady,
      awaiting_agent_bootstrap: apiReady,
      session_authorized: false,
      last_run_succeeded: false,
      last_run_failed: false
    }
  };
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
    const approveCommand = buildDeviceApproveCommand(identity.deviceId);
    return {
      id: "gateway-pairing-required",
      severity: "warning",
      title: "Gateway pairing required",
      message,
      action: "需要在 Main Agent 主机批准 detaches_agent 设备。请复制下方命令到 Main Agent 主机终端执行；命令会读取 Main Agent 的 gateway.auth.token 并显式传给 OpenClaw CLI。如果提示 No pending request，先回到这里重新点击“测试网络”，再执行该命令。",
      details: { deviceId: identity.deviceId, approveCommand }
    };
  }
  return null;
}

function buildDeviceApproveCommand(deviceId: string): string {
  const escapedDeviceId = JSON.stringify(deviceId);
  const tokenReader = `const fs=require("fs");const p=require("os").homedir()+"/.openclaw/openclaw.json";const cfg=JSON.parse(fs.readFileSync(p,"utf8"));const token=cfg.gateway&&cfg.gateway.auth&&cfg.gateway.auth.token;if(typeof token!=="string"||!token){console.error("gateway.auth.token is not plaintext in "+p);process.exit(1)}process.stdout.write(token)`;
  const requestReader = `const fs=require("fs");const p=require("os").homedir()+"/.openclaw/devices/pending.json";const pending=JSON.parse(fs.readFileSync(p,"utf8"));const id=${escapedDeviceId};const r=Object.values(pending).find(x=>x&&x.deviceId===id);if(!r){console.error("No pending request for "+id+" in "+p);process.exit(1)}process.stdout.write(r.requestId)`;
  return `TOKEN=$(node -e '${tokenReader}') && REQ=$(node -e '${requestReader}') && openclaw devices approve "$REQ" --token "$TOKEN"`;
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
      action: "SSH tunnel and local SSH reverse bridge are advanced options and stay disabled unless explicitly enabled."
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
      message: health.config.gatewayTransport === "direct" && !health.config.localSshBridgeEnabled
        ? "Local server and direct Gateway health check passed. SSH advanced links are disabled."
        : "Local server, configured SSH link, and Gateway health check passed."
    });
  }
  return items;
}

apiRoutes.get("/ping", (_req, res) => {
  res.json({ ok: true, app: "detaches_agent", checkedAt: new Date().toISOString() });
});

apiRoutes.get("/callback/ips", async (_req, res) => {
  const config = await runtimeConfig();
  res.json(callbackAddressService.listCandidates(config));
});

apiRoutes.post("/callback/test", async (req, res) => {
  const inputBaseUrl = typeof req.body?.publicBaseUrl === "string" ? req.body.publicBaseUrl.trim() : "";
  const settings = await settingsStore.publicSettings();
  const config = await runtimeConfig();
  const publicBaseUrl = inputBaseUrl || settings.publicBaseUrl;
  const validation = callbackAddressService.validatePublicBaseUrl(publicBaseUrl);
  if (!validation.ok) {
    const testedAt = new Date().toISOString();
    await settingsStore.updateProfile(settings.activeProfileId, {
      gatewayTerminalLastStatus: "error",
      gatewayTerminalLastTestedAt: testedAt,
      gatewayTerminalLastError: validation.message
    });
    res.status(400).json({ ok: false, publicBaseUrl, error: validation.message, checkedAt: testedAt });
    return;
  }
  const selectedHost = callbackAddressService.hostFromBaseUrl(publicBaseUrl);
  const listenHosts = config.serverListenHosts.length ? config.serverListenHosts : [config.serverHost];
  const wildcardListening = listenHosts.includes("0.0.0.0") || listenHosts.includes("::");
  if (selectedHost && !wildcardListening && !listenHosts.includes(selectedHost)) {
    const testedAt = new Date().toISOString();
    const message = `当前 Detach Agent server 监听 ${listenHosts.join(", ")}:${config.serverPort}，但选择的回连 IP 是 ${selectedHost}。请保存配置并重启 Detach Agent 后再测试。`;
    await settingsStore.updateProfile(settings.activeProfileId, {
      publicBaseUrl,
      gatewayTerminalLocalIp: selectedHost,
      gatewayTerminalLastStatus: "error",
      gatewayTerminalLastTestedAt: testedAt,
      gatewayTerminalLastError: message
    });
    res.status(409).json({ ok: false, publicBaseUrl, error: message, checkedAt: testedAt, restartRequired: true });
    return;
  }
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${publicBaseUrl.replace(/\/+$/, "")}/api/ping`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const payload = await response.json() as { app?: string };
    if (!response.ok || payload.app !== "detaches_agent") throw new Error(`Unexpected ping response from ${publicBaseUrl}.`);
    await settingsStore.updateProfile(settings.activeProfileId, {
      publicBaseUrl,
      gatewayTerminalLastStatus: "ok",
      gatewayTerminalLastTestedAt: checkedAt,
      gatewayTerminalLastError: ""
    });
    res.json({ ok: true, publicBaseUrl, checkedAt });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "gateway-terminal callback test timed out after 5000ms."
      : error instanceof Error ? error.message : String(error);
    await settingsStore.updateProfile(settings.activeProfileId, {
      publicBaseUrl,
      gatewayTerminalLastStatus: "error",
      gatewayTerminalLastTestedAt: checkedAt,
      gatewayTerminalLastError: message
    });
    res.status(400).json({ ok: false, publicBaseUrl, error: message, checkedAt });
  } finally {
    clearTimeout(timeout);
  }
});

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
  const result = await runNetworkTest();
  const gatewayOk = result.steps.some((step) => step.id === "gateway-health" && step.state === "ok");
  try {
    const settings = await settingsStore.publicSettings();
    await settingsStore.markProfileTested(settings.activeProfileId, gatewayOk ? "ok" : "error");
  } catch {
    // Network test results are still useful even if persisting the profile status fails.
  }
  res.json(result);
});

apiRoutes.post("/file-service/test", async (req, res) => {
  const type = req.body?.type === "filebrowser" ? "filebrowser" : "";
  const rawHost = typeof req.body?.host === "string" ? req.body.host.trim() : "";
  const host = sanitizeFileServiceHost(rawHost);
  const port = parsePort(req.body?.port);
  const checkedAt = new Date().toISOString();

  if (type !== "filebrowser") {
    res.status(400).json({ ok: false, error: "Only filebrowser is supported.", checkedAt });
    return;
  }
  if (!host) {
    res.status(400).json({ ok: false, type, host: rawHost, port: port ?? DEFAULT_FILEBROWSER_PORT, error: "Host must be an IP address or hostname, without protocol, path, or port.", checkedAt });
    return;
  }
  if (!port) {
    res.status(400).json({ ok: false, type, host, port: DEFAULT_FILEBROWSER_PORT, error: "Port must be between 1 and 65535.", checkedAt });
    return;
  }

  const baseUrl = `http://${host}:${port}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    // 这里只做“HTTP 可达性”检查，不代替 File Browser 登录；401/403/404 仍说明服务已响应。
    const response = await fetch(baseUrl, {
      headers: { Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
      redirect: "manual",
      signal: controller.signal
    });
    await assertLikelyFileBrowser(response);
    await markFileServiceTested({ type, host, port, status: "ok", error: "", checkedAt });
    res.json({ ok: true, type, host, port, baseUrl, checkedAt });
  } catch (error) {
    const message = describeFileServiceFetchError(error, host, port);
    // 保存最近一次“有效地址”的测试结果，避免用户返回页面时丢失刚排查的连接错误。
    await markFileServiceTested({ type, host, port, status: "error", error: message, checkedAt });
    res.status(400).json({ ok: false, type, host, port, baseUrl, error: message, checkedAt });
  } finally {
    clearTimeout(timeout);
  }
});

apiRoutes.get("/ssh/session-password", (_req, res) => {
  res.json({ credential: sshCredentialSessionService.status() });
});

apiRoutes.post("/ssh/session-password", async (req, res) => {
  try {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password) {
      res.status(400).json({ error: "Password is required." });
      return;
    }
    res.json({ credential: sshCredentialSessionService.providePassword(password) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/ssh/session-password/dismiss", (_req, res) => {
  res.json({ credential: sshCredentialSessionService.dismiss() });
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
    const context = await buildChatClientContext(sessionMode, sessionKey, [], { createContextExport: false });
    const detaches = context.detaches as DetachesContextExportResponse["detaches"];
    const config = await runtimeConfig();
    const baseUrl = detaches.localControl?.baseUrl?.replace(/\/+$/, "") || reverseBridgeBaseUrl(config);
    res.json({
      sessionKey: record.sessionKey,
      sessionMode: record.sessionMode,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      consumeUrl: baseUrl ? `${baseUrl}/api/context/exports/${encodeURIComponent(record.token)}` : ""
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
    res.json(await buildContextExportBody(record.sessionKey, record.sessionMode, true, record.attachments));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.put("/settings", async (req, res) => {
  await settingsStore.update(req.body ?? {});
  gatewayClient.disconnect();
  sshTunnelService.stop();
  sshCredentialSessionService.clear();
  res.json(await settingsStore.publicSettings());
});

apiRoutes.post("/settings/profiles", async (req, res) => {
  await settingsStore.createProfile(req.body ?? {});
  gatewayClient.disconnect();
  sshTunnelService.stop();
  sshCredentialSessionService.clear();
  res.json(await settingsStore.publicSettings());
});

apiRoutes.put("/settings/profiles/:id", async (req, res) => {
  try {
    await settingsStore.updateProfile(String(req.params.id), req.body ?? {});
    if ((await settingsStore.publicSettings()).activeProfileId === req.params.id) {
      gatewayClient.disconnect();
      sshTunnelService.stop();
      sshCredentialSessionService.clear();
    }
    res.json(await settingsStore.publicSettings());
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/settings/profiles/:id/activate", async (req, res) => {
  try {
    await settingsStore.activateProfile(String(req.params.id));
    gatewayClient.disconnect();
    sshTunnelService.stop();
    sshCredentialSessionService.clear();
    res.json(await settingsStore.publicSettings());
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.delete("/settings/profiles/:id", async (req, res) => {
  try {
    await settingsStore.deleteProfile(String(req.params.id));
    gatewayClient.disconnect();
    sshTunnelService.stop();
    res.json(await settingsStore.publicSettings());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/settings/profiles/:id/bootstrap-ssh", async (req, res) => {
  try {
    const settings = await settingsStore.publicSettings();
    const profile = settings.profiles.find((item) => item.id === req.params.id);
    if (!profile) {
      res.status(404).json({ error: `Remote profile not found: ${req.params.id}` });
      return;
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const identityPath = typeof req.body?.identityPath === "string" ? req.body.identityPath : profile.remoteIdentityPath;
    const result = await bootstrapSshIdentity({
      host: profile.remoteHost,
      port: profile.remoteSshPort,
      user: profile.remoteUser,
      password,
      identityPath
    });
    await settingsStore.updateProfile(profile.id, { remoteIdentityPath: result.identityPath });
    if (settings.activeProfileId === profile.id) {
      gatewayClient.disconnect();
      sshTunnelService.stop();
      sshCredentialSessionService.clear();
    }
    res.json({ ...result, settings: await settingsStore.publicSettings() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
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

apiRoutes.post("/files/upload", (req, res, next) => {
  uploadSingleFile(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: `File is too large. Maximum upload size is ${appConfig.maxUploadMb} MB.` });
      return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  });
}, async (req, res) => {
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
  if (value === "remote-agent-host" || value === "gateway-managed" || value === "local-user-machine" || value === "main-agent-machine") {
    return value;
  }
  return "local-user-machine";
}

function parseToolRequestKind(value: unknown): ToolRequestKind | null {
  if (
    value === "file-transfer"
    || value === "main-agent-save-file"
    || value === "terminal"
    || value === "adapter-install"
    || value === "skill-install"
    || value === "skill-verify"
  ) {
    return value;
  }
  return null;
}

function isToolRequestStatus(value: string): value is "pending" | "running" | "succeeded" | "approved" | "rejected" | "blocked" | "started" | "failed" {
  return value === "pending"
    || value === "running"
    || value === "succeeded"
    || value === "approved"
    || value === "rejected"
    || value === "blocked"
    || value === "started"
    || value === "failed";
}

function parseInteractionKind(value: unknown): InteractionKind | null {
  return value === "credential.request" || value === "ui.confirm" ? value : null;
}

function isInteractionStatus(value: string): value is InteractionStatus {
  return value === "pending" || value === "resolved" || value === "rejected" || value === "expired";
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

function looksLikeTerminalPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "terminal") return true;
  const payload = record.payload;
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as Record<string, unknown>).command === "string");
}

function parseTerminalChannelName(value: unknown): TerminalChannelName | undefined {
  return value === "gateway-terminal" || value === "ssh-terminal" || value === "chat-terminal" ? value : undefined;
}

function parseToolRequestMetadata(value: unknown): {
  terminalChannel?: TerminalChannelName;
  fallbackMode?: "chat-fenced-block";
  preferredChannel?: TerminalChannelName;
  callbackBaseUrl?: string;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const metadata = {
    terminalChannel: parseTerminalChannelName(record.terminalChannel),
    fallbackMode: record.fallbackMode === "chat-fenced-block" ? "chat-fenced-block" as const : undefined,
    preferredChannel: parseTerminalChannelName(record.preferredChannel),
    callbackBaseUrl: typeof record.callbackBaseUrl === "string" ? record.callbackBaseUrl.trim().slice(0, 500) : undefined
  };
  return metadata.terminalChannel || metadata.fallbackMode || metadata.preferredChannel || metadata.callbackBaseUrl
    ? metadata
    : undefined;
}

function extractBrokerSubmitToken(req: express.Request): string {
  const auth = req.header("authorization") || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  if (typeof body.submitToken === "string") return body.submitToken.trim();
  const queryToken = req.query.submitToken;
  if (typeof queryToken === "string") return queryToken.trim();
  if (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) {
    const payload = body.payload as Record<string, unknown>;
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
    const kind = parseToolRequestKind(req.body.kind);
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
    const kind = parseToolRequestKind(req.body.kind);
    const target = parseToolTarget(req.body.target);
    const sessionKey = typeof req.body.sessionKey === "string" ? req.body.sessionKey.trim() : "";
    const sourceEventId = typeof req.body.sourceEventId === "string" ? req.body.sourceEventId.trim() : "";
    const agentId = typeof req.body.agentId === "string" ? req.body.agentId.trim() : undefined;
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : undefined;
    const payload = req.body.payload && typeof req.body.payload === "object" && !Array.isArray(req.body.payload)
      ? req.body.payload
      : {};
    const metadata = parseToolRequestMetadata(req.body.metadata);
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
      metadata,
      payload
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/interactions/events/gateway", async (req, res) => {
  try {
    if (looksLikeTerminalPayload(req.body)) {
      res.status(400).json({
        ok: false,
        code: "DETACHES_WRONG_ENDPOINT_FOR_TERMINAL",
        error: "Terminal commands must use agent-terminal runtime or the tool broker endpoint, not interactionEventEndpoint."
      });
      return;
    }
    const kind = parseInteractionKind(req.body.kind);
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
    res.json(interactionBrokerService.create({
      kind,
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
  const bridgeBaseUrl = reverseBridgeBaseUrl(config);
  const localMachine = buildLocalMachineContext();
  res.json({
    ok: true,
    app: "detaches_agent",
    protocolVersion: 1,
    localMachine,
    gatewayEventEndpoint: `${bridgeBaseUrl}/api/tools/events/gateway`,
    interactionEventEndpoint: `${bridgeBaseUrl}/api/interactions/events/gateway`,
    eventSource: "gateway-event",
    idempotencyField: "sourceEventId",
    submitTokenRequired: true,
    submitTokenHeader: "Authorization",
    requestFormats: ["broker-event", "fence"],
    requestKinds: ["terminal", "file-transfer", "main-agent-save-file", "adapter-install", "skill-install", "skill-verify"],
    interactionKinds: ["credential.request", "ui.confirm"],
    contextExport: {
      createEndpoint: `${bridgeBaseUrl}/api/context/exports`,
      consumeEndpointPattern: `${bridgeBaseUrl}/api/context/exports/{token}`,
      createdBy: "detaches-ui-reverse-bridge",
      consumedBy: "remote-agent-host",
      oneTime: true,
      ttlSeconds: 300,
      adapterCommand: "context-fetch",
      doctorCommand: "doctor"
    },
    targets: ["local-user-machine", "remote-agent-host", "gateway-managed", "main-agent-machine"],
    approvalRequired: true,
    adapterId: "detaches_agent.openclaw.adapter"
  });
});

apiRoutes.get("/interactions", async (req, res) => {
  try {
    const sessionKey = typeof req.query.sessionKey === "string" ? req.query.sessionKey.trim() : undefined;
    const agentId = typeof req.query.agentId === "string" ? req.query.agentId.trim() : undefined;
    const status = typeof req.query.status === "string" && isInteractionStatus(req.query.status) ? req.query.status : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    res.json(interactionBrokerService.list({ sessionKey, agentId, status, limit }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/interactions/:interactionId", async (req, res) => {
  try {
    const preview = interactionBrokerService.get(req.params.interactionId);
    if (!brokerTokenService.verify(preview.interaction.sessionKey, extractBrokerSubmitToken(req))) {
      res.status(401).json({ error: "Invalid or missing broker submit token.", errorCode: "DETACHES_AUTH_REQUIRED" });
      return;
    }
    res.json(interactionBrokerService.get(req.params.interactionId, { consumeRevealSecret: true }));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/interactions/:interactionId/resolve", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Resolving local interactions is only allowed from the local machine." });
    return;
  }
  try {
    const mode = req.body?.mode === "local-handle" || req.body?.mode === "reveal-once" || req.body?.mode === "confirmed"
      ? req.body.mode
      : undefined;
    const secret = typeof req.body?.secret === "string" ? req.body.secret : undefined;
    const actor = parseToolDecisionActor(req.body?.actor);
    const response = interactionBrokerService.resolve(req.params.interactionId, {
      mode,
      secret,
      value: req.body?.value,
      actor
    });
    const result = response.result && response.result.secret
      ? { ...response.result, secret: undefined }
      : response.result;
    res.json({ ...response, result });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.post("/interactions/:interactionId/reject", async (req, res) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Rejecting local interactions is only allowed from the local machine." });
    return;
  }
  try {
    const actor = parseToolDecisionActor(req.body?.actor);
    const error = typeof req.body?.error === "string" ? req.body.error.trim() : undefined;
    res.json(interactionBrokerService.reject(req.params.interactionId, { actor, error }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

apiRoutes.get("/file-transfers/:transferId", async (req, res) => {
  const transfer = mainAgentFileTransferService.get(req.params.transferId);
  if (!transfer) {
    res.status(404).json({ error: "Transfer not found." });
    return;
  }
  res.json({ transfer });
});

apiRoutes.post("/file-transfers/:transferId/password", async (req, res) => {
  try {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password) {
      res.status(400).json({ error: "Password is required." });
      return;
    }
    res.json({ transfer: mainAgentFileTransferService.providePassword(req.params.transferId, password) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
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
