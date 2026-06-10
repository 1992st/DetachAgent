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

export interface DownloadableArtifact {
  id: string;
  name: string;
  remotePath?: string;
  url: string;
  size?: number;
}
