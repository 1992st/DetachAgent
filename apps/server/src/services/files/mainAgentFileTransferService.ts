import fs from "node:fs/promises";
import path from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { spawn, type IPty } from "node-pty";
import { nanoid } from "nanoid";
import type { MainAgentFileDestination, MainAgentFileTransferSnapshot, ToolRequestRecord } from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { runtimeConfig } from "../../config/settingsStore.js";
import { platformService } from "../platform/platformService.js";
import { fileTransferService } from "./fileTransferService.js";

type TransferMethod = "rsync" | "scp" | "unknown";
type TransferCommand = { command: string; argsPrefix: string[] };
type AskpassSecret = { dir: string; passwordPath: string; scriptPath: string };
const SPAWN_FAILED_EXIT_CODE = 127;
const PASSWORD_TIMEOUT_MS = 3 * 60 * 1000;

interface TransferRecord extends MainAgentFileTransferSnapshot {
  pty?: IPty;
  passwordResolver?: (password: string) => void;
  passwordTimeout?: NodeJS.Timeout;
  waitingForAskpassFallback?: boolean;
  outputTail: string;
}

type AuditEvent =
  | { type: "main-agent-file-transfer.start"; transfer: MainAgentFileTransferSnapshot }
  | { type: "main-agent-file-transfer.status"; transferId: string; status: MainAgentFileTransferSnapshot["status"]; message?: string; error?: string }
  | { type: "main-agent-file-transfer.password"; transferId: string; action: "requested" | "provided" };

class MainAgentFileTransferService {
  private transfers = new Map<string, TransferRecord>();
  readonly emitter = new EventEmitter();

  async start(request: ToolRequestRecord): Promise<MainAgentFileTransferSnapshot> {
    const payload = request.payload;
    const fileId = stringValue(payload.fileId);
    const sourceLocalPath = stringValue(payload.sourceLocalPath);
    const requestedDestination = destinationValue(payload.destination);
    const destination = await resolveMainAgentDestination(requestedDestination);
    const method = methodPreference(payload.methodPreference);
    if (!fileId) throw new Error("main-agent-save-file requires payload.fileId.");
    if (!sourceLocalPath) throw new Error("main-agent-save-file requires payload.sourceLocalPath.");
    if (!destination) throw new Error("main-agent-save-file requires payload.destination.user, payload.destination.path, and configured Main Agent SSH host/port.");
    if (looksLikeDirectoryPath(destination.path)) {
      throw new Error("main-agent-save-file destination.path must be a complete absolute file path, including the final filename and extension; directory paths are not supported.");
    }
    const file = await fileTransferService.stagedFile(fileId);
    if (!file?.localPath) throw new Error("Staged file not found.");
    if (path.resolve(sourceLocalPath) !== path.resolve(file.localPath)) {
      throw new Error("sourceLocalPath does not match the staged file registry.");
    }
    const displayName = stringValue(payload.displayName) || file.displayName || file.name;
    const transfer: TransferRecord = {
      transferId: nanoid(),
      requestId: request.id,
      sessionKey: request.sessionKey,
      agentId: request.agentId,
      fileId,
      sourceLocalPath: file.localPath,
      displayName,
      size: file.size,
      requestedDestination: requestedDestination ?? undefined,
      destination,
      method: "unknown",
      status: "pending",
      needsPassword: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      outputTail: "",
      warnings: destinationWarnings(destination)
    };
    this.transfers.set(transfer.transferId, transfer);
    await this.audit({ type: "main-agent-file-transfer.start", transfer: snapshot(transfer) });
    void this.run(transfer, method);
    return snapshot(transfer);
  }

  get(transferId: string): MainAgentFileTransferSnapshot | null {
    const transfer = this.transfers.get(transferId);
    return transfer ? snapshot(transfer) : null;
  }

  findByRequest(requestId: string): MainAgentFileTransferSnapshot | null {
    const transfer = [...this.transfers.values()].find((item) => item.requestId === requestId);
    return transfer ? snapshot(transfer) : null;
  }

