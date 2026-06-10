import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Eye, Paperclip, Send, Square, X } from "lucide-react";
import type { ChatMessage, ChatSessionMode, ChatSocketServerEvent, ClientIdentity, UploadedFileRef } from "@detaches/shared";
import { TerminalPanel, type TerminalPanelHandle } from "../terminal/TerminalPanel.js";

interface Props {
  sessionKey: string | null;
  sessionMode: ChatSessionMode;
  clientIdentity: ClientIdentity | null;
  attachments: UploadedFileRef[];
  onSessionModeChange: (mode: ChatSessionMode) => void;
  onClearAttachments: () => void;
  onNeedUpload: (files: FileList) => void;
}

export function ChatPanel({
  sessionKey,
  sessionMode,
  clientIdentity,
  attachments,
  onSessionModeChange,
  onClearAttachments,
  onNeedUpload
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [socketState, setSocketState] = useState("idle");
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalPanelHandle | null>(null);

  useEffect(() => {
    setMessages([]);
    setLastRunId(null);
    socketRef.current?.close();
    if (!sessionKey) {
      setSocketState("idle");
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ sessionMode });
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/chat/${encodeURIComponent(sessionKey)}?${params}`);
    socketRef.current = ws;
    setSocketState("connecting");
    ws.onopen = () => setSocketState("connected");
    ws.onclose = () => setSocketState("closed");
    ws.onerror = () => setSocketState("error");
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ChatSocketServerEvent;
      if (data.type === "history") {
        setMessages(data.payload.messages);
      } else if (data.type === "chat") {
        if (isPayloadForSession(data.payload, sessionKey)) {
          setMessages((current) => upsertGatewayChat(current, data.payload));
        }
      } else if (data.type === "sent") {
        setLastRunId(data.payload.runId ?? null);
      } else if (data.type === "error") {
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: "system", text: data.message, timestamp: new Date().toISOString() }
        ]);
      }
    };
    return () => ws.close();
  }, [sessionKey, sessionMode]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const canSend = useMemo(() => Boolean(sessionKey && draft.trim() && socketRef.current?.readyState === WebSocket.OPEN), [sessionKey, draft, socketState]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    const text = draft.trim();
    socketRef.current?.send(JSON.stringify({
      type: "send",
      message: text,
      attachments,
      idempotencyKey: crypto.randomUUID()
    }));
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        text,
        timestamp: new Date().toISOString(),
        attachments: attachments.map((file) => ({ name: file.name, remotePath: file.remotePath, size: file.size, mimeType: file.mimeType }))
      }
    ]);
    setDraft("");
    onClearAttachments();
  }

  function abort() {
    if (!lastRunId) return;
    socketRef.current?.send(JSON.stringify({ type: "abort", runId: lastRunId }));
  }

  async function copyMessage(message: ChatMessage) {
    await navigator.clipboard.writeText(messageText(message));
  }

  function approveTerminalCommand(command: string) {
    const ok = terminalRef.current?.runCommand(command) ?? false;
    terminalRef.current?.reveal();
    if (!ok) {
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "system", text: "Terminal is not connected yet. Open Agent Terminal and try again.", timestamp: new Date().toISOString() }
      ]);
    }
  }

  return (
    <main className="chat-panel">
      <div className="chat-header">
        <div>
          <h1>{sessionKey ? sessionKey : "选择一个 Agent"}</h1>
          <p>
            Socket: {socketState}
            {clientIdentity ? ` · 设备: ${clientIdentity.deviceIdShort}` : ""}
          </p>
        </div>
        <div className="chat-actions">
          <div className="mode-toggle" aria-label="Session mode">
            <button
              type="button"
              className={sessionMode === "device" ? "active" : ""}
              onClick={() => onSessionModeChange("device")}
            >
              本机会话
            </button>
            <button
              type="button"
              className={sessionMode === "main" ? "active" : ""}
              onClick={() => onSessionModeChange("main")}
            >
              主会话
            </button>
          </div>
          <button className="icon-button" disabled={!lastRunId} onClick={abort} title="Stop generation">
            <Square size={16} />
          </button>
        </div>
      </div>
      <div className="messages" ref={messagesRef}>
        {messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <div className="message-meta">
              <span>{message.role}</span>
              <button type="button" className="copy-button" onClick={() => void copyMessage(message)} title="Copy message">
                <Copy size={14} />
              </button>
            </div>
            <p>{messageText(message)}</p>
            <TerminalCommandRequests text={messageText(message)} onApprove={approveTerminalCommand} onReveal={() => terminalRef.current?.reveal()} />
            {message.attachments?.map((attachment) => (
              <small className="attachment-chip" key={`${message.id}-${attachment.name}`}>{attachment.name}</small>
            ))}
          </article>
        ))}
        {!sessionKey ? <div className="empty-state large">左侧选择一个远端 Agent 后开始聊天。</div> : null}
      </div>
      <TerminalPanel ref={terminalRef} sessionKey={sessionKey} />
      <form className="composer" onSubmit={submit}>
        {attachments.length ? (
          <div className="attachment-strip">
            {attachments.map((file) => <span key={file.id}>{file.name}</span>)}
          </div>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(event) => event.target.files && onNeedUpload(event.target.files)}
        />
        <button type="button" className="icon-button" title="Attach files" onClick={() => fileRef.current?.click()} disabled={!sessionKey}>
          <Paperclip size={18} />
        </button>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="发送消息给远端 OpenClaw..." />
        <button className="send-button" disabled={!canSend}>
          <Send size={18} />
          Send
        </button>
      </form>
    </main>
  );
}

interface TerminalCommandRequest {
  command: string;
  reason?: string;
}

function TerminalCommandRequests({
  text,
  onApprove,
  onReveal
}: {
  text: string;
  onApprove: (command: string) => void;
  onReveal: () => void;
}) {
  const requests = parseTerminalCommandRequests(text);
  const [handled, setHandled] = useState<Record<number, "approved" | "rejected">>({});
  useEffect(() => setHandled({}), [text]);
  if (!requests.length) return null;

  return (
    <div className="terminal-requests">
      {requests.map((request, index) => {
        const state = handled[index];
        return (
          <div className="terminal-request-card" key={`${index}-${request.command}`}>
            <div>
              <strong>Terminal command request</strong>
              {request.reason ? <p>{request.reason}</p> : null}
              <code>{request.command}</code>
            </div>
            <div className="terminal-request-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(state)}
                onClick={() => {
                  onApprove(request.command);
                  setHandled((current) => ({ ...current, [index]: "approved" }));
                }}
              >
                <Check size={15} />
                {state === "approved" ? "Approved" : "Run"}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(state)}
                onClick={() => setHandled((current) => ({ ...current, [index]: "rejected" }))}
              >
                <X size={15} />
                {state === "rejected" ? "Rejected" : "Reject"}
              </button>
              <button type="button" className="icon-button" title="Show terminal" onClick={onReveal}>
                <Eye size={15} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function parseTerminalCommandRequests(text: string): TerminalCommandRequest[] {
  const requests: TerminalCommandRequest[] = [];
  const fencePattern = /```(?:detaches-terminal|terminal-command|terminal-run|shell-run)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text))) {
    const body = match[1].trim();
    const parsed = parseTerminalCommandBody(body);
    if (parsed) requests.push(parsed);
  }
  return requests;
}

