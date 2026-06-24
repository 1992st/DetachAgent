import { EventEmitter } from "node:events";
import type { AgentTerminalRun, AgentTerminalRunStatus, AgentTerminalStreamEvent } from "@detaches/shared";

class TerminalStreamHub {
  private readonly emitter = new EventEmitter();

  emit(type: AgentTerminalStreamEvent["type"], run: AgentTerminalRun): void {
    const event = type === "output"
      ? { type: "output" as const, runId: run.runId, chunk: run.outputTail || "", outputTail: run.outputTail }
      : { type, run } as AgentTerminalStreamEvent;
    this.emitter.emit("stream", event);
  }

  subscribe(runId: string, send: (event: AgentTerminalStreamEvent) => void): () => void {
    const handler = (event: AgentTerminalStreamEvent) => {
      if ("run" in event && event.run.runId === runId) send(event);
      if (event.type === "output" && event.runId === runId) send(event);
    };
    this.emitter.on("stream", handler);
    return () => this.emitter.off("stream", handler);
  }

  eventForRun(run: AgentTerminalRun): AgentTerminalStreamEvent {
    return run.status === "waiting_for_approval"
      ? { type: "approval_waiting", run }
      : { type: eventTypeForStatus(run.status), run } as AgentTerminalStreamEvent;
  }
}

export const terminalStreamHub = new TerminalStreamHub();

export function eventTypeForStatus(status: AgentTerminalRunStatus): AgentTerminalStreamEvent["type"] {
  if (status === "waiting_for_approval" || status === "queued") return "approval_waiting";
  if (status === "approved") return "approved";
  if (status === "running") return "started";
  if (status === "completed") return "completed";
  return status;
}
