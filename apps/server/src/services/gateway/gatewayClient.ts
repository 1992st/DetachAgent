import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import WebSocket from "ws";
import type {
  GatewayConnectParams,
  GatewayEventFrame,
  GatewayCapabilitySummary,
  GatewayHello,
  GatewayModelOption,
  GatewayModelsResponse,
  GatewayRequestFrame,
  GatewayResponseFrame
} from "@detaches/shared";
import { runtimeConfig } from "../../config/settingsStore.js";
import { platformService } from "../platform/platformService.js";
import { sshTunnelService } from "../tunnel/sshTunnelService.js";
import { cloudPromptLogService } from "./cloudPromptLogService.js";
import {
  buildDeviceAuthPayloadV3,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload
} from "./deviceIdentityService.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export class GatewayClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private connectPromise: Promise<void> | null = null;
  private hello: GatewayHello | null = null;
  private connected = false;
  private lastError: string | null = null;
  private chatSendClientContextSupported: boolean | null = null;
  private selectedModelsBySession = new Map<string, string>();

  async connect(): Promise<void> {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.open();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async health(): Promise<unknown> {
    try {
      await this.connect();
      return await this.request("health", undefined, 8000);
    } catch (error) {
      this.disconnect();
      await this.connect();
      return this.request("health", undefined, 12000);
    }
  }

  async quickHealth(timeoutMs = 3000): Promise<unknown> {
    await this.connectWithTimeout(timeoutMs);
    return this.request("health", undefined, timeoutMs, false);
  }

  async listSessions(limit = 50): Promise<unknown> {
    await this.connect();
    return this.request("sessions.list", { includeGlobal: true, includeUnknown: true, limit }, 15000);
  }

  async listAgents(): Promise<unknown> {
    await this.connect();
    return this.request("agents.list", {}, 15000);
  }

  async listAgentFiles(agentId: string): Promise<unknown> {
    await this.connect();
    return this.request("agents.files.list", { agentId }, 15000);
  }

  async chatHistory(sessionKey: string): Promise<unknown> {
    await this.connect();
    return this.request("chat.history", { sessionKey, limit: 100 }, 6000);
  }

  async sendChat(params: {
    sessionKey: string;
    message: string;
    model?: string;
    thinking?: string;
    attachments?: unknown[];
    idempotencyKey?: string;
    clientContext?: Record<string, unknown>;
    clientContextFallbackMessage?: string;
    promptGate?: {
      includeLocalControlContext?: boolean;
      includeStagedFileContext?: boolean;
      localControlScope?: string;
      activationReason?: string;
    };
  }): Promise<unknown> {
    await this.connect();
    const attachments = params.attachments
      ?.map((attachment: any) => {
        if (!attachment?.contentBase64) return null;
        return {
          type: attachment.mimeType?.startsWith("image/") ? "image" : "file",
          mimeType: attachment.mimeType || "application/octet-stream",
          fileName: attachment.name || "attachment",
          content: attachment.contentBase64
        };
      })
      .filter(Boolean);
    const buildPayload = (includeClientContext: boolean) => {
      const fallbackMessage = includeClientContext ? "" : params.clientContextFallbackMessage?.trim();
      return {
        sessionKey: params.sessionKey,
        message: fallbackMessage ? `${params.message}\n\n${fallbackMessage}` : params.message,
        thinking: params.thinking ?? "",
        attachments: attachments?.length ? attachments : undefined,
        timeoutMs: 30000,
        idempotencyKey: params.idempotencyKey ?? nanoid(),
        clientContext: includeClientContext ? params.clientContext : undefined
      };
    };
    const sendChatRequest = async (includeClientContext: boolean, phase: "initial" | "fallback") => {
      const payload = buildPayload(includeClientContext);
      const startedAt = Date.now();
      await cloudPromptLogService.logChatSend({
        phase,
        sessionKey: params.sessionKey,
        idempotencyKey: payload.idempotencyKey,
        includeClientContext,
        includeLocalControlContext: params.promptGate?.includeLocalControlContext,
        includeStagedFileContext: params.promptGate?.includeStagedFileContext,
        localControlScope: params.promptGate?.localControlScope,
        activationReason: params.promptGate?.activationReason,
        payload
      });
      try {
        const response = await this.request("chat.send", payload, 35000);
        await cloudPromptLogService.logChatResult({
          phase,
          sessionKey: params.sessionKey,
          idempotencyKey: payload.idempotencyKey,
          includeClientContext,
          includeLocalControlContext: params.promptGate?.includeLocalControlContext,
          includeStagedFileContext: params.promptGate?.includeStagedFileContext,
          localControlScope: params.promptGate?.localControlScope,
          activationReason: params.promptGate?.activationReason,
          ok: true,
          durationMs: Date.now() - startedAt,
          payload: response
        });
        return response;
      } catch (error) {
        await cloudPromptLogService.logChatResult({
          phase,
          sessionKey: params.sessionKey,
          idempotencyKey: payload.idempotencyKey,
          includeClientContext,
          includeLocalControlContext: params.promptGate?.includeLocalControlContext,
          includeStagedFileContext: params.promptGate?.includeStagedFileContext,
          localControlScope: params.promptGate?.localControlScope,
          activationReason: params.promptGate?.activationReason,
          ok: false,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    };
    const includeClientContext = Boolean(params.clientContext) && this.chatSendClientContextSupported !== false;
    const selectedModel = params.model?.trim();
    if (selectedModel && this.selectedModelsBySession.get(params.sessionKey) !== selectedModel) {
      await this.switchChatModel(params.sessionKey, selectedModel, params.idempotencyKey);
      this.selectedModelsBySession.set(params.sessionKey, selectedModel);
    }
    if (!includeClientContext) {
      return sendChatRequest(false, "initial");
    }
    try {
      const response = await sendChatRequest(true, "initial");
      this.chatSendClientContextSupported = true;
      return response;
    } catch (error) {
      if (!isClientContextUnsupportedError(error)) throw error;
      this.chatSendClientContextSupported = false;
      const response = await sendChatRequest(false, "fallback");
      if (isClientContextUnsupportedError(this.lastError)) this.lastError = null;
      return response;
    }
  }

  async abortChat(sessionKey: string, runId: string): Promise<unknown> {
    await this.connect();
    return this.request("chat.abort", { sessionKey, runId }, 10000);
  }

  async switchChatModel(sessionKey: string, model: string, idempotencyKey?: string): Promise<unknown> {
    await this.connect();
    const payload = {
      sessionKey,
      message: `/model ${model}`,
      thinking: "",
      timeoutMs: 12000,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:model` : `model:${nanoid()}`
    };
    await cloudPromptLogService.logChatSend({
      phase: "initial",
      sessionKey,
      idempotencyKey: payload.idempotencyKey,
      includeClientContext: false,
      activationReason: "model-switch",
      payload
    });
    return this.request("chat.send", payload, 15000);
  }

  getHello(): GatewayHello | null {
    return this.hello;
  }

  async capabilitySummary(): Promise<GatewayCapabilitySummary> {
    await this.connect();
    const methods = methodsFromHello(this.hello);
    const hasToolsInvoke = methods.includes("tools.invoke");
    const hasNodeInvoke = methods.includes("node.invoke");
    const hasAgentsFiles = methods.some((method) => method.startsWith("agents.files."));
    const hasArtifacts = methods.some((method) => method.startsWith("artifacts."));
    const hasEnvironments = methods.some((method) => method.startsWith("environments."));
    const candidateAdapters: GatewayCapabilitySummary["candidateAdapters"] = ["local-user-machine"];
    if (hasToolsInvoke || hasAgentsFiles || hasArtifacts) candidateAdapters.unshift("gateway-managed");
    if (hasNodeInvoke || hasEnvironments) candidateAdapters.unshift("remote-agent-host");
    return {
      connected: this.connected,
      methodCount: methods.length,
      hasToolsInvoke,
      hasNodeInvoke,
      hasAgentsFiles,
      hasArtifacts,
      hasEnvironments,
      candidateAdapters: Array.from(new Set(candidateAdapters)),
      methods
    };
  }

  async listModels(params: { agentId?: string } = {}): Promise<GatewayModelsResponse> {
    await this.connect();
    const hello = this.hello;
    const methods = methodsFromHello(hello);
    const errors: string[] = [];
    const raw: Record<string, unknown> = { hello };
    let models: GatewayModelOption[] = [];

    if (methods.includes("chat.metadata")) {
      try {
        const agentId = params.agentId?.trim();
        const metadata = await withTimeout(this.request("chat.metadata", agentId ? { agentId } : {}, 2500, true, false), 3000, "Gateway chat.metadata model discovery timed out.");
        raw["chat.metadata"] = metadata;
        models = collectOpenClawModelList(metadata, "chat.metadata");
      } catch (error) {
        errors.push(`chat.metadata: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      errors.push("chat.metadata is not advertised by this Gateway.");
    }

    return {
      connected: this.connected,
      models,
      selectedModel: selectedModelFromMetadata(raw["chat.metadata"]),
      source: models.length ? Array.from(new Set(models.map((model) => model.source).filter(Boolean))).join("+") : "none",
      methods,
      errors: errors.length ? errors : undefined,
      raw
    };
  }

  getLastError(): string | null {
    return this.lastError;
  }

  disconnect(): void {
    this.socket?.removeAllListeners("error");
    this.socket?.close();
    this.socket = null;
    this.connected = false;
    this.hello = null;
    this.chatSendClientContextSupported = null;
    this.selectedModelsBySession.clear();
    this.rejectAll(new Error("Gateway disconnected."));
  }

  private async open(): Promise<void> {
    const config = await runtimeConfig();
    if (config.gatewayTransport === "ssh") {
      await sshTunnelService.ensure();
    }
    const url = config.gatewayTransport === "direct"
      ? resolveDirectGatewayUrl(config.gatewayDirectUrl, config.gatewayDirectHost, config.gatewayRemotePort)
      : `ws://127.0.0.1:${config.gatewayLocalPort}`;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { maxPayload: 16 * 1024 * 1024 });
      let settled = false;
      let connectTimer: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(connectTimer);
        this.off("hello", onHello);
        socket.off("error", fail);
        socket.off("close", onClose);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.lastError = error.message;
        this.connected = false;
        this.hello = null;
        if (this.socket === socket) this.socket = null;
        socket.once("error", () => {
          // Swallow cleanup-time ws errors; the original connection error is already rejected.
        });
        socket.terminate();
        reject(error);
      };
      const onClose = () => {
        if (!settled) fail(new Error("Gateway socket closed before hello."));
      };
      const onHello = (hello: GatewayHello) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.hello = hello;
        this.connected = true;
        resolve();
      };
      socket.once("open", () => {
        this.socket = socket;
        this.installHandlers(socket);
        this.sendConnectRequest().catch(fail);
      });
      socket.once("error", fail);
      socket.once("close", onClose);
      this.on("hello", onHello);
      connectTimer = setTimeout(() => fail(new Error("Gateway connect timed out.")), 12000);
    });
  }

  private async connectWithTimeout(timeoutMs: number): Promise<void> {
    return withTimeout(this.connect(), timeoutMs, "Gateway quick health timed out.");
  }

  private installHandlers(socket: WebSocket): void {
    socket.on("message", (data) => {
      this.handleFrame(data.toString("utf8"));
    });
    socket.on("close", () => {
      this.socket = null;
      this.connected = false;
      this.rejectAll(new Error("Gateway socket closed."));
      this.emit("disconnected");
    });
    socket.on("error", (error) => {
      this.lastError = error.message;
      this.rejectAll(error);
      this.emit("gateway.error", error);
    });
  }

  private handleFrame(raw: string): void {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.type === "res" || frame.type === "response") {
      const response = frame as GatewayResponseFrame;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.payload);
      else {
        const message = response.error?.message || response.error?.code || "Gateway request failed.";
        this.lastError = message;
        pending.reject(new Error(message));
      }
      return;
    }
    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        this.emit("connect.challenge", frame.payload);
        return;
      }
      this.emit("event", frame as GatewayEventFrame);
      this.emit(`event:${frame.event}`, frame.payload, frame);
    }
  }

  private async sendConnectRequest(): Promise<void> {
    const nonce = await this.waitForConnectChallenge();
    const payload = await this.request("connect", await this.connectParams(nonce), 12000, false);
    this.hello = {
      type: "hello",
      ...(typeof payload === "object" && payload ? payload as Record<string, unknown> : {})
    } as GatewayHello;
    this.emit("hello", this.hello);
  }

  private waitForConnectChallenge(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off("connect.challenge", onChallenge);
        reject(new Error("Gateway connect.challenge timed out."));
      }, 6000);
      const onChallenge = (payload: unknown) => {
        const nonce = typeof (payload as any)?.nonce === "string" ? (payload as any).nonce.trim() : "";
        if (!nonce) return;
        clearTimeout(timeout);
        this.off("connect.challenge", onChallenge);
        resolve(nonce);
      };
      this.on("connect.challenge", onChallenge);
    });
  }

  private async connectParams(nonce: string): Promise<GatewayConnectParams> {
    const auth: Record<string, unknown> = {};
    const config = await runtimeConfig();
    if (config.authMode === "token" && config.authToken) auth.token = config.authToken;
    if (config.authMode === "password" && config.authPassword) auth.password = config.authPassword;
    const role = "operator";
    const scopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
    // Gateway allow-lists this legacy client id. The real local OS is exposed
    // through platform plus detaches localMachine context, not inferred here.
    const clientId = "openclaw-macos";
    const clientMode = "ui";
    const platform = platformService.currentNodePlatform();
    const identity = loadOrCreateDeviceIdentity();
    const signedAtMs = Date.now();
    const signatureToken =
      typeof auth.token === "string" ? auth.token :
      typeof auth.bootstrapToken === "string" ? auth.bootstrapToken :
      null;
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: signatureToken,
      nonce,
      platform,
      deviceFamily: "desktop"
    });
    return {
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: clientId,
        displayName: "detaches_agent local UI",
        version: "1.2.0",
        platform,
        deviceFamily: "desktop",
        mode: clientMode,
        instanceId: "detaches-agent-local"
      },
      role,
      scopes,
      caps: ["chat", "files", "sessions"],
      commands: [],
      auth: Object.keys(auth).length ? auth : undefined,
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature: signDevicePayload(identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce
      },
      locale: "zh-CN",
      userAgent: "detaches-agent/1.2.0"
    };
  }

  async request(method: string, params?: unknown, timeoutMs = 15000, ensureConnected = true, disconnectOnTimeout = true): Promise<unknown> {
    if (ensureConnected) await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway socket is not open.");
    }
    const id = nanoid();
    const frame: GatewayRequestFrame = { type: "req", id, method, params };
    const payload = JSON.stringify(frame);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        if (disconnectOnTimeout) this.disconnect();
        reject(new Error(`Gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket?.send(payload, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isClientContextUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid\s+chat\.send\s+params/i.test(message) && /unexpected\s+property\s+['"]?clientContext['"]?/i.test(message);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const gatewayClient = new GatewayClient();

export function resolveDirectGatewayUrl(gatewayDirectUrl: string, gatewayDirectHost: string, gatewayRemotePort: number): string {
  const directUrl = gatewayDirectUrl.trim();
  if (directUrl) {
    if (/^https:\/\//i.test(directUrl)) return directUrl.replace(/^https:/i, "wss:");
    if (/^http:\/\//i.test(directUrl)) return directUrl.replace(/^http:/i, "ws:");
    if (/^wss?:\/\//i.test(directUrl)) return directUrl;
    return `wss://${directUrl}`;
  }
  return `ws://${gatewayDirectHost}:${gatewayRemotePort}`;
}