function parseTerminalCommandBody(body: string): TerminalCommandRequest | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { command?: unknown; cmd?: unknown; reason?: unknown };
    const command = typeof parsed.command === "string" ? parsed.command : typeof parsed.cmd === "string" ? parsed.cmd : "";
    if (command.trim()) {
      return {
        command: command.trim(),
        reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined
      };
    }
  } catch {
    // Plain shell command block.
  }
  const lines = body.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const command = lines.join("\n").trim();
  return command ? { command } : null;
}

function upsertGatewayChat(current: ChatMessage[], payload: unknown): ChatMessage[] {
  const anyPayload = payload as any;
  const text = textFromGatewayPayload(anyPayload);
  if (!text) return current;
  const role = roleFromGatewayPayload(anyPayload);
  const identity = streamIdentity(anyPayload);
  const updatedAt = new Date().toISOString();
  const existingIndex = findExistingStreamMessage(current, identity, role);
  const nextMessage: ChatMessage = {
    id: identity ?? crypto.randomUUID(),
    role,
    text,
    timestamp: updatedAt,
    raw: payload
  };
  if (existingIndex < 0) return [...current, nextMessage];
  return current.map((message, index) => {
    if (index !== existingIndex) return message;
    return {
      ...message,
      text: mergeStreamText(message.text, text, anyPayload),
      timestamp: updatedAt,
      raw: payload
    };
  });
}