  providePassword(transferId: string, password: string): MainAgentFileTransferSnapshot {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error("Transfer not found.");
    if (!transfer.passwordResolver) throw new Error("Transfer is not waiting for a password.");
    const resolver = transfer.passwordResolver;
    transfer.passwordResolver = undefined;
    transfer.needsPassword = false;
    this.clearPasswordTimeout(transfer);
    this.touch(transfer, { passwordRequestedAt: undefined, passwordExpiresAt: undefined, message: "Password received; continuing transfer." });
    resolver(password);
    void this.audit({ type: "main-agent-file-transfer.password", transferId, action: "provided" });
    return snapshot(transfer);
  }

  private async run(transfer: TransferRecord, preferred: "rsync" | "scp"): Promise<void> {
    try {
      const ssh = await platformService.resolveCommand("ssh");
      if (ssh.available === false) throw new Error(`SSH client is not available: ${ssh.command}`);
      const sshCommand = await resolveSshCommand(ssh.command, ssh.argsPrefix);
      if (!sshCommand) throw new Error("SSH client is not available.");

      const rsync = await resolveTransferCommand("rsync");
      const scp = await resolveTransferCommand("scp");
      const method = preferred === "rsync" && rsync ? "rsync" : "scp";
      transfer.method = method;
      this.touch(transfer, { status: "transferring", message: `Uploading with ${method}.` });
      let code = method === "rsync" && rsync
        ? await this.runRsync(transfer, rsync, sshCommand)
        : await this.runScp(transfer, scp);
      if (code === SPAWN_FAILED_EXIT_CODE && isPtyUnavailable(transfer.outputTail)) {
        await this.runWithAskpassFallback(transfer, preferred, sshCommand);
        return;
      }
      if (method === "rsync" && shouldRetryWithScp(code, transfer.outputTail) && scp) {
        transfer.method = "scp";
        this.touch(transfer, { status: "transferring", message: "rsync failed; retrying upload with scp." });
        code = await this.runScp(transfer, scp);
      }
      transfer.exitCode = code;
      if (code !== 0) throw new Error(`${transfer.method} exited with code ${code}.${outputTailMessage(transfer)}`);
      this.touch(transfer, { status: "succeeded", progress: 1, transferredBytes: transfer.size, message: "File saved to Main Agent machine." });
      await this.audit({ type: "main-agent-file-transfer.status", transferId: transfer.transferId, status: "succeeded", message: transfer.message });
    } catch (error) {
      this.touch(transfer, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      await this.audit({ type: "main-agent-file-transfer.status", transferId: transfer.transferId, status: "failed", error: transfer.error });
    } finally {
      this.clearPasswordTimeout(transfer);
      transfer.pty = undefined;
      transfer.passwordResolver = undefined;
    }
  }

  private runRsync(transfer: TransferRecord, rsync: TransferCommand, ssh: TransferCommand): Promise<number> {
    const args = rsyncArgs(transfer, rsync, ssh, sshInteractiveAuthArgs());
    transfer.commandPreview = shellCommand([rsync.command, ...args]);
    this.touch(transfer, {});
    return this.runCommand(transfer, rsync.command, args, { allowPasswordPrompt: true });
  }

  private runScp(transfer: TransferRecord, scp: TransferCommand | null): Promise<number> {
    if (!scp) {
      transfer.outputTail = `${transfer.outputTail}\nscp is not available.\n`.slice(-4000);
      return Promise.resolve(SPAWN_FAILED_EXIT_CODE);
    }
    const args = scpArgs(transfer, scp, sshInteractiveAuthArgs());
    transfer.commandPreview = shellCommand([scp.command, ...args]);
    this.touch(transfer, {});
    return this.runCommand(transfer, scp.command, args, { allowPasswordPrompt: true });
  }

  private async runWithAskpassFallback(transfer: TransferRecord, preferred: "rsync" | "scp", ssh: TransferCommand): Promise<void> {
    transfer.waitingForAskpassFallback = true;
    const password = await this.requestFallbackPassword(transfer);
    transfer.waitingForAskpassFallback = false;
    this.clearPasswordTimeout(transfer);
    this.touch(transfer, { status: "transferring", needsPassword: false, passwordRequestedAt: undefined, passwordExpiresAt: undefined, message: "Uploading with password authentication." });
    const askpass = await createAskpassSecret(password);
    try {
      const rsync = await resolveTransferCommand("rsync");
      const scp = await resolveTransferCommand("scp");
      const method = preferred === "rsync" && rsync ? "rsync" : "scp";
      transfer.method = method;
      this.touch(transfer, { status: "transferring", message: `Uploading with ${method}.` });
      let code = method === "rsync" && rsync
        ? await this.runChildRsync(transfer, rsync, ssh, askpass)
        : await this.runChildScp(transfer, scp, askpass);
      if (method === "rsync" && shouldRetryWithScp(code, transfer.outputTail) && scp) {
        transfer.method = "scp";
        this.touch(transfer, { status: "transferring", message: "rsync failed; retrying upload with scp." });
        code = await this.runChildScp(transfer, scp, askpass);
      }
      transfer.exitCode = code;
      if (code !== 0) throw new Error(`${transfer.method} exited with code ${code}.${outputTailMessage(transfer)}`);
      this.touch(transfer, { status: "succeeded", progress: 1, transferredBytes: transfer.size, message: "File saved to Main Agent machine." });
      await this.audit({ type: "main-agent-file-transfer.status", transferId: transfer.transferId, status: "succeeded", message: transfer.message });
    } finally {
      await cleanupAskpassSecret(askpass);
    }
  }

  private requestFallbackPassword(transfer: TransferRecord): Promise<string> {
    if (transfer.passwordResolver) {
      return new Promise((resolve) => {
        const previousResolver = transfer.passwordResolver;
        transfer.passwordResolver = (password) => {
          previousResolver?.(password);
          resolve(password);
        };
      });
    }
    return this.beginPasswordWait(transfer);
  }

  private runChildRsync(transfer: TransferRecord, rsync: TransferCommand, ssh: TransferCommand, askpass: AskpassSecret): Promise<number> {
    const args = rsyncArgs(transfer, rsync, ssh, sshAskpassArgs());
    transfer.commandPreview = shellCommand([rsync.command, ...args]);
    this.touch(transfer, {});
    return this.runChildCommand(transfer, rsync.command, args, askpass);
  }

  private runChildScp(transfer: TransferRecord, scp: TransferCommand | null, askpass: AskpassSecret): Promise<number> {
    if (!scp) {
      transfer.outputTail = `${transfer.outputTail}\nscp is not available.\n`.slice(-4000);
      return Promise.resolve(SPAWN_FAILED_EXIT_CODE);
    }
    const args = scpArgs(transfer, scp, sshAskpassArgs());
    transfer.commandPreview = shellCommand([scp.command, ...args]);
    this.touch(transfer, {});
    return this.runChildCommand(transfer, scp.command, args, askpass);
  }

  private runChildCommand(transfer: TransferRecord, command: string, args: string[], askpass: AskpassSecret): Promise<number> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnChild(command, args, {
          cwd: path.dirname(transfer.sourceLocalPath),
          env: askpassEnv(askpass),
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        transfer.outputTail = `${transfer.outputTail}\n${command}: ${error instanceof Error ? error.message : String(error)}\n`.slice(-4000);
        resolve(SPAWN_FAILED_EXIT_CODE);
        return;
      }
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        transfer.outputTail = `${transfer.outputTail}${text}`.slice(-4000);
        this.applyProgress(transfer, text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        transfer.outputTail = `${transfer.outputTail}${text}`.slice(-4000);
        this.applyProgress(transfer, text);
      });
      child.on("error", (error) => {
        transfer.outputTail = `${transfer.outputTail}\n${command}: ${error.message}\n`.slice(-4000);
        resolve(SPAWN_FAILED_EXIT_CODE);
      });
      child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    });
  }

  private beginPasswordWait(transfer: TransferRecord): Promise<string> {
    transfer.needsPassword = true;
    const now = new Date();
    const expires = new Date(now.getTime() + PASSWORD_TIMEOUT_MS);
    this.touch(transfer, {
      status: "waiting-password",
      passwordRequestedAt: now.toISOString(),
      passwordExpiresAt: expires.toISOString(),
      message: "SSH password required."
    });
    void this.audit({ type: "main-agent-file-transfer.password", transferId: transfer.transferId, action: "requested" });
    return new Promise((resolve, reject) => {
      transfer.passwordResolver = resolve;
      transfer.passwordTimeout = setTimeout(() => {
        transfer.passwordResolver = undefined;
        transfer.passwordTimeout = undefined;
        transfer.needsPassword = false;
        transfer.pty?.kill();
        const error = new Error("SSH password input timed out after 3 minutes.");
        this.touch(transfer, {
          status: "failed",
          error: error.message,
          passwordRequestedAt: undefined,
          passwordExpiresAt: undefined
        });
        void this.audit({ type: "main-agent-file-transfer.status", transferId: transfer.transferId, status: "failed", error: error.message });
        reject(error);
      }, PASSWORD_TIMEOUT_MS);
    });
  }

  private clearPasswordTimeout(transfer: TransferRecord): void {
    if (!transfer.passwordTimeout) return;
    clearTimeout(transfer.passwordTimeout);
    transfer.passwordTimeout = undefined;
  }

  private runCommand(
    transfer: TransferRecord,
    command: string,
    args: string[],
    options: { allowPasswordPrompt: boolean }
  ): Promise<number> {
    return new Promise((resolve) => {
      let pty: IPty;
      try {
        pty = spawn(command, args, {
          name: "xterm-256color",
          cols: 120,
          rows: 24,
          cwd: path.dirname(transfer.sourceLocalPath),
          env: transferProcessEnv()
        });
      } catch (error) {
        transfer.outputTail = `${transfer.outputTail}\n${command}: ${error instanceof Error ? error.message : String(error)}\n`.slice(-4000);
        resolve(SPAWN_FAILED_EXIT_CODE);
        return;
      }
      transfer.pty = pty;
      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        transfer.pty = undefined;
        this.clearPasswordTimeout(transfer);
        resolve(code);
      };
      pty.onData((data) => {
        transfer.outputTail = `${transfer.outputTail}${data}`.slice(-4000);
        this.applyProgress(transfer, data);
        if (/are you sure you want to continue connecting/i.test(data)) {
          pty.write("yes\r");
        }
        if (/password:\s*$/i.test(stripAnsi(transfer.outputTail)) || /password:/i.test(data)) {
          if (!options.allowPasswordPrompt) return;
          this.requestPassword(transfer, pty);
        }
      });
      pty.onExit(({ exitCode }) => finish(exitCode));
    });
  }

  private requestPassword(transfer: TransferRecord, pty: IPty): void {
    if (transfer.passwordResolver) return;
    this.beginPasswordWait(transfer).then((password) => {
      this.clearPasswordTimeout(transfer);
      this.touch(transfer, { needsPassword: false, passwordRequestedAt: undefined, passwordExpiresAt: undefined, message: "Password received; continuing transfer." });
      pty.write(`${password}\r`);
    }).catch(() => undefined);
  }

  private applyProgress(transfer: TransferRecord, data: string): void {
    const text = stripAnsi(data);
    const percentMatch = text.match(/(\d{1,3})%\s+([0-9.,]+[kKmMgGtT]?B\/s)?/);
    if (percentMatch) {
      const percent = Math.max(0, Math.min(100, Number(percentMatch[1])));
      this.touch(transfer, {
        status: "transferring",
        progress: percent / 100,
        transferredBytes: Math.round(transfer.size * percent / 100),
        speed: percentMatch[2],
        message: "Uploading file."
      });
    }
  }

  private touch(transfer: TransferRecord, patch: Partial<MainAgentFileTransferSnapshot>): void {
    Object.assign(transfer, patch, { updatedAt: new Date().toISOString() });
    this.emitter.emit("transfer", snapshot(transfer));
  }

  private async audit(event: AuditEvent): Promise<void> {
    const entry = { ts: new Date().toISOString(), ...event };
    const logPath = path.join(appConfig.storageDir, "logs", "main-agent-file-transfer-audit.jsonl");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}

