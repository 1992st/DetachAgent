import { type CSSProperties, type DragEvent, FormEvent, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Check, Copy, Eye, FileText, List, Minus, Paperclip, Plus, Send, Square, Trash2, X } from "lucide-react";
import type { ChatMessage, ChatSessionMode, ChatSocketServerEvent, ClientIdentity, GatewayModelOption, MainAgentFileTransferSnapshot, RelationshipSkillStatus, ToolExecutionResultResponse, ToolRequestRecord, ToolTarget, UploadedFileRef } from "@detaches/shared";
import { approveToolRequest, extractToolRequests, fetchCloudPromptLogs, fetchGatewayModels, fetchToolRequestResult, fetchToolRequests, rejectToolRequest, retryToolResultForward, submitMainAgentTransferPassword, wsUrl } from "../../lib/api.js";
import { DEFAULT_LOG_FILTER, LOG_FILTER_LEVELS, appendRealtimeLog, createLogInput, filterRealtimeLogs, formatLogDetail, type LogEntry, type LogFilterLevel, type LogWriter } from "../logs/realtimeLog.js";
import { TerminalPanel, type TerminalPanelHandle } from "../terminal/TerminalPanel.js";

const PROMPT_PRESETS_STORAGE_KEY = "detaches.promptPresets.v1";
const CHAT_MODEL_STORAGE_KEY = "detaches.chat.selectedModel.v1";
const PRESET_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#475569", "#db2777"];
const PRESET_CLICK_DELAY_MS = 180;

interface PromptPreset {
  id: string;
  name: string;
  color: string;
  prompt: string;
  updatedAt: string;
}

interface Props {
  sessionKey: string | null;
  agentId: string | null;
  sessionMode: ChatSessionMode;
  clientIdentity: ClientIdentity | null;
  attachments: UploadedFileRef[];
  relationshipSkillCheckNonce?: number;
  localControlConsent?: boolean;
  localControlRuntime?: "idle" | "checking" | "install_required" | "installing" | "ready" | "error";
  localControlScope?: string;
  relationshipSkillStatus?: RelationshipSkillStatus;
  relationshipSkillMessage?: string;
  terminalActivity?: "connected" | "running";
  onSessionModeChange: (mode: ChatSessionMode) => void;
  onNewSession: () => void;
  onClearAttachments: () => void;
  onNeedUpload: (files: FileList) => void;
  onRelationshipSkillStatusChange: (status: RelationshipSkillStatus, message?: string, installedVersion?: string, requiredVersion?: string) => void;
  onEnableLocalControl: () => void;
  onDisableLocalControl: () => void;
  onRelationshipSkillInstallRequired: () => void;
  onTerminalActivityChange: (state: "connected" | "running") => void;
}

