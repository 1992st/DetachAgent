import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import type {
  ToolGatewayEventInput,
  ToolRequestApproveInput,
  ToolRequestCreateInput,
  ToolRequestCreateResponse,
  ToolDecisionActor,
  ToolRequestDecisionResponse,
  ToolResultForwardStatus,
  ToolRequestExtractResponse,
  ToolRequestKind,
  ToolRequestListInput,
  ToolRequestListResponse,
  ToolRequestRecord,
  ToolRequestRejectInput,
  ToolRequestStatus,
  ToolRiskAssessment,
  ToolExecutionResultResponse,
  ToolTarget
} from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { fileTransferService } from "../files/fileTransferService.js";
import { mainAgentFileTransferService } from "../files/mainAgentFileTransferService.js";
import { gatewayClient } from "../gateway/gatewayClient.js";
import { terminalService } from "../terminal/terminalService.js";
import { openclawDetachesAdapterService } from "../adapters/openclawDetachesAdapterService.js";
import { platformService } from "../platform/platformService.js";

const DETACH_AGENT_SKILL_NAME = "detach-agent-relationship";
const DETACH_AGENT_SKILL_VERSION = "1.0.1";
const DETACH_AGENT_SKILL_ZIP_PATH = platformService.resolvePackagedResourcePath("web", "public", "skills", "detach-agent-relationship.skill.zip")
  ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../web/public/skills/detach-agent-relationship.skill.zip"
  );
const OPENCLAW_GLOBAL_SKILLS_DIR = "~/.openclaw/skills";
const DETACH_AGENT_LOCAL_SKILL_CACHE_DIR = "~/.detach_agent/skills";

type AuditEvent =
  | { type: "tool.create"; request: ToolRequestRecord }
  | { type: "tool.ingest"; requestId: string; sourceEventId: string; duplicate: boolean }
  | { type: "tool.approve"; requestId: string; status: ToolRequestStatus; command?: string; terminalId?: string; executionId?: string; riskAccepted?: boolean; actor?: ToolDecisionActor; error?: string }
  | { type: "tool.result.forward"; requestId: string; executionId: string; status: ToolResultForwardStatus; ok: boolean; error?: string }
  | { type: "tool.reject"; requestId: string; status: ToolRequestStatus; actor?: ToolDecisionActor };

export type ToolBrokerEvent = {
  action: "created" | "updated" | "ingested" | "duplicate";
  request: ToolRequestRecord;
};

interface ToolExecutionRecord {
  executionId: string;
  requestId: string;
  sessionKey: string;
  terminalId: string;
  startOffset: number;
  command: string;
  wrappedCommand: string;
  createdAt: string;
  mode?: "terminal" | "direct";
  completedAt?: string;
  exitCode?: number;
  output?: string;
  forwardStatus: ToolResultForwardStatus;
  forwardError?: string;
  forwardedAt?: string;
}

interface ToolExecutionResultSnapshot {
  executionId: string;
  requestId: string;
  status: ToolRequestStatus;
  terminalId?: string;
  sessionKey: string;
  completed: boolean;
  exitCode?: number;
  forwardStatus: ToolResultForwardStatus;
  forwardError?: string;
  forwardedAt?: string;
  output: string;
  outputBytes: number;
  capturedAt: string;
  message?: string;
}

interface ToolBrokerState {
  version: 1;
  requests: ToolRequestRecord[];
  executions: ToolExecutionRecord[];
}

class ToolBrokerService {
  private requests = new Map<string, ToolRequestRecord>();
  private executions = new Map<string, ToolExecutionRecord>();
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();
  readonly emitter = new EventEmitter();

  async extractFromText(input: { text: string; sessionKey: string; agentId?: string; sourceMessageId?: string; sourceRunId?: string }): Promise<ToolRequestExtractResponse> {
    await this.load();
    const parsed = parseToolRequests(input.text);
    const requests = [];
    for (const item of parsed) {
      const existing = this.findDuplicateExtractedRequest({
        kind: item.kind,
        target: item.target,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        sourceMessageId: input.sourceMessageId,
        sourceRunId: input.sourceRunId,
        payload: item.payload
      });
      if (existing) {
        requests.push(existing);
        continue;
      }
      requests.push(await this.create({
        kind: item.kind,
        target: item.target,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        reason: item.reason,
        source: "text-extract",
        sourceMessageId: input.sourceMessageId,
        sourceRunId: input.sourceRunId,
        payload: item.payload
      }));
    }
    return { requests };
  }

