import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import SftpClient from "ssh2-sftp-client";
import type { FileTransferPrepareResponse, ToolTarget, UploadedFileRef } from "@detaches/shared";
import { appConfig, publicServerBaseUrl, reverseBridgeBaseUrl } from "../../config/appConfig.js";
import { runtimeConfig, type RuntimeSettings } from "../../config/settingsStore.js";
import { gatewayClient } from "../gateway/gatewayClient.js";
import { platformService } from "../platform/platformService.js";
import { sshCredentialSessionService } from "../ssh/sshCredentialSessionService.js";

function normalizeRemotePath(remotePath: string, remoteHome: string): string {
  return platformService.normalizeRemotePosixPath(remotePath, remoteHome);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.\- \u4e00-\u9fa5]/g, "_").slice(0, 180) || "upload.bin";
}

function displayFileName(name: string): string {
  return repairMultipartFileName(name).replace(/[\0\r\n]/g, " ").trim().slice(0, 240) || "upload.bin";
}

function repairMultipartFileName(name: string): string {
  if (!/[\u00c0-\u00ff]/.test(name)) return name;
  try {
    const repaired = Buffer.from(name, "latin1").toString("utf8");
    return repaired.includes("\uFFFD") ? name : repaired;
  } catch {
    return name;
  }
}

interface StagedFileRecord extends UploadedFileRef {
  localPath: string;
  state?: "available" | "consumed";
  consumedAt?: string;
}

interface StagedFilesState {
  version: 1;
  files: StagedFileRecord[];
}

interface TransferTokenRecord {
  fileId: string;
  target: ToolTarget;
  token: string;
  expiresAtMs: number;
}

type FileTransferAuditEvent =
  | {
      type: "upload";
      fileId: string;
      fileName: string;
      storageName?: string;
      mimeType: string;
      size: number;
      localPath: string;
    }
  | {
      type: "transfer.prepare";
      fileId: string;
      target: ToolTarget;
      fileName: string;
      remotePath: string;
      downloadUrl: string;
      command: string;
      expiresAt: string;
      agentId?: string;
      workspace?: string;
    }
  | {
      type: "transfer.download.start";
      fileId: string;
      target: ToolTarget;
      fileName: string;
      localPath: string;
    }
  | {
      type: "transfer.download.cleanup";
      fileId: string;
      target: ToolTarget;
      fileName: string;
      localPath: string;
      deleted: boolean;
    }
  | {
      type: "transfer.error";
      fileId?: string;
      target?: ToolTarget;
      agentId?: string;
      workspace?: string;
      reason: string;
    };

export class FileTransferService {
  private stagedFiles = new Map<string, StagedFileRecord>();
  private transferTokens = new Map<string, TransferTokenRecord>();
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();

  async saveUpload(file: Express.Multer.File): Promise<UploadedFileRef> {
    await this.load();
    const id = nanoid();
    const originalName = displayFileName(file.originalname);
    const storageName = sanitizeFileName(originalName);
    const localPath = path.join(appConfig.storageDir, "uploads", `${id}-${storageName}`);
    await fs.rename(file.path, localPath);
    const ref: StagedFileRecord = {
      id,
      name: originalName,
      displayName: originalName,
      storageName,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
      localPath,
      createdAt: new Date().toISOString(),
      state: "available"
    };
    this.stagedFiles.set(id, ref);
    await this.save();
    await this.audit({
      type: "upload",
      fileId: ref.id,
      fileName: ref.displayName || ref.name,
      storageName: ref.storageName,
      mimeType: ref.mimeType,
      size: ref.size,
      localPath: ref.localPath
    });
    return ref;
  }

  async prepareTransfer(input: {
    fileId: string;
    target: ToolTarget;
    remotePath: string;
    agentId?: string;
    sessionKey?: string;
  }): Promise<FileTransferPrepareResponse> {
    await this.load();
    const { fileId, target } = input;
    if (target === "gateway-managed") {
      await this.audit({ type: "transfer.error", fileId, target, reason: "gateway-managed transfer adapter is not implemented yet." });
      throw new Error("gateway-managed transfer adapter is not implemented yet.");
    }
    if (target === "remote-agent-host") {
      return this.prepareRemoteAgentTransfer(input);
    }
    const file = await this.requireAvailableFile(fileId, target);
    const cleanedRemotePath = platformService.normalizeLocalPath(input.remotePath) ?? input.remotePath.trim();
    if (!cleanedRemotePath || cleanedRemotePath.includes("\0") || /[\\/]$/.test(cleanedRemotePath)) {
      void this.audit({ type: "transfer.error", fileId, target, reason: "remotePath must be a target file path." });
      throw new Error("remotePath must be a target file path.");
    }
    const token = nanoid(32);
    const expiresAtMs = Date.now() + 10 * 60 * 1000;
    this.transferTokens.set(token, { fileId, target, token, expiresAtMs });
    const config = await runtimeConfig();
    const downloadUrl = `${publicServerBaseUrl(config)}/api/files/staged/${encodeURIComponent(fileId)}?token=${encodeURIComponent(token)}`;
    const response = {
      fileId,
      target,
      fileName: file.displayName || file.name,
      remotePath: cleanedRemotePath,
      downloadUrl,
      command: platformService.buildLocalCurlDownloadCommand(downloadUrl, cleanedRemotePath),
      expiresAt: new Date(expiresAtMs).toISOString(),
      timeoutMs: transferTimeoutMs(file.size)
    };
    await this.audit({
      type: "transfer.prepare",
      fileId,
      target,
      fileName: response.fileName,
      remotePath: response.remotePath,
      downloadUrl: response.downloadUrl,
      command: response.command,
      expiresAt: response.expiresAt
    });
    return response;
  }