export interface ChatPanelHandle {
  revealTerminal: () => void;
  requestRelationshipSkillCheck: (reason?: "user-click" | "new-session-inherited" | "file-transfer") => void;
  sendRelationshipSkillInstallPrompt: (prompt: string) => void;
  promptEnableLocalControl: () => void;
}

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel({
  sessionKey,
  agentId,
  sessionMode,
  clientIdentity,
  attachments,
  relationshipSkillCheckNonce = 0,
  localControlConsent = false,
  localControlRuntime = "idle",
  localControlScope,
  relationshipSkillStatus = "unknown",
  relationshipSkillMessage,
  terminalActivity = "connected",
  onSessionModeChange,
  onNewSession,
  onClearAttachments,
  onNeedUpload,
  onRelationshipSkillStatusChange,
  onEnableLocalControl,
  onDisableLocalControl,
  onRelationshipSkillInstallRequired,
  onTerminalActivityChange
}: Props, ref) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [socketState, setSocketState] = useState("idle");
  const [socketReconnectNonce, setSocketReconnectNonce] = useState(0);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [attachmentContext, setAttachmentContext] = useState("");
  const [attachmentContextOpen, setAttachmentContextOpen] = useState(false);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [fileGateOpen, setFileGateOpen] = useState(false);
  const [pendingFileSend, setPendingFileSend] = useState(false);
  // Prompt 浮动球只保存在当前浏览器，避免把个人常用 prompt 同步到远端或其他设备。
  const [promptPresets, setPromptPresets] = useState<PromptPreset[]>(() => loadPromptPresets());
  const [editingPreset, setEditingPreset] = useState<PromptPreset | null>(null);
  const [presetEditorOpen, setPresetEditorOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<LogFilterLevel>(DEFAULT_LOG_FILTER);
  const [models, setModels] = useState<GatewayModelOption[]>([]);
  const [modelState, setModelState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [modelError, setModelError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => window.localStorage.getItem(modelStorageKey(null, CHAT_MODEL_STORAGE_KEY)) || "");
  const [chatFontSize, setChatFontSize] = useState(() => {
    const saved = Number(window.localStorage.getItem("detaches.chatFontSize"));
    return Number.isFinite(saved) && saved >= 12 && saved <= 20 ? saved : 14;
  });
  const socketRef = useRef<WebSocket | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalPanelHandle | null>(null);
  const logStreamRef = useRef<HTMLDivElement | null>(null);
  const composerDragDepthRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const cloudPromptLogIdsRef = useRef<Set<string>>(new Set());
  const relationshipSkillCheckSeqRef = useRef(0);
  const lastRelationshipSkillCheckNonceRef = useRef(0);
  const runtimeCheckSessionRef = useRef<string | null>(null);
  const pendingInstallCheckRef = useRef(false);

  useImperativeHandle(ref, () => ({
    revealTerminal: () => terminalRef.current?.reveal(),
    requestRelationshipSkillCheck: (reason = "user-click") => sendRelationshipSkillCheck(reason),
    sendRelationshipSkillInstallPrompt: (prompt: string) => {
      pendingInstallCheckRef.current = true;
      sendSystemPrompt(prompt, "relationship-skill-install");
    },
    promptEnableLocalControl: () => setFileGateOpen(true)
  }));

  function sendRelationshipSkillCheck(reason: "user-click" | "new-session-inherited" | "file-transfer") {
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

  function sendSystemPrompt(prompt: string, label: string) {
    const socket = socketRef.current;
    if (!sessionKey || socket?.readyState !== WebSocket.OPEN) return;
    const idempotencyKey = `${label}:${sessionKey}:${Date.now().toString(36)}:${crypto.randomUUID()}`;
    appendLog("info", "prompt", label, { sessionKey, idempotencyKey });
    socket.send(JSON.stringify({
      type: "send",
      message: prompt,
      idempotencyKey,
      // 安装/检查类 prompt 不能携带 detaches context，否则会在启用前污染普通会话。
      includeLocalControlContext: false,
      includeStagedFileContext: false,
      localControlScope
    }));
  }

  useEffect(() => {
    setSelectedModel(window.localStorage.getItem(modelStorageKey(agentId, CHAT_MODEL_STORAGE_KEY)) || "");
  }, [agentId]);

  useEffect(() => {
    let disposed = false;
    setModelState("loading");
    setModelError(null);
    fetchGatewayModels(agentId)
      .then((response) => {
        if (disposed) return;
        setModels(response.models);
        setSelectedModel((current) => {
          if (current && response.models.length && !response.models.some((model) => model.id === current)) return response.selectedModel || "";
          if (!current && response.selectedModel) return response.selectedModel;
          return current;
        });
        setModelState("ready");
      })
      .catch((error) => {
        if (disposed) return;
        if (isAbortError(error)) {
          setModelState("ready");
          return;
        }
        setModelError(error instanceof Error ? error.message : String(error));
        setModelState("error");
      });
    return () => {
      disposed = true;
    };
  }, [agentId]);

  useEffect(() => {
    const key = modelStorageKey(agentId, CHAT_MODEL_STORAGE_KEY);
    if (selectedModel) window.localStorage.setItem(key, selectedModel);
    else window.localStorage.removeItem(key);
  }, [agentId, selectedModel]);

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
        if (pendingInstallCheckRef.current) {
          // 安装 prompt 只代表请求已发出；真正 ready 必须由独立 check prompt 证明。
          pendingInstallCheckRef.current = false;
          sendRelationshipSkillCheck("user-click");
        }
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
    // New session 可能先更新 nonce、后建立 socket；必须等 connected 后再发送检查 prompt。
    if (socketState !== "connected") return;
    if (relationshipSkillCheckNonce <= lastRelationshipSkillCheckNonceRef.current) return;
    lastRelationshipSkillCheckNonceRef.current = relationshipSkillCheckNonce;
    sendRelationshipSkillCheck("new-session-inherited");
  }, [relationshipSkillCheckNonce, socketState]);

  useEffect(() => {
    // 兜底：只要当前 session 处于 checking 且用户已授权，就确保本 session 至少检查一次。
    if (!sessionKey || socketState !== "connected") return;
    if (!localControlConsent || localControlRuntime !== "checking") return;
    if (runtimeCheckSessionRef.current === sessionKey) return;
    runtimeCheckSessionRef.current = sessionKey;
    sendRelationshipSkillCheck("user-click");
  }, [localControlConsent, localControlRuntime, sessionKey, socketState]);

  useEffect(() => {
    if (!pendingFileSend || localControlRuntime !== "ready") return;
    setPendingFileSend(false);
    setFileGateOpen(false);
    sendCurrentMessage({ includeLocalControlContext: true, includeStagedFileContext: true, activationReason: "file-transfer" });
  }, [pendingFileSend, localControlRuntime]);

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

  function savePromptPresets(next: PromptPreset[]) {
    setPromptPresets(next);
    window.localStorage.setItem(PROMPT_PRESETS_STORAGE_KEY, JSON.stringify(next));
  }

  function openPresetEditor(preset?: PromptPreset) {
    setEditingPreset(preset ?? null);
    setPresetEditorOpen(true);
  }

  function savePromptPreset(input: { id?: string; name: string; color: string; prompt: string }) {
    const now = new Date().toISOString();
    const nextPreset: PromptPreset = {
      id: input.id || crypto.randomUUID(),
      name: input.name.trim().slice(0, 12) || "Prompt",
      color: input.color || PRESET_COLORS[0],
      prompt: input.prompt.trim(),
      updatedAt: now
    };
    const next = input.id
      ? promptPresets.map((preset) => preset.id === input.id ? nextPreset : preset)
      : [...promptPresets, nextPreset];
    savePromptPresets(next);
    setPresetEditorOpen(false);
    setEditingPreset(null);
  }

  function deletePromptPreset(id: string) {
    savePromptPresets(promptPresets.filter((preset) => preset.id !== id));
    setPresetEditorOpen(false);
    setEditingPreset(null);
  }

  function prependPromptToDraft(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setDraft((current) => current.trim() ? `${trimmed}\n\n${current}` : trimmed);
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
    if (attachments.length && localControlRuntime !== "ready") {
      // 本机暂存文件默认只在 Detach Agent 机器上；未启用文件 gate 前不能暴露 transfer 指令。
      setFileGateOpen(true);
      return;
    }
    sendCurrentMessage({
      includeLocalControlContext: localControlRuntime === "ready",
      includeStagedFileContext: attachments.length > 0 && localControlRuntime === "ready",
      activationReason: localControlRuntime === "ready" ? "user-click" : undefined
    });
  }

  function sendCurrentMessage(options: {
    includeLocalControlContext: boolean;
    includeStagedFileContext: boolean;
    activationReason?: "user-click" | "new-session-inherited" | "file-transfer";
    fileDescriptionOnly?: boolean;
  }) {
    if (!canSend && !options.fileDescriptionOnly) return;
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    const text = draft.trim();
    const messageTextToSend = options.fileDescriptionOnly
      ? `${text}\n\n${buildFileDescriptionOnlyContext(attachments)}`.trim()
      : text;
    const idempotencyKey = crypto.randomUUID();
    appendLog("info", "prompt", "chat-send", {
      sessionKey,
      sessionMode,
      idempotencyKey,
      messageLength: messageTextToSend.length,
      attachmentCount: options.includeStagedFileContext ? attachments.length : 0,
      includeLocalControlContext: options.includeLocalControlContext,
      includeStagedFileContext: options.includeStagedFileContext,
      activationReason: options.activationReason
    });
    socketRef.current?.send(JSON.stringify({
      type: "send",
      message: messageTextToSend,
      attachments: options.fileDescriptionOnly ? [] : attachments,
      attachmentContextOverride: options.includeStagedFileContext && attachments.length ? attachmentContext : undefined,
      includeLocalControlContext: options.includeLocalControlContext,
      includeStagedFileContext: options.includeStagedFileContext,
      activationReason: options.activationReason,
      localControlScope,
      model: selectedModel || undefined,
      idempotencyKey
    }));
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: messageTextToSend,
        timestamp: new Date().toISOString(),
        attachments: attachments.map((file) => ({ name: file.name, remotePath: file.remotePath, size: file.size, mimeType: file.mimeType }))
      }
    ]);
    setDraft("");
    onClearAttachments();
  }

  function handleComposerDragEnter(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event) || !sessionKey) return;
    event.preventDefault();
    composerDragDepthRef.current += 1;
    setComposerDragActive(true);
  }

  function handleComposerDragOver(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event) || !sessionKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleComposerDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event) || !sessionKey) return;
    event.preventDefault();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setComposerDragActive(false);
  }

  function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event) || !sessionKey) return;
    event.preventDefault();
    composerDragDepthRef.current = 0;
    setComposerDragActive(false);
    if (event.dataTransfer.files.length) onNeedUpload(event.dataTransfer.files);
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
              onTerminalActivityChange={onTerminalActivityChange}
              onLog={appendLog}
            />
            {message.attachments?.map((attachment) => (
              <small className="attachment-chip" key={`${message.id}-${attachment.name}`}>{attachment.name}</small>
            ))}
          </article>
        ))}
        {!sessionKey ? <div className="empty-state large">左侧选择一个远端 Agent 后开始聊天。</div> : null}
      </div>
      <PromptPresetRail
        presets={promptPresets}
        onInsert={prependPromptToDraft}
        onEdit={openPresetEditor}
        onCreate={() => openPresetEditor()}
      />
      {presetEditorOpen ? (
        <PromptPresetEditor
          preset={editingPreset}
          onSave={savePromptPreset}
          onDelete={editingPreset ? () => deletePromptPreset(editingPreset.id) : undefined}
          onClose={() => {
            setPresetEditorOpen(false);
            setEditingPreset(null);
          }}
        />
      ) : null}
      <TerminalPanel
        ref={terminalRef}
        sessionKey={sessionKey}
        title="Agent Control Terminal"
        emptyText="这个终端用于观察 Cloud Agent 在本机执行的审批后操作。"
        localControlRuntime={localControlRuntime}
        localControlConsent={localControlConsent}
        relationshipSkillStatus={relationshipSkillStatus}
        relationshipSkillMessage={relationshipSkillMessage}
        activityState={terminalActivity}
        onEnableLocalControl={onEnableLocalControl}
          onDisableLocalControl={onDisableLocalControl}
          onInstallRelationshipSkill={onRelationshipSkillInstallRequired}
        />
      {fileGateOpen ? (
        <FileSendGateDialog
          runtime={localControlRuntime}
          consent={localControlConsent}
          onEnable={() => {
            setPendingFileSend(true);
            onEnableLocalControl();
          }}
          onDescriptionOnly={() => {
            setPendingFileSend(false);
            setFileGateOpen(false);
            sendCurrentMessage({ includeLocalControlContext: false, includeStagedFileContext: false, fileDescriptionOnly: true });
          }}
          onCancel={() => {
            setPendingFileSend(false);
            setFileGateOpen(false);
          }}
        />
      ) : null}
      <form
        className={`composer ${composerDragActive ? "drag-over" : ""}`}
        onSubmit={submit}
        onDragEnter={handleComposerDragEnter}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
      >
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
        <ModelSelect
          value={selectedModel}
          models={models}
          state={modelState}
          error={modelError}
          onChange={setSelectedModel}
        />
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="发送消息给远端 OpenClaw..." />
        <button className="send-button" disabled={!canSend}>
          <Send size={18} />
          Send
        </button>
      </form>
    </main>
  );
});

