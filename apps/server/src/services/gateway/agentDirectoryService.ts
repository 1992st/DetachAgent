import type { AgentSummary, AgentsListResponse } from "@detaches/shared";
import { runtimeConfig } from "../../config/settingsStore.js";
import { discoverAgentsViaCli } from "./agentCliDiscoveryService.js";
import { gatewayClient } from "./gatewayClient.js";

function textFromPreview(item: any): string {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.message === "string") return item.message;
  return "";
}

function toIsoTime(value: unknown): string | undefined {
  const numeric = typeof value === "number" ? value : Number(value ?? "");
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return new Date(numeric).toISOString();
}

function buildAgentMainSessionKey(agentId: string): string {
  const normalized = agentId.trim().toLowerCase() || "main";
  return `agent:${normalized}:main`;
}

export function extractSessions(raw: unknown): any[] {
  return Array.isArray((raw as any)?.sessions) ? (raw as any).sessions :
    Array.isArray((raw as any)?.items) ? (raw as any).items :
    Array.isArray((raw as any)?.previews) ? (raw as any).previews :
    Array.isArray(raw) ? raw as any[] :
    [];
}

export function extractConfiguredAgents(raw: unknown): any[] {
  return Array.isArray((raw as any)?.agents) ? (raw as any).agents :
    Array.isArray((raw as any)?.items) ? (raw as any).items :
    Array.isArray(raw) ? raw as any[] :
    [];
}

export function extractSnapshotAgents(raw: unknown): any[] {
  const snapshotHealth = (raw as any)?.snapshot?.health;
  return extractConfiguredAgents(snapshotHealth);
}

export function summaryFromSession(item: any, index: number): AgentSummary {
  const sessionKey = String(item.key ?? item.sessionKey ?? item.id ?? `session-${index + 1}`);
  const previewItems = Array.isArray(item.items) ? item.items : [];
  const preview = previewItems.map(textFromPreview).filter(Boolean).slice(-2).join(" / ") ||
    String(item.lastMessagePreview ?? item.preview ?? "");
  const parsedAgentId = /^agent:([^:]+):/.exec(sessionKey)?.[1];
  const title = String(
    item.displayName ??
    item.derivedTitle ??
    item.title ??
    item.name ??
    item.label ??
    sessionKey
  );
  return {
    id: String(item.agentId ?? item.agentid ?? parsedAgentId ?? sessionKey),
    sessionKey,
    title,
    status: String(item.status ?? item.state ?? "available"),
    preview,
    updatedAt: toIsoTime(item.updatedAt ?? item.ts),
    raw: item
  };
}

export function summaryFromConfiguredAgent(item: any): AgentSummary | null {
  const id = String(item.id ?? item.agentId ?? "").trim();
  if (!id) return null;
  const identityName = typeof item.identity?.name === "string" ? item.identity.name : "";
  const runtime = typeof item.agentRuntime?.id === "string" ? item.agentRuntime.id : "";
  const model = typeof item.model?.primary === "string" ? item.model.primary : "";
  return {
    id,
    sessionKey: buildAgentMainSessionKey(id),
    title: String(identityName || item.name || id),
    status: String(runtime || "configured"),
    preview: model || item.workspace || "主会话",
    raw: item
  };
}