  private async prepareRemoteAgentTransfer(input: {
    fileId: string;
    target: ToolTarget;
    remotePath: string;
    agentId?: string;
    sessionKey?: string;
  }): Promise<FileTransferPrepareResponse> {
    const agentId = input.agentId || agentIdFromSessionKey(input.sessionKey);
    if (!agentId) {
      await this.audit({ type: "transfer.error", fileId: input.fileId, target: input.target, reason: "remote-agent-host transfer requires agentId or sessionKey." });
      throw new Error("remote-agent-host transfer requires agentId or sessionKey.");
    }
    const file = await this.requireAvailableFile(input.fileId, input.target, agentId);
    const workspace = await this.agentWorkspace(agentId);
    const config = await runtimeConfig();
    const remoteHomeCandidates = remoteHomeCandidatesForUser(config.remoteUser);
    const remotePath = normalizeRemoteAgentPath(input.remotePath, { workspace, remoteHomeCandidates });
    if (!remotePath) {
      await this.audit({
        type: "transfer.error",
        fileId: input.fileId,
        target: input.target,
        agentId,
        workspace,
        reason: "remotePath must be an absolute path inside the remote agent workspace or remote user home."
      });
      throw new Error(`remote-agent-host remotePath must be an absolute path inside the remote agent workspace (${workspace}) or remote user home (${remoteHomeCandidates.join(", ") || "configured remote user home"}).`);
    }
    const token = nanoid(32);
    const expiresAtMs = Date.now() + 10 * 60 * 1000;
    this.transferTokens.set(token, { fileId: input.fileId, target: input.target, token, expiresAtMs });
    if (!config.remoteUser) {
      this.transferTokens.delete(token);
      const reason = "remote-agent-host transfer requires OPENCLAW_REMOTE_USER.";
      await this.audit({ type: "transfer.error", fileId: input.fileId, target: input.target, agentId, workspace, reason });
      throw new Error(reason);
    }
    const downloadUrl = `${reverseBridgeBaseUrl(config)}/api/files/staged/${encodeURIComponent(input.fileId)}?token=${encodeURIComponent(token)}`;
    const response = {
      fileId: input.fileId,
      target: input.target,
      fileName: file.displayName || file.name,
      remotePath,
      downloadUrl,
      command: buildRemoteAgentCurlCommand(config, downloadUrl, remotePath),
      expiresAt: new Date(expiresAtMs).toISOString(),
      timeoutMs: transferTimeoutMs(file.size)
    };
    await this.audit({
      type: "transfer.prepare",
      fileId: input.fileId,
      target: input.target,
      agentId,
      workspace,
      fileName: response.fileName,
      remotePath: response.remotePath,
      downloadUrl: response.downloadUrl,
      command: response.command,
      expiresAt: response.expiresAt
    });
    return response;
  }

  private async agentWorkspace(agentId: string): Promise<string> {
    const raw = await gatewayClient.listAgentFiles(agentId);
    const workspace = typeof (raw as any)?.workspace === "string" ? (raw as any).workspace.trim() : "";
    if (!workspace) {
      throw new Error(`Gateway did not return a workspace for agent ${agentId}.`);
    }
    return path.posix.normalize(workspace);
  }

