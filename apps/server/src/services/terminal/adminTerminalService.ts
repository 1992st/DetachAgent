import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket, type RawData } from "ws";
import type { AdminTerminalStatusResponse, TerminalInfo, TerminalStatus } from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { platformService } from "../platform/platformService.js";

const execFileAsync = promisify(execFile);
const MAX_REPLAY_CHARS = 120_000;
const GLOBAL_ADMIN_SESSION_KEY = "local-admin-terminal";

interface ExecFailure extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

interface AdminTerminalSession {
  id: string;
  sessionKey: string;
  token: string;
  status: TerminalStatus;
  createdAt: string;
  lastActiveAt: string;
  command: string;
  buffer: string;
  helperPid?: number;
  socket?: WebSocket;
  emitter: EventEmitter;
  handshakeTimer?: NodeJS.Timeout;
  launchError?: string;
  message?: string;
}

interface AdminTerminalSocketMessage {
  type?: string;
  data?: string;
  sessionKey?: string;
  pid?: number;
  shell?: string;
  exitCode?: number;
  signal?: number;
}

export interface AdminTerminalHandle {
  id: string;
  sessionKey: string;
  status: TerminalStatus;
  createdAt: string;
  lastActiveAt: string;
  command: string;
  buffer: string;
  socket?: WebSocket;
  emitter: EventEmitter;
}

export interface AdminTerminalLaunchContext {
  id: string;
  sessionKey: string;
  token: string;
}

export interface AdminTerminalServiceOptions {
  platform?: NodeJS.Platform;
  handshakeTimeoutMs?: number;
  launchElevated?: (session: AdminTerminalLaunchContext, cols: number, rows: number, script: string) => Promise<void>;
}

