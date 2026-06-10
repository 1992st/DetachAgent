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

export function mapHistory(sessionKey: string, raw: unknown): ChatHistoryResponse {
  const rawMessages =
    Array.isArray((raw as any)?.messages) ? (raw as any).messages :
    Array.isArray((raw as any)?.items) ? (raw as any).items :
    [];
  const messages: ChatMessage[] = rawMessages.map((msg: any) => ({
    id: String(msg.id ?? nanoid()),
    role: String(msg.role ?? "assistant"),
    text: extractText(msg.content ?? msg.text ?? msg.message),
    timestamp: new Date(Number(msg.timestamp ?? msg.ts ?? Date.now())).toISOString(),
    raw: msg
  }));
  return { sessionKey: String((raw as any)?.sessionKey ?? sessionKey), messages, raw };
}
