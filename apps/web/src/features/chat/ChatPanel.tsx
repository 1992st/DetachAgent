import { type CSSProperties, FormEvent, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Check, Copy, Eye, FileText, List, Minus, Paperclip, Plus, Send, Square, X } from "lucide-react";
import type { ChatMessage, ChatSessionMode, ChatSocketServerEvent, ClientIdentity, ToolExecutionResultResponse, ToolRequestRecord, ToolTarget, UploadedFileRef } from "@detaches/shared";
import { approveToolRequest, extractToolRequests, fetchToolRequestResult, fetchToolRequests, rejectToolRequest, retryToolResultForward } from "../../lib/api.js";
import { TerminalPanel, type TerminalPanelHandle } from "../terminal/TerminalPanel.js";

interface Props {
  sessionKey: string | null;
  agentId: string | null;
  sessionMode: ChatSessionMode;
  clientIdentity: ClientIdentity | null;
  attachments: UploadedFileRef[];
  onSessionModeChange: (mode: ChatSessionMode) => void;
  onClearAttachments: () => void;
  onNeedUpload: (files: FileList) => void;
}

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  id: string;
  at: string;
  level: LogLevel;
  event: string;
  detail?: unknown;
}

export interface ChatPanelHandle {
  revealTerminal: () => void;
}

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel({
  sessionKey,
  agentId,
  sessionMode,
  clientIdentity,
  attachments,
  onSessionModeChange,
  onClearAttachments,
  onNeedUpload
}: Props, ref) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [socketState, setSocketState] = useState("idle");
  const [socketReconnectNonce, setSocketReconnectNonce] = useState(0);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [attachmentContext, setAttachmentContext] = useState("");
  const [attachmentContextOpen, setAttachmentContextOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [chatFontSize, setChatFontSize] = useState(() => {
    const saved = Number(window.localStorage.getItem("detaches.chatFontSize"));
    return Number.isFinite(saved) && saved >= 12 && saved <= 20 ? saved : 14;
  });
  const socketRef = useRef<WebSocket | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalPanelHandle | null>(null);
  const logStreamRef = useRef<HTMLDivElement | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    revealTerminal: () => terminalRef.current?.reveal()
  }), []);

  useEffect(() => {
    let disposed = false;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setMessages([]);
    setLastRunId(null);
    socketRef.current?.close();
    if (!sessionKey) {
      setSocketState("idle");
      appendLog("info", "session-idle", { sessionKey });
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ sessionMode });
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/chat/${encodeURIComponent(sessionKey)}?${params}`);
    socketRef.current = ws;
    setSocketState("connecting");
    appendLog("info", "socket-connecting", { sessionKey, sessionMode });
    ws.onopen = () => {
      setSocketState("connected");
      appendLog("info", "socket-connected", { sessionKey, sessionMode });
    };
    ws.onclose = (event) => {
      setSocketState("closed");
      appendLog("warn", "socket-closed", { code: event.code, reason: event.reason, wasClean: event.wasClean });
      if (!disposed && sessionKey) {
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          setSocketReconnectNonce((current) => current + 1);
        }, 1500);
      }
    };
    ws.onerror = () => {
      setSocketState("error");
      appendLog("error", "socket-error", { sessionKey, sessionMode });
      ws.close();
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ChatSocketServerEvent;
      appendLog("debug", "socket-message", { type: data.type });
      if (data.type === "history") {
        setMessages(data.payload.messages);
        appendLog("info", "history-loaded", { count: data.payload.messages.length });
      } else if (data.type === "chat") {
        if (isPayloadForSession(data.payload, sessionKey)) {
          setMessages((current) => upsertGatewayChat(current, data.payload));
          appendLog("debug", "chat-upserted", { sessionKey });
        }
      } else if (data.type === "sent") {
        setLastRunId(data.payload.runId ?? null);
        appendLog("info", "message-sent-ack", data.payload);
      } else if (data.type === "error") {
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: "system", text: data.message, timestamp: new Date().toISOString() }
        ]);
        appendLog("error", "server-error", { message: data.message });
      }
    };
    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      appendLog("debug", "socket-cleanup", { sessionKey, sessionMode });
      ws.close();
    };
  }, [sessionKey, sessionMode, socketReconnectNonce]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const nextContext = buildDefaultAttachmentContext(attachments);
    setAttachmentContext(nextContext);
    if (!nextContext) setAttachmentContextOpen(false);
    if (attachments.length) appendLog("info", "attachments-ready", attachments.map((file) => ({ id: file.id, name: file.name, size: file.size })));
  }, [attachments]);

  useEffect(() => {
    const el = logStreamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, logOpen]);

  const canSend = useMemo(() => Boolean(sessionKey && draft.trim() && socketRef.current?.readyState === WebSocket.OPEN), [sessionKey, draft, socketState]);
  const messagesStyle = useMemo(() => ({
    "--chat-message-font-size": `${chatFontSize}px`
  }) as CSSProperties, [chatFontSize]);

  function updateChatFontSize(next: number) {
    const clamped = Math.max(12, Math.min(20, next));
    setChatFontSize(clamped);
    window.localStorage.setItem("detaches.chatFontSize", String(clamped));
    appendLog("debug", "chat-font-size", { size: clamped });
  }

  function appendLog(level: LogLevel, event: string, detail?: unknown) {
    setLogs((current) => {
      const next = [
        ...current,
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          level,
          event,
          detail
        }
      ];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    const text = draft.trim();
    const idempotencyKey = crypto.randomUUID();
    appendLog("info", "chat-send", {
      sessionKey,
      sessionMode,
      idempotencyKey,
      messageLength: text.length,
      attachmentCount: attachments.length
    });
    socketRef.current?.send(JSON.stringify({
      type: "send",
      message: text,
      attachments,
      attachmentContextOverride: attachments.length ? attachmentContext : undefined,
      idempotencyKey
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
    appendLog("warn", "abort-run", { runId: lastRunId });
    socketRef.current?.send(JSON.stringify({ type: "abort", runId: lastRunId }));
  }

  async function copyMessage(message: ChatMessage) {
    await navigator.clipboard.writeText(messageText(message));
    appendLog("debug", "message-copied", { id: message.id, role: message.role });
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
          <div className="font-size-control" aria-label="Chat font size">
            <button type="button" className="icon-button small" title="减小聊天字体" onClick={() => updateChatFontSize(chatFontSize - 1)} disabled={chatFontSize <= 12}>
              <Minus size={14} />
            </button>
            <span>{chatFontSize}px</span>
            <button type="button" className="icon-button small" title="放大聊天字体" onClick={() => updateChatFontSize(chatFontSize + 1)} disabled={chatFontSize >= 20}>
              <Plus size={14} />
            </button>
          </div>
          <button className="icon-button" onClick={() => setLogOpen(true)} title="查看实时 Log">
            <List size={16} />
          </button>
          <button className="icon-button" disabled={!lastRunId} onClick={abort} title="Stop generation">
            <Square size={16} />
          </button>
        </div>
      </div>
      {logOpen ? (
        <section className="log-console" aria-label="实时 Log 控制台">
          <div className="log-console-header">
            <div>
              <strong>实时 Log</strong>
              <small>{logs.length} 条记录</small>
            </div>
            <div className="log-console-actions">
              <button type="button" className="secondary-button compact" onClick={() => setLogs([])}>清空</button>
              <button type="button" className="icon-button small" title="关闭 Log" onClick={() => setLogOpen(false)}>
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="log-console-stream" ref={logStreamRef}>
            {logs.length ? logs.map((entry) => (
              <div className={`log-console-row ${entry.level}`} key={entry.id}>
                <span>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                <strong>{entry.event}</strong>
                {entry.detail === undefined ? null : <code>{formatLogDetail(entry.detail)}</code>}
              </div>
            )) : <p>暂无日志。发送消息、接收响应、上传附件或处理工具请求后会实时出现。</p>}
          </div>
        </section>
      ) : null}
      <div className="messages" ref={messagesRef} style={messagesStyle}>
        {messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <div className="message-meta">
              <span>{message.role}</span>
              <button type="button" className="copy-button" onClick={() => void copyMessage(message)} title="Copy message">
                <Copy size={14} />
              </button>
            </div>
            <p>{messageText(message)}</p>
            <ToolRequests
              text={messageText(message)}
              sessionKey={sessionKey}
              agentId={agentId}
              sourceMessageId={message.id}
              sourceRunId={message.runId}
              clientIdentity={clientIdentity}
              onReveal={() => terminalRef.current?.reveal()}
              onLog={appendLog}
            />
            {message.attachments?.map((attachment) => (
              <small className="attachment-chip" key={`${message.id}-${attachment.name}`}>{attachment.name}</small>
            ))}
          </article>
        ))}
        {!sessionKey ? <div className="empty-state large">左侧选择一个远端 Agent 后开始聊天。</div> : null}
      </div>
      <TerminalPanel
        ref={terminalRef}
        sessionKey={sessionKey}
        title="Agent Control Terminal"
        emptyText="这个终端用于观察 Cloud Agent 在本机执行的审批后操作。"
      />
      <form className="composer" onSubmit={submit}>
        {attachments.length ? (
          <div className="attachment-context-panel">
            <div className="attachment-tray">
              <div className="attachment-list">
                {attachments.map((file) => (
                  <div className="attachment-card" key={file.id} title={file.localPath ? `Local staging: ${file.localPath}` : "Local staging file"}>
                    <FileText size={15} />
                    <div>
                      <strong>{displayFileName(file)}</strong>
                      <small>{formatFileSize(file.size)} · 本机暂存</small>
                    </div>
                  </div>
                ))}
              </div>
              <div className="attachment-actions">
                <button
                  type="button"
                  className="secondary-button compact"
                  onClick={() => setAttachmentContextOpen((current) => !current)}
                >
                  <FileText size={15} />
                  {attachmentContextOpen ? "隐藏上下文" : "编辑上下文"}
                </button>
                <button type="button" className="icon-button small" title="Clear attachments" onClick={onClearAttachments}>
                  <X size={15} />
                </button>
              </div>
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
});

const targetLabels: Record<ToolTarget, string> = {
  "local-user-machine": "用户本机",
  "remote-agent-host": "远端 Agent 机器",
  "gateway-managed": "Gateway 托管",
  "main-agent-machine": "Main Agent 机器"
};

function toolRequestSupported(request: ToolRequestRecord): boolean {
  if (request.kind === "adapter-install") return request.target === "remote-agent-host";
  if (request.kind === "main-agent-save-file") return request.target === "main-agent-machine";
  if (request.kind === "file-transfer") return request.target === "local-user-machine" || request.target === "remote-agent-host";
  if (request.kind === "terminal") return request.target === "local-user-machine";
  return false;
}

function unsupportedTargetMessage(request: ToolRequestRecord): string {
  if (request.target === "remote-agent-host") {
    return `${toolRequestTitle(request)} 当前不支持直接在远端执行，不能退化到用户本机执行。`;
  }
  return `${targetLabels[request.target]} 当前还没有执行 adapter，不能把请求退化到用户本机执行。`;
}

function ToolRequests({
  text,
  sessionKey,
  agentId,
  sourceMessageId,
  sourceRunId,
  clientIdentity,
  onReveal,
  onLog
}: {
  text: string;
  sessionKey: string | null;
  agentId: string | null;
  sourceMessageId: string;
  sourceRunId?: string;
  clientIdentity: ClientIdentity | null;
  onReveal: () => void;
  onLog: (level: LogLevel, event: string, detail?: unknown) => void;
}) {
  const [requests, setRequests] = useState<ToolRequestRecord[]>([]);
  const [handled, setHandled] = useState<Record<number, "approved" | "rejected" | "running" | "error" | "blocked">>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [resultSummaries, setResultSummaries] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!sessionKey || !text) {
      setRequests([]);
      return;
    }
    setHandled({});
    setErrors({});
    setResultSummaries({});
    setRequests([]);
    const loadRequests = () => extractToolRequests({ text, sessionKey, agentId, sourceMessageId, sourceRunId })
      .then((response) => {
        const visibleRequests = keepLastFileTransferPerFile(response.requests).filter(isInlineToolRequestVisible);
        const extractedIds = new Set(visibleRequests.map((request) => request.id));
        return fetchToolRequests({ sessionKey, agentId, limit: 100 })
          .then((listed) => mergeToolRequests(visibleRequests, listed.requests.filter((request) => extractedIds.has(request.id))))
          .catch(() => visibleRequests);
      })
      .then((mergedRequests) => {
        setRequests(mergedRequests);
        if (mergedRequests.length) onLog("info", "tool-requests-detected", mergedRequests.map((request) => ({
          id: request.id,
          kind: request.kind,
          target: request.target,
          status: request.status
        })));
        const nextHandled: Record<number, "blocked"> = {};
        const nextErrors: Record<number, string> = {};
        mergedRequests.forEach((request, index) => {
          if (request.status === "blocked") {
            nextHandled[index] = "blocked";
            nextErrors[index] = request.error || "Tool request is blocked.";
          }
        });
        setHandled(nextHandled);
        setErrors(nextErrors);
      })
      .catch((error) => {
        onLog("error", "tool-requests-load-failed", error);
        setErrors({ 0: error instanceof Error ? error.message : String(error) });
      });
    void loadRequests();
  }, [text, sessionKey, agentId, sourceMessageId, sourceRunId]);
  if (!requests.length && !errors[0]) return null;

  return (
    <div className="terminal-requests">
      {errors[0] && !requests.length ? <p className="request-error">{errors[0]}</p> : null}
      {requests.map((request, index) => {
        const state = handled[index];
        const unsupported = !toolRequestSupported(request);
        const actionLabel = request.kind === "main-agent-save-file" ? "Save" : request.kind === "file-transfer" ? "Transfer" : request.kind === "adapter-install" ? "Install" : "Run";
        return (
          <div className={`terminal-request-card ${request.kind === "file-transfer" ? "file-transfer-card" : ""}`} key={request.id}>
            <div>
              <strong>{toolRequestTitle(request)} request</strong>
              <p className={`target-pill ${request.target}`}>Target: {targetLabels[request.target]}</p>
              {request.risk ? <p className={`risk-pill ${request.risk.level}`}>Risk: {request.risk.level}{request.risk.reasons.length ? ` · ${request.risk.reasons.join("; ")}` : ""}</p> : null}
              {request.reason ? <p>{request.reason}</p> : null}
              <code>{toolRequestCode(request)}</code>
              <small>requestId: {request.id}</small>
              {unsupported ? <p className="request-error">{unsupportedTargetMessage(request)}</p> : null}
              {errors[index] ? <p className="request-error">{errors[index]}</p> : null}
              {resultSummaries[index] ? <small>{resultSummaries[index]}</small> : null}
            </div>
            <div className="terminal-request-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={unsupported || Boolean(state && state !== "error")}
                onClick={() => {
                  if (!confirmElevatedRisk(request)) return;
                  onLog("info", "tool-request-approve", { id: request.id, kind: request.kind, target: request.target });
                  setHandled((current) => ({ ...current, [index]: "running" }));
                  approveToolRequest(request.id, { riskAccepted: request.risk?.level === "elevated", actor: decisionActor(clientIdentity) })
                    .then((response) => {
                      if (!response.execution?.wroteToTerminal && request.kind !== "main-agent-save-file") throw new Error(response.message || "Broker did not execute the request.");
                      if (request.kind !== "file-transfer") onReveal();
                      onLog("info", "tool-request-approved", { id: request.id, execution: response.execution });
                      setHandled((current) => ({ ...current, [index]: "approved" }));
                      return fetchToolRequestResult(request.id);
                    })
                    .then((response) => {
                      if (!response) return;
                      onLog("info", "tool-result-fetched", { id: request.id, result: response.result });
                      setResultSummaries((current) => ({ ...current, [index]: toolResultSummary(response) }));
                    })
                    .catch((error) => {
                      onLog("error", "tool-request-approve-failed", { id: request.id, error });
                      setErrors((current) => ({ ...current, [index]: error instanceof Error ? error.message : String(error) }));
                      setHandled((current) => ({ ...current, [index]: "error" }));
                    });
                }}
              >
                <Check size={15} />
                {state === "approved"
                  ? request.kind === "file-transfer" ? "Transferred" : "Approved"
                  : state === "running"
                    ? request.kind === "file-transfer" ? "Transferring" : "Approving"
                    : request.risk?.level === "elevated" ? `Confirm ${actionLabel}` : actionLabel}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(state && state !== "error")}
                onClick={() => {
                  onLog("warn", "tool-request-reject", { id: request.id, kind: request.kind, target: request.target });
                  void rejectToolRequest(request.id, { actor: decisionActor(clientIdentity) });
                  setHandled((current) => ({ ...current, [index]: "rejected" }));
                }}
              >
                <X size={15} />
                {state === "rejected" ? "Rejected" : "Reject"}
              </button>
              <button type="button" className="icon-button" title="Show terminal" onClick={onReveal}>
                <Eye size={15} />
              </button>
              {state === "approved" ? (
                <button
                  type="button"
                  className="icon-button"
                  title="Retry result forward"
                  onClick={() => {
                    onLog("info", "tool-result-forward-retry", { id: request.id });
                    retryToolResultForward(request.id)
                      .then((response) => {
                        onLog("info", "tool-result-forward-retried", { id: request.id, result: response.result });
                        setResultSummaries((current) => ({ ...current, [index]: toolResultSummary(response) }));
                      })
                      .catch((error) => {
                        onLog("error", "tool-result-forward-retry-failed", { id: request.id, error });
                        setErrors((current) => ({ ...current, [index]: error instanceof Error ? error.message : String(error) }));
                      });
                  }}
                >
                  <Send size={15} />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function decisionActor(identity: ClientIdentity | null) {
  return {
    deviceId: identity?.deviceId,
    deviceIdShort: identity?.deviceIdShort,
    displayName: identity?.displayName,
    source: "detaches-ui" as const
  };
}

function formatLogDetail(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function mergeToolRequests(primary: ToolRequestRecord[], updates: ToolRequestRecord[]): ToolRequestRecord[] {
  const byId = new Map(updates.map((request) => [request.id, request]));
  return primary.map((request) => byId.get(request.id) ?? request);
}

function keepLastFileTransferPerFile(requests: ToolRequestRecord[]): ToolRequestRecord[] {
  const lastIndexByFileId = new Map<string, number>();
  requests.forEach((request, index) => {
    if (request.kind !== "file-transfer") return;
    const fileId = typeof request.payload.fileId === "string" ? request.payload.fileId : "";
    if (fileId) lastIndexByFileId.set(fileId, index);
  });
  return requests.filter((request, index) => {
    if (request.kind !== "file-transfer") return true;
    const fileId = typeof request.payload.fileId === "string" ? request.payload.fileId : "";
    return !fileId || lastIndexByFileId.get(fileId) === index;
  });
}

function isInlineToolRequestVisible(request: ToolRequestRecord): boolean {
  if (request.status === "approved" || request.status === "succeeded" || request.status === "rejected") return false;
  if (
    request.kind === "file-transfer"
    && request.status === "failed"
    && /staged file not found|already transferred/i.test(request.error || "")
  ) {
    return false;
  }
  return true;
}

function toolResultSummary(response: ToolExecutionResultResponse): string {
  const result = response.result;
  const status = result.completed
    ? `completed${typeof result.exitCode === "number" ? `, exit ${result.exitCode}` : ""}`
    : "still running";
  const forward = result.forwardStatus === "sent"
    ? "forwarded to agent"
    : result.forwardStatus === "failed"
      ? `forward failed${result.forwardError ? `: ${result.forwardError}` : ""}`
      : result.forwardStatus === "pending"
        ? "forward pending"
        : "forward not started";
  return `${status}; ${forward}; captured ${result.outputBytes} bytes from terminal ${result.terminalId || ""}`.trim();
}

function toolRequestCode(request: ToolRequestRecord): string {
  if (request.kind === "terminal") {
    return typeof request.payload.command === "string" ? request.payload.command : JSON.stringify(request.payload, null, 2);
  }
  if (request.kind === "main-agent-save-file") {
    const destination = destinationPayload(request.payload.destination);
    return [
      `fileId: ${typeof request.payload.fileId === "string" ? request.payload.fileId : ""}`,
      `sourceLocalPath: ${typeof request.payload.sourceLocalPath === "string" ? request.payload.sourceLocalPath : ""}`,
      `destination: ${destination}`,
      `method: ${typeof request.payload.methodPreference === "string" ? request.payload.methodPreference : "rsync"}`
    ].join("\n");
  }
  return [
    `fileId: ${typeof request.payload.fileId === "string" ? request.payload.fileId : ""}`,
    `remotePath: ${typeof request.payload.remotePath === "string" ? request.payload.remotePath : ""}`
  ].join("\n");
}

function toolRequestTitle(request: ToolRequestRecord): string {
  if (request.kind === "main-agent-save-file") return "Save file to Main Agent";
  if (request.kind === "file-transfer") return "File transfer";
  if (request.kind === "adapter-install") return "Adapter install";
  return "Terminal command";
}

function destinationPayload(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return `${record.user ?? ""}@${record.host ?? ""}:${record.port ?? 22}${record.path ?? ""}`;
}

function confirmElevatedRisk(request: ToolRequestRecord): boolean {
  if (request.risk?.level !== "elevated") return true;
  const reason = request.risk.reasons.join("; ") || "Elevated-risk tool request";
  return window.confirm(`确认执行高风险工具请求？\n\n${reason}`);
}

function buildDefaultAttachmentContext(attachments: UploadedFileRef[]): string {
  if (!attachments.length) return "";
  return [
    "[[DETACH_AGENT_FILE_STAGED]]",
    "用户已在 detaches_agent Web 添加文件。该文件当前只存在于 detaches_agent 本机，不在 Main Agent 机器上。",
    "",
    `fileCount: ${attachments.length}`,
    "",
    ...attachments.flatMap((file, index) => [
      `${index + 1}. ${file.name}`,
      `   fileId: ${file.id}`,
      `   displayName: ${displayFileName(file)}`,
      `   size: ${file.size}`,
      `   mimeType: ${file.mimeType || "application/octet-stream"}`,
      `   sourceLocalPath: ${file.localPath || "not exposed"}`,
      "   currentLocation: 用户本机 detaches_agent staging 区",
      "   remotePath: not uploaded",
      "   role: 主输入/待确认",
      ""
    ]),
    "如果你需要把该文件保存到 Main Agent 机器，请阅读 detach-agent-relationship skill，并生成 main-agent-save-file 请求。",
    "保存目标路径必须由 Main Agent 根据自己的规则决定。",
    "不要假设 Main Agent 已经能直接读取 sourceLocalPath；该路径只能作为 detaches_agent 本机传输源。",
    "不要启动 HTTP 上传服务器，不要发明 curl/http-upload 方法；main-agent-save-file 只支持 rsync 或 scp。",
    "请求格式必须是唯一一个 fenced code block：",
    "```main-agent-save-file",
    "{\"fileId\":\"上面的文件 id\",\"sourceLocalPath\":\"上面的 sourceLocalPath\",\"displayName\":\"原始文件名\",\"size\":12345,\"destination\":{\"host\":\"Main Agent SSH host\",\"port\":22,\"user\":\"Main Agent SSH user\",\"path\":\"由 Main Agent 规则决定的绝对目标路径\"},\"methodPreference\":\"rsync\",\"reason\":\"说明为什么需要保存到 Main Agent\"}",
    "```",
    "用户批准后，detaches_agent 会在本机调用 rsync/scp 传输；如果 Main Agent 机器没有开启 SSH/SFTP 等可达服务，则该功能不可用。",
    "用户批准前不要假装已经读取文件；如果传输失败，请根据 terminal 输出继续处理。"
  ].join("\n").trimEnd();
}

