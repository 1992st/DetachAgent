import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type {
  ToolGatewayEventInput,
  ToolRequestApproveInput,
  ToolRequestCreateInput,
  ToolRequestCreateResponse,
  ToolRequestDecisionResponse,
  ToolResultForwardStatus,
  ToolRequestExtractResponse,
  ToolRequestKind,
  ToolRequestListInput,
  ToolRequestListResponse,
  ToolRequestRecord,
  ToolRequestStatus,
  ToolRiskAssessment,
  ToolExecutionResultResponse,
  ToolTarget
} from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { fileTransferService } from "../files/fileTransferService.js";
import { gatewayClient } from "../gateway/gatewayClient.js";
import { terminalService } from "../terminal/terminalService.js";

type AuditEvent =
  | { type: "tool.create"; request: ToolRequestRecord }
  | { type: "tool.ingest"; requestId: string; sourceEventId: string; duplicate: boolean }
  | { type: "tool.approve"; requestId: string; status: ToolRequestStatus; command?: string; terminalId?: string; executionId?: string; error?: string }
  | { type: "tool.result.forward"; requestId: string; executionId: string; status: ToolResultForwardStatus; ok: boolean; error?: string }
  | { type: "tool.reject"; requestId: string; status: ToolRequestStatus };

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
  forwardStatus: ToolResultForwardStatus;
  forwardError?: string;
  forwardedAt?: string;
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

  async extractFromText(input: { text: string; sessionKey: string; agentId?: string }): Promise<ToolRequestExtractResponse> {
    await this.load();
    const parsed = parseToolRequests(input.text);
    const requests = [];
    for (const item of parsed) {
      requests.push(await this.create({
        kind: item.kind,
        target: item.target,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        reason: item.reason,
        source: "text-extract",
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
      await this.audit({ type: "tool.approve", requestId, status: "blocked", error: request.error });
      throw new Error(request.error || "Tool request is blocked.");
    }
    if (request.status !== "pending" && request.status !== "failed") {
      throw new Error(`Tool request is already ${request.status}.`);
    }
    if (request.risk?.level === "elevated" && !input.riskAccepted) {
      throw new Error(`Elevated-risk tool request requires explicit confirmation: ${request.risk.reasons.join("; ")}`);
    }
    if (request.kind === "terminal") {
      const command = stringPayload(request, "command");
      if (!command) {
        return this.fail(request, "Terminal request payload.command is required.");
      }
      const execution = await this.runInTerminal(request, command);
      const updated = this.update(request, "approved");
      await this.save();
      await this.audit({ type: "tool.approve", requestId, status: updated.status, command, terminalId: execution.terminalId, executionId: execution.executionId });
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
        const execution = await this.runInTerminal(request, prepared.command);
        const updated = this.update(request, "approved");
        await this.save();
        await this.audit({ type: "tool.approve", requestId, status: updated.status, command: prepared.command, terminalId: execution.terminalId, executionId: execution.executionId });
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
          message: "File transfer command was written to the session terminal by the server broker."
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
    const snapshot = await terminalService.snapshot(execution.sessionKey);
    const parsed = parseExecutionOutput(snapshot.replay.slice(execution.startOffset), execution.executionId);
    const output = parsed.output.slice(-20_000);
    return {
      request,
      result: {
        executionId: execution.executionId,
        requestId,
        status: request.status,
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
      }
    };
  }

  async reject(requestId: string): Promise<ToolRequestRecord> {
    await this.load();
    const request = this.requireRequest(requestId);
    const updated = this.update(request, "rejected");
    await this.save();
    await this.audit({ type: "tool.reject", requestId, status: updated.status });
    return updated;
  }

  async retryForward(requestId: string): Promise<ToolExecutionResultResponse> {
    await this.load();
    await this.forwardResultToAgent(requestId, { delayMs: 0, force: true });
    return this.result(requestId);
  }

  private targetSupported(kind: ToolRequestKind, target: ToolTarget): boolean {
    return (kind === "terminal" || kind === "file-transfer") && target === "local-user-machine";
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

  private update(request: ToolRequestRecord, status: ToolRequestStatus, error?: string): ToolRequestRecord {
    const updated = {
      ...request,
      status,
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
      forwardStatus: "not-started"
    };
    this.executions.set(execution.executionId, execution);
    await this.save();
    return execution;
  }

  private async forwardResultToAgent(requestId: string, options?: { delayMs?: number; force?: boolean }): Promise<void> {
    await this.load();
    const request = this.requireRequest(requestId);
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

function assessRisk(input: Pick<ToolRequestRecord, "kind" | "payload">): ToolRiskAssessment {
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

function targetObject(value: unknown): value is { [key: string]: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isToolRequestRecord(value: unknown): value is ToolRequestRecord {
  if (!targetObject(value)) return false;
  return typeof value.id === "string"
    && (value.kind === "terminal" || value.kind === "file-transfer")
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

function wrapCommandForCompletion(command: string, executionId: string): string {
  return [
    `printf '%s\\n' ${shellQuote(`__DETACHES_TOOL_START__:${executionId}`)}`,
    "{",
    command,
    "\n}",
    "__detaches_status=$?",
    `printf '%s\\n' \"__DETACHES_TOOL_END__:${executionId}:$__detaches_status\"`
  ].join("\n");
}

function parseExecutionOutput(raw: string, executionId: string): { output: string; completed: boolean; exitCode?: number } {
  const startMarker = `__DETACHES_TOOL_START__:${executionId}`;
  const endPattern = new RegExp(`__DETACHES_TOOL_END__:${escapeRegExp(executionId)}:(\\d+)`);
  const afterStart = raw.includes(startMarker) ? raw.slice(raw.indexOf(startMarker) + startMarker.length) : raw;
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