function PromptPresetRail({
  presets,
  onInsert,
  onEdit,
  onCreate
}: {
  presets: PromptPreset[];
  onInsert: (prompt: string) => void;
  onEdit: (preset: PromptPreset) => void;
  onCreate: () => void;
}) {
  const clickTimerRef = useRef<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  function clearClickTimer() {
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }

  useEffect(() => () => clearClickTimer(), []);

  return (
    <aside className={`prompt-preset-rail ${mobileOpen ? "mobile-open" : ""}`} aria-label="Prompt presets">
      <button
        type="button"
        className="prompt-preset-mobile-toggle"
        title={mobileOpen ? "收起 prompt 浮动球" : "展开 prompt 浮动球"}
        aria-label={mobileOpen ? "收起 prompt 浮动球" : "展开 prompt 浮动球"}
        onClick={() => setMobileOpen((current) => !current)}
      >
        P
      </button>
      <div className="prompt-preset-list">
        {presets.map((preset) => (
          <button
            type="button"
            className="prompt-preset-ball"
            style={{ "--preset-color": preset.color } as CSSProperties}
            title={preset.name}
            aria-label={`插入 ${preset.name}`}
            key={preset.id}
            onClick={() => {
              // 用短延迟区分单击插入和双击编辑，避免双击时先把 prompt 塞进输入框。
              clearClickTimer();
              clickTimerRef.current = window.setTimeout(() => {
                clickTimerRef.current = null;
                onInsert(preset.prompt);
              }, PRESET_CLICK_DELAY_MS);
            }}
            onDoubleClick={() => {
              clearClickTimer();
              onEdit(preset);
            }}
          >
            {presetLabel(preset.name)}
          </button>
        ))}
      </div>
      <button type="button" className="prompt-preset-add" title="新增 prompt 浮动球" aria-label="新增 prompt 浮动球" onClick={onCreate}>
        <Plus size={17} />
      </button>
    </aside>
  );
}

