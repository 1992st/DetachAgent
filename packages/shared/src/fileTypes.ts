export type ToolTarget = "local-user-machine" | "remote-agent-host" | "gateway-managed" | "main-agent-machine";

export interface UploadedFileRef {
  id: string;
  name: string;
  displayName?: string;
  storageName?: string;
  mimeType: string;
  size: number;
  localPath?: string;
  remotePath?: string;
  contentBase64?: string;
  createdAt: string;
}

export interface FileUploadResponse {
  file: UploadedFileRef;
  warning?: string;
}

export interface FileTransferPrepareRequest {
  fileId: string;
  target: ToolTarget;
  remotePath: string;
  agentId?: string;
  sessionKey?: string;
}

export interface FileTransferPrepareResponse {
  fileId: string;
  target: ToolTarget;
  agentId?: string;
  workspace?: string;
  fileName: string;
  remotePath: string;
  downloadUrl: string;
  command: string;
  expiresAt: string;
  timeoutMs?: number;
}

export interface DownloadableArtifact {
  id: string;
  name: string;
  remotePath?: string;
  url: string;
  size?: number;
}

export type MainAgentFileTransferStatus =
  | "pending"
  | "probing"
  | "waiting-password"
  | "transferring"
  | "succeeded"
  | "failed";

export interface MainAgentFileDestination {
  host: string;
  port: number;
  user: string;
  path: string;
}

export interface MainAgentFileTransferSnapshot {
  transferId: string;
  requestId: string;
  sessionKey: string;
  agentId?: string;
  fileId: string;
  sourceLocalPath: string;
  displayName: string;
  size: number;
  requestedDestination?: Partial<MainAgentFileDestination>;
  destination: MainAgentFileDestination;
  commandPreview?: string;
  warnings?: string[];
  method: "rsync" | "scp" | "unknown";
  status: MainAgentFileTransferStatus;
  progress?: number;
  transferredBytes?: number;
  speed?: string;
  message?: string;
  error?: string;
  exitCode?: number;
  outputTail?: string;
  needsPassword: boolean;
  passwordRequestedAt?: string;
  passwordExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MainAgentFileTransferPasswordResponse {
  transfer: MainAgentFileTransferSnapshot;
}
