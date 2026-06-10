export interface PublicSettings {
  remoteHost: string;
  remoteSshPort: number;
  remoteUser: string;
  remoteIdentityPath: string;
  gatewayTransport: "ssh" | "direct";
  gatewayDirectHost: string;
  gatewayRemotePort: number;
  gatewayLocalPort: number;
  authMode: "token" | "password" | "none";
  remoteWorkspaceRoot: string;
  publicBaseUrl: string;
  hasAuthToken: boolean;
  hasAuthPassword: boolean;
}

export interface SettingsUpdate {
  remoteHost?: string;
  remoteSshPort?: number;
  remoteUser?: string;
  remoteIdentityPath?: string;
  gatewayTransport?: "ssh" | "direct";
  gatewayDirectHost?: string;
  gatewayRemotePort?: number;
  gatewayLocalPort?: number;
  authMode?: "token" | "password" | "none";
  authToken?: string;
  authPassword?: string;
  clearAuthToken?: boolean;
  clearAuthPassword?: boolean;
  remoteWorkspaceRoot?: string;
  publicBaseUrl?: string;
}
