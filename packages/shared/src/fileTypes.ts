export type ToolTarget = "local-user-machine" | "remote-agent-host" | "gateway-managed";

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
}

export interface FileTransferPrepareResponse {
  fileId: string;
  target: ToolTarget;
  fileName: string;
  remotePath: string;
  downloadUrl: string;
  command: string;
  expiresAt: string;
}

export interface DownloadableArtifact {
  id: string;
  name: string;
  remotePath?: string;
  url: string;
  size?: number;
}