function findExistingStreamMessage(messages: ChatMessage[], identity: string | null, role: string): number {
  if (identity) {
    const byIdentity = messages.findIndex((message) => message.id === identity);
    if (byIdentity >= 0) return byIdentity;
  }
  if (role !== "assistant") return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return -1;
    if (message.role === "assistant") return index;
  }
  return -1;
}

function mergeStreamText(previous: string, incoming: string, payload: Record<string, unknown>): string {
  if (!previous) return incoming;
  if (incoming === previous) return previous;
  if (incoming.startsWith(previous)) return incoming;
  const eventType = String(payload.type ?? payload.event ?? payload.kind ?? "");
  if (eventType.includes("delta") || typeof payload.delta === "string") return `${previous}${incoming}`;
  return incoming.length >= previous.length ? incoming : `${previous}${incoming}`;
}

function streamIdentity(payload: Record<string, unknown>): string | null {
  for (const key of ["messageId", "message_id", "runId", "run_id", "responseId", "response_id", "id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const message = payload.message as Record<string, unknown> | undefined;
  if (message) return streamIdentity(message);
  return null;
}

function roleFromGatewayPayload(payload: Record<string, unknown>): string {
  const message = payload.message as Record<string, unknown> | undefined;
  return String(payload.role ?? message?.role ?? "assistant");
}

function textFromGatewayPayload(payload: Record<string, unknown>): string {
  const message = payload.message as Record<string, unknown> | undefined;
  return textFromUnknown(
    payload.text ??
    payload.messageText ??
    payload.delta ??
    payload.content ??
    message?.text ??
    message?.content ??
    payload
  );
}

function isPayloadForSession(payload: unknown, sessionKey: string | null): boolean {
  if (!sessionKey) return false;
  const keys = new Set<string>();
  collectSessionKeys(payload, keys);
  if (keys.size === 0) return true;
  return keys.has(sessionKey);
}

function collectSessionKeys(value: unknown, keys: Set<string>, depth = 0): void {
  if (!value || depth > 4) return;
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item) => collectSessionKeys(item, keys, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionKey", "session", "conversationId", "threadId"]) {
    const found = record[key];
    if (typeof found === "string" && found.startsWith("agent:")) keys.add(found);
  }
  for (const key of ["payload", "message", "data", "event", "delta", "item"]) {
    collectSessionKeys(record[key], keys, depth + 1);
  }
}

function messageText(message: ChatMessage): string {
  return textFromUnknown((message as any).text ?? (message as any).content ?? message.raw);
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return renderFallback(item);
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const anyValue = value as any;
    if (typeof anyValue.text === "string") return anyValue.text;
    if (typeof anyValue.message === "string") return anyValue.message;
    if (typeof anyValue.delta === "string") return anyValue.delta;
    if (typeof anyValue.content === "string") return anyValue.content;
  }
  return renderFallback(value);
}

function renderFallback(raw: unknown): string {
  if (!raw) return "";
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}
