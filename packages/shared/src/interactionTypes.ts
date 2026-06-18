import type { ToolDecisionActor } from "./toolBrokerTypes.js";

export type InteractionKind = "credential.request" | "ui.confirm";
export type InteractionStatus = "pending" | "resolved" | "rejected" | "expired";
export type InteractionSource = "api" | "gateway-event";
export type CredentialReturnMode = "local-handle" | "reveal-once";

export interface InteractionCredentialTarget {
  host?: string;
  port?: number;
  user?: string;
  label?: string;
}

export interface InteractionCreateInput {
  kind: InteractionKind;
  sessionKey: string;
  agentId?: string;
  reason?: string;
  source?: InteractionSource;
  sourceEventId?: string;
  sourceMessageId?: string;
  sourceRunId?: string;
  payload: Record<string, unknown>;
}

export interface InteractionRecord extends InteractionCreateInput {
  id: string;
  status: InteractionStatus;
  source: InteractionSource;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  result?: InteractionResult;
  error?: string;
}

export interface InteractionResult {
  mode: CredentialReturnMode | "confirmed";
  credentialHandle?: string;
  secret?: string;
  value?: unknown;
  actor?: ToolDecisionActor;
  decidedAt: string;
}

export interface InteractionCreateResponse {
  interaction: InteractionRecord;
  duplicate?: boolean;
}

export interface InteractionResolveInput {
  mode?: CredentialReturnMode | "confirmed";
  secret?: string;
  value?: unknown;
  actor?: ToolDecisionActor;
}

export interface InteractionRejectInput {
  actor?: ToolDecisionActor;
  error?: string;
}

export interface InteractionResultResponse {
  interaction: InteractionRecord;
  result?: InteractionResult;
}

export type InteractionSocketEvent = {
  type: "interaction";
  action: "created" | "updated" | "duplicate" | "resolved" | "rejected" | "expired";
  interaction: InteractionRecord;
};
