import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  ToolRequestCreateInput,
  ToolRequestDecisionResponse,
  ToolRequestKind,
  ToolRequestRecord,
  ToolRequestStatus,
  ToolTarget
} from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { fileTransferService } from "../files/fileTransferService.js";

type AuditEvent =
  | { type: "tool.create"; request: ToolRequestRecord }
  | { type: "tool.approve"; requestId: string; status: ToolRequestStatus; command?: string; error?: string }
  | { type: "tool.reject"; requestId: string; status: ToolRequestStatus };

class ToolBrokerService {
  private requests = new Map<string, ToolRequestRecord>();

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
      const updated = this.update(request, "approved");
      await this.audit({ type: "tool.approve", requestId, status: updated.status, command });
      return { request: updated, command };
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
        const updated = this.update(request, "approved");
        await this.audit({ type: "tool.approve", requestId, status: updated.status, command: prepared.command });
        return { request: updated, command: prepared.command };
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

function stringPayload(request: ToolRequestRecord, key: string): string {
  const value = request.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function unsupportedTargetMessage(kind: ToolRequestKind, target: ToolTarget): string {
  return `${kind} target ${target} is not available. The request cannot fallback to local-user-machine.`;
}