function ModelSelect({
  value,
  models,
  state,
  error,
  onChange
}: {
  value: string;
  models: GatewayModelOption[];
  state: "idle" | "loading" | "ready" | "error";
  error: string | null;
  onChange: (value: string) => void;
}) {
  const knownSelected = !value || models.some((model) => model.id === value);
  const title = error || (models.length ? "选择本次发送使用的模型" : "Gateway 未提供模型列表，使用 Agent 默认模型");
  return (
    <select
      className="model-select"
      value={value}
      title={title}
      aria-label="选择模型"
      onChange={(event) => onChange(event.target.value)}
      disabled={state === "loading" && !models.length}
    >
      <option value="">{state === "loading" ? "模型..." : "自动模型"}</option>
      {!knownSelected && value ? <option value={value}>{value}</option> : null}
      {models.map((model) => (
        <option value={model.id} key={model.id}>
          {model.provider ? `${model.label} · ${model.provider}` : model.label}
        </option>
      ))}
    </select>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function modelStorageKey(agentId: string | null | undefined, baseKey: string): string {
  return agentId ? `${baseKey}.${agentId}` : baseKey;
}

function PromptPresetEditor({
  preset,
  onSave,
  onDelete,
  onClose
}: {
  preset: PromptPreset | null;
  onSave: (input: { id?: string; name: string; color: string; prompt: string }) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(preset?.name ?? "");
  const [color, setColor] = useState(preset?.color ?? PRESET_COLORS[0]);
  const [prompt, setPrompt] = useState(preset?.prompt ?? "");
  const canSave = prompt.trim().length > 0;

  useEffect(() => {
    setName(preset?.name ?? "");
    setColor(preset?.color ?? PRESET_COLORS[0]);
    setPrompt(preset?.prompt ?? "");
  }, [preset]);

  return (
    <div className="prompt-preset-editor-backdrop" role="presentation">
      <section className="prompt-preset-editor" role="dialog" aria-modal="true" aria-label={preset ? "编辑 prompt 浮动球" : "新增 prompt 浮动球"}>
        <header>
          <div>
            <strong>{preset ? "编辑浮动球" : "新增浮动球"}</strong>
            <small>单击插入，双击编辑</small>
          </div>
          <button type="button" className="icon-button small" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <label>
          <span>名称</span>
          <input value={name} maxLength={12} onChange={(event) => setName(event.target.value)} placeholder="例如：复盘" />
        </label>
        <div className="prompt-preset-color-field">
          <span>颜色</span>
          <div className="prompt-preset-swatches">
            {PRESET_COLORS.map((item) => (
              <button
                type="button"
                className={item === color ? "active" : ""}
                style={{ background: item }}
                aria-label={`选择颜色 ${item}`}
                key={item}
                onClick={() => setColor(item)}
              />
            ))}
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="自定义颜色" />
          </div>
        </div>
        <label className="prompt-preset-prompt-field">
          <span>Prompt</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="输入要插入到消息开头的 prompt..." />
        </label>
        <footer>
          {onDelete ? (
            <button type="button" className="secondary-button danger" onClick={onDelete}>
              <Trash2 size={14} />
              删除
            </button>
          ) : <span />}
          <div>
            <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            <button type="button" className="primary-button" disabled={!canSave} onClick={() => onSave({ id: preset?.id, name, color, prompt })}>保存</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function FileSendGateDialog({
  runtime,
  consent,
  onEnable,
  onDescriptionOnly,
  onCancel
}: {
  runtime: "idle" | "checking" | "install_required" | "installing" | "ready" | "error";
  consent: boolean;
  onEnable: () => void;
  onDescriptionOnly: () => void;
  onCancel: () => void;
}) {
  const busy = runtime === "checking" || runtime === "installing";
  return (
    <div className="save-password-backdrop" role="presentation">
      <section className="save-password-dialog" role="dialog" aria-modal="true" aria-label="本机文件发送方式">
        <header className="save-password-header">
          <FileText size={20} />
          <div>
            <strong>本机暂存文件</strong>
            <small>{consent ? "当前会话正在准备本机文件传输能力。" : "选择本次消息如何描述这些文件。"}</small>
          </div>
          <button type="button" className="icon-button small" title="关闭" onClick={onCancel}>
            <X size={15} />
          </button>
        </header>
        <div className="save-password-content">
          <section>
            <h3>发送方式</h3>
            <p className="save-password-note">启用本机文件传输后，Agent 才会收到 staged file transfer 上下文。只发送文件说明不会让 Agent 误以为可以读取文件内容。</p>
          </section>
        </div>
        <footer className="save-password-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
          <button type="button" className="secondary-button" onClick={onDescriptionOnly} disabled={busy}>只发送文件说明</button>
          <button type="button" className="primary-button" onClick={onEnable} disabled={busy}>{busy ? "准备中..." : "启用本机文件传输"}</button>
        </footer>
      </section>
    </div>
  );
}

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
  onTerminalActivityChange,
  onLog
}: {
  text: string;
  sessionKey: string | null;
  agentId: string | null;
  sourceMessageId: string;
  sourceRunId?: string;
  clientIdentity: ClientIdentity | null;
  onReveal: () => void;
  onTerminalActivityChange: (state: "connected" | "running") => void;
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
            if (transfer.status === "succeeded") {
              setErrors((current) => clearIndexedValue(current, index));
            }
          }
          if (transfer && (transfer.status === "succeeded" || transfer.status === "failed")) {
            delete pollTimersRef.current[index];
            setHandled((current) => ({ ...current, [index]: transfer.status === "succeeded" ? "approved" : "error" }));
            setErrors((current) => transfer.status === "succeeded"
              ? clearIndexedValue(current, index)
              : transfer.error
                ? { ...current, [index]: transfer.error }
                : current);
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
        const latestTransferSucceeded = transfer?.status === "succeeded";
        const displayRequestError = latestTransferSucceeded ? undefined : request.error;
        const displayInlineError = latestTransferSucceeded ? undefined : errors[index];
        return (
          <div className={`terminal-request-card ${request.kind === "file-transfer" ? "file-transfer-card" : ""}`} key={request.id}>
            <div>
              <strong>{toolRequestTitle(request)} request</strong>
              <p className={`target-pill ${request.target}`}>Target: {targetLabels[request.target]}</p>
              {request.risk ? <p className={`risk-pill ${request.risk.level}`}>Risk: {request.risk.level}{request.risk.reasons.length ? ` · ${request.risk.reasons.join("; ")}` : ""}</p> : null}
              {request.reason ? <p>{request.reason}</p> : null}
              <code>{toolRequestCode(request)}</code>
              <small>requestId: {request.id}</small>
              {displayRequestError ? <p className="request-error">{displayRequestError}</p> : null}
              {unsupported ? <p className="request-error">{unsupportedTargetMessage(request)}</p> : null}
              {displayInlineError ? <p className="request-error">{displayInlineError}</p> : null}
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
                  if (request.kind === "terminal") onTerminalActivityChange("running");
                  approveToolRequest(request.id, { riskAccepted: request.risk?.level === "elevated", actor: decisionActor(clientIdentity) })
                    .then((response) => {
                      if (!response.execution?.wroteToTerminal && request.kind !== "main-agent-save-file") throw new Error(response.message || "Broker did not execute the request.");
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
                      if (transfer) {
                        setTransfers((current) => ({ ...current, [index]: transfer }));
                        if (transfer.status === "succeeded") {
                          setErrors((current) => clearIndexedValue(current, index));
                          setHandled((current) => ({ ...current, [index]: "approved" }));
                        } else if (transfer.status === "failed" && transfer.error) {
                          setErrors((current) => ({ ...current, [index]: transfer.error || "" }));
                          setHandled((current) => ({ ...current, [index]: "error" }));
                        }
                      }
                      if (request.kind === "main-agent-save-file") scheduleMainAgentTransferPoll(request, index);
                      if (request.kind === "terminal") onTerminalActivityChange("connected");
                    })
                    .catch((error) => {
                      onLog("error", "tool", "tool-request-approve-failed", { id: request.id, error });
                      setErrors((current) => ({ ...current, [index]: error instanceof Error ? error.message : String(error) }));
                      setHandled((current) => ({ ...current, [index]: "error" }));
                      if (request.kind === "terminal") onTerminalActivityChange("connected");
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
                  if (request.kind === "terminal") onTerminalActivityChange("connected");
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

function clearIndexedValue<T>(record: Record<number, T>, index: number): Record<number, T> {
  if (!(index in record)) return record;
  const next = { ...record };
  delete next[index];
  return next;
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

function buildFileDescriptionOnlyContext(attachments: UploadedFileRef[]): string {
  if (!attachments.length) return "";
  return [
    "[本机暂存文件说明]",
    "这些文件只在 Detach Agent 用户本机暂存。本次消息没有启用本机文件传输上下文；不要假设你可以读取文件内容、访问 sourceLocalPath，或生成 main-agent-save-file 请求。",
    "",
    ...attachments.map((file, index) => [
      `${index + 1}. ${displayFileName(file)}`,
      `   size: ${formatFileSize(file.size)}`,
      `   mimeType: ${file.mimeType || "application/octet-stream"}`
    ].join("\n"))
  ].join("\n");
}

function loadPromptPresets(): PromptPreset[] {
  try {
    const raw = window.localStorage.getItem(PROMPT_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is PromptPreset => Boolean(item)
        && typeof item.id === "string"
        && typeof item.name === "string"
        && typeof item.color === "string"
        && typeof item.prompt === "string")
      .map((item) => ({ ...item, updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString() }));
  } catch {
    return [];
  }
}

function presetLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "+";
  const chars = Array.from(trimmed.replace(/\s+/g, ""));
  return chars.slice(0, 2).join("");
}

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
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
