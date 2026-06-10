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
}

export interface ChatSendResponse {
  runId?: string;
  raw?: unknown;
}

export type ChatSocketServerEvent =
  | { type: "ready"; sessionKey: string }
  | { type: "history"; payload: ChatHistoryResponse }
  | { type: "chat"; payload: unknown }
  | { type: "agent"; payload: unknown }
  | { type: "health"; ok: boolean; payload?: unknown }
  | { type: "sent"; payload: ChatSendResponse }
  | { type: "error"; message: string; details?: unknown };

export type ChatSocketClientEvent =
  | { type: "send"; message: string; thinking?: string; attachments?: UploadedFileRef[]; attachmentContextOverride?: string; idempotencyKey?: string }
  | { type: "history" }
  | { type: "abort"; runId: string };
