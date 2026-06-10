import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  ToolRequestCreateInput,
  ToolRequestDecisionResponse,
  ToolRequestExtractResponse,
  ToolRequestKind,
  ToolRequestRecord,
  ToolRequestStatus,
  ToolTarget
} from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { fileTransferService } from "../files/fileTransferService.js";
import { terminalService } from "../terminal/terminalService.js";

type AuditEvent =
  | { type: "tool.create"; request: ToolRequestRecord }
  | { type: "tool.approve"; requestId: string; status: ToolRequestStatus; command?: string; terminalId?: string; error?: string }
  | { type: "tool.reject"; requestId: string; status: ToolRequestStatus };

class ToolBrokerService {
  private requests = new Map<string, ToolRequestRecord>();

  async extractFromText(input: { text: string; sessionKey: string; agentId?: string }): Promise<ToolRequestExtractResponse> {
    const parsed = parseToolRequests(input.text);
    const requests = [];
    for (const item of parsed) {
      requests.push(await this.create({
        kind: item.kind,
        target: item.target,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        reason: item.reason,
        payload: item.payload
      }));
    }
    return { requests };
  }

  async create(input: ToolRequestCreateInput): Promise<ToolRequestRecord> {
    const now = new Date().toISOString();
    const record: ToolRequestRecord = {
      ...input,
      id: nanoid(),
      status: this.targetSupported(input.kind, input.target) ? "pending" : "blocked",
      createdAt: now,
      updatedAt: now,
      error: this.targetSupported(input.kind, input.target) ? undefined : unsupportedTargetMessage(input.kind, input.target)
    };
    this.requests.set(record.id, record);
    await this.audit({ type: "tool.create", request: record });
    return record;
  }

  async approve(requestId: string): Promise<ToolRequestDecisionResponse> {
    const request = this.requireRequest(requestId);
    if (request.status === "blocked") {
      await this.audit({ type: "tool.approve", requestId, status: "blocked", error: request.error });
      throw new Error(request.error || "Tool request is blocked.");
    }
    if (request.status !== "pending" && request.status !== "failed") {
      throw new Error(`Tool request is already ${request.status}.`);
    }
    if (request.kind === "terminal") {
      const command = stringPayload(request, "command");
      if (!command) {
        return this.fail(request, "Terminal request payload.command is required.");
      }
      const terminal = await terminalService.runCommand(request.sessionKey, command);
      const updated = this.update(request, "approved");
      await this.audit({ type: "tool.approve", requestId, status: updated.status, command, terminalId: terminal.terminalId });
      return {
        request: updated,
        command,
        execution: {
          target: request.target,
          terminalId: terminal.terminalId,
          sessionKey: terminal.sessionKey,
          wroteToTerminal: true
        },
        message: "Command was written to the session terminal by the server broker."
      };
    }
    if (request.kind === "file-transfer") {
      const fileId = stringPayload(request, "fileId");
      const remotePath = stringPayload(request, "remotePath");
      if (!fileId || !remotePath) {
        return this.fail(request, "File transfer request requires payload.fileId and payload.remotePath.");
      }
      try {
        const prepared = await fileTransferService.prepareTransfer({
          fileId,
          remotePath,
          target: request.target,
          agentId: request.agentId,
          sessionKey: request.sessionKey
        });
        const terminal = await terminalService.runCommand(request.sessionKey, prepared.command);
        const updated = this.update(request, "approved");
        await this.audit({ type: "tool.approve", requestId, status: updated.status, command: prepared.command, terminalId: terminal.terminalId });
        return {
          request: updated,
          command: prepared.command,
          execution: {
            target: request.target,
            terminalId: terminal.terminalId,
            sessionKey: terminal.sessionKey,
            wroteToTerminal: true
          },
          message: "File transfer command was written to the session terminal by the server broker."
        };
      } catch (error) {
        return this.fail(request, error instanceof Error ? error.message : String(error));
      }
    }
    return this.fail(request, `Unsupported tool request kind: ${request.kind}`);
  }

  async reject(requestId: string): Promise<ToolRequestRecord> {
    const request = this.requireRequest(requestId);
    const updated = this.update(request, "rejected");
    await this.audit({ type: "tool.reject", requestId, status: updated.status });
    return updated;
  }

