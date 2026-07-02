import { type CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Copy, ExternalLink, FileText, Folder, Library, MessageCircle, Plus, RefreshCw, Send, Settings, Square, X } from "lucide-react";
import type { AgentSummary, ChatMessage, ChatSessionMode, ChatSocketServerEvent, ClientIdentity, LibraryConfigResponse, LibraryEntry, LibraryPathResolution, LibraryServerConfig } from "@detaches/shared";
import {
  activateLibraryServer,
  checkLibraryUrl,
  fetchLibraryConfig,
  fetchLibraryDirectory,
  resolveLibraryPath,
  saveLibraryServer,
  testLibraryServer,
  wsUrl
} from "../../lib/api.js";

const DEFAULT_LIBRARY_PORT = 8000;
const FLOAT_STORAGE_KEY = "detaches.library.floatPosition.v1";

interface Props {
  selectedAgent: AgentSummary | null;
  clientIdentity: ClientIdentity | null;
}

interface RecommendedFile {
  id: string;
  title: string;
  absolutePath: string;
  reason?: string;
  snippet?: string;
  resolution: LibraryPathResolution;
}

interface SelectedFile {
  source: "directory" | "recommendation" | "recent";
  title: string;
  absolutePath?: string;
  relativePath: string;
  displayPath: string;
  url: string;
}

interface DirectoryNodeState {
  entries?: LibraryEntry[];
  expanded?: boolean;
  loading?: boolean;
  error?: string;
}

interface FloatPosition {
  x: number;
  y: number;
}

