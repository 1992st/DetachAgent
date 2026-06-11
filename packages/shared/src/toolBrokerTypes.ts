import type { ToolTarget } from "./fileTypes.js";

export type ToolRequestKind = "terminal" | "file-transfer" | "adapter-install";
export type ToolRequestStatus = "pending" | "approved" | "rejected" | "blocked" | "started" | "failed";
export type ToolResultForwardStatus = "not-started" | "pending" | "sent" | "failed";
export type ToolRequestSource = "text-extract" | "api" | "gateway-event";
export type ToolRiskLevel = "safe" | "elevated" | "destructive";

export interface ToolRiskAssessment {
  level: ToolRiskLevel;
  reasons: string[];
}

export interface ToolDecisionActor {
  deviceId?: string;
  deviceIdShort?: string;
  displayName?: string;
  source?: "detaches-ui" | "api" | "unknown";
}

export interface ToolDecisionRecord {
  action: "approved" | "rejected";
  decidedAt: string;
  actor?: ToolDecisionActor;
  riskAccepted?: boolean;
}

export interface ToolRequestCreateInput {
  kind: ToolRequestKind;
  target: ToolTarget;
  sessionKey: string;
  agentId?: string;
  reason?: string;
  source?: ToolRequestSource;
  sourceEventId?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
  payload: Record<string, unknown>;
}

export interface ToolBrokerCapabilities {
  ok: true;
  app: "detaches_agent";
  protocolVersion: 1;
  gatewayEventEndpoint: string;
  eventSource: "gateway-event";
  idempotencyField: "sourceEventId";
  submitTokenRequired: true;
  submitTokenHeader: "Authorization";
  requestFormats: Array<"broker-event" | "fence">;
  requestKinds: ToolRequestKind[];
  targets: ToolTarget[];
  approvalRequired: true;
  adapterId: "detaches_agent.openclaw.adapter";
}

export interface ToolRequestRecord extends ToolRequestCreateInput {
  id: string;
  status: ToolRequestStatus;
  risk?: ToolRiskAssessment;
  lastDecision?: ToolDecisionRecord;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface ToolRequestCreateResponse {
  request: ToolRequestRecord;
}

export interface ToolGatewayEventInput extends ToolRequestCreateInput {
  source: "gateway-event";
  sourceEventId: string;
}

export interface ToolRequestListInput {
  sessionKey?: string;
  agentId?: string;
  status?: ToolRequestStatus;
  limit?: number;
}

export interface ToolRequestListResponse {
  requests: ToolRequestRecord[];
}

export type ToolBrokerSocketEvent =
  | { type: "ready"; filters: { sessionKey?: string; agentId?: string } }
  | { type: "request"; action: "created" | "updated" | "ingested" | "duplicate"; request: ToolRequestRecord }
  | { type: "error"; message: string };

export interface ToolRequestDecisionResponse {
  request: ToolRequestRecord;
  command?: string;
  execution?: {
    executionId?: string;
    target: ToolTarget;
    terminalId?: string;
    sessionKey?: string;
    wroteToTerminal?: boolean;
    completed?: boolean;
    exitCode?: number;
    forwardStatus?: ToolResultForwardStatus;
  };
  message?: string;
}

export interface ToolRequestApproveInput {
  riskAccepted?: boolean;
  actor?: ToolDecisionActor;
}

export interface ToolRequestRejectInput {
  actor?: ToolDecisionActor;
}

export interface ToolRequestExtractInput {
  text: string;
  sessionKey: string;
  agentId?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
}

export interface ToolRequestExtractResponse {
  requests: ToolRequestRecord[];
}

export interface ToolExecutionResult {
  executionId: string;
  requestId: string;
  status: ToolRequestStatus;
  terminalId?: string;
  sessionKey: string;
  completed: boolean;
  exitCode?: number;
  forwardStatus: ToolResultForwardStatus;
  forwardError?: string;
  forwardedAt?: string;
  output: string;
  outputBytes: number;
  capturedAt: string;
  message?: string;
}

export interface ToolExecutionResultResponse {
  request: ToolRequestRecord;
  result: ToolExecutionResult;
}
