import { type CSSProperties, FormEvent, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Check, Copy, Eye, FileText, List, Minus, Paperclip, Plus, Send, Square, X } from "lucide-react";
import type { ChatMessage, ChatSessionMode, ChatSocketServerEvent, ClientIdentity, MainAgentFileTransferSnapshot, RelationshipSkillStatus, ToolExecutionResultResponse, ToolRequestRecord, ToolTarget, UploadedFileRef } from "@detaches/shared";
import { approveToolRequest, extractToolRequests, fetchCloudPromptLogs, fetchToolRequestResult, fetchToolRequests, rejectToolRequest, retryToolResultForward, submitMainAgentTransferPassword, wsUrl } from "../../lib/api.js";
import { DEFAULT_LOG_FILTER, LOG_FILTER_LEVELS, appendRealtimeLog, createLogInput, filterRealtimeLogs, formatLogDetail, type LogEntry, type LogFilterLevel, type LogWriter } from "../logs/realtimeLog.js";
import { TerminalPanel, type TerminalPanelHandle } from "../terminal/TerminalPanel.js";

interface Props {
  sessionKey: string | null;
  agentId: string | null;
  sessionMode: ChatSessionMode;
  clientIdentity: ClientIdentity | null;
  attachments: UploadedFileRef[];
  relationshipSkillCheckNonce?: number;
  onSessionModeChange: (mode: ChatSessionMode) => void;
  onNewSession: () => void;
  onClearAttachments: () => void;
  onNeedUpload: (files: FileList) => void;
  onRelationshipSkillStatusChange: (status: RelationshipSkillStatus, message?: string, installedVersion?: string, requiredVersion?: string) => void;
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
  relationshipSkillCheckNonce = 0,
  onSessionModeChange,
  onNewSession,
  onClearAttachments,
  onNeedUpload,
  onRelationshipSkillStatusChange
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
  const [logFilter, setLogFilter] = useState<LogFilterLevel>(DEFAULT_LOG_FILTER);
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
  const cloudPromptLogIdsRef = useRef<Set<string>>(new Set());
  const relationshipSkillCheckSeqRef = useRef(0);

  useImperativeHandle(ref, () => ({
    revealTerminal: () => terminalRef.current?.reveal()
  }), []);

