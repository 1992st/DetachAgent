import type { RemoteProfile, RemoteProfileUpdate } from "../settingsTypes.js";

export type AgentConfigAssistantAgentType = "openclaw" | "claude-code" | "codex" | "other";

export type AgentConfigAssistantStatus = "ready" | "needs_input" | "unsupported" | "invalid";

export type AgentConfigFindingLevel = "info" | "warning" | "error";

export interface AgentConfigFinding {
  level: AgentConfigFindingLevel;
  message: string;
}

export interface AgentConfigAssistantInput {
  agentType: AgentConfigAssistantAgentType;
  configText: string;
  mainAgentAddress: string;
  existingProfile: RemoteProfile;
}

export interface AgentConfigAssistantDetected {
  bind?: string;
  tailscaleMode?: string;
  port?: number;
  authMode?: string;
  hasAuthToken?: boolean;
  hasAuthPassword?: boolean;
}

export interface AgentConfigAssistantResult {
  status: AgentConfigAssistantStatus;
  agentType: AgentConfigAssistantAgentType;
  title: string;
  summary: string;
  proposedUpdate: RemoteProfileUpdate;
  findings: AgentConfigFinding[];
  detected: AgentConfigAssistantDetected;
}

