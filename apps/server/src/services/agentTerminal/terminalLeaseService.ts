import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AgentTerminalBootstrapResponse, AgentTerminalRunStatus, AgentTerminalSession } from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { runtimeConfig } from "../../config/settingsStore.js";

export type AgentTerminalStoredSession = AgentTerminalSession & { leaseToken: string };

const LEASE_TTL_MS = 12 * 60 * 60 * 1000;
const LEASE_REFRESH_AFTER_MS = 10 * 60 * 60 * 1000;

class TerminalLeaseService {
  private sessions = new Map<string, AgentTerminalStoredSession>();

  load(sessions: AgentTerminalStoredSession[]): void {
    this.sessions = new Map(sessions.map((session) => [session.terminalSessionId, session]));
  }

  list(): AgentTerminalStoredSession[] {
    return [...this.sessions.values()];
  }

  async bootstrap(input: { remoteAddress: string; sessionKey: string; agentId: string }): Promise<AgentTerminalBootstrapResponse> {
    await assertAllowedRemote(input.remoteAddress);
    const remoteAddress = normalizeRemoteAddress(input.remoteAddress);
    const existing = [...this.sessions.values()].find((session) => (
      session.sessionKey === input.sessionKey
      && session.agentId === input.agentId
      && session.remoteAddress === remoteAddress
      && session.state !== "revoked"
    ));
    if (existing?.state === "pending_authorization") {
      throw codedError("DETACHES_TERMINAL_BOOTSTRAP_REQUIRED", "Agent Terminal session is waiting for Detach Agent UI authorization.");
    }
    const session = existing
      ? this.refresh(existing)
      : this.createPending(input.sessionKey, input.agentId, remoteAddress);
    this.sessions.set(session.terminalSessionId, session);
    if (session.state === "pending_authorization") {
      throw codedError("DETACHES_TERMINAL_BOOTSTRAP_REQUIRED", "Agent Terminal session was created and is waiting for Detach Agent UI authorization.");
    }
    return bootstrapResponse(session);
  }

  public(session: AgentTerminalStoredSession): AgentTerminalSession {
    const { leaseToken: _leaseToken, ...rest } = session;
    return rest;
  }

  requireById(terminalSessionId: string): AgentTerminalStoredSession {
    const session = this.sessions.get(terminalSessionId);
    if (!session) throw codedError("DETACHES_TERMINAL_INTERNAL_ERROR", `Agent terminal session not found: ${terminalSessionId}`);
    return session;
  }

  requireByLease(leaseToken: string): AgentTerminalStoredSession {
    const token = leaseToken.trim();
    const session = [...this.sessions.values()].find((item) => item.leaseToken === token);
    if (!session) throw codedError("DETACHES_TERMINAL_LEASE_REVOKED", "Invalid or revoked terminal lease.");
    if (session.state === "revoked") throw codedError("DETACHES_TERMINAL_LEASE_REVOKED", "Terminal lease has been revoked.");
    if (Date.parse(session.leaseExpiresAt) <= Date.now()) throw codedError("DETACHES_TERMINAL_LEASE_EXPIRED", "Terminal lease has expired.");
    return session;
  }

  authorize(terminalSessionId: string): AgentTerminalBootstrapResponse {
    const session = this.requireById(terminalSessionId);
    if (session.state === "revoked") throw codedError("DETACHES_TERMINAL_LEASE_REVOKED", "Terminal session has been revoked.");
    const updated = this.refresh({ ...session, state: "ready" });
    this.sessions.set(updated.terminalSessionId, updated);
    return bootstrapResponse(updated);
  }

  revoke(terminalSessionId: string): AgentTerminalSession {
    const session = this.requireById(terminalSessionId);
    const updated = { ...session, state: "revoked" as const, revokedAt: nowIso(), lastActiveAt: nowIso() };
    this.sessions.set(session.terminalSessionId, updated);
    return this.public(updated);
  }