export const mainAgentFileTransferService = new MainAgentFileTransferService();

function snapshot(transfer: TransferRecord): MainAgentFileTransferSnapshot {
  const { pty: _pty, passwordResolver: _passwordResolver, passwordTimeout: _passwordTimeout, outputTail, ...rest } = transfer;
  return {
    ...rest,
    outputTail: stripAnsi(outputTail).trim().slice(-4000)
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function methodPreference(value: unknown): "rsync" | "scp" {
  if (value === undefined || value === null || value === "" || value === "rsync") return "rsync";
  if (value === "scp") return "scp";
  throw new Error("main-agent-save-file only supports methodPreference rsync or scp.");
}

function destinationValue(value: unknown): Partial<MainAgentFileDestination> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const host = usableConnectionValue(record.host);
  const user = usableConnectionValue(record.user);
  const remotePath = stringValue(record.path);
  const port = typeof record.port === "number" ? record.port : Number(record.port);
  if (!remotePath || !path.posix.isAbsolute(remotePath) || isPlaceholderText(remotePath)) return null;
  return {
    host: host || undefined,
    user: user || undefined,
    path: path.posix.normalize(remotePath),
    port: Number.isFinite(port) && port > 0 ? Math.max(1, Math.min(65535, Math.floor(port))) : undefined
  };
}

async function resolveMainAgentDestination(destination: Partial<MainAgentFileDestination> | null): Promise<MainAgentFileDestination | null> {
  if (!destination?.path) return null;
  const config = await runtimeConfig();
  const host = usableConnectionValue(destination.host) || usableConnectionValue(config.gatewayDirectHost) || usableConnectionValue(config.remoteHost);
  const user = usableConnectionValue(destination.user);
  const port = typeof destination.port === "number" && destination.port > 0 ? destination.port : config.remoteSshPort;
  if (!host || !user || !Number.isFinite(port)) return null;
  return {
    host,
    user,
    path: destination.path,
    port: Math.max(1, Math.min(65535, Math.floor(port)))
  };
}

function usableConnectionValue(value: unknown): string {
  const text = stringValue(value);
  return text && !isPlaceholderText(text) ? text : "";
}

function isPlaceholderText(value: string): boolean {
  return /上面的|<[^>]+>|请替换|替换为|your-|example\.|100\.x\.x\.x|192\.168\.x\.x|main agent.*ip|main agent.*host|detaches_agent.*host|detaches-agent.*host|ssh user|原始文件名|final-filename\.ext/i.test(value);
}

function looksLikeDirectoryPath(remotePath: string): boolean {
  const trimmed = remotePath.trim();
  if (trimmed.endsWith("/")) return true;
  const base = path.posix.basename(trimmed).toLowerCase();
  if (!base || base === "." || base === "..") return true;
  return ["screenshots", "attachments", "uploads", "docs", "documents", "images", "files", "_staging", "staging"].includes(base);
}

function destinationWarnings(destination: MainAgentFileDestination): string[] {
  const match = destination.path.match(/^\/home\/([^/]+)\//);
  if (match?.[1] && match[1] !== destination.user) {
    return [`SSH user "${destination.user}" differs from destination home user "${match[1]}".`];
  }
  return [];
}

function rsyncArgs(transfer: TransferRecord, rsync: TransferCommand, ssh: TransferCommand, sshArgs: string[]): string[] {
  return [
    ...rsync.argsPrefix,
    "-P",
    "-e",
    `${shellCommand([ssh.command, ...ssh.argsPrefix, ...sshArgs])} -p ${transfer.destination.port}`,
    transfer.sourceLocalPath,
    remoteFileSpec(transfer)
  ];
}

function scpArgs(transfer: TransferRecord, scp: TransferCommand, sshArgs: string[]): string[] {
  return [
    ...scp.argsPrefix,
    ...sshArgs,
    "-P",
    String(transfer.destination.port),
    transfer.sourceLocalPath,
    remoteFileSpec(transfer)
  ];
}

async function resolveTransferCommand(command: "rsync" | "scp"): Promise<TransferCommand | null> {
  return resolveExecutable(command);
}

async function resolveSshCommand(command: string, argsPrefix: string[]): Promise<TransferCommand | null> {
  if (path.isAbsolute(command)) {
    try {
      await fs.access(command, fs.constants.X_OK);
      return { command, argsPrefix };
    } catch {
      return null;
    }
  }
  const resolved = await resolveExecutable(command);
  return resolved ? { ...resolved, argsPrefix } : null;
}

async function resolveExecutable(command: string): Promise<TransferCommand | null> {
  for (const dir of transferSearchPath()) {
    for (const name of platformService.executableNames(command)) {
      const candidate = path.join(dir, name);
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return { command: candidate, argsPrefix: [] };
      } catch {
        // Try the next executable name or PATH entry.
      }
    }
  }
  return null;
}
function transferSearchPath(): string[] {
  return [
    ...String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/usr/local/bin",
    "/opt/homebrew/bin"
  ].filter((item, index, all) => all.indexOf(item) === index);
}

function transferProcessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: transferSearchPath().join(path.delimiter)
  };
}