export interface AdminTerminalDebugLaunch {
  supported: boolean;
  helperEntry: string;
  helperExists: boolean;
  workingDirectory: string;
  logPath: string;
  script: string;
  elevatedScript: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function helperEntry(): string {
  const packaged = platformService.resolvePackagedResourcePath("server", "dist", "services", "terminal", "adminTerminalHelper.js");
  if (packaged && fs.existsSync(packaged)) return packaged;
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const localDist = path.resolve(currentDir, "..", "..", "..", "dist", "services", "terminal", "adminTerminalHelper.js");
  if (fs.existsSync(localDist)) return localDist;
  return path.resolve(currentDir, "adminTerminalHelper.js");
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const failure = error as ExecFailure;
  const stderr = failure.stderr ? failure.stderr.toString().trim() : "";
  const stdout = failure.stdout ? failure.stdout.toString().trim() : "";
  return [error.message, stderr ? `stderr: ${stderr}` : "", stdout ? `stdout: ${stdout}` : ""].filter(Boolean).join("\n");
}

function helperWorkingDirectory(): string {
  const dir = platformService.getAppDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function helperLogPath(): string {
  return path.join(platformService.getAppDataDir(), "admin-terminal-helper.log");
}

function serverBaseUrl(): string {
  const host = appConfig.serverHost === "0.0.0.0" ? "127.0.0.1" : appConfig.serverHost;
  return `http://${host}:${appConfig.serverPort}`;
}

function helperConnectUrl(): string {
  const url = new URL("/api/terminal/admin/helper", serverBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function shellCommandForUac(session: AdminTerminalSession, cols: number, rows: number): string {
  const elevatedScript = elevatedHelperScript(session, cols, rows);
  const encoded = Buffer.from(elevatedScript, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$psi = New-Object System.Diagnostics.ProcessStartInfo",
    "$psi.FileName = 'powershell.exe'",
    `$psi.Arguments = ${psSingleQuoted(`-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`)}`,
    `$psi.WorkingDirectory = ${psSingleQuoted(helperWorkingDirectory())}`,
    "$psi.UseShellExecute = $true",
    "$psi.Verb = 'runas'",
    "$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Minimized",
    "$process = [System.Diagnostics.Process]::Start($psi)",
    "if ($null -eq $process) { throw 'UAC ShellExecute returned no process.' }"
  ].join("; ");
  return script;
}

function elevatedHelperScript(session: AdminTerminalSession, cols: number, rows: number): string {
  const args = [
    helperEntry(),
    "--connect-url",
    helperConnectUrl(),
    "--token",
    session.token,
    "--session-key",
    session.sessionKey,
    "--cols",
    String(cols),
    "--rows",
    String(rows)
  ];
  const encodedArgs = args.map(psSingleQuoted).join(", ");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$exe = ${psSingleQuoted(process.execPath)}`,
    `$arguments = @(${encodedArgs})`,
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    process.env.NODE_PATH ? `$env:NODE_PATH = ${psSingleQuoted(process.env.NODE_PATH)}` : "",
    process.env.DETACHES_RESOURCES_DIR ? `$env:DETACHES_RESOURCES_DIR = ${psSingleQuoted(process.env.DETACHES_RESOURCES_DIR)}` : "",
    `Set-Location ${psSingleQuoted(helperWorkingDirectory())}`,
    "& $exe @arguments",
    "exit $LASTEXITCODE"
  ].filter(Boolean).join("; ");
}

export class AdminTerminalService {
  private sessions = new Map<string, AdminTerminalSession>();

  constructor(private readonly options: AdminTerminalServiceOptions = {}) {}

  supported(): boolean {
    return (this.options.platform || platformService.currentNodePlatform()) === "win32";
  }

  async enable(sessionKey: string, cols = 120, rows = 32): Promise<AdminTerminalStatusResponse> {
    if (!this.supported()) {
      return { ok: false, supported: false, active: false, message: "Administrator terminal is only supported on Windows." };
    }

    const sessionId = this.storageKey();
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status !== "exited" && existing.status !== "error") {
      return { ok: true, supported: true, active: existing.status === "connected", sessionKey, terminal: this.info(existing, sessionKey), message: existing.message };
    }

    const session: AdminTerminalSession = {
      id: crypto.randomUUID(),
      sessionKey: sessionId,
      token: crypto.randomBytes(32).toString("base64url"),
      status: "starting",
      createdAt: nowIso(),
      lastActiveAt: nowIso(),
      command: "Administrator PowerShell",
      buffer: "",
      message: "Administrator terminal launch requested. Waiting for elevated helper callback.",
      emitter: new EventEmitter()
    };
    session.emitter.setMaxListeners(100);
    this.sessions.set(sessionId, session);

    try {
      // Windows cannot elevate an existing process in place; UAC must launch a new helper confirmed by the user.
      await this.launchElevated(session, cols, rows);
      this.append(session, "\r\n[detaches_agent] Administrator terminal launch requested. Waiting for elevated helper callback.\r\n");
    } catch (error) {
      session.status = "error";
      session.launchError = errorDetails(error);
      session.message = `Administrator terminal UAC launch failed or was cancelled: ${session.launchError}`;
      this.append(session, `\r\n[detaches_agent] ${session.message}\r\n`);
      return { ok: false, supported: true, active: false, sessionKey, terminal: this.info(session, sessionKey), message: session.message };
    }

    // The helper connects back with a one-time token so another local process cannot impersonate it.
    session.handshakeTimer = setTimeout(() => {
      if (session.status === "starting") {
        session.status = "error";
        session.launchError = `Administrator terminal did not connect back after UAC approval. Check ${helperLogPath()}.`;
        session.message = session.launchError;
        this.append(session, `\r\n[detaches_agent] ${session.launchError}\r\n`);
      }
    }, this.options.handshakeTimeoutMs ?? 45_000);

    return {
      ok: true,
      supported: true,
      active: false,
      sessionKey,
      terminal: this.info(session, sessionKey),
      message: session.message
    };
  }

  async disable(sessionKey: string): Promise<AdminTerminalStatusResponse> {
    const session = this.sessions.get(this.storageKey());
    if (!session) return { ok: true, supported: this.supported(), active: false, sessionKey };
    this.stop(session, "Administrator terminal was closed by the user.");
    this.sessions.delete(this.storageKey());
    return { ok: true, supported: this.supported(), active: false, sessionKey };
  }

  status(sessionKey: string): AdminTerminalStatusResponse {
    const session = this.sessions.get(this.storageKey());
    if (!session) return { ok: true, supported: this.supported(), active: false, sessionKey };
    return {
      ok: session.status === "connected" || session.status === "starting",
      supported: this.supported(),
      active: session.status === "connected",
      sessionKey,
      terminal: this.info(session, sessionKey),
      message: session.message || session.launchError
    };
  }

  isActive(sessionKey: string): boolean {
    void sessionKey;
    return this.sessions.get(this.storageKey())?.status === "connected";
  }

  debugLaunch(sessionKey: string, cols = 120, rows = 32): AdminTerminalDebugLaunch {
    const session: AdminTerminalSession = {
      id: "debug",
      sessionKey,
      token: "debug-token",
      status: "starting",
      createdAt: nowIso(),
      lastActiveAt: nowIso(),
      command: "Administrator PowerShell",
      buffer: "",
      emitter: new EventEmitter()
    };
    const entry = helperEntry();
    return {
      supported: this.supported(),
      helperEntry: entry,
      helperExists: fs.existsSync(entry),
      workingDirectory: helperWorkingDirectory(),
      logPath: helperLogPath(),
      script: shellCommandForUac(session, cols, rows),
      elevatedScript: elevatedHelperScript(session, cols, rows)
    };
  }

  info(session: AdminTerminalHandle, displaySessionKey = session.sessionKey): TerminalInfo {
    return {
      terminalId: session.id,
      sessionKey: displaySessionKey,
      status: session.status,
      privilege: "administrator",
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      command: session.command
    };
  }

  async ensure(sessionKey: string, cols = 120, rows = 32): Promise<AdminTerminalHandle> {
    const status = this.status(sessionKey);
    if (!status.active) {
      await this.enable(sessionKey, cols, rows);
    }
    const session = this.sessions.get(this.storageKey());
    if (!session || session.status !== "connected") {
      throw new Error(status.message || "Administrator terminal is not connected. Confirm the Windows UAC prompt and retry.");
    }
    return session;
  }

  snapshot(sessionKey: string): { terminal: TerminalInfo; replay: string } {
    const session = this.requireActive(sessionKey);
    return { terminal: this.info(session, sessionKey), replay: session.buffer };
  }

  replay(session: AdminTerminalHandle): string {
    return session.buffer;
  }

  write(session: AdminTerminalHandle, data: string): void {
    if (session.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Administrator terminal helper is not connected.");
    }
    session.lastActiveAt = nowIso();
    session.socket.send(JSON.stringify({ type: "input", data }));
  }

  resize(session: AdminTerminalHandle, cols: number, rows: number): void {
    if (session.socket?.readyState !== WebSocket.OPEN) return;
    session.socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  async runCommand(sessionKey: string, command: string): Promise<TerminalInfo> {
    const session = await this.ensure(sessionKey);
    this.write(session, `${command.trimEnd()}\r`);
    return this.info(session, sessionKey);
  }

  attachHelper(socket: WebSocket, token: string, sessionKey: string): boolean {
    void sessionKey;
    const session = this.sessions.get(this.storageKey());
    if (!session || session.token !== token || session.status === "connected") {
      socket.close(1008, "Invalid administrator terminal token.");
      return false;
    }
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    session.socket = socket;
    session.status = "connected";
    session.message = "Administrator helper connected after UAC approval.";
    session.lastActiveAt = nowIso();
    this.append(session, "\r\n[detaches_agent] Administrator helper connected after UAC approval.\r\n");
    socket.on("message", (raw) => this.handleHelperMessage(session, raw));
    socket.on("close", () => {
      if (session.status !== "exited") {
        session.status = "exited";
        session.message = "Administrator terminal helper disconnected.";
        this.append(session, "\r\n[detaches_agent] Administrator terminal helper disconnected.\r\n");
      }
    });
    socket.on("error", (error) => {
      session.status = "error";
      session.launchError = error.message;
      session.message = `Administrator terminal helper error: ${error.message}`;
      this.append(session, `\r\n[detaches_agent] ${session.message}\r\n`);
    });
    return true;
  }

  private async launchElevated(session: AdminTerminalSession, cols: number, rows: number): Promise<void> {
    const script = shellCommandForUac(session, cols, rows);
    if (this.options.launchElevated) {
      await this.options.launchElevated(session, cols, rows, script);
      return;
    }
    await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], { timeout: 30_000, windowsHide: true });
  }

  private requireActive(sessionKey: string): AdminTerminalSession {
    void sessionKey;
    const session = this.sessions.get(this.storageKey());
    if (!session || session.status !== "connected") throw new Error("Administrator terminal is not active.");
    return session;
  }

  private storageKey(): string {
    return GLOBAL_ADMIN_SESSION_KEY;
  }

  private handleHelperMessage(session: AdminTerminalSession, raw: RawData): void {
    let event: AdminTerminalSocketMessage;
    try {
      event = JSON.parse(raw.toString()) as AdminTerminalSocketMessage;
    } catch {
      return;
    }
    if (event.type === "hello") {
      session.helperPid = event.pid;
      session.command = event.shell ? `Administrator ${event.shell}` : "Administrator PowerShell";
      session.message = "Administrator terminal is active.";
      session.lastActiveAt = nowIso();
      session.emitter.emit("status", this.info(session));
    } else if (event.type === "data" && typeof event.data === "string") {
      this.append(session, event.data);
    } else if (event.type === "exit") {
      session.status = "exited";
      session.message = `Administrator terminal exited: code=${event.exitCode ?? ""} signal=${event.signal ?? ""}`;
      this.append(session, `\r\n[${session.message}]\r\n`);
    }
  }

  private append(session: AdminTerminalSession, data: string): void {
    session.lastActiveAt = nowIso();
    session.buffer = `${session.buffer}${data}`.slice(-MAX_REPLAY_CHARS);
    session.emitter.emit("data", data);
    session.emitter.emit("status", this.info(session));
  }

  private stop(session: AdminTerminalSession, reason: string): void {
    if (session.handshakeTimer) clearTimeout(session.handshakeTimer);
    this.append(session, `\r\n[detaches_agent] ${reason}\r\n`);
    session.status = "exited";
    session.message = reason;
    if (session.socket?.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: "stop" }));
      session.socket.close();
    }
  }
}

export const adminTerminalService = new AdminTerminalService();
