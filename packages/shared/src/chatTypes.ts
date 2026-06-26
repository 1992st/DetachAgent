import type { UploadedFileRef } from "./fileTypes.js";

export interface ChatAttachmentPayload {
  id?: string;
  name: string;
  mimeType?: string;
  size?: number;
  remotePath?: string;
  url?: string;
}

export interface ChatMessage {
  id: string;
  runId?: string;
  role: "user" | "assistant" | "system" | "tool" | string;
  text: string;
  timestamp: string;
  attachments?: ChatAttachmentPayload[];
  raw?: unknown;
}

export interface ChatHistoryResponse {
  sessionKey: string;
  messages: ChatMessage[];
  raw?: unknown;
}

export interface ChatSendRequest {
  message: string;
  thinking?: string;
  attachments?: UploadedFileRef[];
  attachmentContextOverride?: string;
  includeLocalControlContext?: boolean;
  includeStagedFileContext?: boolean;
  activationReason?: LocalControlActivationReason;
}

export interface ChatSendResponse {
  runId?: string;
  raw?: unknown;
}

export type RelationshipSkillStatus = "unknown" | "checking" | "ready" | "missing" | "outdated" | "error";
export type LocalControlActivationReason = "user-click" | "new-session-inherited" | "file-transfer";

export type ChatSocketServerEvent =
  | { type: "ready"; sessionKey: string }
  | { type: "history"; payload: ChatHistoryResponse }
  | { type: "chat"; payload: unknown }
  | { type: "agent"; payload: unknown }
  | { type: "health"; ok: boolean; payload?: unknown }
  | { type: "sent"; payload: ChatSendResponse }
  | {
      type: "relationship-skill-status";
      status: RelationshipSkillStatus;
      message?: string;
      installedVersion?: string;
      requiredVersion?: string;
      raw?: unknown;
    }
  | { type: "error"; message: string; details?: unknown };

export type ChatSocketClientEvent =
  | {
      type: "send";
      message: string;
      thinking?: string;
      attachments?: UploadedFileRef[];
      attachmentContextOverride?: string;
      includeLocalControlContext?: boolean;
      includeStagedFileContext?: boolean;
      activationReason?: LocalControlActivationReason;
      localControlScope?: string;
      idempotencyKey?: string;
    }
  | { type: "bootstrap-relationship-skill-check"; idempotencyKey?: string }
  | { type: "history" }
  | { type: "abort"; runId: string };
