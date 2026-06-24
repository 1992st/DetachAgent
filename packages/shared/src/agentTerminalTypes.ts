import type { ToolRiskLevel } from "./toolBrokerTypes.js";

export type AgentTerminalSessionState = "pending_authorization" | "ready" | "revoked" | "expired";
export type AgentTerminalRunStatus =
  | "queued"
  | "waiting_for_approval"
  | "approved"
  | "running"
  | "completed"
  | "rejected"
  | "blocked"
  | "failed"
  | "timeout"
  | "cancelled";

export type CommandGuardDecision = "allow" | "warn" | "block" | "require-confirmation";
export type CommandGuardRiskLevel = ToolRiskLevel;

export interface CommandGuardResult {
  decision: CommandGuardDecision;
  riskLevel: CommandGuardRiskLevel;
  matchedRules: string[];
  guardReason?: string;
  normalizedCommand: string;
}

export interface AgentTerminalSession {
  terminalSessionId: string;
  sessionKey: string;
  agentId?: string;
  remoteAddress: string;
  terminalId?: string;
  state: AgentTerminalSessionState;
  createdAt: string;
  lastActiveAt: string;
  leaseExpiresAt: string;
  refreshAfter: string;
  revokedAt?: string;
  lastRunStatus?: AgentTerminalRunStatus;
}

export interface AgentTerminalBootstrapRequest {
  sessionKey?: string;
  agentId?: string;
  displayName?: string;
}

export interface AgentTerminalBootstrapResponse {
  ok: true;
  terminalSession: AgentTerminalSession;
  leaseToken: string;
  leaseExpiresAt: string;
  refreshAfter: string;
  capabilities: {
    supportsWait: true;
    supportsStreaming: true;
    supportsCancel: true;
    approvalRequired: true;
  };
}

export interface AgentTerminalRunRequest {
  command: string;
  reason?: string;
  workingDirectory?: string | null;
  sourceEventId?: string;
}

export interface AgentTerminalRun {
  runId: string;
  terminalSessionId: string;
  requestId?: string;
  command: string;
  reason?: string;
  status: AgentTerminalRunStatus;
  approvalStatus?: "pending" | "approved" | "rejected";
  executionId?: string;
  output?: string;
  outputTail?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  exitCode?: number;
  guard: CommandGuardResult;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  error?: string;
}

export interface AgentTerminalRunResponse {
  ok: boolean;
  run: AgentTerminalRun;
  status: AgentTerminalRunStatus;
  pollEndpoint: string;
  streamEndpoint: string;
  output?: string;
  outputTail?: string;
  outputTruncated?: boolean;
  exitCode?: number;
  code?: string;
  message?: string;
}

export type AgentTerminalStreamEvent =
  | { type: "approval_waiting"; run: AgentTerminalRun }
  | { type: "approved"; run: AgentTerminalRun }
  | { type: "started"; run: AgentTerminalRun }
  | { type: "output"; runId: string; chunk: string; outputTail?: string }
  | { type: "completed"; run: AgentTerminalRun }
  | { type: "rejected"; run: AgentTerminalRun }
  | { type: "blocked"; run: AgentTerminalRun }
  | { type: "failed"; run: AgentTerminalRun }
  | { type: "timeout"; run: AgentTerminalRun }
  | { type: "cancelled"; run: AgentTerminalRun };

export interface AgentTerminalSessionsResponse {
  sessions: AgentTerminalSession[];
}
