import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import SftpClient from "ssh2-sftp-client";
import type { FileTransferPrepareResponse, UploadedFileRef } from "@detaches/shared";
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
  token: string;
  expiresAtMs: number;
}

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
    return ref;
  }

  prepareTransfer(fileId: string, remotePath: string): FileTransferPrepareResponse {
    const file = this.stagedFiles.get(fileId);
    if (!file) {
      throw new Error("Staged file not found or already transferred.");
    }
    const cleanedRemotePath = remotePath.trim();
    if (!cleanedRemotePath || cleanedRemotePath.includes("\0") || cleanedRemotePath.endsWith("/")) {
      throw new Error("remotePath must be a target file path.");
    }
    const token = nanoid(32);
    const expiresAtMs = Date.now() + 10 * 60 * 1000;
    this.transferTokens.set(token, { fileId, token, expiresAtMs });
    const downloadUrl = `http://${this.localAccessHost()}:${appConfig.serverPort}/api/files/staged/${encodeURIComponent(fileId)}?token=${encodeURIComponent(token)}`;
    return {
      fileId,
      fileName: file.displayName || file.name,
      remotePath: cleanedRemotePath,
      downloadUrl,
      command: buildCurlCommand(downloadUrl, cleanedRemotePath),
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  async consumeStagedDownload(fileId: string, token: string): Promise<{ localPath: string; name: string; cleanup: () => Promise<void> }> {
    const tokenRecord = this.transferTokens.get(token);
    if (!tokenRecord || tokenRecord.fileId !== fileId) {
      throw new Error("Invalid staged file token.");
    }
    if (tokenRecord.expiresAtMs < Date.now()) {
      this.transferTokens.delete(token);
      throw new Error("Staged file token expired.");
    }
    const file = this.stagedFiles.get(fileId);
    if (!file) {
      this.transferTokens.delete(token);
      throw new Error("Staged file not found or already transferred.");
    }
    await fs.access(file.localPath);
    const cleanup = async () => {
      this.transferTokens.delete(token);
      this.stagedFiles.delete(fileId);
      try {
        await fs.unlink(file.localPath);
      } catch {
        // Best effort cleanup after a successful one-time transfer.
      }
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