  private targetSupported(kind: ToolRequestKind, target: ToolTarget): boolean {
    return (kind === "terminal" || kind === "file-transfer") && target === "local-user-machine";
  }

  private requireRequest(requestId: string): ToolRequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw new Error("Tool request not found.");
    return request;
  }

  private update(request: ToolRequestRecord, status: ToolRequestStatus, error?: string): ToolRequestRecord {
    const updated = {
      ...request,
      status,
      error,
      updatedAt: new Date().toISOString()
    };
    this.requests.set(request.id, updated);
    return updated;
  }

  private async fail(request: ToolRequestRecord, error: string): Promise<ToolRequestDecisionResponse> {
    const updated = this.update(request, "failed", error);
    await this.audit({ type: "tool.approve", requestId: request.id, status: "failed", error });
    return { request: updated, message: error };
  }

  private async audit(event: AuditEvent): Promise<void> {
    const entry = { ts: new Date().toISOString(), ...event };
    const logPath = path.join(appConfig.storageDir, "logs", "tool-broker-audit.jsonl");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}

export const toolBrokerService = new ToolBrokerService();

interface ParsedToolRequest {
  kind: ToolRequestKind;
  target: ToolTarget;
  reason?: string;
  payload: Record<string, unknown>;
}

function parseToolRequests(text: string): ParsedToolRequest[] {
  return [
    ...parseTerminalCommandRequests(text),
    ...parseFileTransferRequests(text)
  ];
}

function parseTerminalCommandRequests(text: string): ParsedToolRequest[] {
  const requests: ParsedToolRequest[] = [];
  const fencePattern = /```(?:detaches-terminal|terminal-command|terminal-run|shell-run)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text))) {
    const parsed = parseTerminalCommandBody(match[1].trim());
    if (parsed) requests.push(parsed);
  }
  return requests;
}

function parseFileTransferRequests(text: string): ParsedToolRequest[] {
  const requests: ParsedToolRequest[] = [];
  const fencePattern = /```(?:detaches-file-transfer|file-transfer)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text))) {
    const body = match[1].trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as {
        fileId?: unknown;
        remotePath?: unknown;
        target?: unknown;
        reason?: unknown;
      };
      const fileId = typeof parsed.fileId === "string" ? parsed.fileId.trim() : "";
      const remotePath = typeof parsed.remotePath === "string"
        ? parsed.remotePath.trim()
        : targetObject(parsed.target) && typeof parsed.target.remotePath === "string"
          ? parsed.target.remotePath.trim()
          : "";
      if (fileId && remotePath) {
        requests.push({
          kind: "file-transfer",
          target: parseToolTarget(parsed.target),
          reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
          payload: { fileId, remotePath }
        });
      }
    } catch {
      // Ignore malformed requests; the agent can resend a valid JSON block.
    }
  }
  return requests;
}

function parseTerminalCommandBody(body: string): ParsedToolRequest | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { command?: unknown; cmd?: unknown; target?: unknown; reason?: unknown };
    const command = typeof parsed.command === "string" ? parsed.command : typeof parsed.cmd === "string" ? parsed.cmd : "";
    if (command.trim()) {
      return {
        kind: "terminal",
        target: parseToolTarget(parsed.target),
        reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
        payload: { command: command.trim() }
      };
    }
  } catch {
    // Plain shell command block.
  }
  const lines = body.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const command = lines.join("\n").trim();
  return command ? { kind: "terminal", target: "local-user-machine", payload: { command } } : null;
}

function parseToolTarget(value: unknown): ToolTarget {
  const raw = targetObject(value) ? value.environment ?? value.type ?? value.id : value;
  if (raw === "remote-agent-host" || raw === "remote" || raw === "agent-host") return "remote-agent-host";
  if (raw === "gateway-managed" || raw === "gateway") return "gateway-managed";
  return "local-user-machine";
}

function stringPayload(request: ToolRequestRecord, key: string): string {
  const value = request.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function unsupportedTargetMessage(kind: ToolRequestKind, target: ToolTarget): string {
  return `${kind} target ${target} is not available. The request cannot fallback to local-user-machine.`;
}

function targetObject(value: unknown): value is { [key: string]: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
