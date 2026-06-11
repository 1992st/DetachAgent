import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import SftpClient from "ssh2-sftp-client";
import type { FileTransferPrepareResponse, ToolTarget, UploadedFileRef } from "@detaches/shared";
import { appConfig, publicServerBaseUrl } from "../../config/appConfig.js";
import { runtimeConfig } from "../../config/settingsStore.js";
import { gatewayClient } from "../gateway/gatewayClient.js";

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

  async prepareTransfer(input: {
    fileId: string;
    target: ToolTarget;
    remotePath: string;
    agentId?: string;
    sessionKey?: string;
  }): Promise<FileTransferPrepareResponse> {
    const { fileId, target } = input;
    if (target === "gateway-managed") {
      await this.audit({ type: "transfer.error", fileId, target, reason: "gateway-managed transfer adapter is not implemented yet." });
      throw new Error("gateway-managed transfer adapter is not implemented yet.");
    }
    if (target === "remote-agent-host") {
      return this.prepareRemoteAgentTransfer(input);
    }
    const file = this.stagedFiles.get(fileId);
    if (!file) {
      void this.audit({ type: "transfer.error", fileId, target, reason: "Staged file not found or already transferred." });
      throw new Error("Staged file not found or already transferred.");
    }
    const cleanedRemotePath = input.remotePath.trim();
    if (!cleanedRemotePath || cleanedRemotePath.includes("\0") || cleanedRemotePath.endsWith("/")) {
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
    const file = this.stagedFiles.get(input.fileId);
    if (!file) {
      await this.audit({ type: "transfer.error", fileId: input.fileId, target: input.target, agentId, reason: "Staged file not found or already transferred." });
      throw new Error("Staged file not found or already transferred.");
    }
    const workspace = await this.agentWorkspace(agentId);
    const remotePath = normalizeAgentWorkspacePath(input.remotePath, workspace);
    if (!remotePath) {
      await this.audit({
        type: "transfer.error",
        fileId: input.fileId,
        target: input.target,
        agentId,
        workspace,
        reason: "remotePath is outside the remote agent workspace."
      });
      throw new Error(`remotePath is outside the remote agent workspace: ${workspace}`);
    }
    const token = nanoid(32);
    const expiresAtMs = Date.now() + 10 * 60 * 1000;
    this.transferTokens.set(token, { fileId: input.fileId, target: input.target, token, expiresAtMs });
    const config = await runtimeConfig();
    const publicBaseUrl = publicServerBaseUrl(config);
    if (!isRemoteReachablePublicBaseUrl(publicBaseUrl)) {
      this.transferTokens.delete(token);
      const reason = "remote-agent-host transfer requires DETACHES_PUBLIC_BASE_URL to be reachable from the remote host; 127.0.0.1/localhost only works for local-user-machine.";
      await this.audit({ type: "transfer.error", fileId: input.fileId, target: input.target, agentId, workspace, reason });
      throw new Error(reason);
    }
    const downloadUrl = `${publicBaseUrl}/api/files/staged/${encodeURIComponent(input.fileId)}?token=${encodeURIComponent(token)}`;
    const response = {
      fileId: input.fileId,
      target: input.target,
      fileName: file.displayName || file.name,
      remotePath,
      downloadUrl,
      command: buildRemoteAgentCurlCommand(config, downloadUrl, remotePath),
      expiresAt: new Date(expiresAtMs).toISOString()
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

function isRemoteReachablePublicBaseUrl(value: string): boolean {
  if (!value.trim()) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentIdFromSessionKey(sessionKey?: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey || "");
  return match?.[1] || "";
}

function normalizeAgentWorkspacePath(remotePath: string, workspace: string): string | null {
  const cleaned = remotePath.trim();
  if (!cleaned || cleaned.includes("\0") || cleaned.endsWith("/")) return null;
  const root = path.posix.normalize(workspace);
  const candidate = path.posix.isAbsolute(cleaned)
    ? path.posix.normalize(cleaned)
    : path.posix.normalize(path.posix.join(root, cleaned));
  return candidate === root || candidate.startsWith(`${root}/`) ? candidate : null;
}
