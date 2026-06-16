import type { RemoteProfileUpdate } from "../settingsTypes.js";
import type { AgentConfigAssistantInput, AgentConfigAssistantResult } from "./types.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_GATEWAY_PORT = 18789;

export function analyzeOpenClawConfig(input: AgentConfigAssistantInput): AgentConfigAssistantResult {
  if (input.agentType !== "openclaw") {
    return unsupportedResult(input.agentType);
  }

  const parsed = parseJsonObject(input.configText);
  if (!parsed.ok) {
    return {
      status: "invalid",
      agentType: "openclaw",
      title: "OpenClaw 配置无法解析",
      summary: parsed.error,
      proposedUpdate: {},
      findings: [{ level: "error", message: parsed.error }],
      detected: {}
    };
  }

  const gateway = isRecord(parsed.value.gateway) ? parsed.value.gateway : {};
  const auth = isRecord(gateway.auth) ? gateway.auth : {};
  const tailscale = isRecord(gateway.tailscale) ? gateway.tailscale : {};
  const bind = readString(gateway.bind) || "loopback";
  const tailscaleMode = readString(tailscale.mode) || "off";
  const port = readPort(gateway.port) ?? DEFAULT_GATEWAY_PORT;
  const authMode = readAuthMode(auth.mode);
  const tokenValue = readPlainSecret(auth.token);
  const passwordValue = readPlainSecret(auth.password);
  const hasTrustedProxy = authMode === "trusted-proxy";
  const hasPlainToken = Boolean(tokenValue);
  const hasPlainPassword = Boolean(passwordValue);
  const hasUnresolvedToken = auth.token !== undefined && !hasPlainToken;
  const hasUnresolvedPassword = auth.password !== undefined && !hasPlainPassword;
  const findings: AgentConfigAssistantResult["findings"] = [];
  const proposedUpdate: RemoteProfileUpdate = {
    gatewayTransport: "direct",
    gatewayRemotePort: port,
    remoteWorkspaceRoot: input.existingProfile.remoteWorkspaceRoot,
    publicBaseUrl: input.existingProfile.publicBaseUrl
  };

  if (authMode === "password") {
    proposedUpdate.authMode = "password";
    if (passwordValue) proposedUpdate.authPassword = passwordValue;
  } else if (authMode === "none") {
    proposedUpdate.authMode = "none";
  } else {
    proposedUpdate.authMode = "token";
    if (tokenValue) proposedUpdate.authToken = tokenValue;
  }

  if (hasUnresolvedToken || hasUnresolvedPassword) {
    findings.push({ level: "warning", message: "Gateway 凭据使用 secret/env/file/exec 引用，无法从配置文件解析明文，需要用户手动填写。" });
  }

  const nonLoopback = bind === "tailnet" || bind === "lan" || (bind === "custom" && !isLoopbackHost(readString(gateway.customBindHost) || ""));
  if (nonLoopback && !hasPlainToken && !hasPlainPassword && !hasTrustedProxy) {
    findings.push({ level: "error", message: "OpenClaw 非 loopback Gateway 监听需要 token/password 或 trusted-proxy；当前配置无法一键完成。" });
  }

  const address = normalizeAddress(input.mainAgentAddress);
  if (bind === "loopback" && (tailscaleMode === "serve" || tailscaleMode === "funnel")) {
    proposedUpdate.gatewayDirectUrl = normalizeGatewayUrl(address);
    proposedUpdate.gatewayDirectHost = input.existingProfile.gatewayDirectHost;
    findings.push({ level: "info", message: "检测到 Tailscale Serve/Funnel + loopback，将使用 Gateway URL 方式连接。" });
    if (!isGatewayUrl(address)) {
      findings.push({ level: "error", message: "请输入 Tailscale Serve 的 HTTPS 地址，例如 https://main-agent.tailnet.ts.net。" });
      proposedUpdate.gatewayDirectUrl = "";
    }
  } else if (bind === "loopback") {
    proposedUpdate.gatewayTransport = "ssh";
    proposedUpdate.remoteHost = address || input.existingProfile.remoteHost;
    proposedUpdate.gatewayDirectHost = input.existingProfile.gatewayDirectHost;
    proposedUpdate.gatewayDirectUrl = "";
    findings.push({ level: "info", message: "检测到 loopback Gateway，将自动配置为 SSH tunnel；Gateway 仍只需监听 Main Agent 本机。如果希望使用 Direct connect，需要修改 OpenClaw 配置为 gateway.bind=lan。" });
  } else if (bind === "tailnet" || bind === "lan" || bind === "auto") {
    proposedUpdate.gatewayDirectHost = address || input.existingProfile.gatewayDirectHost || input.existingProfile.remoteHost;
    proposedUpdate.remoteHost = proposedUpdate.gatewayDirectHost;
    proposedUpdate.gatewayDirectUrl = "";
    if (bind === "lan") {
      findings.push({ level: "warning", message: "gateway.bind=lan 会监听 LAN/所有可用网卡，请确认主机防火墙、网络边界和 Gateway auth 已配置。" });
    }
    if (bind === "auto") {
      findings.push({ level: "warning", message: "gateway.bind=auto 会随运行环境变化，建议确认 Main Agent 实际监听地址。" });
    }
  } else if (bind === "custom") {
    const customBindHost = readString(gateway.customBindHost) || "";
    if (isLoopbackHost(customBindHost)) {
      proposedUpdate.gatewayDirectUrl = normalizeGatewayUrl(address);
      findings.push({ level: "warning", message: "customBindHost 是 loopback；远端 PC 不能通过裸 host:port 直连，需使用 Tailscale Serve URL 或高级 SSH。" });
      if (!isGatewayUrl(address)) {
        findings.push({ level: "error", message: "请输入可访问的 Tailscale Serve HTTPS URL。" });
        proposedUpdate.gatewayDirectUrl = "";
      }
    } else {
      proposedUpdate.gatewayDirectHost = address || customBindHost || input.existingProfile.gatewayDirectHost;
      proposedUpdate.remoteHost = proposedUpdate.gatewayDirectHost;
      proposedUpdate.gatewayDirectUrl = "";
      if (address && customBindHost && address !== customBindHost) {
        findings.push({ level: "warning", message: `用户输入地址 ${address} 与 customBindHost ${customBindHost} 不一致，请确认实际可访问地址。` });
      }
    }
  } else {
    findings.push({ level: "error", message: `暂不支持的 gateway.bind: ${bind}` });
  }

  if (authMode && authMode !== "token" && authMode !== "password" && authMode !== "none" && authMode !== "trusted-proxy") {
    findings.push({ level: "warning", message: `检测到未知 auth mode: ${authMode}` });
  }

  const hasError = findings.some((finding) => finding.level === "error");
  const status = hasError ? "needs_input" : "ready";
  return {
    status,
    agentType: "openclaw",
    title: status === "ready" ? "OpenClaw 配置可应用" : "OpenClaw 配置需要补充信息",
    summary: summarizeOpenClaw(bind, tailscaleMode, port),
    proposedUpdate,
    findings,
    detected: {
      bind,
      tailscaleMode,
      port,
      authMode,
      hasAuthToken: hasPlainToken,
      hasAuthPassword: hasPlainPassword
    }
  };
}