  function sendRelationshipSkillCheck(reason: "socket-open" | "new-session") {
    const socket = socketRef.current;
    if (!sessionKey || socket?.readyState !== WebSocket.OPEN) return;
    relationshipSkillCheckSeqRef.current += 1;
    onRelationshipSkillStatusChange("checking", "Checking detach-agent-relationship skill...");
    const idempotencyKey = `relationship-skill:${sessionKey}:${reason}:${Date.now().toString(36)}:${relationshipSkillCheckSeqRef.current}`;
    appendLog("info", "system", "relationship-skill-check-requested", { sessionKey, reason, idempotencyKey });
    socket.send(JSON.stringify({
      type: "bootstrap-relationship-skill-check",
      idempotencyKey
    }));
  }

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
      return;
    }
    const params = new URLSearchParams({ sessionMode });
    const ws = new WebSocket(wsUrl(`/api/chat/${encodeURIComponent(sessionKey)}?${params}`));
    socketRef.current = ws;
    setSocketState("connecting");
    appendLog("debug", "socket", "socket-connecting", { sessionKey, sessionMode });
    ws.onopen = () => {
      setSocketState("connected");
      appendLog("debug", "socket", "socket-connected", { sessionKey, sessionMode });
      sendRelationshipSkillCheck("socket-open");
    };
    ws.onclose = (event) => {
      setSocketState("closed");
      appendLog("debug", "socket", "socket-closed", { code: event.code, reason: event.reason, wasClean: event.wasClean });
      if (!disposed && sessionKey) {
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          setSocketReconnectNonce((current) => current + 1);
        }, 1500);
      }
    };
    ws.onerror = () => {
      setSocketState("error");
      appendLog("error", "socket", "socket-error", { sessionKey, sessionMode });
      ws.close();
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ChatSocketServerEvent;
      appendLog("debug", "socket", "socket-message", { type: data.type });
      if (data.type === "history") {
        const visibleMessages = data.payload.messages.filter((message) => !isRelationshipSkillCheckMessage(messageText(message)));
        setMessages(visibleMessages);
        appendLog("debug", "chat", "history-loaded", { count: visibleMessages.length, hiddenRelationshipSkillChecks: data.payload.messages.length - visibleMessages.length });
      } else if (data.type === "chat") {
        if (isPayloadForSession(data.payload, sessionKey)) {
          if (!isRelationshipSkillCheckMessage(textFromUnknown(data.payload))) {
            setMessages((current) => upsertGatewayChat(current, data.payload));
          }
          appendLog("debug", "chat", "chat-upserted", { sessionKey });
        }
      } else if (data.type === "sent") {
        setLastRunId(data.payload.runId ?? null);
        appendLog("info", "prompt", "message-sent-ack", data.payload);
        void refreshCloudPromptLogs();
      } else if (data.type === "relationship-skill-status") {
        onRelationshipSkillStatusChange(data.status, data.message, data.installedVersion, data.requiredVersion);
        appendLog("info", "system", "relationship-skill-status", {
          status: data.status,
          message: data.message,
          installedVersion: data.installedVersion,
          requiredVersion: data.requiredVersion
        });
      } else if (data.type === "error") {
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: "system", text: data.message, timestamp: new Date().toISOString() }
        ]);
        appendLog("error", "system", "server-error", { message: data.message });
      }
    };
    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      appendLog("debug", "socket", "socket-cleanup", { sessionKey, sessionMode });
      ws.close();
    };
  }, [sessionKey, sessionMode, socketReconnectNonce, onRelationshipSkillStatusChange]);

  useEffect(() => {
    if (relationshipSkillCheckNonce > 0) sendRelationshipSkillCheck("new-session");
  }, [relationshipSkillCheckNonce]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const nextContext = buildDefaultAttachmentContext(attachments);
    setAttachmentContext(nextContext);
    if (!nextContext) setAttachmentContextOpen(false);
    if (attachments.length) appendLog("info", "file", "attachments-ready", attachments.map((file) => ({ id: file.id, name: file.name, size: file.size })));
  }, [attachments]);

  useEffect(() => {
    const el = logStreamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs, logFilter, logOpen]);

  useEffect(() => {
    if (!logOpen) return;
    void refreshCloudPromptLogs();
    const timer = window.setInterval(() => void refreshCloudPromptLogs(), 2000);
    return () => window.clearInterval(timer);
  }, [logOpen]);

  const canSend = useMemo(() => Boolean(sessionKey && draft.trim() && socketRef.current?.readyState === WebSocket.OPEN), [sessionKey, draft, socketState]);
  const messagesStyle = useMemo(() => ({
    "--chat-message-font-size": `${chatFontSize}px`
  }) as CSSProperties, [chatFontSize]);
  const visibleLogs = useMemo(() => filterRealtimeLogs(logs, logFilter), [logs, logFilter]);

  function updateChatFontSize(next: number) {
    const clamped = Math.max(12, Math.min(20, next));
    setChatFontSize(clamped);
    window.localStorage.setItem("detaches.chatFontSize", String(clamped));
    appendLog("debug", "chat", "chat-font-size", { size: clamped });
  }

  function appendLog(...args: Parameters<LogWriter>) {
    setLogs((current) => appendRealtimeLog(current, createLogInput(...args)));
  }

  async function refreshCloudPromptLogs() {
    try {
      const response = await fetchCloudPromptLogs(100);
      response.entries.forEach((entry) => {
        const key = `${entry.ts}:${entry.phase}:${entry.idempotencyKey || ""}:${entry.sessionKey}`;
        if (cloudPromptLogIdsRef.current.has(key)) return;
        cloudPromptLogIdsRef.current.add(key);
        appendLog("info", "prompt", "cloud-prompt", {
          logPath: response.path,
          phase: entry.phase,
          sessionKey: entry.sessionKey,
          idempotencyKey: entry.idempotencyKey,
          includeClientContext: entry.includeClientContext,
          payload: entry.payload
        });
      });
    } catch (error) {
      appendLog("error", "prompt", "cloud-prompt-log-load-failed", error);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    const text = draft.trim();
    const idempotencyKey = crypto.randomUUID();
    appendLog("info", "prompt", "chat-send", {
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
    appendLog("info", "prompt", "abort-run", { runId: lastRunId });
    socketRef.current?.send(JSON.stringify({ type: "abort", runId: lastRunId }));
  }

  async function copyMessage(message: ChatMessage) {
    await navigator.clipboard.writeText(messageText(message));
    appendLog("debug", "chat", "message-copied", { id: message.id, role: message.role });
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
          <button type="button" className="secondary-button compact" onClick={onNewSession} disabled={!sessionKey} title="New session">
            <Plus size={14} />
            New session
          </button>
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
            <div className="log-console-title">
              <strong>实时 Log</strong>
              <small>{visibleLogs.length} / {logs.length} 条记录</small>
              <div className="log-level-toggle" aria-label="Log level">
                {LOG_FILTER_LEVELS.map((level) => (
                  <button
                    type="button"
                    className={logFilter === level ? "active" : ""}
                    onClick={() => setLogFilter(level)}
                    key={level}
                  >
                    {level.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="log-console-actions">
              <button type="button" className="secondary-button compact" onClick={() => setLogs([])}>清空</button>
              <button type="button" className="icon-button small" title="关闭 Log" onClick={() => setLogOpen(false)}>
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="log-console-stream" ref={logStreamRef}>
            {visibleLogs.length ? visibleLogs.map((entry) => (
              <div className={`log-console-row ${entry.level}`} key={entry.id}>
                <span>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                <b>{entry.level}</b>
                <em>{entry.module}</em>
                <strong>{entry.event}</strong>
                {entry.detail === undefined ? null : <code>{formatLogDetail(entry.detail)}</code>}
              </div>
            )) : <p>{logs.length ? "当前等级下暂无日志。" : "暂无日志。发送消息、接收响应、上传附件或处理工具请求后会实时出现。"}</p>}
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
          onChange={(event) => {
            if (event.target.files) onNeedUpload(event.target.files);
            event.currentTarget.value = "";
          }}
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
  onLog: LogWriter;
}) {
  const [requests, setRequests] = useState<ToolRequestRecord[]>([]);
  const [handled, setHandled] = useState<Record<number, "approved" | "rejected" | "running" | "error" | "blocked">>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [resultSummaries, setResultSummaries] = useState<Record<number, string>>({});
  const [transfers, setTransfers] = useState<Record<number, MainAgentFileTransferSnapshot>>({});
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const pollTimersRef = useRef<Record<number, number>>({});
  const loggedRequestSignatureRef = useRef<{ scope: string; signature: string }>({ scope: "", signature: "" });

  useEffect(() => () => {
    Object.values(pollTimersRef.current).forEach((timer) => window.clearTimeout(timer));
    pollTimersRef.current = {};
  }, []);

  useEffect(() => {
    if (!sessionKey || !text) {
      setRequests([]);
      return;
    }
    const logScope = `${sessionKey}:${sourceMessageId}:${sourceRunId || ""}`;
    if (loggedRequestSignatureRef.current.scope !== logScope) {
      loggedRequestSignatureRef.current = { scope: logScope, signature: "" };
    }
    setHandled({});
    setErrors({});
    setResultSummaries({});
    setTransfers({});
    setPasswords({});
    Object.values(pollTimersRef.current).forEach((timer) => window.clearTimeout(timer));
    pollTimersRef.current = {};
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
        const requestSignature = mergedRequests.map((request) => `${request.id}:${request.status}`).sort().join("|");
        if (mergedRequests.length && loggedRequestSignatureRef.current.signature !== requestSignature) {
          loggedRequestSignatureRef.current = { scope: logScope, signature: requestSignature };
          onLog("info", "tool", "tool-requests-detected", mergedRequests.map((request) => ({
            id: request.id,
            kind: request.kind,
            target: request.target,
            status: request.status,
            source: request.source,
            channel: request.kind === "terminal" && request.source === "text-extract" ? "chat-terminal" : request.source === "gateway-event" ? "gateway-terminal" : undefined,
            fallback: request.kind === "terminal" && request.source === "text-extract" ? true : undefined
          })));
        }
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
        onLog("error", "tool", "tool-requests-load-failed", error);
        setErrors({ 0: error instanceof Error ? error.message : String(error) });
      });
    void loadRequests();
  }, [text, sessionKey, agentId, sourceMessageId, sourceRunId]);
  if (!requests.length && !errors[0]) return null;

  function scheduleMainAgentTransferPoll(request: ToolRequestRecord, index: number) {
    if (request.kind !== "main-agent-save-file") return;
    if (pollTimersRef.current[index]) window.clearTimeout(pollTimersRef.current[index]);
    const poll = () => {
      fetchToolRequestResult(request.id)
        .then((response) => {
          const transfer = transferFromResult(response);
          if (transfer) {
            setTransfers((current) => ({ ...current, [index]: transfer }));
            setResultSummaries((current) => ({ ...current, [index]: mainAgentTransferSummary(transfer) }));
          }
          if (transfer && (transfer.status === "succeeded" || transfer.status === "failed")) {
            delete pollTimersRef.current[index];
            setHandled((current) => ({ ...current, [index]: transfer.status === "succeeded" ? "approved" : "error" }));
            if (transfer.error) setErrors((current) => ({ ...current, [index]: transfer.error || "" }));
            return;
          }
          pollTimersRef.current[index] = window.setTimeout(poll, transfer?.status === "waiting-password" ? 3000 : 1000);
        })
        .catch((error) => {
          delete pollTimersRef.current[index];
          onLog("error", "terminal", "main-agent-transfer-poll-failed", { id: request.id, error });
          setErrors((current) => ({ ...current, [index]: error instanceof Error ? error.message : String(error) }));
          setHandled((current) => ({ ...current, [index]: "error" }));
        });
    };
    pollTimersRef.current[index] = window.setTimeout(poll, 300);
  }

  function submitTransferPassword(index: number) {
    const transfer = transfers[index];
    const password = passwords[index];
    if (!transfer || !password) return;
    setHandled((current) => ({ ...current, [index]: "running" }));
    submitMainAgentTransferPassword(transfer.transferId, password)
      .then((response) => {
        setPasswords((current) => ({ ...current, [index]: "" }));
        setTransfers((current) => ({ ...current, [index]: response.transfer }));
        setResultSummaries((current) => ({ ...current, [index]: mainAgentTransferSummary(response.transfer) }));
        const request = requests[index];
        if (request) scheduleMainAgentTransferPoll(request, index);
      })
      .catch((error) => {
        onLog("error", "terminal", "main-agent-transfer-password-failed", { transferId: transfer.transferId, error });
        setErrors((current) => ({ ...current, [index]: error instanceof Error ? error.message : String(error) }));
        setHandled((current) => ({ ...current, [index]: "error" }));
      });
  }

  return (
    <div className="terminal-requests">
      {errors[0] && !requests.length ? <p className="request-error">{errors[0]}</p> : null}
      {requests.map((request, index) => {
        const state = handled[index];
        const unsupported = !toolRequestSupported(request);
        const actionLabel = request.kind === "main-agent-save-file" ? "Save" : request.kind === "file-transfer" ? "Transfer" : request.kind === "adapter-install" ? "Install" : "Run";
        const transfer = transfers[index];
        const runningTransfer = request.kind === "main-agent-save-file" && request.status === "running";
        return (
          <div className={`terminal-request-card ${request.kind === "file-transfer" ? "file-transfer-card" : ""}`} key={request.id}>
            <div>
              <strong>{toolRequestTitle(request)} request</strong>
              <p className={`target-pill ${request.target}`}>Target: {targetLabels[request.target]}</p>
              {request.risk ? <p className={`risk-pill ${request.risk.level}`}>Risk: {request.risk.level}{request.risk.reasons.length ? ` · ${request.risk.reasons.join("; ")}` : ""}</p> : null}
              {request.reason ? <p>{request.reason}</p> : null}
              <code>{toolRequestCode(request)}</code>
              <small>requestId: {request.id}</small>
              {request.error ? <p className="request-error">{request.error}</p> : null}
              {unsupported ? <p className="request-error">{unsupportedTargetMessage(request)}</p> : null}
              {errors[index] ? <p className="request-error">{errors[index]}</p> : null}
              {resultSummaries[index] ? <small>{resultSummaries[index]}</small> : null}
              {transfer ? <InlineTransferProgress transfer={transfer} /> : null}
              {transfer?.status === "waiting-password" || transfer?.needsPassword ? (
                <label className="inline-password-prompt">
                  <span>SSH password required</span>
                  <input
                    type="password"
                    value={passwords[index] || ""}
                    placeholder={`${transfers[index].destination.user}@${transfers[index].destination.host}`}
                    onChange={(event) => setPasswords((current) => ({ ...current, [index]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitTransferPassword(index);
                    }}
                  />
                  <button type="button" className="secondary-button compact" disabled={!passwords[index]} onClick={() => submitTransferPassword(index)}>
                    Continue
                  </button>
                </label>
              ) : null}
            </div>
            <div className="terminal-request-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={unsupported || runningTransfer || Boolean(state && state !== "error")}
                onClick={() => {
                  if (!confirmElevatedRisk(request)) return;
                  onLog("info", "tool", "tool-request-approve", { id: request.id, kind: request.kind, target: request.target });
                  setHandled((current) => ({ ...current, [index]: "running" }));
                  approveToolRequest(request.id, { riskAccepted: request.risk?.level === "elevated", actor: decisionActor(clientIdentity) })
                    .then((response) => {
                      if (!response.execution?.wroteToTerminal && request.kind !== "main-agent-save-file") throw new Error(response.message || "Broker did not execute the request.");
                      if (request.kind !== "file-transfer" && request.kind !== "main-agent-save-file") onReveal();
                      onLog("info", "terminal", "tool-request-approved", { id: request.id, execution: response.execution });
                      setHandled((current) => ({ ...current, [index]: request.kind === "main-agent-save-file" && !response.execution?.completed ? "running" : "approved" }));
                      return fetchToolRequestResult(request.id);
                    })
                    .then((response) => {
                      if (!response) return;
                      onLog("info", "terminal", "tool-result-fetched", { id: request.id, result: response.result });
                      const transfer = transferFromResult(response);
                      setResultSummaries((current) => ({
                        ...current,
                        [index]: transfer ? mainAgentTransferSummary(transfer) : toolResultSummary(response)
                      }));
                      if (transfer) setTransfers((current) => ({ ...current, [index]: transfer }));
                      if (request.kind === "main-agent-save-file") scheduleMainAgentTransferPoll(request, index);
                    })
                    .catch((error) => {
                      onLog("error", "tool", "tool-request-approve-failed", { id: request.id, error });
                      setErrors((current) => ({ ...current, [index]: error instanceof Error ? error.message : String(error) }));
                      setHandled((current) => ({ ...current, [index]: "error" }));
                    });
                }}
              >
                <Check size={15} />
                {state === "approved"
                  ? request.kind === "file-transfer" ? "Transferred" : "Approved"
                  : state === "running" || runningTransfer
                    ? transfer?.status === "waiting-password" || transfer?.needsPassword ? "Waiting password" : request.kind === "file-transfer" ? "Transferring" : "Running"
                    : request.risk?.level === "elevated" ? `Confirm ${actionLabel}` : actionLabel}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(state && state !== "error")}
                onClick={() => {
                  onLog("info", "tool", "tool-request-reject", { id: request.id, kind: request.kind, target: request.target });
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
                    onLog("info", "tool", "tool-result-forward-retry", { id: request.id });
                    retryToolResultForward(request.id)
                      .then((response) => {
                        onLog("info", "terminal", "tool-result-forward-retried", { id: request.id, result: response.result });
                        setResultSummaries((current) => ({ ...current, [index]: toolResultSummary(response) }));
                      })
                      .catch((error) => {
                        onLog("error", "tool", "tool-result-forward-retry-failed", { id: request.id, error });
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

function mergeToolRequests(primary: ToolRequestRecord[], updates: ToolRequestRecord[]): ToolRequestRecord[] {
  const byId = new Map(updates.map((request) => [request.id, request]));
  return primary.map((request) => byId.get(request.id) ?? request);
}

function keepLastFileTransferPerFile(requests: ToolRequestRecord[]): ToolRequestRecord[] {
  const lastIndexByKey = new Map<string, number>();
  requests.forEach((request, index) => {
    if (request.kind !== "file-transfer" && request.kind !== "main-agent-save-file") return;
    const fileId = typeof request.payload.fileId === "string" ? request.payload.fileId : "";
    if (fileId) lastIndexByKey.set(`${request.kind}:${fileId}`, index);
  });
  return requests.filter((request, index) => {
    if (request.kind !== "file-transfer" && request.kind !== "main-agent-save-file") return true;
    const fileId = typeof request.payload.fileId === "string" ? request.payload.fileId : "";
    return !fileId || lastIndexByKey.get(`${request.kind}:${fileId}`) === index;
  });
}

function isInlineToolRequestVisible(request: ToolRequestRecord): boolean {
  if (request.status === "approved" || request.status === "succeeded" || request.status === "rejected") return false;
  if (isPlaceholderToolRequest(request)) return false;
  if (
    request.kind === "file-transfer"
    && request.status === "failed"
    && /staged file not found|already transferred/i.test(request.error || "")
  ) {
    return false;
  }
  return true;
}

function isPlaceholderToolRequest(request: ToolRequestRecord): boolean {
  if (request.kind !== "main-agent-save-file") return false;
  const destination = request.payload.destination && typeof request.payload.destination === "object" && !Array.isArray(request.payload.destination)
    ? request.payload.destination as Record<string, unknown>
    : {};
  const haystack = [
    request.payload.fileId,
    request.payload.sourceLocalPath,
    destination.path
  ].map((value) => typeof value === "string" ? value : JSON.stringify(value ?? "")).join("\n").toLowerCase();
  return /上面的|<file-id>|<absolute path|final-filename\.ext|原始文件名|请替换|替换为|your-|example\.|100\.x\.x\.x|192\.168\.x\.x|main agent.*ip|main agent.*host|detaches_agent.*host|detaches-agent.*host|ssh user/.test(haystack);
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

function transferFromResult(response: ToolExecutionResultResponse): MainAgentFileTransferSnapshot | null {
  if (response.request.kind !== "main-agent-save-file" || !response.result.output) return null;
  try {
    const parsed = JSON.parse(response.result.output) as MainAgentFileTransferSnapshot;
    return parsed?.transferId && parsed?.requestId ? parsed : null;
  } catch {
    return null;
  }
}

function mainAgentTransferSummary(transfer: MainAgentFileTransferSnapshot): string {
  const percent = typeof transfer.progress === "number" ? ` · ${Math.round(transfer.progress * 100)}%` : "";
  const message = transfer.error || transfer.message || "";
  return `${transfer.status}${percent}${message ? ` · ${message}` : ""}`;
}

function InlineTransferProgress({ transfer }: { transfer: MainAgentFileTransferSnapshot }) {
  return (
    <div className={`transfer-progress ${transfer.status}`}>
      <small>{mainAgentTransferSummary(transfer)}</small>
      <progress value={transfer.progress ?? 0} max={1} />
      <code>{transfer.sourceLocalPath}{"\n"}→ {transfer.destination.user}@{transfer.destination.host}:{transfer.destination.path}</code>
      {transfer.commandPreview ? <code>{transfer.commandPreview}</code> : null}
      {transfer.warnings?.map((warning) => <p className="request-warning" key={warning}>{warning}</p>)}
    </div>
  );
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
  const user = typeof record.user === "string" && record.user.trim() ? record.user.trim() : "(missing user)";
  const pathValue = typeof record.path === "string" && record.path.trim() ? record.path.trim() : "(missing path)";
  const host = typeof record.host === "string" && record.host.trim() ? record.host.trim() : "current Main Agent SSH config";
  const port = typeof record.port === "number" && record.port > 0 ? `:${record.port}` : "";
  return `user: ${user}\nconnection: ${host}${port}\npath: ${pathValue}`;
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
    "The user added file(s) in detaches_agent. These files currently exist only in detaches_agent local staging, not on the Host/Main Agent machine.",
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
      "   currentLocation: user-local-machine detaches_agent staging",
      "   remotePath: not uploaded",
      "   role: primary user input; confirm intended use before choosing a destination",
      ""
    ]),
    "If the user explicitly asks to save a staged file to the Main Agent machine, create exactly one main-agent-save-file request.",
    "destination.path must be chosen by the Main Agent according to its own rules and must be a complete absolute POSIX target file path: directory plus final filename and extension.",
    "destination.path cannot be a directory and cannot stop at generic folders such as screenshots/, docs/, or _staging/. If you only know a directory, derive a concrete filename from displayName first.",
    "If the file purpose or archive category is unclear, ask the user for the intended use; do not invent supplier/product/category folders or a _staging path without evidence.",
    "destination.user and destination.path are the core required fields. destination.user is the real remote SSH/Linux account that owns or can write the destination path.",
    "If destination.path starts with /home/<account>/, destination.user must match <account>; do not use a different SSH user for another account's home directory.",
    "destination.host/port may be omitted; detaches_agent fills them from the current Main Agent SSH/Gateway settings.",
    "Do not put placeholders or example values in destination.user/host/port. If destination.user is unknown, say the save request cannot be created yet.",
    "Do not assume the Main Agent can read sourceLocalPath directly. That path exists only on the detaches_agent local machine and can only be used as the transfer source by detaches_agent.",
    "Do not start an HTTP upload server or invent a curl/http-upload method. main-agent-save-file supports only rsync or scp.",
    "Do not generate ssh/rsync/scp/curl commands and do not ask the user to run transfer commands in a terminal. Generate only the structured main-agent-save-file JSON request.",
    "detaches_agent only transfers the staged file to destination.path. It does not create remote directories, validate the remote file afterward, or organize the Main Agent filesystem.",
    "The request must be exactly one fenced code block:",
    "```main-agent-save-file",
    "{\"fileId\":\"file id listed above\",\"sourceLocalPath\":\"sourceLocalPath listed above\",\"displayName\":\"original filename\",\"size\":12345,\"destination\":{\"user\":\"zhangst\",\"path\":\"/home/zhangst/path/to/final-filename.ext\"},\"methodPreference\":\"rsync\",\"reason\":\"why this file should be saved to the Main Agent machine and why this destination path is correct\"}",
    "```",
    "After user approval, detaches_agent broker performs the structured rsync/scp transfer. If SSH needs a password, detaches_agent UI shows a one-time password input.",
    "Before approval, do not pretend to have read the file. If transfer fails, report only the approved detaches_agent tool result and do not invent alternative transfer methods."
  ].join("\n").trimEnd();
}

function displayFileName(file: UploadedFileRef): string {
  return file.displayName || file.name;
}

function isRelationshipSkillCheckMessage(text: string): boolean {
  return text.includes("[[DETACH_AGENT_RELATIONSHIP_SKILL_CHECK]]")
    || text.includes("DETACH_AGENT_SKILL_STATUS:");
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
  previous = collapseRepeatedText(previous);
  incoming = collapseRepeatedText(incoming);
  if (!previous) return incoming;
  if (incoming === previous) return previous;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.includes(incoming)) return previous;
  if (incoming.includes(previous)) return incoming;
  const overlap = suffixPrefixOverlap(previous, incoming);
  if (overlap >= 24) return collapseRepeatedText(`${previous}${incoming.slice(overlap)}`);
  const repeatedPrefix = longestRepeatedPrefix(incoming);
  if (repeatedPrefix && previous.endsWith(repeatedPrefix)) {
    return collapseRepeatedText(`${previous}${incoming.slice(repeatedPrefix.length)}`);
  }
  const eventType = String(payload.type ?? payload.event ?? payload.kind ?? "");
  const hasExplicitDelta = eventType.includes("delta") || typeof payload.delta === "string";
  if (hasExplicitDelta && looksLikeSmallDelta(previous, incoming)) return collapseRepeatedText(`${previous}${incoming}`);
  return incoming.length >= previous.length ? collapseRepeatedText(incoming) : collapseRepeatedText(`${previous}${incoming}`);
}

function looksLikeSmallDelta(previous: string, incoming: string): boolean {
  if (incoming.length <= 160) return true;
  if (incoming.length < previous.length * 0.35) return true;
  return false;
}

function collapseRepeatedText(text: string): string {
  let current = text;
  for (let pass = 0; pass < 6; pass += 1) {
    const next = collapseRepeatedChunks(collapseRepeatedLines(collapseRepeatedParagraphRuns(current)));
    if (next === current) return current;
    current = next;
  }
  return current;
}

function collapseRepeatedParagraphRuns(text: string): string {
  const pieces = text.split(/(\n{2,})/);
  const seen = new Map<string, number>();
  const output: string[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (/^\n{2,}$/.test(piece)) {
      output.push(piece);
      continue;
    }
    const key = piece.trim();
    const previousIndex = meaningfulRepeatChunk(key) ? seen.get(key) : undefined;
    if (previousIndex !== undefined) {
      output.splice(previousIndex);
      rebuildParagraphSeen(output, seen);
    }
    if (piece) {
      seen.set(key, output.length);
      output.push(piece);
    }
  }
  return output.join("");
}

function rebuildParagraphSeen(output: string[], seen: Map<string, number>): void {
  seen.clear();
  output.forEach((piece, index) => {
    if (/^\n{2,}$/.test(piece)) return;
    const key = piece.trim();
    if (meaningfulRepeatChunk(key)) seen.set(key, index);
  });
}

function collapseRepeatedLines(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    const current = line.trim();
    const previous = output.at(-1)?.trim() ?? "";
    if (meaningfulRepeatChunk(current) && meaningfulRepeatChunk(previous)) {
      if (current === previous || previous.startsWith(current)) continue;
      if (current.startsWith(previous)) {
        output[output.length - 1] = line;
        continue;
      }
    }
    output.push(line);
  }
  return output.join("\n");
}

function collapseRepeatedChunks(text: string): string {
  let current = text;
  let changed = true;
  while (changed) {
    changed = false;
    const scanStart = Math.max(0, current.length - 8000);
    const maxSize = Math.min(500, Math.floor((current.length - scanStart) / 2));
    for (let size = maxSize; size >= 8; size -= 1) {
      for (let start = scanStart; start + size * 2 <= current.length; start += 1) {
        const chunk = current.slice(start, start + size);
        if (!meaningfulRepeatChunk(chunk)) continue;
        let repeats = 1;
        while (current.slice(start + size * repeats, start + size * (repeats + 1)) === chunk) repeats += 1;
        if (repeats > 1) {
          current = `${current.slice(0, start + size)}${current.slice(start + size * repeats)}`;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return current;
}

function meaningfulRepeatChunk(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 6 && /[\p{L}\p{N}]/u.test(trimmed) && !trimmed.startsWith("```");
}

function suffixPrefixOverlap(previous: string, incoming: string): number {
  const max = Math.min(previous.length, incoming.length, 2000);
  for (let length = max; length >= 24; length -= 1) {
    if (previous.endsWith(incoming.slice(0, length))) return length;
  }
  return 0;
}

function longestRepeatedPrefix(text: string): string {
  const max = Math.min(400, Math.floor(text.length / 2));
  for (let length = max; length >= 24; length -= 1) {
    const prefix = text.slice(0, length);
    if (text.slice(length).startsWith(prefix)) return prefix;
  }
  return "";
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