function methodsFromHello(hello: GatewayHello | null): string[] {
  const rawMethods = (hello?.features as any)?.methods;
  return Array.isArray(rawMethods) ? rawMethods.filter((method): method is string => typeof method === "string") : [];
}

function collectOpenClawModelList(value: unknown, source: string): GatewayModelOption[] {
  const output: GatewayModelOption[] = [];
  const models = Array.isArray((value as any)?.models) ? (value as any).models : [];
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = stringValue(record.id);
    if (!id) continue;
    const provider = stringValue(record.provider);
    const ref = provider && !id.includes("/") ? `${provider}/${id}` : id;
    addModel(output, {
      id: ref,
      label: stringValue(record.name) || stringValue(record.label) || ref,
      provider,
      source,
      raw: item
    });
  }
  return uniqueModels(output);
}

function addModel(output: GatewayModelOption[], model: GatewayModelOption): void {
  const id = model.id.trim();
  if (!id || id.length > 120) return;
  if (/^(configured|available|ready|main|global|default)$/i.test(id)) return;
  output.push({ ...model, id, label: model.label.trim() || id });
}

function uniqueModels(models: GatewayModelOption[]): GatewayModelOption[] {
  const byId = new Map<string, GatewayModelOption>();
  for (const model of models) {
    const key = model.id.toLowerCase();
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, model);
      continue;
    }
    byId.set(key, {
      ...existing,
      label: existing.label || model.label,
      provider: existing.provider || model.provider,
      source: Array.from(new Set([existing.source, model.source].filter(Boolean))).join("+"),
      raw: existing.raw ?? model.raw
    });
  }
  return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function selectedModelFromMetadata(value: unknown): string | undefined {
  const models: unknown[] = Array.isArray((value as any)?.models) ? (value as any).models : [];
  const selected = models.find((model) => Boolean((model as any)?.selected || (model as any)?.current || (model as any)?.isDefault));
  if (!selected || typeof selected !== "object") return undefined;
  const record = selected as Record<string, unknown>;
  const id = stringValue(record.id);
  if (!id) return undefined;
  const provider = stringValue(record.provider);
  return provider && !id.includes("/") ? `${provider}/${id}` : id;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