function unsupportedResult(agentType: AgentConfigAssistantInput["agentType"]): AgentConfigAssistantResult {
  return {
    status: "unsupported",
    agentType,
    title: "Agent 类型暂未支持",
    summary: "当前版本只支持 OpenClaw 配置导入。",
    proposedUpdate: {},
    findings: [{ level: "warning", message: "请选择 OpenClaw。" }],
    detected: {}
  };
}

function parseJsonObject(text: string): { ok: true; value: JsonObject } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return { ok: false, error: "配置内容必须是 JSON object。" };
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPort(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

function readAuthMode(value: unknown): string {
  return readString(value) || "token";
}

function readPlainSecret(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeAddress(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeGatewayUrl(value: string): string {
  const trimmed = normalizeAddress(value);
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed) || /^wss?:\/\//i.test(trimmed)) return trimmed;
  if (/\.ts\.net(?::\d+)?(?:\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return "";
}

function isGatewayUrl(value: string): boolean {
  const trimmed = normalizeAddress(value);
  return /^https?:\/\//i.test(trimmed) || /^wss?:\/\//i.test(trimmed) || /\.ts\.net(?::\d+)?(?:\/.*)?$/i.test(trimmed);
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host.startsWith("127.") || host === "::1" || host === "[::1]";
}

function summarizeOpenClaw(bind: string, tailscaleMode: string, port: number): string {
  return `检测到 gateway.bind=${bind}, gateway.tailscale.mode=${tailscaleMode}, gateway.port=${port}。`;
}
