#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { AgentSummary, AgentsListResponse, ChatSocketClientEvent, ChatSocketServerEvent } from "@detaches/shared";

const DEFAULT_BASE_URL = "http://127.0.0.1:38888";
const DEFAULT_TIMEOUT_MS = 120_000;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

interface CliContext {
  baseUrl: string;
  json: boolean;
}

interface ResolvedTarget {
  input: string;
  agentId?: string;
  agent?: AgentSummary;
  sessionKey: string;
}

interface WaitResult {
  ok: boolean;
  agentId?: string;
  sessionKey: string;
  runId?: string;
  timedOut: boolean;
  events: ChatSocketServerEvent[];
  raw?: unknown;
}

class CliError extends Error {
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(message: string, exitCode = 1, details?: unknown) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const eqIndex = item.indexOf("=");
    if (eqIndex > 2) {
      flags[item.slice(2, eqIndex)] = item.slice(eqIndex + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

export function resolveBaseUrl(flags: Record<string, string | boolean>, env = process.env): string {
  const configured = stringFlag(flags, "base-url") || env.DETACH_AGENT_BASE_URL || DEFAULT_BASE_URL;
  return configured.replace(/\/+$/, "");
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

function timeoutFlag(flags: Record<string, string | boolean>): number {
  const raw = stringFlag(flags, "timeout-ms");
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError("--timeout-ms must be a non-negative integer.", 2);
  }
  return parsed;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): string {
  return [
    "detach-agent",
    "",
    "Detach Agent CLI is an app companion CLI. It requires the Detach Agent App local server.",
    "It is not a standalone Gateway client and will not become one in future versions.",
    "",
    "Usage:",
    "  detach-agent --version",
    "  detach-agent help [command]",
    "  detach-agent agent status [--json] [--base-url <url>]",
    "  detach-agent agent list [--json] [--base-url <url>]",
    "  detach-agent agent send <agent-id-or-session-key> --message <text> [--local-control] [--wait] [--timeout-ms <ms>] [--json] [--base-url <url>]",
    "  detach-agent agent listen <agent-id-or-session-key> [--run-id <runId>] [--timeout-ms <ms>] [--json] [--raw] [--base-url <url>]"
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const context: CliContext = {
    baseUrl: resolveBaseUrl(parsed.flags),
    json: booleanFlag(parsed.flags, "json")
  };
  const [scope, command, ...rest] = parsed.positionals;

  if (booleanFlag(parsed.flags, "version") || scope === "--version") {
    console.log("0.1.0");
    return 0;
  }
  if (!scope || scope === "help" || booleanFlag(parsed.flags, "help")) {
    console.log(usage());
    return 0;
  }
  if (scope !== "agent") throw new CliError(`Unknown command scope: ${scope}`, 2);
  if (!command) throw new CliError("Missing agent command.", 2);

  if (command === "status") return agentStatus(context);
  if (command === "list") return agentList(context);
  if (command === "send") return agentSend(context, rest, parsed.flags);
  if (command === "listen") return agentListen(context, rest, parsed.flags);
  throw new CliError(`Unknown agent command: ${command}`, 2);
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { headers: { Accept: "application/json" } });
  } catch (error) {
    throw new CliError(`Detach Agent app server is unreachable at ${baseUrl}. Open Detach Agent App first.`, 3, error);
  }
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new CliError(`Expected JSON from ${path}, got: ${text.slice(0, 200)}`, 1);
  }
  if (!response.ok) {
    const message = typeof (payload as { message?: unknown })?.message === "string"
      ? String((payload as { message: string }).message)
      : typeof (payload as { error?: unknown })?.error === "string"
        ? String((payload as { error: string }).error)
        : `HTTP ${response.status}`;
    throw new CliError(message, response.status === 503 ? 4 : 1, payload);
  }
  return payload as T;
}

async function agentStatus(context: CliContext): Promise<number> {
  const health = await getJson<unknown>(context.baseUrl, "/api/health");
  let gateway: unknown;
  try {
    gateway = await getJson<unknown>(context.baseUrl, "/api/gateway/status");
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    gateway = { ok: false, message: error.message, details: error.details };
  }
  const payload = { ok: true, health, gateway };
  if (context.json) {
    printJson(payload);
    return 0;
  }
  const healthRecord = health as { server?: { state?: string }; gateway?: { state?: string; message?: string }; config?: Record<string, unknown> };
  const gatewayRecord = gateway as { ok?: boolean; message?: string };
  console.log(`Server: ${healthRecord.server?.state || "unknown"}`);
  console.log(`Gateway: ${gatewayRecord.ok === true ? "ok" : healthRecord.gateway?.state || "unknown"}`);
  console.log(`Message: ${gatewayRecord.message || healthRecord.gateway?.message || "No message."}`);
  if (healthRecord.config) {
    console.log(`Transport: ${String(healthRecord.config.gatewayTransport || "unknown")}`);
  }
  return gatewayRecord.ok === false ? 4 : 0;
}

async function loadAgents(baseUrl: string): Promise<AgentsListResponse> {
  return getJson<AgentsListResponse>(baseUrl, "/api/agents");
}

async function agentList(context: CliContext): Promise<number> {
  const payload = await loadAgents(context.baseUrl);
  if (context.json) {
    printJson(payload);
    return 0;
  }
  if (!payload.agents.length) {
    console.log("No agents found.");
    return 0;
  }
  for (const agent of payload.agents) {
    const updated = agent.updatedAt ? ` updated=${agent.updatedAt}` : "";
    console.log(`${agent.id}\t${agent.status}\t${agent.sessionKey}\t${agent.title}${updated}`);
  }
  return 0;
}

async function resolveTarget(baseUrl: string, input: string): Promise<ResolvedTarget> {
  const payload = await loadAgents(baseUrl).catch(() => ({ agents: [], source: "fallback" as const }));
  const agent = payload.agents.find((item) => item.id === input || item.sessionKey === input);
  if (agent) return { input, agentId: agent.id, agent, sessionKey: agent.sessionKey };
  if (!input.trim()) throw new CliError("Missing agent id or session key.", 2);
  return { input, sessionKey: input };
}

async function agentSend(context: CliContext, rest: string[], flags: Record<string, string | boolean>): Promise<number> {
  const targetInput = rest[0];
  if (!targetInput) throw new CliError("Missing <agent-id-or-session-key>.", 2);
  const message = stringFlag(flags, "message");
  if (!message) throw new CliError("Missing --message <text>.", 2);
  const target = await resolveTarget(context.baseUrl, targetInput);
  const wait = booleanFlag(flags, "wait");
  const timeoutMs = timeoutFlag(flags);
  const result = await chatSendAndMaybeWait({
    context,
    target,
    message,
    includeLocalControlContext: booleanFlag(flags, "local-control"),
    wait,
    timeoutMs,
    raw: booleanFlag(flags, "raw")
  });
  outputWaitResult(context, result, wait);
  return result.timedOut ? 1 : 0;
}

async function agentListen(context: CliContext, rest: string[], flags: Record<string, string | boolean>): Promise<number> {
  const targetInput = rest[0];
  if (!targetInput) throw new CliError("Missing <agent-id-or-session-key>.", 2);
  const target = await resolveTarget(context.baseUrl, targetInput);
  const timeoutMs = timeoutFlag(flags);
  const result = await listenForEvents({
    context,
    target,
    runId: stringFlag(flags, "run-id"),
    timeoutMs,
    raw: booleanFlag(flags, "raw")
  });
  outputWaitResult(context, result, true);
  return result.timedOut ? 1 : 0;
}

function outputWaitResult(context: CliContext, result: WaitResult, includeEvents: boolean): void {
  if (context.json) {
    printJson(result);
    return;
  }
  if (result.runId) console.log(`runId: ${result.runId}`);
  console.log(`sessionKey: ${result.sessionKey}`);
  if (result.agentId) console.log(`agentId: ${result.agentId}`);
  if (result.timedOut) console.log("timedOut: true");
  if (!includeEvents) return;
  for (const event of result.events) {
    console.log(formatEvent(event));
  }
}

function formatEvent(event: ChatSocketServerEvent): string {
  if (event.type === "error") return `[error] ${event.message}`;
  if (event.type === "sent") return `[sent] runId=${event.payload.runId || ""}`;
  if (event.type === "chat" || event.type === "agent") {
    const text = collectText(event.payload).join("\n").trim();
    return text ? `[${event.type}] ${text}` : `[${event.type}] ${JSON.stringify(event.payload)}`;
  }
  return `[${event.type}] ${JSON.stringify(event)}`;
}

function collectText(value: unknown, output: string[] = [], depth = 0): string[] {
  if (value == null || depth > 5) return output;
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) collectText(item, output, depth + 1);
    return output;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["text", "message", "content", "output", "delta", "answer", "result", "payload", "raw"]) {
    collectText(record[key], output, depth + 1);
  }
  return output;
}

