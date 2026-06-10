import { nanoid } from "nanoid";
import type { ChatSessionMode, UploadedFileRef } from "@detaches/shared";

interface ContextExportRecord {
  token: string;
  sessionKey: string;
  sessionMode: ChatSessionMode;
  attachments: UploadedFileRef[];
  expiresAtMs: number;
}

const exportsByToken = new Map<string, ContextExportRecord>();

function cleanupExpired(now = Date.now()): void {
  for (const [token, record] of exportsByToken.entries()) {
    if (record.expiresAtMs <= now) exportsByToken.delete(token);
  }
}

export const contextExportService = {
  create(input: { sessionKey: string; sessionMode: ChatSessionMode; attachments?: UploadedFileRef[]; ttlMs?: number }): ContextExportRecord {
    cleanupExpired();
    const sessionKey = input.sessionKey.trim();
    if (!sessionKey) throw new Error("sessionKey is required.");
    const ttlMs = Math.min(Math.max(input.ttlMs ?? 5 * 60 * 1000, 30 * 1000), 10 * 60 * 1000);
    const token = nanoid(40);
    const record: ContextExportRecord = {
      token,
      sessionKey,
      sessionMode: input.sessionMode,
      attachments: input.attachments?.map((attachment) => ({ ...attachment })) ?? [],
      expiresAtMs: Date.now() + ttlMs
    };
    exportsByToken.set(token, record);
    return record;
  },

  consume(token: string): ContextExportRecord | null {
    cleanupExpired();
    const normalized = token.trim();
    const record = exportsByToken.get(normalized);
    if (!record) return null;
    exportsByToken.delete(normalized);
    if (record.expiresAtMs <= Date.now()) return null;
    return record;
  }
};