  async consumeStagedDownload(fileId: string, token: string): Promise<{ localPath: string; name: string; cleanup: () => Promise<void> }> {
    await this.load();
    const tokenRecord = this.transferTokens.get(token);
    if (!tokenRecord || tokenRecord.fileId !== fileId) {
      await this.audit({ type: "transfer.error", fileId, reason: "Invalid staged file token." });
      throw new Error("Invalid staged file token.");
    }
    if (tokenRecord.expiresAtMs < Date.now()) {
      this.transferTokens.delete(token);
      await this.audit({ type: "transfer.error", fileId, reason: "Staged file token expired." });
      throw new Error("Staged file token expired.");
    }
    const file = this.stagedFiles.get(fileId);
    if (!file || file.state === "consumed") {
      this.transferTokens.delete(token);
      await this.audit({ type: "transfer.error", fileId, reason: "Staged file not found or already transferred." });
      throw new Error("Staged file not found or already transferred.");
    }
    await fs.access(file.localPath);
    await this.audit({
      type: "transfer.download.start",
      fileId,
      target: tokenRecord.target,
      fileName: file.displayName || file.name,
      localPath: file.localPath
    });
    const cleanup = async () => {
      await this.save();
      await this.audit({
        type: "transfer.download.cleanup",
        fileId,
        target: tokenRecord.target,
        fileName: file.displayName || file.name,
        localPath: file.localPath,
        deleted: false
      });
    };
    return { localPath: file.localPath, name: file.displayName || file.name, cleanup };
  }

  async markTransferred(fileId: string): Promise<void> {
    await this.load();
    const file = this.stagedFiles.get(fileId);
    if (!file) return;
    this.stagedFiles.set(fileId, { ...file, state: "consumed", consumedAt: new Date().toISOString() });
    for (const [token, record] of this.transferTokens.entries()) {
      if (record.fileId === fileId) this.transferTokens.delete(token);
    }
    await this.save();
  }

  async stagedFile(fileId: string): Promise<UploadedFileRef | null> {
    await this.load();
    const file = this.stagedFiles.get(fileId);
    if (!file || file.state === "consumed") return null;
    try {
      await fs.access(file.localPath);
    } catch {
      return null;
    }
    return file;
  }

  private async requireAvailableFile(fileId: string, target: ToolTarget, agentId?: string): Promise<StagedFileRecord> {
    const file = this.stagedFiles.get(fileId);
    if (!file || file.state === "consumed") {
      await this.audit({ type: "transfer.error", fileId, target, agentId, reason: "Staged file not found or already transferred." });
      throw new Error("Staged file not found or already transferred.");
    }
    try {
      await fs.access(file.localPath);
    } catch {
      await this.audit({ type: "transfer.error", fileId, target, agentId, reason: "Staged file exists in registry but is missing on disk." });
      throw new Error("Staged file exists in registry but is missing on disk.");
    }
    return file;
  }

  async downloadRemote(remotePath: string): Promise<{ localPath: string; name: string }> {
    const normalizedRemotePath = await this.normalizeAllowedRemotePath(remotePath);
    if (!normalizedRemotePath) {
      throw new Error("Remote path is outside the configured workspace.");
    }
    const config = await runtimeConfig();
    if (!config.remoteUser) {
      throw new Error("OPENCLAW_REMOTE_USER is not configured.");
    }
    const name = sanitizeFileName(path.posix.basename(normalizedRemotePath));
    const localPath = path.join(appConfig.storageDir, "downloads", `${nanoid()}-${name}`);
    const sftp = await connectSftpWithCredentials(config, "SSH password required to download the remote file.");
    try {
      await sftp.fastGet(normalizedRemotePath, localPath);
      return { localPath, name };
    } finally {
      await sftp.end();
    }
  }

  async isAllowedRemotePath(remotePath: string): Promise<boolean> {
    return Boolean(await this.normalizeAllowedRemotePath(remotePath));
  }

  private async normalizeAllowedRemotePath(remotePath: string): Promise<string | null> {
    const config = await runtimeConfig();
    const remoteHome = await this.remoteHome();
    const root = normalizeRemotePath(config.remoteWorkspaceRoot, remoteHome);
    const candidate = normalizeRemotePath(remotePath, remoteHome);
    return candidate === root || candidate.startsWith(`${root}/`) ? candidate : null;
  }