function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function sshInteractiveAuthArgs(): string[] {
  return [
    "-o", "BatchMode=no",
    "-o", "PreferredAuthentications=publickey,password,keyboard-interactive",
    "-o", "NumberOfPasswordPrompts=3"
  ];
}

function sshAskpassArgs(): string[] {
  return [
    "-o", "BatchMode=no",
    "-o", "PreferredAuthentications=publickey,password,keyboard-interactive",
    "-o", "NumberOfPasswordPrompts=1",
    "-o", "StrictHostKeyChecking=accept-new"
  ];
}

function outputTailMessage(transfer: TransferRecord): string {
  const tail = stripAnsi(transfer.outputTail).trim();
  return tail ? ` Output: ${tail.slice(-1000)}` : "";
}

function remoteFileSpec(transfer: TransferRecord): string {
  return `${transfer.destination.user}@${transfer.destination.host}:${shellQuote(transfer.destination.path)}`;
}

function isPtyUnavailable(outputTail: string): boolean {
  return /posix_spawnp failed|node-pty unavailable/i.test(outputTail);
}

function shouldRetryWithScp(code: number, outputTail: string): boolean {
  return code === SPAWN_FAILED_EXIT_CODE || isRsyncUsageOutput(outputTail);
}

function isRsyncUsageOutput(outputTail: string): boolean {
  return /usage:\s*rsync|source\s+\.\.\.\s+directory|\[--server\]|unknown option|unrecognized option/i.test(outputTail);
}

async function createAskpassSecret(password: string): Promise<AskpassSecret> {
  const dir = await fs.mkdtemp(path.join(appConfig.storageDir, "cache", "askpass-"));
  const passwordPath = path.join(dir, "password.txt");
  const scriptPath = path.join(dir, "askpass.sh");
  await fs.writeFile(passwordPath, password, { mode: 0o600 });
  await fs.writeFile(scriptPath, [
    "#!/bin/sh",
    `cat ${shellQuote(passwordPath)}`
  ].join("\n"), { mode: 0o700 });
  return { dir, passwordPath, scriptPath };
}

async function cleanupAskpassSecret(secret: AskpassSecret): Promise<void> {
  await fs.rm(secret.dir, { recursive: true, force: true }).catch(() => undefined);
}

function askpassEnv(secret: AskpassSecret): NodeJS.ProcessEnv {
  return {
    ...transferProcessEnv(),
    SSH_ASKPASS: secret.scriptPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: process.env.DISPLAY || "detaches-agent:0"
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
