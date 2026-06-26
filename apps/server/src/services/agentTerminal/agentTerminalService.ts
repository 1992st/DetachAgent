import { nanoid } from "nanoid";
import type {
  AgentTerminalBootstrapResponse,
  AgentTerminalRun,
  AgentTerminalRunRequest,
  AgentTerminalRunResponse,
  AgentTerminalRunStatus,
  AgentTerminalSessionsResponse,
  AgentTerminalStreamEvent
} from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { toolBrokerService } from "../tools/toolBrokerService.js";
import { terminalService } from "../terminal/terminalService.js";
import { loadAgentTerminalState, saveAgentTerminalState, terminalLeaseService } from "./terminalLeaseService.js";
import { isTerminalRunDone, terminalRunStore } from "./terminalRunStore.js";
import { terminalStreamHub } from "./terminalStreamHub.js";

const DEFAULT_SESSION_KEY = "gateway-terminal";
const DEFAULT_AGENT_ID = "main-agent";
const OUTPUT_LIMIT = 64 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

class AgentTerminalService {
  private loaded = false;
  private saveChain = Promise.resolve();
  private activeRunLocks = new Map<string, string>();

  async bootstrap(input: { remoteAddress: string; sessionKey?: string; agentId?: string; displayName?: string }): Promise<AgentTerminalBootstrapResponse> {
    await this.load();
    const sessionKey = input.sessionKey?.trim() || DEFAULT_SESSION_KEY;
    const agentId = input.agentId?.trim() || DEFAULT_AGENT_ID;
    const response = await terminalLeaseService.bootstrap({ remoteAddress: input.remoteAddress, sessionKey, agentId });
    await this.save();
    return response;
  }

