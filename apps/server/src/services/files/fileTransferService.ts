import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import SftpClient from "ssh2-sftp-client";
import type { UploadedFileRef } from "@detaches/shared";
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

export class FileTransferService {
  async saveUpload(file: Express.Multer.File, sessionKey: string): Promise<UploadedFileRef> {
    const id = nanoid();
    const safeName = sanitizeFileName(file.originalname);
    const localPath = path.join(appConfig.storageDir, "uploads", `${id}-${safeName}`);
    await fs.rename(file.path, localPath);
    const ref: UploadedFileRef = {
      id,
      name: safeName,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
      localPath,
      contentBase64: (await fs.readFile(localPath)).toString("base64"),
      createdAt: new Date().toISOString()
    };
    try {
      ref.remotePath = await this.uploadToRemote(localPath, safeName, sessionKey);
    } catch {
      // Keep the local attachment usable even when SFTP is not configured yet.
    }
    return ref;
  }

  async uploadToRemote(localPath: string, fileName: string, sessionKey: string): Promise<string> {
    const config = await runtimeConfig();
    if (!config.remoteUser) {
      throw new Error("OPENCLAW_REMOTE_USER is not configured.");
    }
    const remoteHome = await this.remoteHome();
    const remoteDir = `${normalizeRemotePath(config.remoteWorkspaceRoot, remoteHome)}/ui_uploads/${sessionKey}`;
    const remotePath = `${remoteDir}/${fileName}`;
    const sftp = new SftpClient();
    await sftp.connect({
      host: config.remoteHost,
      port: config.remoteSshPort,
      username: config.remoteUser,
      privateKey: config.remoteIdentityPath ? await fs.readFile(config.remoteIdentityPath) : undefined
    });
    try {
      await sftp.mkdir(remoteDir, true);
      await sftp.fastPut(localPath, remotePath);
      return remotePath;
    } finally {
      await sftp.end();
    }
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
}

export const fileTransferService = new FileTransferService();