  touch(terminalSessionId: string, lastRunStatus?: AgentTerminalRunStatus): void {
    const session = this.sessions.get(terminalSessionId);
    if (session) this.sessions.set(session.terminalSessionId, { ...session, lastActiveAt: nowIso(), lastRunStatus });
  }

  private createPending(sessionKey: string, agentId: string, remoteAddress: string): AgentTerminalStoredSession {
    return {
      terminalSessionId: nanoid(),
      sessionKey,
      agentId,
      remoteAddress,
      terminalId: sessionKey,
      state: "pending_authorization",
      createdAt: nowIso(),
      lastActiveAt: nowIso(),
      leaseExpiresAt: futureIso(LEASE_TTL_MS),
      refreshAfter: futureIso(LEASE_REFRESH_AFTER_MS),
      leaseToken: nanoid(48)
    };
  }

  private refresh(session: AgentTerminalStoredSession): AgentTerminalStoredSession {
    return {
      ...session,
      state: "ready",
      lastActiveAt: nowIso(),
      leaseExpiresAt: futureIso(LEASE_TTL_MS),
      refreshAfter: futureIso(LEASE_REFRESH_AFTER_MS),
      leaseToken: session.leaseToken || nanoid(48)
    };
  }
}

export const terminalLeaseService = new TerminalLeaseService();

export async function saveAgentTerminalState(state: { version: 1; sessions: AgentTerminalStoredSession[]; runs: unknown[] }): Promise<void> {
  const filePath = statePath();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

export async function loadAgentTerminalState(): Promise<{ version?: number; sessions?: AgentTerminalStoredSession[]; runs?: unknown[] } | null> {
  try {
    return JSON.parse(await fs.readFile(statePath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

function bootstrapResponse(session: AgentTerminalStoredSession): AgentTerminalBootstrapResponse {
  return {
    ok: true,
    terminalSession: terminalLeaseService.public(session),
    leaseToken: session.leaseToken,
    leaseExpiresAt: session.leaseExpiresAt,
    refreshAfter: session.refreshAfter,
    capabilities: {
      supportsWait: true,
      supportsStreaming: true,
      supportsCancel: true,
      approvalRequired: true
    }
  };
}

async function assertAllowedRemote(remoteAddress: string): Promise<void> {
  const normalized = normalizeRemoteAddress(remoteAddress);
  if (isLoopbackAddress(normalized)) return;
  const config = await runtimeConfig();
  const allowedHosts = new Set<string>();
  addHost(allowedHosts, config.remoteHost);
  addHost(allowedHosts, config.gatewayDirectHost);
  addHost(allowedHosts, hostFromUrl(config.gatewayDirectUrl));
  addHost(allowedHosts, config.reverseBridgeRemoteHost);
  const allowedAddresses = new Set<string>();
  for (const host of allowedHosts) {
    if (!host || isLoopbackAddress(host)) continue;
    if (net.isIP(host)) {
      allowedAddresses.add(normalizeRemoteAddress(host));
      continue;
    }
    try {
      const records = await import("node:dns").then((dns) => dns.promises.lookup(host, { all: true }));
      for (const record of records) allowedAddresses.add(normalizeRemoteAddress(record.address));
    } catch {
      // DNS can be unavailable for stale profiles. A failed lookup must not widen Agent Terminal access.
    }
  }
  if (!allowedAddresses.has(normalized)) {
    throw codedError("DETACHES_TERMINAL_BOOTSTRAP_REQUIRED", `Remote address ${normalized} is not in the configured Main Agent allowlist.`);
  }
}

function statePath(): string {
  return path.join(appConfig.storageDir, "cache", "agent-terminal-state.json");
}

function normalizeRemoteAddress(value: string): string {
  return value.replace(/^::ffff:/, "") || "unknown";
}

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function addHost(hosts: Set<string>, host?: string): void {
  const trimmed = host?.trim();
  if (trimmed) hosts.add(trimmed);
}

function hostFromUrl(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).hostname;
  } catch {
    return "";
  }
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function codedError(code: string, message: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}
