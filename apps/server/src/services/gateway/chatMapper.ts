import { nanoid } from "nanoid";
import type { ChatHistoryResponse, ChatMessage } from "@detaches/shared";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const anyContent = content as any;
    if (typeof anyContent.text === "string") return anyContent.text;
    if (typeof anyContent.content === "string") return anyContent.content;
  }
  return "";
}

function extractRunId(value: unknown, depth = 0): string | undefined {
  if (!value || depth > 4 || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.runId ?? record.run_id;
  if (typeof direct === "string" && direct.trim()) return direct;

  const run = record.run;
  if (run && typeof run === "object") {
    const runRecord = run as Record<string, unknown>;
    if (typeof runRecord.id === "string" && runRecord.id.trim()) return runRecord.id;
  }

  for (const key of ["payload", "message", "event", "data", "meta", "metadata"]) {
    const found = extractRunId(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function mapHistory(sessionKey: string, raw: unknown): ChatHistoryResponse {
  const rawMessages =
    Array.isArray((raw as any)?.messages) ? (raw as any).messages :
    Array.isArray((raw as any)?.items) ? (raw as any).items :
    [];
  const messages: ChatMessage[] = rawMessages.map((msg: any) => ({
    id: String(msg.id ?? nanoid()),
    runId: extractRunId(msg),
    role: String(msg.role ?? "assistant"),
    text: extractText(msg.content ?? msg.text ?? msg.message),
    timestamp: new Date(Number(msg.timestamp ?? msg.ts ?? Date.now())).toISOString(),
    raw: msg
  }));
  return { sessionKey: String((raw as any)?.sessionKey ?? sessionKey), messages, raw };
}
