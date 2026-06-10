import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Eye, FileText, Paperclip, Send, Square, X } from "lucide-react";
import type { ChatMessage, ChatSessionMode, ChatSocketServerEvent, ClientIdentity, UploadedFileRef } from "@detaches/shared";
import { prepareFileTransfer } from "../../lib/api.js";
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
  const [attachmentContext, setAttachmentContext] = useState("");
  const [attachmentContextOpen, setAttachmentContextOpen] = useState(false);
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

  useEffect(() => {
    const nextContext = buildDefaultAttachmentContext(attachments);
    setAttachmentContext(nextContext);
    setAttachmentContextOpen(Boolean(nextContext));
  }, [attachments]);

  const canSend = useMemo(() => Boolean(sessionKey && draft.trim() && socketRef.current?.readyState === WebSocket.OPEN), [sessionKey, draft, socketState]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    const text = draft.trim();
    socketRef.current?.send(JSON.stringify({
      type: "send",
      message: text,
      attachments,
      attachmentContextOverride: attachments.length ? attachmentContext : undefined,
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

  async function prepareAndRunFileTransfer(request: FileTransferRequest) {
    const response = await prepareFileTransfer(request.fileId, request.remotePath);
    const ok = terminalRef.current?.runCommand(response.command) ?? false;
    terminalRef.current?.reveal();
    if (!ok) {
      throw new Error("Terminal is not connected yet. Open Agent Terminal and try again.");
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
            <FileTransferRequests text={messageText(message)} onPrepareTransfer={prepareAndRunFileTransfer} onReveal={() => terminalRef.current?.reveal()} />
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
          <div className="attachment-context-panel">
            <div className="attachment-strip">
              {attachments.map((file) => (
                <span key={file.id} title={file.localPath ? `Local staging: ${file.localPath}` : "Local staging file"}>
                  {file.name}
                </span>
              ))}
              <button
                type="button"
                className="secondary-button compact"
                onClick={() => setAttachmentContextOpen((current) => !current)}
              >
                <FileText size={15} />
                {attachmentContextOpen ? "隐藏上下文" : "编辑上下文"}
              </button>
            </div>
            {attachmentContextOpen ? (
              <label className="attachment-context-editor">
                <span>本次发送嵌入上下文</span>
                <textarea
                  value={attachmentContext}
                  onChange={(event) => setAttachmentContext(event.target.value)}
                  placeholder="描述这些文件的作用，以及远端 agent 应该如何读取和处理。"
                />
              </label>
            ) : null}
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

interface FileTransferRequest {
  fileId: string;
  remotePath: string;
  reason?: string;
}

function FileTransferRequests({
  text,
  onPrepareTransfer,
  onReveal
}: {
  text: string;
  onPrepareTransfer: (request: FileTransferRequest) => Promise<void>;
  onReveal: () => void;
}) {
  const requests = parseFileTransferRequests(text);
  const [handled, setHandled] = useState<Record<number, "approved" | "rejected" | "running" | "error">>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  useEffect(() => {
    setHandled({});
    setErrors({});
  }, [text]);
  if (!requests.length) return null;

  return (
    <div className="terminal-requests">
      {requests.map((request, index) => {
        const state = handled[index];
        return (
          <div className="terminal-request-card file-transfer-card" key={`${index}-${request.fileId}-${request.remotePath}`}>
            <div>
              <strong>File transfer request</strong>
              {request.reason ? <p>{request.reason}</p> : null}
              <code>{`fileId: ${request.fileId}\nremotePath: ${request.remotePath}`}</code>
              {errors[index] ? <p className="request-error">{errors[index]}</p> : null}
            </div>
            <div className="terminal-request-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(state && state !== "error")}
                onClick={() => {
                  setHandled((current) => ({ ...current, [index]: "running" }));
                  onPrepareTransfer(request)
                    .then(() => setHandled((current) => ({ ...current, [index]: "approved" })))
                    .catch((error) => {
                      setErrors((current) => ({ ...current, [index]: error instanceof Error ? error.message : String(error) }));
                      setHandled((current) => ({ ...current, [index]: "error" }));
                    });
                }}
              >
                <Check size={15} />
                {state === "approved" ? "Started" : state === "running" ? "Starting" : "Transfer"}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(state && state !== "error")}
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

function parseFileTransferRequests(text: string): FileTransferRequest[] {
  const requests: FileTransferRequest[] = [];
  const fencePattern = /```(?:detaches-file-transfer|file-transfer)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text))) {
    const body = match[1].trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as { fileId?: unknown; remotePath?: unknown; target?: { remotePath?: unknown }; reason?: unknown };
      const fileId = typeof parsed.fileId === "string" ? parsed.fileId.trim() : "";
      const remotePath = typeof parsed.remotePath === "string"
        ? parsed.remotePath.trim()
        : typeof parsed.target?.remotePath === "string"
          ? parsed.target.remotePath.trim()
          : "";
      if (fileId && remotePath) {
        requests.push({
          fileId,
          remotePath,
          reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined
        });
      }
    } catch {
      // Ignore malformed requests; the agent can resend a valid JSON block.
    }
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

function buildDefaultAttachmentContext(attachments: UploadedFileRef[]): string {
  if (!attachments.length) return "";
  return [
    "[detaches_agent 文件上下文]",
    `本次消息附带 ${attachments.length} 个文件。`,
    "",
    ...attachments.flatMap((file, index) => [
      `${index + 1}. ${file.name}`,
      `   fileId: ${file.id}`,
      `   mimeType: ${file.mimeType || "application/octet-stream"}`,
      `   size: ${formatFileSize(file.size)}`,
      `   localPath: ${file.localPath || "not exposed"}`,
      "   currentLocation: 用户本机 detaches_agent staging 区",
      "   remotePath: not uploaded",
      "   role: 主输入/待确认",
      ""
    ]),
    "这些文件目前只在用户本机，尚未自动上传到远端。",
    "如果你需要读取或处理文件，请先决定远端目标文件路径，然后向 UI 发起 detaches-file-transfer 待审批请求。",
    "请求格式必须是唯一一个 fenced code block：",
    "```detaches-file-transfer",
    "{\"fileId\":\"上面的文件 id\",\"remotePath\":\"/absolute/or/relative/target-file\",\"reason\":\"说明为什么需要传输\"}",
    "```",
    "用户批准后，detaches_agent 会生成一次性下载链接并在本会话 terminal 中执行 curl，把文件传到你指定的 remotePath。",
    "用户批准前不要假装已经读取文件；如果传输失败，请根据 terminal 输出继续处理。"
  ].join("\n").trimEnd();
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "unknown";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
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