function displayFileName(file: UploadedFileRef): string {
  return file.displayName || file.name;
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
  const runId = runIdentity(anyPayload);
  const updatedAt = new Date().toISOString();
  const existingIndex = findExistingStreamMessage(current, identity, role);
  const nextMessage: ChatMessage = {
    id: identity ?? crypto.randomUUID(),
    runId,
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
      runId: message.runId ?? runId,
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
  if (previous.includes(incoming)) return previous;
  if (incoming.includes(previous)) return incoming;
  const eventType = String(payload.type ?? payload.event ?? payload.kind ?? "");
  if (eventType.includes("delta") || typeof payload.delta === "string") return `${previous}${incoming}`;
  return incoming.length >= previous.length ? incoming : `${previous}${incoming}`;
}

function runIdentity(payload: Record<string, unknown>): string | undefined {
  const direct = payload.runId ?? payload.run_id;
  if (typeof direct === "string" && direct.trim()) return direct;
  const run = payload.run as Record<string, unknown> | undefined;
  if (run && typeof run.id === "string" && run.id.trim()) return run.id;
  for (const key of ["payload", "message", "event", "data", "meta", "metadata"]) {
    const child = payload[key];
    if (child && typeof child === "object") {
      const found = runIdentity(child as Record<string, unknown>);
      if (found) return found;
    }
  }
  return undefined;
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