  private async remoteHome(): Promise<string> {
    const config = await runtimeConfig();
    if (!config.remoteUser) return `/home/${config.remoteUser || ""}`;
    const sftp = await connectSftpWithCredentials(config, "SSH password required to inspect the remote home directory.");
    try {
      return path.posix.normalize(await sftp.realPath("."));
    } finally {
      await sftp.end();
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.statePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<StagedFilesState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.files)) return;
      this.stagedFiles = new Map(parsed.files.filter(isStagedFileRecord).map((file) => [file.id, file]));
    } catch {
      this.stagedFiles = new Map();
    }
  }

  private async save(): Promise<void> {
    const state: StagedFilesState = {
      version: 1,
      files: [...this.stagedFiles.values()]
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
    return path.join(appConfig.storageDir, "cache", "staged-files.json");
  }

  private async audit(event: FileTransferAuditEvent): Promise<void> {
    const entry = { ts: new Date().toISOString(), ...event };
    const logPath = path.join(appConfig.storageDir, "logs", "file-transfer-audit.jsonl");
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}

export const fileTransferService = new FileTransferService();

function buildCurlCommand(downloadUrl: string, remotePath: string): string {
  return [
    "mkdir -p",
    shellQuote(path.posix.dirname(remotePath)),
    "&&",
    "curl -fL",
    "--speed-limit 1024",
    "--speed-time 45",
    shellQuote(downloadUrl),
    "-o",
    shellQuote(remotePath)
  ].join(" ");
}

function transferTimeoutMs(sizeBytes: number): number {
  const minMs = 60_000;
  const maxMs = 600_000;
  const bytesPerSecondFloor = 8 * 1024;
  const estimatedMs = Math.ceil((Math.max(sizeBytes, 1) / bytesPerSecondFloor) * 1000) + 30_000;
  return Math.min(maxMs, Math.max(minMs, estimatedMs));
}

function buildRemoteAgentCurlCommand(
  config: Awaited<ReturnType<typeof runtimeConfig>>,
  downloadUrl: string,
  remotePath: string
): string {
  if (!config.remoteUser) {
    throw new Error("OPENCLAW_REMOTE_USER is not configured.");
  }
  const remoteScript = buildCurlCommand(downloadUrl, remotePath);
  return [
    "ssh",
    "-p",
    String(config.remoteSshPort),
    ...(config.remoteIdentityPath ? ["-i", shellQuote(config.remoteIdentityPath)] : []),
    shellQuote(`${config.remoteUser}@${config.remoteHost}`),
    shellQuote(remoteScript)
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentIdFromSessionKey(sessionKey?: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey || "");
  return match?.[1] || "";
}

function normalizeRemoteAgentPath(remotePath: string, input: { workspace: string; remoteHomeCandidates: string[] }): string | null {
  const cleaned = remotePath.trim();
  if (!cleaned || cleaned.includes("\0") || cleaned.endsWith("/")) return null;
  if (!path.posix.isAbsolute(cleaned)) return null;
  const workspace = path.posix.normalize(input.workspace);
  const candidate = path.posix.normalize(cleaned);
  const allowedRoots = [workspace, ...input.remoteHomeCandidates].filter(Boolean);
  return allowedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`)) ? candidate : null;
}

function remoteHomeCandidatesForUser(remoteUser: string): string[] {
  const user = remoteUser.trim();
  if (!user) return [];
  return [`/Users/${user}`, `/home/${user}`].map((item) => path.posix.normalize(item));
}

async function connectSftpWithCredentials(config: RuntimeSettings, passwordPrompt: string): Promise<SftpClient> {
  const target = sshCredentialSessionService.targetFromConfig(config);
  const privateKey = config.remoteIdentityPath ? await fs.readFile(config.remoteIdentityPath) : undefined;
  let password = target ? sshCredentialSessionService.getPassword(target) : null;
  if (!privateKey && target && !password) {
    password = await sshCredentialSessionService.requestPassword(target, { message: passwordPrompt });
  }

  try {
    const sftp = await connectSftp(config, { privateKey, password });
    if (target && password) sshCredentialSessionService.markReady(target, "SSH password is ready for this app session.");
    return sftp;
  } catch (error) {
    if (!target || !isSshAuthFailure(error)) throw error;
    if (password) sshCredentialSessionService.markFailed(target, error instanceof Error ? error.message : String(error), { clearPassword: true });
    const nextPassword = await sshCredentialSessionService.requestPassword(target, { force: Boolean(password), message: passwordPrompt });
    const sftp = await connectSftp(config, { privateKey, password: nextPassword });
    sshCredentialSessionService.markReady(target, "SSH password is ready for this app session.");
    return sftp;
  }
}

async function connectSftp(
  config: RuntimeSettings,
  auth: { privateKey?: Buffer; password?: string | null }
): Promise<SftpClient> {
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: config.remoteHost,
      port: config.remoteSshPort,
      username: config.remoteUser,
      privateKey: auth.privateKey,
      password: auth.password || undefined
    });
    return sftp;
  } catch (error) {
    await sftp.end().catch(() => undefined);
    throw error;
  }
}

function isSshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /auth|authentication|permission denied|password|privatekey|all configured authentication methods failed/i.test(message);
}

function isStagedFileRecord(value: unknown): value is StagedFileRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StagedFileRecord>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.mimeType === "string"
    && typeof record.size === "number"
    && typeof record.localPath === "string"
    && typeof record.createdAt === "string";
}
