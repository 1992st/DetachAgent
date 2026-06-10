export type OpenClawAdapterReadinessState = "ready" | "missing" | "invalid" | "error";

export interface OpenClawAdapterReadinessCheck {
  id: string;
  state: OpenClawAdapterReadinessState;
  message: string;
  details?: unknown;
}

export interface OpenClawAdapterReadiness {
  target: "local-distribution" | "remote-agent-host";
  installDir: string;
  probe?: "local-fs" | "remote-ssh";
  remoteHost?: string;
  remoteUser?: string;
  workspaceDir?: string;
  expectedAdapterId: string;
  expectedVersion: string;
  state: OpenClawAdapterReadinessState;
  checks: OpenClawAdapterReadinessCheck[];
  verifyCommands: string[];
}

export interface OpenClawAdapterInstallPlan {
  target: "remote-agent-host";
  adapterId: string;
  version: string;
  baseUrl: string;
  installDir: string;
  workspaceDir: string;
  bundleUrl: string;
  bundleSha256: string;
  commands: string[];
  verifyCommands: string[];
  notes: string[];
}