export function LibraryPage({ selectedAgent, clientIdentity }: Props) {
  const [config, setConfig] = useState<LibraryConfigResponse | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", host: "", port: String(DEFAULT_LIBRARY_PORT), agentRootPath: "" });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"root" | "recommended" | "recent">("root");
  const [filter, setFilter] = useState("");
  const [tree, setTree] = useState<Record<string, DirectoryNodeState>>({});
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [readerKey, setReaderKey] = useState(0);
  const [readerNotice, setReaderNotice] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<RecommendedFile[]>([]);
  const [recent, setRecent] = useState<SelectedFile[]>([]);
  const [floatOpen, setFloatOpen] = useState(false);
  const [floatPos, setFloatPos] = useState<FloatPosition>(() => loadFloatPosition());

  const activeServer = useMemo(() => {
    if (!config) return null;
    return config.servers.find((server) => server.id === config.activeServerId) ?? config.servers[0] ?? null;
  }, [config]);

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    if (!config) return;
    const server = activeServer;
    setForm(server
      ? { id: server.id, name: server.name, host: server.host, port: String(server.port), agentRootPath: server.agentRootPath }
      : { id: "", name: "", host: defaultLibraryHost(config), port: String(DEFAULT_LIBRARY_PORT), agentRootPath: config.suggestedAgentRootPath });
    setConfigOpen(!server);
  }, [config, activeServer]);

  useEffect(() => {
    setTree({});
    setSelectedFile(null);
    setReaderNotice(null);
    if (activeServer) void loadDirectory("");
  }, [activeServer?.id]);

  async function loadConfig() {
    setConfigLoading(true);
    setConfigError(null);
    try {
      setConfig(await fetchLibraryConfig());
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      setConfigLoading(false);
    }
  }

  async function saveConfig(event?: FormEvent) {
    event?.preventDefault();
    setFormBusy(true);
    setFormError(null);
    try {
      const next = await saveLibraryServer({
        id: form.id || undefined,
        name: form.name,
        host: form.host,
        port: Number.parseInt(form.port, 10),
        agentRootPath: form.agentRootPath
      });
      setConfig(next);
      const server = next.servers.find((candidate) => candidate.id === next.activeServerId);
      if (server) {
        try {
          setConfig(await testLibraryServer(server.id));
        } catch (testError) {
          setFormError(`配置已保存，但连接测试失败：${testError instanceof Error ? testError.message : String(testError)}`);
          await loadConfig();
          return;
        }
      }
      setConfigOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setFormBusy(false);
    }
  }

  async function selectServer(id: string) {
    try {
      setConfig(await activateLibraryServer(id));
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadDirectory(relativePath: string) {
    if (!activeServer) return;
    setTree((current) => ({
      ...current,
      [relativePath]: { ...current[relativePath], loading: true, error: undefined }
    }));
    try {
      const response = await fetchLibraryDirectory(activeServer.id, relativePath);
      setTree((current) => ({
        ...current,
        [relativePath]: {
          entries: response.entries,
          expanded: relativePath === "" ? true : current[relativePath]?.expanded ?? true,
          loading: false
        }
      }));
    } catch (error) {
      setTree((current) => ({
        ...current,
        [relativePath]: {
          ...current[relativePath],
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }));
    }
  }

  async function toggleDirectory(entry: LibraryEntry) {
    const state = tree[entry.relativePath];
    if (!state?.entries && !state?.loading) {
      setTree((current) => ({ ...current, [entry.relativePath]: { expanded: true, loading: true } }));
      await loadDirectory(entry.relativePath);
      return;
    }
    setTree((current) => ({
      ...current,
      [entry.relativePath]: { ...current[entry.relativePath], expanded: !current[entry.relativePath]?.expanded }
    }));
  }

  async function openEntry(entry: LibraryEntry, source: SelectedFile["source"] = "directory") {
    if (entry.type === "directory") {
      await toggleDirectory(entry);
      return;
    }
    if (!entry.url) return;
    openFile({
      source,
      title: entry.name,
      absolutePath: entry.absolutePath,
      relativePath: entry.relativePath,
      displayPath: entry.displayPath,
      url: entry.url
    });
  }

  async function openRecommended(file: RecommendedFile) {
    if (file.resolution.status !== "ok" || !file.resolution.url || !file.resolution.relativePath) return;
    openFile({
      source: "recommendation",
      title: file.title,
      absolutePath: file.absolutePath,
      relativePath: file.resolution.relativePath,
      displayPath: file.resolution.displayPath || file.resolution.relativePath,
      url: file.resolution.url
    });
  }

  function openFile(file: SelectedFile) {
    setSelectedFile(file);
    setReaderNotice(null);
    setReaderKey((current) => current + 1);
    setRecent((current) => [file, ...current.filter((item) => item.url !== file.url)].slice(0, 12));
  }

  async function checkSelectedUrl() {
    if (!activeServer || !selectedFile) return;
    try {
      const response = await checkLibraryUrl(activeServer.id, selectedFile.relativePath);
      if (!response.ok) {
        setReaderNotice(buildNotFoundNotice(activeServer, selectedFile, response.status));
      }
    } catch (error) {
      setReaderNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function resolveRecommendedFiles(files: Array<{ title?: string; absolutePath?: string; reason?: string; snippet?: string }>) {
    if (!activeServer) return;
    const resolved: RecommendedFile[] = [];
    for (const file of files) {
      if (!file.absolutePath) continue;
      const resolution = await resolveLibraryPath(activeServer.id, file.absolutePath).catch((error): LibraryPathResolution => ({
        status: "invalid",
        absolutePath: file.absolutePath || "",
        message: error instanceof Error ? error.message : String(error)
      }));
      resolved.push({
        id: `${file.absolutePath}:${resolved.length}`,
        title: file.title || file.absolutePath.split("/").pop() || file.absolutePath,
        absolutePath: file.absolutePath,
        reason: file.reason,
        snippet: file.snippet,
        resolution
      });
    }
    if (!resolved.length) return;
    setRecommended((current) => mergeRecommended(current, resolved));
    setActiveTab("recommended");
  }

  const filteredRoot = filterEntries(tree[""]?.entries ?? [], filter);

  if (configLoading) {
    return <div className="library-workspace"><div className="library-loading">正在读取图书馆配置...</div></div>;
  }

  return (
    <div className="library-workspace">
      <header className="library-toolbar">
        <div className="library-title">
          <Library size={18} />
          <strong>图书馆</strong>
          {activeServer ? <span>{activeServer.host}:{activeServer.port}</span> : <span>未配置服务</span>}
        </div>
        <div className="library-service-controls">
          <select
            value={activeServer?.id || ""}
            onChange={(event) => void selectServer(event.target.value)}
            disabled={!config?.servers.length}
            title="图书馆服务"
          >
            {config?.servers.map((server) => (
              <option value={server.id} key={server.id}>{server.name} · {server.host}:{server.port}</option>
            ))}
          </select>
          <span className="library-agent-root">{activeServer?.agentRootPath || "Agent 根目录未配置"}</span>
          <button type="button" className="icon-button" title="新增服务" onClick={() => {
            setForm({ id: "", name: "", host: config ? defaultLibraryHost(config) : browserFallbackHost(), port: String(DEFAULT_LIBRARY_PORT), agentRootPath: config?.suggestedAgentRootPath || "" });
            setConfigOpen(true);
          }}>
            <Plus size={15} />
          </button>
          <button type="button" className="icon-button" title="配置" onClick={() => setConfigOpen(true)}>
            <Settings size={15} />
          </button>
          <button type="button" className="icon-button" title="刷新目录" disabled={!activeServer} onClick={() => void loadDirectory("")}>
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      {configError ? <div className="panel-error">{configError}</div> : null}
      {configOpen || !activeServer ? (
        <LibraryConfigPanel
          form={form}
          defaultHost={config ? defaultLibraryHost(config) : browserFallbackHost()}
          busy={formBusy}
          error={formError}
          onChange={setForm}
          onSubmit={saveConfig}
          onClose={activeServer ? () => setConfigOpen(false) : undefined}
        />
      ) : (
        <div className="library-main">
          <aside className="library-sidebar">
            <div className="library-tabs">
              <button className={activeTab === "root" ? "active" : ""} onClick={() => setActiveTab("root")}>根目录</button>
              <button className={activeTab === "recommended" ? "active" : ""} onClick={() => setActiveTab("recommended")}>馆员推荐</button>
              <button className={activeTab === "recent" ? "active" : ""} onClick={() => setActiveTab("recent")}>最近打开</button>
            </div>
            <input className="library-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="过滤已加载文件" />
            <div className="library-tree">
              {activeTab === "root" ? (
                <>
                  {tree[""]?.loading ? <div className="library-muted">正在加载根目录...</div> : null}
                  {tree[""]?.error ? <DirectoryError error={tree[""].error} onRetry={() => void loadDirectory("")} /> : null}
                  {filteredRoot.map((entry) => (
                    <LibraryEntryRow
                      key={entry.relativePath}
                      entry={entry}
                      level={0}
                      tree={tree}
                      filter={filter}
                      selectedRelativePath={selectedFile?.relativePath}
                      onOpen={openEntry}
                      onToggle={toggleDirectory}
                    />
                  ))}
                  {!tree[""]?.loading && !tree[""]?.error && filteredRoot.length === 0 ? <div className="library-muted">目录为空或没有匹配项。</div> : null}
                </>
              ) : activeTab === "recommended" ? (
                <RecommendedList files={recommended} onOpen={(file) => void openRecommended(file)} onConfigure={() => setConfigOpen(true)} />
              ) : (
                <RecentList files={recent} onOpen={openFile} />
              )}
            </div>
          </aside>
          <section className="library-reader">
            <header className="library-reader-toolbar">
              <div>
                <strong>{selectedFile?.title || "选择一个文件开始阅读"}</strong>
                <small>{selectedFile?.displayPath || "也可以点击右下角馆员询问 workspace 文档"}</small>
              </div>
              <div className="library-reader-actions">
                <button type="button" className="icon-button" title="刷新预览" disabled={!selectedFile} onClick={() => {
                  setReaderNotice(null);
                  setReaderKey((current) => current + 1);
                }}>
                  <RefreshCw size={15} />
                </button>
                <button type="button" className="icon-button" title="复制链接" disabled={!selectedFile} onClick={() => selectedFile && void navigator.clipboard.writeText(selectedFile.url)}>
                  <Copy size={15} />
                </button>
                <a className={`icon-button ${selectedFile ? "" : "disabled"}`} title="外部打开" href={selectedFile?.url || "#"} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} />
                </a>
              </div>
            </header>
            <div className="library-frame-wrap">
              {selectedFile ? (
                <>
                  <iframe key={readerKey} title="Library reader" src={selectedFile.url} onLoad={() => void checkSelectedUrl()} />
                  {readerNotice ? <ReaderNotice notice={readerNotice} selectedFile={selectedFile} activeServer={activeServer} onConfigure={() => setConfigOpen(true)} /> : null}
                </>
              ) : (
                <div className="library-empty-reader">
                  <Library size={42} />
                  <p>从左侧选择文件，或让图书馆管理员帮你找资料。</p>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <LibraryFloatingChat
        open={floatOpen}
        position={floatPos}
        selectedAgent={selectedAgent}
        clientIdentity={clientIdentity}
        activeServer={activeServer}
        selectedFile={selectedFile}
        recentFiles={recent}
        onPositionChange={setFloatPos}
        onOpenChange={setFloatOpen}
        onRecommendedFiles={(files) => void resolveRecommendedFiles(files)}
      />
    </div>
  );
}

function LibraryConfigPanel({ form, defaultHost, busy, error, onChange, onSubmit, onClose }: {
  form: { id: string; name: string; host: string; port: string; agentRootPath: string };
  defaultHost: string;
  busy: boolean;
  error: string | null;
  onChange: (next: { id: string; name: string; host: string; port: string; agentRootPath: string }) => void;
  onSubmit: (event?: FormEvent) => void;
  onClose?: () => void;
}) {
  return (
    <form className="library-config-panel" onSubmit={onSubmit}>
      <div className="library-config-heading">
        <div>
          <h1>图书馆服务配置</h1>
          <p>默认 IP 已使用当前服务器地址。如 http-server 在其他网卡、内网 IP 或 Tailscale IP 上监听，可以手动修改。</p>
        </div>
        {onClose ? <button type="button" className="icon-button" onClick={onClose}><X size={16} /></button> : null}
      </div>
      <label>服务名称<input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder={`${form.host || defaultHost}:${form.port || DEFAULT_LIBRARY_PORT}`} /></label>
      <div className="library-config-grid">
        <label>Host<input value={form.host} onChange={(event) => onChange({ ...form, host: event.target.value })} placeholder={defaultHost} /></label>
        <label>Port<input value={form.port} onChange={(event) => onChange({ ...form, port: event.target.value })} inputMode="numeric" placeholder="8000" /></label>
      </div>
      <label>Agent 根目录<input value={form.agentRootPath} onChange={(event) => onChange({ ...form, agentRootPath: event.target.value })} placeholder="/mnt/agent/workspace" /></label>
      <p className="library-config-note">Agent 根目录是 Agent 查找文件时看到的 workspace 根路径。图书馆会用它裁剪 Agent 返回的绝对路径，并转换成浏览器 URL。每个端口可以保存不同的 Agent 根目录。</p>
      {error ? <div className="panel-error">{error}</div> : null}
      <div className="library-config-actions">
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "保存中..." : "保存并测试"}</button>
      </div>
    </form>
  );
}

function LibraryEntryRow({ entry, level, tree, filter, selectedRelativePath, onOpen, onToggle }: {
  entry: LibraryEntry;
  level: number;
  tree: Record<string, DirectoryNodeState>;
  filter: string;
  selectedRelativePath?: string;
  onOpen: (entry: LibraryEntry) => void;
  onToggle: (entry: LibraryEntry) => void;
}) {
  const state = tree[entry.relativePath];
  const children = filterEntries(state?.entries ?? [], filter);
  const expanded = state?.expanded === true;
  return (
    <>
      <button
        type="button"
        className={`library-entry ${selectedRelativePath === entry.relativePath ? "active" : ""}`}
        style={{ paddingLeft: 10 + level * 16 }}
        onClick={() => entry.type === "directory" ? void onToggle(entry) : void onOpen(entry)}
      >
        {entry.type === "directory" ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <FileText size={14} />}
        {entry.type === "directory" ? <Folder size={15} /> : null}
        <span><strong>{entry.name}</strong><small>{entry.displayPath}</small></span>
      </button>
      {state?.loading ? <div className="library-muted nested" style={{ paddingLeft: 30 + level * 16 }}>加载中...</div> : null}
      {state?.error ? <div className="library-muted nested error" style={{ paddingLeft: 30 + level * 16 }}>{state.error}</div> : null}
      {expanded ? children.map((child) => (
        <LibraryEntryRow
          key={child.relativePath}
          entry={child}
          level={level + 1}
          tree={tree}
          filter={filter}
          selectedRelativePath={selectedRelativePath}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      )) : null}
    </>
  );
}

function RecommendedList({ files, onOpen, onConfigure }: { files: RecommendedFile[]; onOpen: (file: RecommendedFile) => void; onConfigure: () => void }) {
  if (!files.length) return <div className="library-muted">馆员找到文件后会显示在这里。</div>;
  return (
    <>
      {files.map((file) => (
        <div
          className={`library-recommendation ${file.resolution.status} ${file.resolution.status === "ok" ? "clickable" : ""}`}
          key={file.id}
          role={file.resolution.status === "ok" ? "button" : undefined}
          tabIndex={file.resolution.status === "ok" ? 0 : -1}
          onClick={() => {
            if (file.resolution.status === "ok") onOpen(file);
          }}
          onKeyDown={(event) => {
            if (file.resolution.status === "ok" && (event.key === "Enter" || event.key === " ")) onOpen(file);
          }}
        >
          <strong>{file.title}</strong>
          <small>{file.resolution.displayPath || file.absolutePath}</small>
          {file.reason ? <p>{file.reason}</p> : null}
          {file.resolution.status !== "ok" ? <em>{file.resolution.message || "无法映射到当前服务"} · 修改路径配置</em> : null}
          {file.resolution.status !== "ok" ? <button type="button" className="secondary-button compact" onClick={onConfigure}>配置</button> : null}
        </div>
      ))}
    </>
  );
}

function RecentList({ files, onOpen }: { files: SelectedFile[]; onOpen: (file: SelectedFile) => void }) {
  if (!files.length) return <div className="library-muted">最近打开的文件会显示在这里。</div>;
  return (
    <>
      {files.map((file) => (
        <button type="button" className="library-recommendation ok" key={file.url} onClick={() => onOpen(file)}>
          <strong>{file.title}</strong>
          <small>{file.displayPath}</small>
        </button>
      ))}
    </>
  );
}

function LibraryFloatingChat({ open, position, selectedAgent, clientIdentity, activeServer, selectedFile, recentFiles, onPositionChange, onOpenChange, onRecommendedFiles }: {
  open: boolean;
  position: FloatPosition;
  selectedAgent: AgentSummary | null;
  clientIdentity: ClientIdentity | null;
  activeServer: LibraryServerConfig | null;
  selectedFile: SelectedFile | null;
  recentFiles: SelectedFile[];
  onPositionChange: (next: FloatPosition) => void;
  onOpenChange: (open: boolean) => void;
  onRecommendedFiles: (files: Array<{ title?: string; absolutePath?: string; reason?: string; snippet?: string }>) => void;
}) {
  const [sessionKey, setSessionKey] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [socketState, setSocketState] = useState("idle");
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; x: number; y: number; dragging: boolean } | null>(null);

  useEffect(() => {
    if (!selectedAgent || !clientIdentity) return;
    setSessionKey(librarySessionKey(selectedAgent, clientIdentity));
    setMessages([]);
    setLastRunId(null);
  }, [selectedAgent?.id, clientIdentity?.deviceIdShort]);

  useEffect(() => {
    if (!open || !sessionKey) return;
    const params = new URLSearchParams({ sessionMode: "device" satisfies ChatSessionMode });
    const ws = new WebSocket(wsUrl(`/api/chat/${encodeURIComponent(sessionKey)}?${params}`));
    socketRef.current = ws;
    setSocketState("connecting");
    ws.onopen = () => setSocketState("connected");
    ws.onclose = () => setSocketState("closed");
    ws.onerror = () => {
      setSocketState("error");
      ws.close();
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ChatSocketServerEvent;
      if (data.type === "history") {
        setMessages(data.payload.messages);
      } else if (data.type === "chat") {
        const message = chatMessageFromPayload(data.payload);
        if (message) {
          setMessages((current) => upsertMessage(current, message));
          const files = extractLibraryFiles(message.text);
          if (files.length) onRecommendedFiles(files);
        }
      } else if (data.type === "sent") {
        setLastRunId(data.payload.runId ?? null);
      } else if (data.type === "error") {
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "system", text: data.message, timestamp: new Date().toISOString() }]);
      }
    };
    return () => ws.close();
  }, [open, sessionKey]);

  function newSession() {
    if (!selectedAgent || !clientIdentity) return;
    setMessages([]);
    setLastRunId(null);
    setSessionKey(librarySessionKey(selectedAgent, clientIdentity));
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || !activeServer || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    const text = draft.trim();
    socketRef.current.send(JSON.stringify({
      type: "send",
      message: text,
      idempotencyKey: crypto.randomUUID(),
      includeLocalControlContext: false,
      includeStagedFileContext: false,
      libraryContext: {
        libraryBaseUrl: `http://${activeServer.host}:${activeServer.port}/`,
        agentRootPath: activeServer.agentRootPath,
        currentRelativePath: selectedFile?.relativePath || "/",
        currentFilePath: selectedFile?.absolutePath || selectedFile?.displayPath || "",
        recentFiles: recentFiles.map((file) => file.absolutePath || file.displayPath)
      }
    }));
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text, timestamp: new Date().toISOString() }]);
    setDraft("");
  }

  function abort() {
    if (!lastRunId) return;
    socketRef.current?.send(JSON.stringify({ type: "abort", runId: lastRunId }));
  }

  function pointerDown(event: ReactMouseEvent<HTMLButtonElement>) {
    dragRef.current = { startX: event.clientX, startY: event.clientY, x: position.x, y: position.y, dragging: false };
    window.addEventListener("mousemove", pointerMove);
    window.addEventListener("mouseup", pointerUp);
  }

  function pointerMove(event: MouseEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const x = Math.max(12, Math.min(window.innerWidth - 64, drag.x + event.clientX - drag.startX));
    const y = Math.max(80, Math.min(window.innerHeight - 64, drag.y + event.clientY - drag.startY));
    drag.dragging = true;
    onPositionChange({ x, y });
    saveFloatPosition({ x, y });
  }

  function pointerUp() {
    const wasDragging = dragRef.current?.dragging;
    dragRef.current = null;
    window.removeEventListener("mousemove", pointerMove);
    window.removeEventListener("mouseup", pointerUp);
    if (!wasDragging) onOpenChange(!open);
  }

  const quadrantClass = position.x < window.innerWidth / 2
    ? position.y < window.innerHeight / 2 ? "bottom-right" : "top-right"
    : position.y < window.innerHeight / 2 ? "bottom-left" : "top-left";

  return (
    <>
      <button
        type="button"
        className="library-float-ball"
        style={{ left: position.x, top: position.y }}
        onMouseDown={pointerDown}
        title="图书馆管理员"
      >
        <MessageCircle size={22} />
      </button>
      {open ? (
        <section className={`library-chat-popover ${quadrantClass}`} style={popoverStyle(position, quadrantClass)}>
          <header>
            <div><strong>图书馆管理员</strong><small>{selectedAgent ? `${selectedAgent.title} · ${socketState}` : "请先选择 Agent"}</small></div>
            <div>
              <button className="icon-button small" type="button" title="新会话" onClick={newSession} disabled={!selectedAgent}><Plus size={14} /></button>
              <button className="icon-button small" type="button" title="停止" onClick={abort} disabled={!lastRunId}><Square size={14} /></button>
              <button className="icon-button small" type="button" title="关闭" onClick={() => onOpenChange(false)}><X size={14} /></button>
            </div>
          </header>
          <div className="library-chat-messages">
            {!selectedAgent ? <div className="library-muted">请先在聊天页选择 Agent。</div> : !activeServer?.agentRootPath ? <div className="library-muted">请先配置当前端口的 Agent 根目录。</div> : null}
            {messages.map((message) => (
              <article className={`library-chat-message ${message.role}`} key={message.id}>
                <span>{message.role}</span>
                <p>{message.text}</p>
              </article>
            ))}
          </div>
          <form className="library-chat-composer" onSubmit={send}>
            <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="询问 workspace 里的文档..." disabled={!selectedAgent || !activeServer?.agentRootPath || socketState !== "connected"} />
            <button className="primary-button compact" disabled={!draft.trim() || !selectedAgent || !activeServer?.agentRootPath || socketState !== "connected"}>
              <Send size={14} />
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}

function DirectoryError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div className="library-directory-error"><p>{error}</p><button type="button" className="secondary-button compact" onClick={onRetry}>重试</button></div>;
}

function ReaderNotice({ notice, selectedFile, activeServer, onConfigure }: { notice: string; selectedFile: SelectedFile; activeServer: LibraryServerConfig; onConfigure: () => void }) {
  const detail = [
    `当前服务：http://${activeServer.host}:${activeServer.port}`,
    `当前端口保存的 Agent 根目录：${activeServer.agentRootPath}`,
    selectedFile.absolutePath ? `Agent 返回路径：${selectedFile.absolutePath}` : "",
    `映射后的浏览路径：${selectedFile.relativePath}`
  ].filter(Boolean).join("\n");
  return (
    <div className="library-reader-notice">
      <strong>文件没有在当前 HTTP 服务中找到。</strong>
      <p>{notice}</p>
      <pre>{detail}</pre>
      <div>
        <button type="button" className="secondary-button compact" onClick={onConfigure}>修改路径配置</button>
        <button type="button" className="secondary-button compact" onClick={() => void navigator.clipboard.writeText(detail)}>复制映射详情</button>
        <a className="secondary-button compact" href={`http://${activeServer.host}:${activeServer.port}/`} target="_blank" rel="noreferrer">打开 HTTP 根目录</a>
      </div>
    </div>
  );
}

function filterEntries(entries: LibraryEntry[], filter: string): LibraryEntry[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return entries;
  return entries.filter((entry) => `${entry.name} ${entry.displayPath}`.toLowerCase().includes(normalized));
}

function buildNotFoundNotice(server: LibraryServerConfig, file: SelectedFile, status: number): string {
  return `HTTP ${status}。请确认当前端口的 http-server 是否暴露了同一份目录结构，以及 ${server.agentRootPath} 是否是 Agent 看到的正确根目录。`;
}

function mergeRecommended(current: RecommendedFile[], next: RecommendedFile[]): RecommendedFile[] {
  const byPath = new Map<string, RecommendedFile>();
  [...next, ...current].forEach((file) => byPath.set(file.absolutePath, file));
  return Array.from(byPath.values()).slice(0, 80);
}

function librarySessionKey(agent: AgentSummary, identity: ClientIdentity): string {
  const agentId = agent.id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "custom";
  const device = identity.deviceIdShort || "local";
  return `agent:${agentId}:library:${device}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function chatMessageFromPayload(payload: unknown): ChatMessage | null {
  const record = payload as Record<string, unknown>;
  const text = collectPayloadText(payload).join("\n").trim();
  if (!text) return null;
  return {
    id: String(record.id || record.messageId || crypto.randomUUID()),
    runId: typeof record.runId === "string" ? record.runId : undefined,
    role: String(record.role || "assistant"),
    text,
    timestamp: new Date().toISOString(),
    raw: payload
  };
}

function collectPayloadText(value: unknown, output: string[] = [], depth = 0): string[] {
  if (value == null || depth > 4) return output;
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPayloadText(item, output, depth + 1));
    return output;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "message", "delta", "answer", "output"]) collectPayloadText(record[key], output, depth + 1);
  }
  return output;
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

function extractLibraryFiles(text: string): Array<{ title?: string; absolutePath?: string; reason?: string; snippet?: string }> {
  const files: Array<{ title?: string; absolutePath?: string; reason?: string; snippet?: string }> = [];
  const pattern = /```library-files\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    try {
      const parsed = JSON.parse(match[1] || "{}") as { files?: Array<{ title?: string; absolutePath?: string; reason?: string; snippet?: string }> };
      if (Array.isArray(parsed.files)) files.push(...parsed.files);
    } catch {
    }
  }
  return files;
}