export async function listAgents(): Promise<AgentsListResponse> {
  let sessionsRaw: unknown = null;
  let sessionsError: string | null = null;
  let helloRaw: unknown = null;
  let agentsRaw: unknown = null;
  let agentsError: string | null = null;
  let snapshotAgentsRaw: any[] = [];
  let cliDiscovery: Awaited<ReturnType<typeof discoverAgentsViaCli>> | null = null;
  if (!gatewayClient.getHello()) {
    try {
      await gatewayClient.connect();
    } catch (error) {
      agentsError = error instanceof Error ? error.message : String(error);
    }
  }
  helloRaw = gatewayClient.getHello();

  try {
    agentsRaw = await gatewayClient.listAgents();
  } catch (error) {
    agentsError = error instanceof Error ? error.message : String(error);
  }

  const gatewayAgents = extractConfiguredAgents(agentsRaw)
    .map(summaryFromConfiguredAgent)
    .filter(Boolean) as AgentSummary[];
  snapshotAgentsRaw = extractSnapshotAgents(helloRaw);
  const snapshotAgents = snapshotAgentsRaw
    .map(summaryFromConfiguredAgent)
    .filter(Boolean) as AgentSummary[];
  try {
    sessionsRaw = await gatewayClient.listSessions(200);
  } catch (error) {
    sessionsError = error instanceof Error ? error.message : String(error);
  }
  const sessions = extractSessions(sessionsRaw).map(summaryFromSession);
  const config = await runtimeConfig();
  if (!gatewayAgents.length && agentsError && config.gatewayTransport === "ssh") {
    cliDiscovery = await discoverAgentsViaCli();
  }
  const { agents, source } = buildAgentDirectory({
    configured: gatewayAgents.length ? gatewayAgents : snapshotAgents,
    sessions,
    cliAgents: cliDiscovery?.agents ?? [],
    configuredSource: gatewayAgents.length ? "gateway-agents-rpc" : snapshotAgents.length ? "gateway-agents" : undefined
  });

  return {
    agents,
    source,
    raw: { hello: helloRaw, agents: agentsRaw, agentsError, snapshotAgents: snapshotAgentsRaw, sessions: sessionsRaw, sessionsError, cli: cliDiscovery }
  };
}

export function buildAgentDirectory(input: {
  configured?: AgentSummary[];
  sessions?: AgentSummary[];
  cliAgents?: AgentSummary[];
  configuredSource?: "gateway-agents" | "gateway-agents-rpc";
}): Pick<AgentsListResponse, "agents" | "source"> {
  const configured = input.configured ?? [];
  const sessions = input.sessions ?? [];
  const cliAgents = input.cliAgents ?? [];
  const configuredSource = input.configuredSource ?? "gateway-agents";
  const byAgentId = new Map<string, AgentSummary>();
  const sessionsByAgentId = new Map<string, AgentSummary[]>();

  for (const session of sessions) {
    const key = session.id.toLowerCase();
    sessionsByAgentId.set(key, [...(sessionsByAgentId.get(key) ?? []), session]);
  }

  for (const agent of [...configured, ...cliAgents]) {
    byAgentId.set(agent.id.toLowerCase(), agent);
  }
  for (const session of sessions) {
    const key = session.id.toLowerCase();
    if (key === "global") continue;
    const existing = byAgentId.get(key);
    if (!existing) {
      byAgentId.set(key, {
        id: session.id,
        sessionKey: buildAgentMainSessionKey(session.id),
        title: session.id,
        status: "session-only",
        preview: `${sessionsByAgentId.get(key)?.length ?? 1} sessions`,
        updatedAt: session.updatedAt,
        raw: { sessions: sessionsByAgentId.get(key)?.map((item) => item.raw) ?? [session.raw] }
      });
    }
  }

  const agents = Array.from(byAgentId.values()).map((agent) => {
    const key = agent.id.toLowerCase();
    const agentSessions = sessionsByAgentId.get(key) ?? [];
    return {
      ...agent,
      preview: agent.preview || (agentSessions.length ? `${agentSessions.length} sessions` : agent.preview),
      raw: { agent: agent.raw, sessions: agentSessions.map((item) => item.raw) }
    };
  }).sort((a, b) => {
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });

  return {
    agents,
    source: configured.length
      ? configuredSource === "gateway-agents-rpc" ? "gateway-agents-rpc+sessions" : cliAgents.length ? "gateway-agents+sessions+ssh-cli" : "gateway-agents+sessions"
      : cliAgents.length ? "gateway-agents+sessions+ssh-cli" : "gateway-sessions"
  };
}
