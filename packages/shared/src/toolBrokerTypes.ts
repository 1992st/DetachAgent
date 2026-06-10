import type { ToolTarget } from "./fileTypes.js";

export type ToolRequestKind = "terminal" | "file-transfer";
export type ToolRequestStatus = "pending" | "approved" | "rejected" | "blocked" | "started" | "failed";

export interface ToolRequestCreateInput {
  kind: ToolRequestKind;
  target: ToolTarget;
  sessionKey: string;
  agentId?: string;
  reason?: string;
  payload: Record<string, unknown>;
}

export interface ToolRequestRecord extends ToolRequestCreateInput {
  id: string;
  status: ToolRequestStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface ToolRequestCreateResponse {
  request: ToolRequestRecord;
}

export interface ToolRequestDecisionResponse {
  request: ToolRequestRecord;
  command?: string;
  execution?: {
    executionId?: string;
    target: ToolTarget;
    terminalId?: string;
    sessionKey?: string;
    wroteToTerminal?: boolean;
  };
  message?: string;
}

export interface ToolRequestExtractInput {
  text: string;
  sessionKey: string;
  agentId?: string;
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
  output: string;
  outputBytes: number;
  capturedAt: string;
  message?: string;
}

export interface ToolExecutionResultResponse {
  request: ToolRequestRecord;
  result: ToolExecutionResult;
}
