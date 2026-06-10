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
  message?: string;
}
