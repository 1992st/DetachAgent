import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import SftpClient from "ssh2-sftp-client";
import type { FileTransferPrepareResponse, ToolTarget, UploadedFileRef } from "@detaches/shared";
import { appConfig } from "../../config/appConfig.js";
import { runtimeConfig } from "../../config/settingsStore.js";

function normalizeRemotePath(remotePath: string, remoteHome: string): string {
  const trimmed = remotePath.trim();
  const expanded = trimmed === "~" ? remoteHome : trimmed.startsWith("~/") ? `${remoteHome}/${trimmed.slice(2)}` : trimmed;
  const normalized = path.posix.normalize(expanded);
  if (!normalized.startsWith("/")) {
    throw new Error("Remote path must be absolute or start with ~/.");
  }
  return normalized.replace(/\/+$/, "") || "/";
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
      reason: string;
    };

export class FileTransferService {
  private stagedFiles = new Map<string, StagedFileRecord>();
  private transferTokens = new Map<string, TransferTokenRecord>();

  async saveUpload(file: Express.Multer.File): Promise<UploadedFileRef> {
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
      createdAt: new Date().toISOString()
    };
    this.stagedFiles.set(id, ref);
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

  async prepareTransfer(fileId: string, target: ToolTarget, remotePath: string): Promise<FileTransferPrepareResponse> {
    if (target !== "local-user-machine") {
      await this.audit({ type: "transfer.error", fileId, target, reason: `Unsupported transfer target: ${target}` });
      throw new Error(`Unsupported transfer target: ${target}.`);
    }
    const file = this.stagedFiles.get(fileId);
    if (!file) {
      void this.audit({ type: "transfer.error", fileId, target, reason: "Staged file not found or already transferred." });
      throw new Error("Staged file not found or already transferred.");
    }
    const cleanedRemotePath = remotePath.trim();
    if (!cleanedRemotePath || cleanedRemotePath.includes("\0") || cleanedRemotePath.endsWith("/")) {
      void this.audit({ type: "transfer.error", fileId, target, reason: "remotePath must be a target file path." });
      throw new Error("remotePath must be a target file path.");
    }
    const token = nanoid(32);
    const expiresAtMs = Date.now() + 10 * 60 * 1000;
    this.transferTokens.set(token, { fileId, target, token, expiresAtMs });
    const downloadUrl = `http://${this.localAccessHost()}:${appConfig.serverPort}/api/files/staged/${encodeURIComponent(fileId)}?token=${encodeURIComponent(token)}`;
    const response = {
      fileId,
      target,
      fileName: file.displayName || file.name,
      remotePath: cleanedRemotePath,
      downloadUrl,
      command: buildCurlCommand(downloadUrl, cleanedRemotePath),
      expiresAt: new Date(expiresAtMs).toISOString()
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

  async consumeStagedDownload(fileId: string, token: string): Promise<{ localPath: string; name: string; cleanup: () => Promise<void> }> {
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
    if (!file) {
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
      this.transferTokens.delete(token);
      this.stagedFiles.delete(fileId);
      let deleted = false;
      try {
        await fs.unlink(file.localPath);
        deleted = true;
      } catch {
        // Best effort cleanup after a successful one-time transfer.
      }
      await this.audit({
        type: "transfer.download.cleanup",
        fileId,
        target: tokenRecord.target,
        fileName: file.displayName || file.name,
        localPath: file.localPath,
        deleted
      });
    };
    return { localPath: file.localPath, name: file.displayName || file.name, cleanup };
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
    const sftp = new SftpClient();
    await sftp.connect({
      host: config.remoteHost,
      port: config.remoteSshPort,
      username: config.remoteUser,
      privateKey: config.remoteIdentityPath ? await fs.readFile(config.remoteIdentityPath) : undefined
    });
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
    const sftp = new SftpClient();
    await sftp.connect({
      host: config.remoteHost,
      port: config.remoteSshPort,
      username: config.remoteUser,
      privateKey: config.remoteIdentityPath ? await fs.readFile(config.remoteIdentityPath) : undefined
    });
    try {
      return path.posix.normalize(await sftp.realPath("."));
    } finally {
      await sftp.end();
    }
  }

  private localAccessHost(): string {
    const configured = process.env.DETACHES_PUBLIC_HOST?.trim();
    if (configured) return configured;
    const directHost = process.env.TAILSCALE_IP?.trim();
    if (directHost) return directHost;
    return appConfig.serverHost === "0.0.0.0" ? "127.0.0.1" : appConfig.serverHost;
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
    shellQuote(downloadUrl),
    "-o",
    shellQuote(remotePath)
  ].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
