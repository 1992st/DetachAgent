import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn, type IPty } from "node-pty";
import { nanoid } from "nanoid";
import type { MainAgentFileDestination, MainAgentFileTransferSnapshot, ToolRequestRecord } from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { platformService } from "../platform/platformService.js";
import { fileTransferService } from "./fileTransferService.js";

type TransferMethod = "rsync" | "scp" | "unknown";

interface TransferRecord extends MainAgentFileTransferSnapshot {
  pty?: IPty;
  passwordResolver?: (password: string) => void;
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
    const destination = destinationValue(payload.destination);
    const method = methodPreference(payload.methodPreference);
    if (!fileId) throw new Error("main-agent-save-file requires payload.fileId.");
    if (!sourceLocalPath) throw new Error("main-agent-save-file requires payload.sourceLocalPath.");
    if (!destination) throw new Error("main-agent-save-file requires payload.destination { host, port, user, path }.");
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
      destination,
      method: "unknown",
      status: "pending",
      needsPassword: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      outputTail: ""
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
    this.touch(transfer, { message: "Password received; continuing transfer." });
    resolver(password);
    void this.audit({ type: "main-agent-file-transfer.password", transferId, action: "provided" });
    return snapshot(transfer);
  }

  private async run(transfer: TransferRecord, preferred: "rsync" | "scp"): Promise<void> {
    try {
      this.touch(transfer, { status: "probing", message: "Checking SSH reachability." });
      const ssh = await platformService.resolveCommand("ssh");
      if (ssh.available === false) throw new Error(`SSH client is not available: ${ssh.command}`);
      await this.runCommand(transfer, ssh.command, [
        ...ssh.argsPrefix,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-p", String(transfer.destination.port),
        `${transfer.destination.user}@${transfer.destination.host}`,
        "true"
      ], { allowPasswordPrompt: false, phase: "probe" });
      if (!/permission denied|publickey|password/i.test(transfer.outputTail) && /connection refused|timed out|no route to host|could not resolve|name or service not known|operation timed out/i.test(transfer.outputTail)) {
        throw new Error("Main Agent remote service is unavailable or unreachable.");
      }

      this.touch(transfer, { status: "transferring", message: "Creating destination directory." });
      const mkdirCode = await this.runCommand(transfer, ssh.command, [
        ...ssh.argsPrefix,
        "-p", String(transfer.destination.port),
        `${transfer.destination.user}@${transfer.destination.host}`,
        `mkdir -p ${shellQuote(path.posix.dirname(transfer.destination.path))}`
      ], { allowPasswordPrompt: true, phase: "mkdir" });
      if (mkdirCode !== 0) throw new Error("Failed to create destination directory.");

      const method = preferred === "rsync" && await commandAvailable("rsync") ? "rsync" : "scp";
      transfer.method = method;
      this.touch(transfer, { status: "transferring", message: `Uploading with ${method}.` });
      const code = method === "rsync"
        ? await this.runRsync(transfer)
        : await this.runScp(transfer);
      if (code !== 0) throw new Error(`${method} exited with code ${code}.`);
      this.touch(transfer, { status: "succeeded", progress: 1, transferredBytes: transfer.size, message: "File saved to Main Agent machine." });
      await this.audit({ type: "main-agent-file-transfer.status", transferId: transfer.transferId, status: "succeeded", message: transfer.message });
    } catch (error) {
      this.touch(transfer, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      await this.audit({ type: "main-agent-file-transfer.status", transferId: transfer.transferId, status: "failed", error: transfer.error });
    } finally {
      transfer.pty = undefined;
      transfer.passwordResolver = undefined;
    }
  }

  private runRsync(transfer: TransferRecord): Promise<number> {
    return this.runCommand(transfer, "rsync", [
      "-P",
      "--info=progress2",
      "-e",
      `ssh -p ${transfer.destination.port}`,
      transfer.sourceLocalPath,
      `${transfer.destination.user}@${transfer.destination.host}:${transfer.destination.path}`
    ], { allowPasswordPrompt: true, phase: "transfer" });
  }

  private runScp(transfer: TransferRecord): Promise<number> {
    return this.runCommand(transfer, "scp", [
      "-P",
      String(transfer.destination.port),
      transfer.sourceLocalPath,
      `${transfer.destination.user}@${transfer.destination.host}:${transfer.destination.path}`
    ], { allowPasswordPrompt: true, phase: "transfer" });
  }

  private runCommand(
    transfer: TransferRecord,
    command: string,
    args: string[],
    options: { allowPasswordPrompt: boolean; phase: string }
  ): Promise<number> {
    return new Promise((resolve) => {
      const pty = spawn(command, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 24,
        cwd: path.dirname(transfer.sourceLocalPath),
        env: { ...process.env }
      });
      transfer.pty = pty;
      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        transfer.pty = undefined;
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
    transfer.needsPassword = true;
    this.touch(transfer, { status: "waiting-password", message: "SSH password required." });
    void this.audit({ type: "main-agent-file-transfer.password", transferId: transfer.transferId, action: "requested" });
    new Promise<string>((resolve) => {
      transfer.passwordResolver = resolve;
    }).then((password) => {
      pty.write(`${password}\r`);
    });
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
  const { pty: _pty, passwordResolver: _passwordResolver, outputTail: _outputTail, ...rest } = transfer;
  return rest;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function methodPreference(value: unknown): "rsync" | "scp" {
  if (value === undefined || value === null || value === "" || value === "rsync") return "rsync";
  if (value === "scp") return "scp";
  throw new Error("main-agent-save-file only supports methodPreference rsync or scp.");
}

function destinationValue(value: unknown): MainAgentFileDestination | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const host = stringValue(record.host);
  const user = stringValue(record.user);
  const remotePath = stringValue(record.path);
  const port = typeof record.port === "number" ? record.port : Number(record.port);
  if (!host || !user || !remotePath || !path.posix.isAbsolute(remotePath) || !Number.isFinite(port)) return null;
  return { host, user, path: path.posix.normalize(remotePath), port: Math.max(1, Math.min(65535, Math.floor(port))) };
}

async function commandAvailable(command: string): Promise<boolean> {
  const paths = String(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of paths) {
    try {
      await fs.access(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
