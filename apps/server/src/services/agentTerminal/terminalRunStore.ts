import type { AgentTerminalRun, AgentTerminalRunStatus } from "@detaches/shared";
import { terminalStreamHub, eventTypeForStatus } from "./terminalStreamHub.js";

class TerminalRunStore {
  private runs = new Map<string, AgentTerminalRun>();

  load(runs: AgentTerminalRun[]): void {
    this.runs = new Map(runs.map((run) => [run.runId, run]));
  }

  list(): AgentTerminalRun[] {
    return [...this.runs.values()];
  }

  create(run: AgentTerminalRun): AgentTerminalRun {
    this.runs.set(run.runId, run);
    terminalStreamHub.emit(run.status === "blocked" ? "blocked" : "approval_waiting", run);
    return run;
  }

  require(runId: string): AgentTerminalRun {
    const run = this.runs.get(runId);
    if (!run) throw codedError("DETACHES_TERMINAL_INTERNAL_ERROR", `Agent terminal run not found: ${runId}`);
    return run;
  }

  update(run: AgentTerminalRun, patch: Partial<AgentTerminalRun>): AgentTerminalRun {
    const updated = { ...run, ...patch };
    this.runs.set(run.runId, updated);
    if (updated.status !== run.status) terminalStreamHub.emit(eventTypeForStatus(updated.status), updated);
    return updated;
  }
}

export const terminalRunStore = new TerminalRunStore();

export function isTerminalRunDone(status: AgentTerminalRunStatus): boolean {
  return ["completed", "rejected", "blocked", "failed", "timeout", "cancelled"].includes(status);
}

function codedError(code: string, message: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}
