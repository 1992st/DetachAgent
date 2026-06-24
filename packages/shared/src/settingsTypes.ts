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
  hasAuthToken: boolean;
  hasAuthPassword: boolean;
  lastTestedAt?: string;
  lastStatus?: "ok" | "error";
}

export interface PublicSettings extends RemoteProfile {
  activeProfileId: string;
  profiles: RemoteProfile[];
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
}

export interface SettingsUpdate extends RemoteProfileUpdate {
  activeProfileId?: string;
}
