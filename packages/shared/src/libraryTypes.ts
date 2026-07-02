export interface LibraryServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  agentRootPath: string;
  lastStatus?: "ok" | "error";
  lastTestedAt?: string;
  lastError?: string;
}

export interface LibraryConfigResponse {
  servers: LibraryServerConfig[];
  activeServerId?: string;
  suggestedHost: string;
  suggestedAgentRootPath: string;
}

export interface LibraryServerSaveInput {
  id?: string;
  name?: string;
  host: string;
  port: number;
  agentRootPath: string;
}

export interface LibraryPathResolution {
  status: "ok" | "unmapped" | "invalid";
  absolutePath: string;
  relativePath?: string;
  displayPath?: string;
  url?: string;
  message?: string;
}

export interface LibraryEntry {
  name: string;
  type: "file" | "directory";
  absolutePath?: string;
  relativePath: string;
  displayPath: string;
  url?: string;
  size?: string;
  modifiedAt?: string;
}

export interface LibraryDirectoryResponse {
  serverId: string;
  relativePath: string;
  entries: LibraryEntry[];
}

export interface LibraryUrlCheckResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
}
