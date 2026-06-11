export type ConnectionState = "unknown" | "ok" | "error" | "disabled";

export interface HealthCheck {
  state: ConnectionState;
  message: string;
  details?: unknown;
}

export interface AppHealth {
  server: HealthCheck;
  ssh: HealthCheck;
  gateway: HealthCheck;
  config: {
    remoteHost: string;
    remoteSshPort: number;
    gatewayTransport: "ssh" | "direct";
    gatewayDirectHost: string;
    gatewayLocalPort: number;
    gatewayRemotePort: number;
    reverseBridgeRemoteHost: string;
    reverseBridgeRemotePort: number;
    authMode: "token" | "password" | "none";
  };
  checkedAt: string;
}

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticItem {
  id: string;
  severity: DiagnosticSeverity;
  title: string;
  message: string;
  action?: string;
  details?: unknown;
}

export interface DiagnosticsResponse {
  items: DiagnosticItem[];
  health: AppHealth;
  checkedAt: string;
}

export interface NetworkTestStep {
  id: string;
  label: string;
  state: ConnectionState;
  message: string;
  details?: unknown;
}

export interface NetworkTestResponse {
  steps: NetworkTestStep[];
  checkedAt: string;
}
