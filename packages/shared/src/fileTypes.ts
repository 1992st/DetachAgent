export interface UploadedFileRef {
  id: string;
  name: string;
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
  remotePath: string;
}

export interface FileTransferPrepareResponse {
  fileId: string;
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