  async listSessions(): Promise<AgentTerminalSessionsResponse> {
    await this.load();
    return { sessions: terminalLeaseService.list().map((session) => terminalLeaseService.public(session)).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)) };
  }

  async session(terminalSessionId: string) {
    await this.load();
    return terminalLeaseService.public(terminalLeaseService.requireById(terminalSessionId));
  }

  async revokeSession(terminalSessionId: string) {
    await this.load();
    const updated = terminalLeaseService.revoke(terminalSessionId);
    await this.save();
    return updated;
  }

  async authorizeSession(terminalSessionId: string): Promise<AgentTerminalBootstrapResponse> {
    await this.load();
    const response = terminalLeaseService.authorize(terminalSessionId);
    await this.save();
    return response;
  }

  async createRun(input: {
    leaseToken: string;
    request: AgentTerminalRunRequest;
    waitMs?: number;
  }): Promise<AgentTerminalRunResponse> {
    await this.load();
    const session = terminalLeaseService.requireByLease(input.leaseToken);
    const command = input.request.command.trim();
    if (!command) throw codedError("DETACHES_TERMINAL_INTERNAL_ERROR", "command is required.");
    await this.syncActiveRunsForSession(session.terminalSessionId);
    const runId = nanoid();
    const activeRun = this.findActiveRunForSession(session.terminalSessionId);
    const activeLockRunId = this.activeRunLocks.get(session.terminalSessionId);
    if (activeRun || activeLockRunId) {
      return this.createBusyRun({
        terminalSessionId: session.terminalSessionId,
        command,
        reason: input.request.reason,
        activeRunId: activeRun?.runId ?? activeLockRunId ?? "unknown"
      });
    }
    this.activeRunLocks.set(session.terminalSessionId, runId);
    const sourceEventId = input.request.sourceEventId?.trim() || `agent-terminal:${runId}`;
    try {
      const request = await toolBrokerService.create({
        kind: "terminal",
        target: "local-user-machine",
        sessionKey: session.sessionKey,
        agentId: session.agentId,
        reason: input.request.reason,
        source: "gateway-event",
        sourceEventId,
        metadata: {
          terminalChannel: "gateway-terminal",
          preferredChannel: "gateway-terminal",
          callbackBaseUrl: appConfig.publicBaseUrl,
          agentTerminalRunId: runId
        },
        payload: {
          command,
          workingDirectory: input.request.workingDirectory ?? undefined
        }
      });
      const run: AgentTerminalRun = {
        runId,
        terminalSessionId: session.terminalSessionId,
        requestId: request.id,
        command,
        reason: input.request.reason,
        status: request.status === "blocked" ? "blocked" : "waiting_for_approval",
        approvalStatus: "pending",
        guard: request.guard ?? {
          decision: "allow",
          riskLevel: request.risk?.level ?? "safe",
          matchedRules: request.risk?.reasons ?? [],
          normalizedCommand: command
        },
        createdAt: nowIso(),
        error: request.error
      };
      terminalRunStore.create(run);
      terminalLeaseService.touch(session.terminalSessionId, run.status);
      if (isTerminalRunDone(run.status)) this.releaseRunLock(run);
      await this.save();
      return this.waitOrRespond(runId, input.waitMs);
    } catch (error) {
      if (this.activeRunLocks.get(session.terminalSessionId) === runId) {
        this.activeRunLocks.delete(session.terminalSessionId);
      }
      throw error;
    }
  }

  async run(runId: string): Promise<AgentTerminalRunResponse> {
    await this.load();
    return this.responseFor(await this.syncRun(runId));
  }

  async assertRunLease(runId: string, leaseToken: string): Promise<void> {
    await this.load();
    const run = terminalRunStore.require(runId);
    const session = terminalLeaseService.requireByLease(leaseToken);
    if (session.terminalSessionId !== run.terminalSessionId) {
      throw codedError("DETACHES_TERMINAL_LEASE_REVOKED", "Terminal lease does not match this run.");
    }
  }

  async cancel(runId: string): Promise<AgentTerminalRunResponse> {
    await this.load();
    const run = await this.syncRun(runId);
    if (["completed", "rejected", "blocked", "failed", "timeout", "cancelled"].includes(run.status)) {
      return this.responseFor(run);
    }
    const error = "Cancelled by agent-terminal request.";
    if (run.status === "waiting_for_approval" && run.requestId) {
      await toolBrokerService.reject(run.requestId, {
        actor: { displayName: "Agent Terminal Runtime", source: "api" }
      }).catch(() => undefined);
    } else if (run.requestId) {
      await toolBrokerService.failRequest(run.requestId, error).catch(() => undefined);
    }
    const session = terminalLeaseService.list().find((item) => item.terminalSessionId === run.terminalSessionId);
    if (session && (run.status === "running" || run.status === "approved")) {
      terminalService.interrupt(session.sessionKey);
      terminalService.reset(session.sessionKey, `gateway terminal run ${run.runId} was cancelled; recreating the PTY for the next command`);
    }
    const updated = this.updateRun(run, { status: "cancelled", cancelledAt: nowIso(), error });
    await this.save();
    return this.responseFor(updated);
  }

  async wait(runId: string, timeoutMs: number): Promise<AgentTerminalRunResponse> {
    await this.load();
    return this.waitOrRespond(runId, timeoutMs);
  }

  async stream(runId: string, send: (event: AgentTerminalStreamEvent) => void): Promise<() => void> {
    await this.load();
    const initial = await this.syncRun(runId);
    send(terminalStreamHub.eventForRun(initial));
    return terminalStreamHub.subscribe(runId, send);
  }

  private async waitOrRespond(runId: string, waitMs = 0): Promise<AgentTerminalRunResponse> {
    const started = Date.now();
    let latest = await this.syncRun(runId);
    while (!isTerminalRunDone(latest.status) && waitMs > 0 && Date.now() - started < waitMs) {
      await delay(350);
      latest = await this.syncRun(runId);
    }
    if (!isTerminalRunDone(latest.status) && waitMs > 0 && Date.now() - started >= waitMs) {
      latest = await this.timeoutRun(latest, waitMs);
    }
    return this.responseFor(latest);
  }

  private async syncRun(runId: string): Promise<AgentTerminalRun> {
    const run = terminalRunStore.require(runId);
    if (!run.requestId || isTerminalRunDone(run.status)) return run;
    const request = await toolBrokerService.request(run.requestId);
    let patch: Partial<AgentTerminalRun> = {};
    if (request.status === "rejected") patch = { status: "rejected", approvalStatus: "rejected", error: request.error };
    if (request.status === "blocked") patch = { status: "blocked", error: request.error };
    if (request.status === "failed") patch = { status: "failed", error: request.error };
    if (request.status === "approved" || request.status === "running" || request.status === "succeeded") {
      patch = { status: "running", approvalStatus: "approved" };
      const result = await toolBrokerService.result(run.requestId).catch(() => null);
      if (result?.result) {
        const output = result.result.output || "";
        patch = {
          ...patch,
          executionId: result.result.executionId,
          output: output.slice(-OUTPUT_LIMIT),
          outputTail: output.slice(-4000),
          outputBytes: result.result.outputBytes,
          outputTruncated: output.length > OUTPUT_LIMIT,
          exitCode: result.result.exitCode,
          startedAt: run.startedAt || result.result.capturedAt
        };
        terminalStreamHub.emit("output", { ...run, ...patch, status: patch.status as AgentTerminalRunStatus });
        if (result.result.completed) {
          patch = {
            ...patch,
            status: result.result.exitCode === 0 ? "completed" : "failed",
            completedAt: nowIso(),
            error: result.result.exitCode === 0 ? undefined : `Command exited with code ${result.result.exitCode}.`
          };
        }
      }
    }
    const updated = Object.keys(patch).length ? this.updateRun(run, patch) : run;
    await this.save();
    return updated;
  }

  private async timeoutRun(run: AgentTerminalRun, waitMs: number): Promise<AgentTerminalRun> {
    const error = `Timed out after ${waitMs}ms.`;
    if (run.requestId) {
      await toolBrokerService.failRequest(run.requestId, error).catch(() => undefined);
    }
    if (run.status === "running" || run.status === "approved") {
      const session = terminalLeaseService.list().find((item) => item.terminalSessionId === run.terminalSessionId);
      if (session) {
        terminalService.interrupt(session.sessionKey);
        terminalService.reset(session.sessionKey, `gateway terminal run ${run.runId} timed out; recreating the PTY for the next command`);
      }
    }
    const updated = this.updateRun(run, { status: "timeout", completedAt: nowIso(), error });
    await this.save();
    return updated;
  }

  private async syncActiveRunsForSession(terminalSessionId: string): Promise<void> {
    const activeRuns = terminalRunStore.list().filter((run) => run.terminalSessionId === terminalSessionId && !isTerminalRunDone(run.status));
    for (const run of activeRuns) {
      await this.syncRun(run.runId).catch(() => undefined);
    }
  }

  private findActiveRunForSession(terminalSessionId: string): AgentTerminalRun | null {
    const lockedRunId = this.activeRunLocks.get(terminalSessionId);
    if (lockedRunId) {
      const lockedRun = terminalRunStore.list().find((run) => run.runId === lockedRunId);
      if (!lockedRun || !isTerminalRunDone(lockedRun.status)) return lockedRun ?? null;
      this.activeRunLocks.delete(terminalSessionId);
    }
    return terminalRunStore.list()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .find((run) => run.terminalSessionId === terminalSessionId && !isTerminalRunDone(run.status)) ?? null;
  }

  private async createBusyRun(input: { terminalSessionId: string; command: string; reason?: string; activeRunId: string }): Promise<AgentTerminalRunResponse> {
    const run: AgentTerminalRun = {
      runId: nanoid(),
      terminalSessionId: input.terminalSessionId,
      command: input.command,
      reason: input.reason,
      status: "failed",
      guard: {
        decision: "block",
        riskLevel: "safe",
        matchedRules: ["gateway-terminal-active-run"],
        normalizedCommand: input.command
      },
      createdAt: nowIso(),
      error: `Gateway terminal is busy. Active run ${input.activeRunId} has not reached a terminal state yet.`
    };
    terminalRunStore.create(run);
    terminalLeaseService.touch(input.terminalSessionId, run.status);
    await this.save();
    return this.responseFor(run);
  }

  private updateRun(run: AgentTerminalRun, patch: Partial<AgentTerminalRun>): AgentTerminalRun {
    const updated = terminalRunStore.update(run, patch);
    terminalLeaseService.touch(run.terminalSessionId, updated.status);
    if (isTerminalRunDone(updated.status)) this.releaseRunLock(updated);
    return updated;
  }

  private releaseRunLock(run: AgentTerminalRun): void {
    if (this.activeRunLocks.get(run.terminalSessionId) === run.runId) {
      this.activeRunLocks.delete(run.terminalSessionId);
    }
  }

  private responseFor(run: AgentTerminalRun): AgentTerminalRunResponse {
    return {
      ok: run.status === "completed" || run.status === "running" || run.status === "waiting_for_approval" || run.status === "approved",
      run,
      status: run.status,
      pollEndpoint: `/api/agent-terminal/runs/${encodeURIComponent(run.runId)}`,
      streamEndpoint: `/api/agent-terminal/runs/${encodeURIComponent(run.runId)}/stream`,
      output: run.output,
      outputTail: run.outputTail,
      outputTruncated: run.outputTruncated,
      exitCode: run.exitCode,
      code: codeForRun(run),
      message: run.error
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const parsed = await loadAgentTerminalState();
    if (parsed?.version !== 1) return;
    terminalLeaseService.load(parsed.sessions ?? []);
    terminalRunStore.load((parsed.runs ?? []) as AgentTerminalRun[]);
  }

  private async save(): Promise<void> {
    const state: { version: 1; sessions: ReturnType<typeof terminalLeaseService.list>; runs: AgentTerminalRun[] } = {
      version: 1,
      sessions: terminalLeaseService.list(),
      runs: terminalRunStore.list()
    };
    this.saveChain = this.saveChain.then(() => saveAgentTerminalState(state));
    return this.saveChain;
  }
}

export const agentTerminalService = new AgentTerminalService();

function codeForRun(run: AgentTerminalRun): string | undefined {
  const status = run.status;
  if (status === "failed" && run.error?.startsWith("Gateway terminal is busy.")) return "DETACHES_TERMINAL_BUSY";
  if (status === "blocked") return "DETACHES_COMMAND_BLOCKED";
  if (status === "rejected") return "DETACHES_APPROVAL_REJECTED";
  if (status === "timeout") return "DETACHES_TERMINAL_TIMEOUT";
  if (status === "cancelled") return "DETACHES_TERMINAL_CANCELLED";
  if (status === "failed") return "DETACHES_TERMINAL_INTERNAL_ERROR";
  return undefined;
}

function codedError(code: string, message: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