function loadFloatPosition(): FloatPosition {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FLOAT_STORAGE_KEY) || "") as FloatPosition;
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return parsed;
  } catch {
  }
  return { x: Math.max(24, window.innerWidth - 88), y: Math.max(100, window.innerHeight - 120) };
}

function saveFloatPosition(position: FloatPosition) {
  window.localStorage.setItem(FLOAT_STORAGE_KEY, JSON.stringify(position));
}

function defaultLibraryHost(config: LibraryConfigResponse): string {
  if (config.suggestedHost && config.suggestedHost !== "127.0.0.1") return config.suggestedHost;
  return browserFallbackHost();
}

function browserFallbackHost(): string {
  const host = window.location.hostname;
  return host && host !== "localhost" ? host : "127.0.0.1";
}

function popoverStyle(position: FloatPosition, quadrant: string): CSSProperties {
  const width = Math.min(460, Math.max(360, window.innerWidth * 0.28));
  const height = Math.min(620, Math.max(420, window.innerHeight * 0.48));
  const style: CSSProperties = { width, height };
  if (quadrant.includes("left")) style.left = Math.max(12, position.x - width - 12);
  else style.left = Math.min(window.innerWidth - width - 12, position.x + 58);
  if (quadrant.includes("top")) style.top = Math.max(80, position.y - height - 12);
  else style.top = Math.min(window.innerHeight - height - 12, position.y + 58);
  return style;
}
