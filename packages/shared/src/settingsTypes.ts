import type { LibraryServerConfig } from "./libraryTypes.js";

export interface RemoteProfile {
  id: string;
  name: string;
  remoteHost: string;
  remoteSshPort: number;
  remoteUser: string;
  remoteIdentityPath: string;
  mainAgentServiceEnabled: boolean;
  localSshBridgeEnabled: boolean;
  reverseBridgeRemoteHost: string;
  reverseBridgeRemotePort: number;
  gatewayTransport: "ssh" | "direct";
  gatewayDirectHost: string;
  gatewayDirectUrl: string;
  gatewayRemotePort: number;
  gatewayLocalPort: number;
  authMode: "token" | "password" | "none";
  remoteWorkspaceRoot: string;
  publicBaseUrl: string;
  gatewayTerminalLocalIp?: string;
  gatewayTerminalLocalIpSource?: "auto" | "manual";
  gatewayTerminalLastStatus?: "ok" | "error";
  gatewayTerminalLastTestedAt?: string;
  gatewayTerminalLastError?: string;
  fileServiceType?: "filebrowser";
  fileServiceHost?: string;
  fileServicePort?: number;
  fileServiceLastStatus?: "ok" | "error";
  fileServiceLastTestedAt?: string;
  fileServiceLastError?: string;
  libraryServers?: LibraryServerConfig[];
  activeLibraryServerId?: string;
  hasAuthToken: boolean;
  hasAuthPassword: boolean;
  lastTestedAt?: string;
  lastStatus?: "ok" | "error";
}

export interface PublicSettings extends RemoteProfile {
  activeProfileId: string;
  profiles: RemoteProfile[];
  serverHost: string;
  serverPort: number;
  serverListenHosts?: string[];
}

export interface RemoteProfileUpdate {
  name?: string;
  remoteHost?: string;
  remoteSshPort?: number;
  remoteUser?: string;
  remoteIdentityPath?: string;
  mainAgentServiceEnabled?: boolean;
  localSshBridgeEnabled?: boolean;
  reverseBridgeRemoteHost?: string;
  reverseBridgeRemotePort?: number;
  gatewayTransport?: "ssh" | "direct";
  gatewayDirectHost?: string;
  gatewayDirectUrl?: string;
  gatewayRemotePort?: number;
  gatewayLocalPort?: number;
  authMode?: "token" | "password" | "none";
  authToken?: string;
  authPassword?: string;
  clearAuthToken?: boolean;
  clearAuthPassword?: boolean;
  remoteWorkspaceRoot?: string;
  publicBaseUrl?: string;
  gatewayTerminalLocalIp?: string;
  gatewayTerminalLocalIpSource?: "auto" | "manual";
  gatewayTerminalLastStatus?: "ok" | "error";
  gatewayTerminalLastTestedAt?: string;
  gatewayTerminalLastError?: string;
  fileServiceType?: "filebrowser";
  fileServiceHost?: string;
  fileServicePort?: number;
  fileServiceLastStatus?: "ok" | "error";
  fileServiceLastTestedAt?: string;
  fileServiceLastError?: string;
  libraryServers?: LibraryServerConfig[];
  activeLibraryServerId?: string;
}

export interface SettingsUpdate extends RemoteProfileUpdate {
  activeProfileId?: string;
}