function chatUrl(baseUrl: string, sessionKey: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/chat/${encodeURIComponent(sessionKey)}`;
  url.search = "";
  return url.toString();
}

async function chatSendAndMaybeWait(input: {
  context: CliContext;
  target: ResolvedTarget;
  message: string;
  includeLocalControlContext: boolean;
  wait: boolean;
  timeoutMs: number;
  raw: boolean;
}): Promise<WaitResult> {
  return withChatSocket(input.context.baseUrl, input.target, input.timeoutMs, (socket, finish, state) => {
    socket.on("message", (data) => {
      const event = parseSocketEvent(data);
      if (!event) return;
      if (input.raw || event.type === "chat" || event.type === "agent" || event.type === "error" || event.type === "sent") {
        state.events.push(event);
      }
      if (event.type === "ready") {
        const payload: ChatSocketClientEvent = {
          type: "send",
          message: input.message,
          includeLocalControlContext: input.includeLocalControlContext,
          ...(input.includeLocalControlContext ? { activationReason: "user-click" as const } : {})
        };
        socket.send(JSON.stringify(payload));
      } else if (event.type === "sent") {
        state.runId = event.payload.runId;
        state.raw = event.payload.raw;
        if (!input.wait) finish(false);
      } else if (event.type === "error") {
        finish(false);
      }
    });
  });
}

async function listenForEvents(input: {
  context: CliContext;
  target: ResolvedTarget;
  runId?: string;
  timeoutMs: number;
  raw: boolean;
}): Promise<WaitResult> {
  return withChatSocket(input.context.baseUrl, input.target, input.timeoutMs, (socket, _finish, state) => {
    state.runId = input.runId;
    socket.on("message", (data) => {
      const event = parseSocketEvent(data);
      if (!event) return;
      if (event.type === "ready" && input.runId) {
        socket.send(JSON.stringify({ type: "track-run", runId: input.runId } satisfies ChatSocketClientEvent));
      }
      if (input.raw || event.type === "chat" || event.type === "agent" || event.type === "error") {
        state.events.push(event);
      }
    });
  });
}

function withChatSocket(
  baseUrl: string,
  target: ResolvedTarget,
  timeoutMs: number,
  attach: (
    socket: WebSocket,
    finish: (timedOut: boolean) => void,
    state: { events: ChatSocketServerEvent[]; runId?: string; raw?: unknown }
  ) => void
): Promise<WaitResult> {
  const state: { events: ChatSocketServerEvent[]; runId?: string; raw?: unknown } = { events: [] };
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(chatUrl(baseUrl, target.sessionKey));
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.close();
      resolve({
        ok: !timedOut,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        runId: state.runId,
        timedOut,
        events: state.events,
        raw: state.raw
      });
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(true), timeoutMs);
    }
    socket.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new CliError(`Detach Agent chat socket is unreachable at ${baseUrl}.`, 3, error));
    });
    socket.on("close", () => {
      if (!settled && timeoutMs === 0) finish(false);
    });
    attach(socket, finish, state);
  });
}

function parseSocketEvent(data: unknown): ChatSocketServerEvent | null {
  try {
    return JSON.parse(socketMessageText(data)) as ChatSocketServerEvent;
  } catch {
    return null;
  }
}

function socketMessageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