  async create(input: ToolRequestCreateInput): Promise<ToolRequestRecord> {
    await this.load();
    if (input.sourceEventId) {
      const existing = this.findBySourceEventId(input.sourceEventId);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const risk = assessRisk(input);
    const supported = this.targetSupported(input.kind, input.target);
    const blockedReason = supported
      ? risk.level === "destructive" ? `Tool request blocked by risk policy: ${risk.reasons.join("; ")}` : undefined
      : unsupportedTargetMessage(input.kind, input.target);
    const record: ToolRequestRecord = {
      ...input,
      id: nanoid(),
      risk,
      status: blockedReason ? "blocked" : "pending",
      createdAt: now,
      updatedAt: now,
      error: blockedReason
    };
    this.requests.set(record.id, record);
    await this.save();
    await this.audit({ type: "tool.create", request: record });
    this.emit("created", record);
    return record;
  }

  async ingestGatewayEvent(input: ToolGatewayEventInput): Promise<ToolRequestCreateResponse> {
    await this.load();
    const existing = this.findBySourceEventId(input.sourceEventId);
    if (existing) {
      await this.audit({ type: "tool.ingest", requestId: existing.id, sourceEventId: input.sourceEventId, duplicate: true });
      this.emit("duplicate", existing);
      return { request: existing };
    }
    const request = await this.create(input);
    await this.audit({ type: "tool.ingest", requestId: request.id, sourceEventId: input.sourceEventId, duplicate: false });
    this.emit("ingested", request);
    return { request };
  }

  async list(input: ToolRequestListInput = {}): Promise<ToolRequestListResponse> {
    await this.load();
    const limit = Number.isFinite(input.limit) && input.limit ? Math.min(Math.max(Math.floor(input.limit), 1), 200) : 50;
    const requests = [...this.requests.values()]
      .filter((request) => !input.sessionKey || request.sessionKey === input.sessionKey)
      .filter((request) => !input.agentId || request.agentId === input.agentId)
      .filter((request) => !input.status || request.status === input.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return { requests };
  }

  async approve(requestId: string, input: ToolRequestApproveInput = {}): Promise<ToolRequestDecisionResponse> {
    await this.load();
    const request = this.requireRequest(requestId);
    if (request.status === "blocked") {
      await this.audit({ type: "tool.approve", requestId, status: "blocked", actor: input.actor, riskAccepted: input.riskAccepted, error: request.error });
      throw new Error(request.error || "Tool request is blocked.");
    }
    if (request.status !== "pending" && request.status !== "failed") {
      throw new Error(`Tool request is already ${request.status}.`);
    }
    if (request.risk?.level === "elevated" && !input.riskAccepted) {
      await this.audit({ type: "tool.approve", requestId, status: request.status, actor: input.actor, riskAccepted: false, error: "risk confirmation missing" });
      throw new Error(`Elevated-risk tool request requires explicit confirmation: ${request.risk.reasons.join("; ")}`);
    }
    if (request.kind === "terminal") {
      const command = stringPayload(request, "command");
      if (!command) {
        return this.fail(request, "Terminal request payload.command is required.");
      }
      const execution = await this.runInTerminal(request, command);
      const updated = this.update(request, "approved", undefined, decision("approved", input));
      await this.save();
      await this.audit({ type: "tool.approve", requestId, status: updated.status, command, terminalId: execution.terminalId, executionId: execution.executionId, actor: input.actor, riskAccepted: input.riskAccepted });
      void this.forwardResultToAgent(updated.id);
      return {
        request: updated,
        command,
        execution: {
          executionId: execution.executionId,
          target: request.target,
          terminalId: execution.terminalId,
          sessionKey: execution.sessionKey,
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
        const timeoutMs = prepared.timeoutMs ?? 30000;
        const execution = await this.runDirectCommand(request, prepared.command, timeoutMs);
        let updated = this.update(request, "running", undefined, decision("approved", input));
        await this.save();
        await this.audit({ type: "tool.approve", requestId, status: updated.status, command: prepared.command, terminalId: execution.terminalId, executionId: execution.executionId, actor: input.actor, riskAccepted: input.riskAccepted });
        const result = await this.waitForExecutionResult(updated.id, { timeoutMs: timeoutMs + 1000 });
        if (result.completed) {
          if (result.exitCode === 0) {
            await fileTransferService.markTransferred(fileId);
            updated = this.update(updated, "succeeded");
          } else {
            updated = this.update(updated, "failed", result.output.trim().slice(-4000) || `File transfer exited with code ${result.exitCode}.`);
          }
          await this.save();
        } else {
          updated = this.update(updated, "failed", "File transfer did not report completion within 30 seconds. Check the session terminal output and retry.");
          await this.save();
        }
        void this.forwardResultToAgent(updated.id, { delayMs: 0 });
        return {
          request: updated,
          command: prepared.command,
          execution: {
            executionId: execution.executionId,
            target: request.target,
            terminalId: execution.terminalId,
            sessionKey: execution.sessionKey,
            wroteToTerminal: execution.mode !== "direct",
            completed: result.completed,
            exitCode: result.exitCode,
            forwardStatus: result.forwardStatus
          },
          message: result.completed && result.exitCode === 0
            ? "File transfer completed and the result is being forwarded to the agent."
            : result.completed
              ? "File transfer failed and the result is being forwarded to the agent."
              : "File transfer command was written to the session terminal; completion is still pending."
        };
      } catch (error) {
        return this.fail(request, error instanceof Error ? error.message : String(error));
      }
    }
    if (request.kind === "main-agent-save-file") {
      try {
        const transfer = await mainAgentFileTransferService.start(request);
        const updated = this.update(request, "running", undefined, decision("approved", input));
        await this.save();
        await this.audit({ type: "tool.approve", requestId, status: updated.status, command: `main-agent-save-file:${transfer.transferId}`, actor: input.actor, riskAccepted: input.riskAccepted });
        return {
          request: updated,
          execution: {
            executionId: transfer.transferId,
            target: request.target,
            sessionKey: request.sessionKey,
            wroteToTerminal: false,
            completed: false,
            forwardStatus: "not-started"
          },
          message: transfer.needsPassword ? "File transfer is waiting for SSH password." : "Main Agent file transfer started."
        };
      } catch (error) {
        return this.fail(request, error instanceof Error ? error.message : String(error));
      }
    }
    if (request.kind === "adapter-install") {
      const installDir = stringPayload(request, "installDir") || "~/.detach_agent";
      const workspaceDir = stringPayload(request, "workspaceDir") || "~/.openclaw/workspace";
      try {
        const prepared = await openclawDetachesAdapterService.prepareRemoteInstallCommand({ installDir, workspaceDir });
        const execution = await this.runInTerminal(request, prepared.command);
        const updated = this.update(request, "approved", undefined, decision("approved", input));
        await this.save();
        await this.audit({ type: "tool.approve", requestId, status: updated.status, command: prepared.command, terminalId: execution.terminalId, executionId: execution.executionId, actor: input.actor, riskAccepted: input.riskAccepted });
        void this.forwardResultToAgent(updated.id);
        return {
          request: updated,
          command: prepared.command,
          execution: {
            executionId: execution.executionId,
            target: request.target,
            terminalId: execution.terminalId,
            sessionKey: execution.sessionKey,
            wroteToTerminal: true
          },
          message: "Remote adapter installation command was written to the session terminal by the server broker."
        };
      } catch (error) {
        return this.fail(request, error instanceof Error ? error.message : String(error));
      }
    }
    if (request.kind === "skill-install" || request.kind === "skill-verify") {
      try {
        const command = request.kind === "skill-install"
          ? buildOpenClawSkillInstallCommand(request)
          : buildOpenClawSkillVerifyCommand(request);
        const execution = await this.runInTerminal(request, command);
        const updated = this.update(request, "approved", undefined, decision("approved", input));
        await this.save();
        await this.audit({ type: "tool.approve", requestId, status: updated.status, command, terminalId: execution.terminalId, executionId: execution.executionId, actor: input.actor, riskAccepted: input.riskAccepted });
        void this.forwardResultToAgent(updated.id);
        return {
          request: updated,
          command,
          execution: {
            executionId: execution.executionId,
            target: request.target,
            terminalId: execution.terminalId,
            sessionKey: execution.sessionKey,
            wroteToTerminal: true
          },
          message: request.kind === "skill-install"
            ? "Skill installation command was written to the session terminal by the server broker."
            : "Skill verification command was written to the session terminal by the server broker."
        };
      } catch (error) {
        return this.fail(request, error instanceof Error ? error.message : String(error));
      }
    }
    return this.fail(request, `Unsupported tool request kind: ${request.kind}`);
  }

  async result(requestId: string): Promise<ToolExecutionResultResponse> {
    await this.load();
    const request = this.requireRequest(requestId);
    if (request.kind === "main-agent-save-file") {
      const transfer = mainAgentFileTransferService.findByRequest(requestId);
      if (transfer && (transfer.status === "succeeded" || transfer.status === "failed") && request.status === "running") {
        const updated = this.update(request, transfer.status === "succeeded" ? "succeeded" : "failed", transfer.error);
        await this.save();
        void this.forwardResultToAgent(updated.id, { delayMs: 0 });
        return this.result(requestId);
      }
      const output = transfer ? JSON.stringify(transfer, null, 2) : "";
      return {
        request: this.requests.get(requestId) ?? request,
        result: {
          executionId: transfer?.transferId ?? "",
          requestId,
          status: (this.requests.get(requestId) ?? request).status,
          sessionKey: request.sessionKey,
          completed: transfer?.status === "succeeded" || transfer?.status === "failed",
          exitCode: transfer?.status === "succeeded" ? 0 : transfer?.status === "failed" ? 1 : undefined,
          forwardStatus: "not-started",
          output,
          outputBytes: Buffer.byteLength(output, "utf8"),
          capturedAt: new Date().toISOString(),
          message: "Main Agent file transfer status snapshot."
        }
      };
    }
    const execution = [...this.executions.values()].find((item) => item.requestId === requestId);
    if (!execution) {
      return {
        request,
        result: {
          executionId: "",
          requestId,
          status: request.status,
          sessionKey: request.sessionKey,
          completed: false,
          forwardStatus: "not-started",
          output: "",
          outputBytes: 0,
          capturedAt: new Date().toISOString(),
          message: "No terminal execution has been recorded for this request."
        }
      };
    }
    if (execution.mode === "direct") {
      const parsed = {
        output: execution.output ?? "",
        completed: typeof execution.exitCode === "number",
        exitCode: execution.exitCode
      };
      const result = this.buildExecutionResult(request, execution, parsed);
      return {
        request,
        result
      };
    }
    const snapshot = await terminalService.snapshot(execution.sessionKey);
    const parsed = parseExecutionOutput(snapshot.replay, execution);
    const result = this.buildExecutionResult(request, execution, parsed);
    return {
      request,
      result
    };
  }

  async reject(requestId: string, input: ToolRequestRejectInput = {}): Promise<ToolRequestRecord> {
    await this.load();
    const request = this.requireRequest(requestId);
    const updated = this.update(request, "rejected", undefined, decision("rejected", input));
    await this.save();
    await this.audit({ type: "tool.reject", requestId, status: updated.status, actor: input.actor });
    return updated;
  }

  async retryForward(requestId: string): Promise<ToolExecutionResultResponse> {
    await this.load();
    await this.forwardResultToAgent(requestId, { delayMs: 0, force: true });
    return this.result(requestId);
  }

  private targetSupported(kind: ToolRequestKind, target: ToolTarget): boolean {
    if (kind === "adapter-install") return target === "remote-agent-host";
    if (kind === "skill-install" || kind === "skill-verify") return target === "local-user-machine";
    if (kind === "main-agent-save-file") return target === "main-agent-machine";
    if (kind === "file-transfer") return target === "local-user-machine" || target === "remote-agent-host";
    return kind === "terminal" && target === "local-user-machine";
  }

  private requireRequest(requestId: string): ToolRequestRecord {
    const request = this.requests.get(requestId);
    if (!request) throw new Error("Tool request not found.");
    return request;
  }

  private findBySourceEventId(sourceEventId: string): ToolRequestRecord | null {
    const normalized = sourceEventId.trim();
    if (!normalized) return null;
    return [...this.requests.values()].find((request) => request.sourceEventId === normalized) ?? null;
  }

  private findDuplicateExtractedRequest(input: {
    kind: ToolRequestKind;
    target: ToolTarget;
    sessionKey: string;
    agentId?: string;
    sourceMessageId?: string;
    sourceRunId?: string;
    payload: Record<string, unknown>;
  }): ToolRequestRecord | null {
    return [...this.requests.values()].find((request) => {
      if (request.source !== "text-extract") return false;
      if (request.kind !== input.kind || request.target !== input.target || request.sessionKey !== input.sessionKey) return false;
      if ((request.agentId || "") !== (input.agentId || "")) return false;
      if (input.sourceMessageId && request.sourceMessageId !== input.sourceMessageId) return false;
      if (!input.sourceMessageId && input.sourceRunId && request.sourceRunId !== input.sourceRunId) return false;
      return toolPayloadFingerprint(request) === toolPayloadFingerprint(input);
    }) ?? null;
  }

  private update(request: ToolRequestRecord, status: ToolRequestStatus, error?: string, lastDecision?: ToolRequestRecord["lastDecision"]): ToolRequestRecord {
    const updated = {
      ...request,
      status,
      lastDecision: lastDecision ?? request.lastDecision,
      error,
      updatedAt: new Date().toISOString()
    };
    this.requests.set(request.id, updated);
    void this.save();
    this.emit("updated", updated);
    return updated;
  }

  private emit(action: ToolBrokerEvent["action"], request: ToolRequestRecord): void {
    this.emitter.emit("request", { action, request } satisfies ToolBrokerEvent);
  }

  private async fail(request: ToolRequestRecord, error: string): Promise<ToolRequestDecisionResponse> {
    const updated = this.update(request, "failed", error);
    await this.save();
    await this.audit({ type: "tool.approve", requestId: request.id, status: "failed", error });
    return { request: updated, message: error };
  }

  private async runInTerminal(request: ToolRequestRecord, command: string): Promise<ToolExecutionRecord> {
    const executionId = nanoid();
    const before = await terminalService.snapshot(request.sessionKey);
    const wrappedCommand = wrapCommandForCompletion(command, executionId);
    const terminal = await terminalService.runCommand(request.sessionKey, wrappedCommand);
    const execution: ToolExecutionRecord = {
      executionId,
      requestId: request.id,
      sessionKey: request.sessionKey,
      terminalId: terminal.terminalId,
      startOffset: before.replay.length,
      command,
      wrappedCommand,
      createdAt: new Date().toISOString(),
      mode: "terminal",
      forwardStatus: "not-started"
    };
    this.executions.set(execution.executionId, execution);
    await this.save();
    return execution;
  }

  private async runDirectCommand(request: ToolRequestRecord, command: string, timeoutMs: number): Promise<ToolExecutionRecord> {
    const executionId = nanoid();
    const terminal = await terminalService.ensure(request.sessionKey);
    const execution: ToolExecutionRecord = {
      executionId,
      requestId: request.id,
      sessionKey: request.sessionKey,
      terminalId: terminal.id,
      startOffset: 0,
      command,
      wrappedCommand: command,
      createdAt: new Date().toISOString(),
      mode: "direct",
      forwardStatus: "not-started",
      output: ""
    };
    this.executions.set(execution.executionId, execution);
    await this.save();
    const result = await runShellCommand(command, timeoutMs);
    const updated: ToolExecutionRecord = {
      ...execution,
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      output: result.output
    };
    this.executions.set(execution.executionId, updated);
    await this.save();
    return updated;
  }

  private async waitForExecutionResult(requestId: string, options: { timeoutMs: number }): Promise<ToolExecutionResultSnapshot> {
    const started = Date.now();
    let latest = await this.result(requestId);
    while (!latest.result.completed && Date.now() - started < options.timeoutMs) {
      await delay(250);
      latest = await this.result(requestId);
    }
    return latest.result;
  }

  private buildExecutionResult(
    request: ToolRequestRecord,
    execution: ToolExecutionRecord,
    parsed: { output: string; completed: boolean; exitCode?: number }
  ): ToolExecutionResultSnapshot {
    const output = parsed.output.slice(-20_000);
    const latestRequest = this.requests.get(request.id) ?? request;
    return {
      executionId: execution.executionId,
      requestId: request.id,
      status: latestRequest.status,
      terminalId: execution.terminalId,
      sessionKey: execution.sessionKey,
      completed: parsed.completed,
      exitCode: parsed.exitCode,
      forwardStatus: execution.forwardStatus,
      forwardError: execution.forwardError,
      forwardedAt: execution.forwardedAt,
      output,
      outputBytes: Buffer.byteLength(output, "utf8"),
      capturedAt: new Date().toISOString(),
      message: parsed.completed
        ? "Output is a terminal replay snapshot captured after the broker completion marker."
        : "Output is a terminal replay snapshot; completion marker has not appeared yet."
    };
  }

  private async forwardResultToAgent(requestId: string, options?: { delayMs?: number; force?: boolean }): Promise<void> {
    await this.load();
    const request = this.requireRequest(requestId);
    if (request.kind === "main-agent-save-file") {
      await this.forwardMainAgentFileTransferResult(request, options);
      return;
    }
    const execution = [...this.executions.values()].find((item) => item.requestId === requestId);
    if (!execution) return;
    if (!options?.force && execution.forwardStatus === "sent") return;
    this.setForwardState(execution, "pending");
    await delay(options?.delayMs ?? 600);
    try {
      const result = await this.result(requestId);
      const output = result.result.output.trim();
      const message = [
        "[detaches_agent 工具结果]",
        "Tool request execution snapshot from the user's local detaches_agent broker.",
        "",
        "```json",
        JSON.stringify({
          requestId,
          executionId: result.result.executionId,
          kind: request.kind,
          target: request.target,
          status: request.status,
          terminalId: result.result.terminalId,
          sessionKey: result.result.sessionKey,
          completed: result.result.completed,
          exitCode: result.result.exitCode,
          outputBytes: result.result.outputBytes,
          outputTail: output.slice(-4000)
        }, null, 2),
        "```",
        "",
        "This is a terminal replay snapshot, not a guaranteed command-completion signal."
      ].join("\n");
      await gatewayClient.sendChat({
        sessionKey: request.sessionKey,
        message,
        idempotencyKey: `detaches-tool-result:${execution.executionId}`,
        clientContext: {
          app: "detaches_agent",
          channel: "detaches_tool_result",
          toolResult: true,
          requestId,
          executionId: execution.executionId
        }
      });
      this.setForwardState(execution, "sent");
      await this.audit({ type: "tool.result.forward", requestId, executionId: execution.executionId, status: "sent", ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setForwardState(execution, "failed", message);
      await this.audit({
        type: "tool.result.forward",
        requestId,
        executionId: execution.executionId,
        status: "failed",
        ok: false,
        error: message
      });
    }
  }

  private async forwardMainAgentFileTransferResult(request: ToolRequestRecord, options?: { delayMs?: number; force?: boolean }): Promise<void> {
    const transfer = mainAgentFileTransferService.findByRequest(request.id);
    if (!transfer) return;
    await delay(options?.delayMs ?? 600);
    try {
      const message = [
        "[detaches_agent 工具结果]",
        "Main Agent file transfer snapshot from the user's local detaches_agent broker.",
        "",
        "```json",
        JSON.stringify({
          requestId: request.id,
          executionId: transfer.transferId,
          kind: request.kind,
          target: request.target,
          status: request.status,
          completed: transfer.status === "succeeded" || transfer.status === "failed",
          transferStatus: transfer.status,
          sourceLocalPath: transfer.sourceLocalPath,
          destination: transfer.destination,
          method: transfer.method,
          error: transfer.error
        }, null, 2),
        "```"
      ].join("\n");
      await gatewayClient.sendChat({
        sessionKey: request.sessionKey,
        message,
        idempotencyKey: `detaches-tool-result:${transfer.transferId}`,
        clientContext: {
          app: "detaches_agent",
          channel: "detaches_tool_result",
          toolResult: true,
          requestId: request.id,
          executionId: transfer.transferId
        }
      });
      await this.audit({ type: "tool.result.forward", requestId: request.id, executionId: transfer.transferId, status: "sent", ok: true });
    } catch (error) {
      await this.audit({
        type: "tool.result.forward",
        requestId: request.id,
        executionId: transfer.transferId,
        status: "failed",
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private setForwardState(execution: ToolExecutionRecord, status: ToolResultForwardStatus, error?: string): void {
    const updated: ToolExecutionRecord = {
      ...execution,
      forwardStatus: status,
      forwardError: error,
      forwardedAt: status === "sent" ? new Date().toISOString() : execution.forwardedAt
    };
    if (status !== "failed") delete updated.forwardError;
    this.executions.set(execution.executionId, updated);
    void this.save();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.statePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<ToolBrokerState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.requests) || !Array.isArray(parsed.executions)) return;
      this.requests = new Map(parsed.requests.filter(isToolRequestRecord).map((request) => [request.id, request]));
      this.executions = new Map(parsed.executions.filter(isToolExecutionRecord).map((execution) => [execution.executionId, execution]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.audit({
          type: "tool.result.forward",
          requestId: "state-load",
          executionId: "state-load",
          status: "failed",
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async save(): Promise<void> {
    const state: ToolBrokerState = {
      version: 1,
      requests: [...this.requests.values()],
      executions: [...this.executions.values()]
    };
    this.saveChain = this.saveChain.then(async () => {
      const filePath = this.statePath();
      const tempPath = `${filePath}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tempPath, filePath);
    });
    return this.saveChain;
  }

  private statePath(): string {
    return path.join(appConfig.storageDir, "cache", "tool-broker-state.json");
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
  return dedupeParsedToolRequests([
    ...parseTerminalCommandRequests(text),
    ...parseFileTransferRequests(text),
    ...parseMainAgentSaveFileRequests(text)
  ]);
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

function dedupeParsedToolRequests(requests: ParsedToolRequest[]): ParsedToolRequest[] {
  const seen = new Set<string>();
  return requests.filter((request) => {
    const fingerprint = parsedToolFingerprint(request);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function parsedToolFingerprint(request: ParsedToolRequest): string {
  return [
    request.kind,
    request.target,
    String(request.payload.command ?? ""),
    String(request.payload.fileId ?? ""),
    String(request.payload.remotePath ?? ""),
    String(request.payload.sourceLocalPath ?? ""),
    destinationFingerprint(request.payload.destination)
  ].join("\0");
}

function toolPayloadFingerprint(input: Pick<ToolRequestCreateInput, "kind" | "target" | "payload">): string {
  return [
    input.kind,
    input.target,
    String(input.payload.command ?? ""),
    String(input.payload.fileId ?? ""),
    String(input.payload.remotePath ?? ""),
    String(input.payload.sourceLocalPath ?? ""),
    destinationFingerprint(input.payload.destination)
  ].join("\0");
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
  return keepLastFileTransferPerFile(requests);
}

function parseMainAgentSaveFileRequests(text: string): ParsedToolRequest[] {
  const requests: ParsedToolRequest[] = [];
  const fencePattern = /```(?:main-agent-save-file|detaches-main-agent-save-file)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text))) {
    const body = match[1].trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as {
        fileId?: unknown;
        sourceLocalPath?: unknown;
        displayName?: unknown;
        size?: unknown;
        destination?: unknown;
        methodPreference?: unknown;
        reason?: unknown;
      };
      const fileId = typeof parsed.fileId === "string" ? parsed.fileId.trim() : "";
      const sourceLocalPath = typeof parsed.sourceLocalPath === "string" ? parsed.sourceLocalPath.trim() : "";
      const destination = mainAgentDestinationPayload(parsed.destination);
      if (fileId && sourceLocalPath && destination) {
        requests.push({
          kind: "main-agent-save-file",
          target: "main-agent-machine",
          reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
          payload: {
            fileId,
            sourceLocalPath,
            displayName: typeof parsed.displayName === "string" ? parsed.displayName.trim() : undefined,
            size: typeof parsed.size === "number" ? parsed.size : undefined,
            destination,
            methodPreference: parsed.methodPreference === "scp" ? "scp" : "rsync"
          }
        });
      }
    } catch {
      // Ignore malformed requests; the agent can resend a valid JSON block.
    }
  }
  return requests;
}

function keepLastFileTransferPerFile(requests: ParsedToolRequest[]): ParsedToolRequest[] {
  const lastIndexByFileId = new Map<string, number>();
  requests.forEach((request, index) => {
    const fileId = typeof request.payload.fileId === "string" ? request.payload.fileId : "";
    if (fileId) lastIndexByFileId.set(fileId, index);
  });
  return requests.filter((request, index) => {
    const fileId = typeof request.payload.fileId === "string" ? request.payload.fileId : "";
    return !fileId || lastIndexByFileId.get(fileId) === index;
  });
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
  if (raw === "main-agent-machine" || raw === "main-agent" || raw === "host-main-agent") return "main-agent-machine";
  return "local-user-machine";
}

function destinationFingerprint(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return [record.host, record.port, record.user, record.path].map((item) => String(item ?? "")).join(":");
}

function mainAgentDestinationPayload(value: unknown): { host: string; port: number; user: string; path: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const host = typeof record.host === "string" ? record.host.trim() : "";
  const user = typeof record.user === "string" ? record.user.trim() : "";
  const remotePath = typeof record.path === "string" ? record.path.trim() : "";
  const port = typeof record.port === "number" ? record.port : Number(record.port);
  if (!host || !user || !remotePath.startsWith("/") || !Number.isFinite(port)) return null;
  return { host, user, path: remotePath, port: Math.max(1, Math.min(65535, Math.floor(port))) };
}

function stringPayload(request: ToolRequestRecord, key: string): string {
  const value = request.payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function buildOpenClawSkillInstallCommand(request: ToolRequestRecord): string {
  const skillName = stringPayload(request, "skillName") || DETACH_AGENT_SKILL_NAME;
  const targetAgent = stringPayload(request, "targetAgent") || "openclaw";
  if (skillName !== DETACH_AGENT_SKILL_NAME) throw new Error(`Unsupported skillName: ${skillName}`);
  if (targetAgent !== "openclaw") throw new Error(`Unsupported targetAgent: ${targetAgent}`);
  const targetDir = shellPath(stringPayload(request, "targetDir") || OPENCLAW_GLOBAL_SKILLS_DIR);
  const localSkillCacheDir = shellPath(stringPayload(request, "localSkillCacheDir") || DETACH_AGENT_LOCAL_SKILL_CACHE_DIR);
  const zipPath = shellQuote(DETACH_AGENT_SKILL_ZIP_PATH);
  const quotedSkill = shellQuote(DETACH_AGENT_SKILL_NAME);
  const quotedVersion = shellQuote(DETACH_AGENT_SKILL_VERSION);
  return [
    "set -e",
    `ZIP=${zipPath}`,
    `TARGET_DIR=${targetDir}`,
    `LOCAL_SKILL_CACHE_DIR=${localSkillCacheDir}`,
    `SKILL_NAME=${quotedSkill}`,
    `TARGET_VERSION=${quotedVersion}`,
    "TMP_DIR=$(mktemp -d)",
    "cleanup() { rm -rf \"$TMP_DIR\"; }",
    "trap cleanup EXIT",
    "test -f \"$ZIP\" || { echo \"Skill zip not found: $ZIP\" >&2; exit 2; }",
    "mkdir -p \"$LOCAL_SKILL_CACHE_DIR\"",
    "unzip -q -o \"$ZIP\" -d \"$TMP_DIR\"",
    "test -f \"$TMP_DIR/$SKILL_NAME/SKILL.md\" || { echo \"Missing SKILL.md in skill package\" >&2; exit 3; }",
    "test -f \"$TMP_DIR/$SKILL_NAME/VERSION\" || { echo \"Missing VERSION in skill package\" >&2; exit 4; }",
    "test -f \"$TMP_DIR/$SKILL_NAME/README.md\" || { echo \"Missing README.md in skill package\" >&2; exit 5; }",
    "test -f \"$TMP_DIR/$SKILL_NAME/CHANGELOG.md\" || { echo \"Missing CHANGELOG.md in skill package\" >&2; exit 8; }",
    "rm -rf \"$LOCAL_SKILL_CACHE_DIR/$SKILL_NAME\"",
    "cp -R \"$TMP_DIR/$SKILL_NAME\" \"$LOCAL_SKILL_CACHE_DIR/$SKILL_NAME\"",
    "test -f \"$LOCAL_SKILL_CACHE_DIR/$SKILL_NAME/SKILL.md\" || { echo \"Local skill cache missing SKILL.md: $LOCAL_SKILL_CACHE_DIR/$SKILL_NAME\" >&2; exit 7; }",
    "mkdir -p \"$TARGET_DIR\"",
    "OLD_VERSION=\"not-installed\"",
    "if [ -f \"$TARGET_DIR/$SKILL_NAME/VERSION\" ]; then OLD_VERSION=$(cat \"$TARGET_DIR/$SKILL_NAME/VERSION\"); fi",
    "rm -rf \"$TARGET_DIR/$SKILL_NAME\"",
    "cp -R \"$LOCAL_SKILL_CACHE_DIR/$SKILL_NAME\" \"$TARGET_DIR/$SKILL_NAME\"",
    "NEW_VERSION=$(cat \"$TARGET_DIR/$SKILL_NAME/VERSION\")",
    "test \"$NEW_VERSION\" = \"$TARGET_VERSION\" || { echo \"Installed version mismatch: $NEW_VERSION expected $TARGET_VERSION\" >&2; exit 6; }",
    "echo \"detach-agent-relationship skill installed\"",
    "echo \"oldSkillVersion=$OLD_VERSION\"",
    "echo \"newSkillVersion=$NEW_VERSION\"",
    "echo \"localSkillCachePath=$LOCAL_SKILL_CACHE_DIR/$SKILL_NAME\"",
    "echo \"installedPath=$TARGET_DIR/$SKILL_NAME\"",
    "echo \"installScope=openclaw_global_shared\"",
    "echo \"packageStructureStatus=ok\"",
    "echo \"reloadOrReindexStatus=start a new Main Agent session or refresh/reindex skills if needed\""
  ].join("\n");
}

function buildOpenClawSkillVerifyCommand(request: ToolRequestRecord): string {
  const skillName = stringPayload(request, "skillName") || DETACH_AGENT_SKILL_NAME;
  const targetAgent = stringPayload(request, "targetAgent") || "openclaw";
  if (skillName !== DETACH_AGENT_SKILL_NAME) throw new Error(`Unsupported skillName: ${skillName}`);
  if (targetAgent !== "openclaw") throw new Error(`Unsupported targetAgent: ${targetAgent}`);
  const targetDir = shellPath(stringPayload(request, "targetDir") || OPENCLAW_GLOBAL_SKILLS_DIR);
  const localSkillCacheDir = shellPath(stringPayload(request, "localSkillCacheDir") || DETACH_AGENT_LOCAL_SKILL_CACHE_DIR);
  const quotedSkill = shellQuote(DETACH_AGENT_SKILL_NAME);
  const quotedVersion = shellQuote(DETACH_AGENT_SKILL_VERSION);
  return [
    "set -e",
    `TARGET_DIR=${targetDir}`,
    `LOCAL_SKILL_CACHE_DIR=${localSkillCacheDir}`,
    `SKILL_NAME=${quotedSkill}`,
    `TARGET_VERSION=${quotedVersion}`,
    "SKILL_DIR=\"$TARGET_DIR/$SKILL_NAME\"",
    "LOCAL_SKILL_DIR=\"$LOCAL_SKILL_CACHE_DIR/$SKILL_NAME\"",
    "test -d \"$LOCAL_SKILL_DIR\" || { echo \"Local skill cache missing: $LOCAL_SKILL_DIR\" >&2; exit 2; }",
    "test -f \"$LOCAL_SKILL_DIR/SKILL.md\" || { echo \"Local skill cache missing SKILL.md\" >&2; exit 3; }",
    "test -f \"$LOCAL_SKILL_DIR/VERSION\" || { echo \"Local skill cache missing VERSION\" >&2; exit 4; }",
    "test -f \"$LOCAL_SKILL_DIR/README.md\" || { echo \"Local skill cache missing README.md\" >&2; exit 5; }",
    "test -f \"$LOCAL_SKILL_DIR/CHANGELOG.md\" || { echo \"Local skill cache missing CHANGELOG.md\" >&2; exit 8; }",
    "if [ ! -d \"$SKILL_DIR\" ]; then mkdir -p \"$TARGET_DIR\"; cp -R \"$LOCAL_SKILL_DIR\" \"$SKILL_DIR\"; fi",
    "test -f \"$SKILL_DIR/SKILL.md\" || { echo \"Missing SKILL.md\" >&2; exit 3; }",
    "test -f \"$SKILL_DIR/VERSION\" || { echo \"Missing VERSION\" >&2; exit 4; }",
    "test -f \"$SKILL_DIR/README.md\" || { echo \"Missing README.md\" >&2; exit 5; }",
    "test -f \"$SKILL_DIR/CHANGELOG.md\" || { echo \"Missing CHANGELOG.md\" >&2; exit 8; }",
    "VERSION=$(cat \"$SKILL_DIR/VERSION\")",
    "test \"$VERSION\" = \"$TARGET_VERSION\" || { echo \"Version mismatch: $VERSION expected $TARGET_VERSION\" >&2; exit 6; }",
    "echo \"detach-agent-relationship skill ready\"",
    "echo \"skillVersion=$VERSION\"",
    "echo \"localSkillCachePath=$LOCAL_SKILL_DIR\"",
    "echo \"installedPath=$SKILL_DIR\"",
    "echo \"installScope=openclaw_global_shared\"",
    "echo \"packageStructureStatus=ok\""
  ].join("\n");
}

function unsupportedTargetMessage(kind: ToolRequestKind, target: ToolTarget): string {
  return `${kind} target ${target} is not available. The request cannot fallback to local-user-machine.`;
}

function assessRisk(input: Pick<ToolRequestRecord, "kind" | "payload">): ToolRiskAssessment {
  if (input.kind === "main-agent-save-file") return { level: "elevated", reasons: ["将通过本机 SSH/SCP/Rsync 把 staged 文件保存到 Main Agent 机器"] };
  if (input.kind === "adapter-install") return { level: "elevated", reasons: ["将在远端 agent host 安装 detaches adapter"] };
  if (input.kind === "skill-install") return { level: "elevated", reasons: ["将在 Host/Main Agent 的 OpenClaw 全局 skills 路径安装或覆盖 skill"] };
  if (input.kind === "skill-verify") return { level: "safe", reasons: [] };
  if (input.kind !== "terminal") return { level: "safe", reasons: [] };
  const command = typeof input.payload.command === "string" ? input.payload.command : "";
  const normalized = command.toLowerCase();
  const destructive = [
    /\brm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\s+(\/|\$home\b|~\b|\.\.?\b)/i,
    /\bsudo\s+rm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\b/i,
    /\bmkfs(\.[a-z0-9]+)?\b/i,
    /\bdd\s+.*\bof=\/dev\//i,
    />\s*\/(?:etc|bin|sbin|usr|var|system|library)\b/i,
    /\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh)\b/i
  ].filter((pattern) => pattern.test(command));
  if (destructive.length) {
    return { level: "destructive", reasons: ["可能删除/覆盖关键路径、格式化磁盘，或下载后直接执行脚本"] };
  }
  const reasons: string[] = [];
  if (/\bsudo\b/.test(normalized)) reasons.push("需要 sudo 权限");
  if (/\b(chmod|chown)\b/.test(normalized)) reasons.push("修改文件权限或归属");
  if (/\b(npm|pnpm|yarn|pip|brew)\s+(install|add|remove|uninstall)\b/.test(normalized)) reasons.push("安装或移除依赖");
  if (/(^|\s)(rm|mv|cp)\s+/.test(normalized) && /(?:\/etc|\/usr|\/var|\/bin|\/sbin|~\/\.|\.ssh|\.zshrc|\.bashrc|\.profile)/.test(normalized)) {
    reasons.push("修改 shell/profile、SSH 或系统相关路径");
  }
  return reasons.length ? { level: "elevated", reasons } : { level: "safe", reasons: [] };
}

function decision(action: "approved" | "rejected", input: ToolRequestApproveInput | ToolRequestRejectInput): ToolRequestRecord["lastDecision"] {
  return {
    action,
    decidedAt: new Date().toISOString(),
    actor: input.actor,
    riskAccepted: "riskAccepted" in input ? input.riskAccepted : undefined
  };
}

function targetObject(value: unknown): value is { [key: string]: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function shellPath(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  if (normalized === "~") return "$HOME";
  if (normalized.startsWith("~/")) return `$HOME/${normalized.slice(2).replace(/'/g, "'\\''")}`;
  return shellQuote(normalized);
}

function isToolRequestRecord(value: unknown): value is ToolRequestRecord {
  if (!targetObject(value)) return false;
  return typeof value.id === "string"
    && (value.kind === "terminal" || value.kind === "file-transfer" || value.kind === "adapter-install" || value.kind === "skill-install" || value.kind === "skill-verify")
    && typeof value.sessionKey === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && typeof value.payload === "object"
    && value.payload !== null
    && !Array.isArray(value.payload);
}

function isToolExecutionRecord(value: unknown): value is ToolExecutionRecord {
  if (!targetObject(value)) return false;
  return typeof value.executionId === "string"
    && typeof value.requestId === "string"
    && typeof value.sessionKey === "string"
    && typeof value.terminalId === "string"
    && typeof value.startOffset === "number"
    && typeof value.command === "string"
    && typeof value.wrappedCommand === "string"
    && typeof value.createdAt === "string"
    && (value.forwardStatus === "not-started" || value.forwardStatus === "pending" || value.forwardStatus === "sent" || value.forwardStatus === "failed");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runShellCommand(command: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const launch = platformService.buildNonInteractiveShellLaunch(command, { cwd: appConfig.storageDir });
    const child = spawn(launch.shell, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, output: output.slice(-20_000) });
    };
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-40_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      output = `${output}\n${error.message}`.slice(-40_000);
      finish(127);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        output = `${output}\n[process terminated by signal ${signal}]`.slice(-40_000);
      }
      finish(typeof code === "number" ? code : 1);
    });
    timer = setTimeout(() => {
      output = `${output}\n[process timed out after ${timeoutMs}ms]`.slice(-40_000);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref();
      finish(124);
    }, timeoutMs);
  });
}

function wrapCommandForCompletion(command: string, executionId: string): string {
  return platformService.wrapCommandForCompletion(command, executionId);
}

function parseExecutionOutput(replay: string, execution: ToolExecutionRecord): { output: string; completed: boolean; exitCode?: number } {
  const sliced = parseExecutionReplay(replay.slice(execution.startOffset), execution.executionId);
  if (sliced.completed) return sliced;
  return parseExecutionReplay(replay, execution.executionId);
}

function parseExecutionReplay(raw: string, executionId: string): { output: string; completed: boolean; exitCode?: number } {
  const startPattern = new RegExp(`__DETACHES_TOOL_START__:${escapeRegExp(executionId)}`);
  const endPattern = new RegExp(`__DETACHES_TOOL_END__:${escapeRegExp(executionId)}:(\\d+)`);
  const startMatch = startPattern.exec(raw);
  const afterStart = startMatch ? raw.slice(startMatch.index + startMatch[0].length) : raw;
  const endMatch = endPattern.exec(afterStart);
  const beforeEnd = endMatch ? afterStart.slice(0, endMatch.index) : afterStart;
  return {
    output: stripCommandEcho(beforeEnd).trim(),
    completed: Boolean(endMatch),
    exitCode: endMatch ? Number(endMatch[1]) : undefined
  };
}

function stripCommandEcho(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !line.includes("__DETACHES_TOOL_START__") && !line.includes("__DETACHES_TOOL_END__"))
    .join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
