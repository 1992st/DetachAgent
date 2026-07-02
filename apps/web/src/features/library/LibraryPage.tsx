import { type CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, Copy, ExternalLink, FileText, Folder, Library, MessageCircle, Plus, RefreshCw, Send, Settings, Square, X } from "lucide-react";
import type { AgentSummary, ChatMessage, ChatSessionMode, ChatSocketServerEvent, ClientIdentity, LibraryConfigResponse, LibraryEntry, LibraryPathResolution, LibraryServerConfig } from "@detaches/shared";
import {
  activateLibraryServer,
  checkLibraryUrl,
  fetchLibraryTextFile,
  fetchLibraryConfig,
  fetchLibraryDirectory,
  libraryFileUrl,
  resolveLibraryPath,
  saveLibraryServer,
  testLibraryServer,
  wsUrl
} from "../../lib/api.js";
import {
  createLibrarySessionKey,
  getLibraryWorkspaceState,
  libraryScopeKey,
  updateLibraryWorkspaceState,
  type DirectoryNodeState,
  type FloatPosition,
  type LibraryActiveTab,
  type LibraryWorkspaceState,
  type RecommendedFile,
  type SelectedFile
} from "./libraryMemoryStore.js";

const DEFAULT_LIBRARY_PORT = 8000;
const LOCAL_DRAWIO_URL = "/vendor/drawio/index.html";
const ONLINE_DRAWIO_URL = "https://embed.diagrams.net/";

interface Props {
  selectedAgent: AgentSummary | null;
  clientIdentity: ClientIdentity | null;
}

export function LibraryPage({ selectedAgent, clientIdentity }: Props) {
  const defaultFloatPosition = useMemo(() => loadFloatPosition(), []);
  const scopeKey = useMemo(
    () => libraryScopeKey(selectedAgent?.id, clientIdentity?.deviceIdShort),
    [selectedAgent?.id, clientIdentity?.deviceIdShort]
  );
  const [workspaceState, setWorkspaceState] = useState(() => getLibraryWorkspaceState(scopeKey, defaultFloatPosition));
  const [config, setConfig] = useState<LibraryConfigResponse | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [form, setForm] = useState({ id: "", name: "", host: "", port: String(DEFAULT_LIBRARY_PORT), agentRootPath: "" });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const activeTab = workspaceState.ui.activeTab;
  const filter = workspaceState.ui.filter;
  const tree = workspaceState.directory.tree;
  const selectedFile = workspaceState.reader.selectedFile;
  const readerKey = workspaceState.reader.readerRevision;
  const readerNotice = workspaceState.reader.readerNotice;
  const recommended = workspaceState.recommendations.files;
  const recent = workspaceState.recent.files;
  const floatOpen = workspaceState.ui.floatOpen;
  const floatPos = workspaceState.ui.floatPosition;
  const configOpen = workspaceState.ui.configOpen;

  const activeServer = useMemo(() => {
    if (!config) return null;
    return config.servers.find((server) => server.id === config.activeServerId) ?? config.servers[0] ?? null;
  }, [config]);

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    setWorkspaceState(getLibraryWorkspaceState(scopeKey, defaultFloatPosition));
  }, [scopeKey, defaultFloatPosition]);

  useEffect(() => {
    if (!config) return;
    const server = activeServer;
    setForm(server
      ? { id: server.id, name: server.name, host: server.host, port: String(server.port), agentRootPath: server.agentRootPath }
      : { id: "", name: "", host: defaultLibraryHost(config), port: String(DEFAULT_LIBRARY_PORT), agentRootPath: config.suggestedAgentRootPath });
    setConfigOpen(!server);
  }, [config, activeServer]);

  useEffect(() => {
    if (!activeServer) return;
    if (workspaceState.directory.loadedServerId === activeServer.id) return;
    updateWorkspace((current) => ({
      ...current,
      activeServerId: activeServer.id,
      reader: { ...current.reader, selectedFile: null, readerNotice: null, readerRevision: current.reader.readerRevision + 1 },
      directory: { tree: {}, loadedServerId: activeServer.id }
    }));
    if (activeServer) void loadDirectory("");
  }, [activeServer?.id, workspaceState.directory.loadedServerId]);

  function updateWorkspace(updater: Parameters<typeof updateLibraryWorkspaceState>[1]) {
    setWorkspaceState(updateLibraryWorkspaceState(scopeKey, updater, defaultFloatPosition));
  }

  function setConfigOpen(open: boolean) {
    updateWorkspace((current) => ({ ...current, ui: { ...current.ui, configOpen: open } }));
  }

  function setActiveTab(tab: LibraryActiveTab) {
    updateWorkspace((current) => ({ ...current, ui: { ...current.ui, activeTab: tab } }));
  }

  function setFilterValue(value: string) {
    updateWorkspace((current) => ({ ...current, ui: { ...current.ui, filter: value } }));
  }

  function setReaderNoticeValue(notice: string | null) {
    updateWorkspace((current) => ({ ...current, reader: { ...current.reader, readerNotice: notice } }));
  }

  function bumpReaderRevision() {
    updateWorkspace((current) => ({ ...current, reader: { ...current.reader, readerNotice: null, readerRevision: current.reader.readerRevision + 1 } }));
  }

  function setFloatOpenValue(open: boolean) {
    updateWorkspace((current) => ({ ...current, ui: { ...current.ui, floatOpen: open } }));
  }

  function setFloatPositionValue(position: FloatPosition) {
    updateWorkspace((current) => ({ ...current, ui: { ...current.ui, floatPosition: position } }));
  }

  function setTreeValue(updater: (current: Record<string, DirectoryNodeState>) => Record<string, DirectoryNodeState>) {
    updateWorkspace((current) => ({ ...current, directory: { ...current.directory, tree: updater(current.directory.tree) } }));
  }

  function setRecommendedValue(updater: (current: RecommendedFile[]) => RecommendedFile[]) {
    updateWorkspace((current) => ({
      ...current,
      recommendations: { files: updater(current.recommendations.files), updatedAt: new Date().toISOString() }
    }));
  }

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
    setTreeValue((current) => ({
      ...current,
      [relativePath]: { ...current[relativePath], loading: true, error: undefined }
    }));
    try {
      const response = await fetchLibraryDirectory(activeServer.id, relativePath);
      setTreeValue((current) => ({
        ...current,
        [relativePath]: {
          entries: response.entries,
          expanded: relativePath === "" ? true : current[relativePath]?.expanded ?? true,
          loading: false
        }
      }));
    } catch (error) {
      setTreeValue((current) => ({
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
      setTreeValue((current) => ({ ...current, [entry.relativePath]: { expanded: true, loading: true } }));
      await loadDirectory(entry.relativePath);
      return;
    }
    setTreeValue((current) => ({
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
    updateWorkspace((current) => ({
      ...current,
      reader: { selectedFile: file, readerNotice: null, readerRevision: current.reader.readerRevision + 1 },
      recent: { files: [file, ...current.recent.files.filter((item) => item.url !== file.url)].slice(0, 12) }
    }));
  }

  async function checkSelectedUrl() {
    if (!activeServer || !selectedFile) return;
    try {
      const response = await checkLibraryUrl(activeServer.id, selectedFile.relativePath);
      if (!response.ok) {
        setReaderNoticeValue(buildNotFoundNotice(activeServer, selectedFile, response.status));
      }
    } catch (error) {
      setReaderNoticeValue(error instanceof Error ? error.message : String(error));
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
    setRecommendedValue((current) => mergeRecommended(current, resolved));
    setActiveTab("recommended");
  }

  const filteredRoot = filterEntries(tree[""]?.entries ?? [], filter);

  if (configLoading) {
    return <div className="library-workspace"><div className="library-loading">正在读取图书馆配置...</div></div>;
  }

  return (
    <div className="library-workspace">
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
            <input className="library-filter" value={filter} onChange={(event) => setFilterValue(event.target.value)} placeholder="过滤已加载文件" />
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
                <small>{selectedFile ? `${fileKindLabel(selectedFile.relativePath)} · ${selectedFile.displayPath}` : "也可以点击右下角馆员询问 workspace 文档"}</small>
              </div>
              <div className="library-reader-actions">
                <select
                  className="library-service-select compact"
                  value={activeServer?.id || ""}
                  onChange={(event) => void selectServer(event.target.value)}
                  disabled={!config?.servers.length}
                  title="图书馆服务"
                >
                  {config?.servers.map((server) => (
                    <option value={server.id} key={server.id}>{server.name} · {server.host}:{server.port}</option>
                  ))}
                </select>
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
                <button type="button" className="icon-button" title="刷新预览" disabled={!selectedFile} onClick={() => {
                  bumpReaderRevision();
                }}>
                  <RefreshCw size={15} />
                </button>
                <button type="button" className="icon-button" title="复制链接" disabled={!selectedFile} onClick={() => selectedFile && void navigator.clipboard.writeText(selectedFile.url)}>
                  <Copy size={15} />
                </button>
                <a className={`icon-button ${selectedFile ? "" : "disabled"}`} title="外部打开" href={selectedFile?.url || "#"} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} />
                </a>
                {selectedFile && (isPdfFile(selectedFile.relativePath) || isDrawioFile(selectedFile.relativePath)) ? <span className="library-reader-badge">只读预览</span> : null}
              </div>
            </header>
            <div className="library-frame-wrap">
              {selectedFile ? (
                <>
                  <LibraryReader
                    key={readerKey}
                    file={selectedFile}
                    serverId={activeServer.id}
                    onNotice={setReaderNoticeValue}
                    onFallbackLoad={() => void checkSelectedUrl()}
                  />
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
        scopeKey={scopeKey}
        defaultFloatPosition={defaultFloatPosition}
        onPositionChange={setFloatPositionValue}
        onOpenChange={setFloatOpenValue}
        onRecommendedFiles={(files) => void resolveRecommendedFiles(files)}
        onWorkspaceChange={setWorkspaceState}
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
      <p className="library-config-note">Agent 根目录用于映射浏览路径。PDF、Markdown 和 draw.io 预览会优先尝试从本机同路径读取，失败时回退当前 HTTP 服务。</p>
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

function LibraryReader({ file, serverId, onNotice, onFallbackLoad }: {
  file: SelectedFile;
  serverId: string;
  onNotice: (notice: string | null) => void;
  onFallbackLoad: () => void;
}) {
  const [vendorState, setVendorState] = useState<"checking" | "ready" | "missing">("checking");
  const [drawioBaseUrl, setDrawioBaseUrl] = useState(LOCAL_DRAWIO_URL);
  const vendorUrl = isPdfFile(file.relativePath) ? "/vendor/pdfjs/web/viewer.html" : isDrawioFile(file.relativePath) ? LOCAL_DRAWIO_URL : "";

  useEffect(() => {
    if (!vendorUrl) {
      setVendorState("ready");
      return;
    }
    let cancelled = false;
    fetch(vendorUrl, { method: "GET" })
      .then(async (response) => {
        if (!response.ok) return false;
        const text = await response.text().catch(() => "");
        return vendorLooksInstalled(vendorUrl, text);
      })
      .then((installed) => {
        if (cancelled) return;
        if (installed) {
          setDrawioBaseUrl(LOCAL_DRAWIO_URL);
          setVendorState("ready");
        } else if (isDrawioFile(file.relativePath) && navigator.onLine) {
          setDrawioBaseUrl(ONLINE_DRAWIO_URL);
          setVendorState("ready");
          onNotice("本地 draw.io 资源未安装，已临时使用在线 embed.diagrams.net。离线使用请运行 pnpm vendors:library。");
        } else {
          setVendorState("missing");
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (isDrawioFile(file.relativePath) && navigator.onLine) {
          setDrawioBaseUrl(ONLINE_DRAWIO_URL);
          setVendorState("ready");
          onNotice("本地 draw.io 资源不可用，已临时使用在线 embed.diagrams.net。");
        } else {
          setVendorState("missing");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vendorUrl]);

  if (vendorState === "checking") {
    return <div className="library-empty-reader"><RefreshCw size={34} /><p>正在检查预览资源...</p></div>;
  }
  if (vendorState === "missing") {
    return (
      <div className="library-empty-reader">
        <FileText size={38} />
        <p>{isPdfFile(file.relativePath) ? "PDF.js 预览资源未安装。" : "draw.io 预览资源未安装。"}</p>
        <small>请运行 pnpm vendors:library 后重新打包，或检查 apps/web/public/vendor。</small>
      </div>
    );
  }

  if (isPdfFile(file.relativePath)) {
    return <iframe title="PDF reader" src={pdfViewerUrl(serverId, file.relativePath)} onLoad={() => onNotice(null)} />;
  }
  if (isDrawioFile(file.relativePath)) {
    return <DrawioPreview file={file} serverId={serverId} drawioBaseUrl={drawioBaseUrl} onNotice={onNotice} />;
  }
  if (isTextFile(file.relativePath)) {
    return <TextReader file={file} serverId={serverId} onNotice={onNotice} />;
  }
  return <iframe title="Library reader" src={file.url} onLoad={onFallbackLoad} />;
}

function TextReader({ file, serverId, onNotice }: { file: SelectedFile; serverId: string; onNotice: (notice: string | null) => void }) {
  const [text, setText] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetchLibraryTextFile(serverId, file.relativePath)
      .then((content) => {
        if (cancelled) return;
        setText(content);
        onNotice(null);
      })
      .catch((error) => {
        if (!cancelled) onNotice(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, file.relativePath]);
  if (isMarkdownFile(file.relativePath)) return <MarkdownPreview source={text} />;
  return <pre className="library-text-reader">{text}</pre>;
}

function MarkdownPreview({ source }: { source: string }) {
  return (
    <article className="library-markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </article>
  );
}

function DrawioPreview({ file, serverId, drawioBaseUrl, onNotice }: { file: SelectedFile; serverId: string; drawioBaseUrl: string; onNotice: (notice: string | null) => void }) {
  const [svg, setSvg] = useState("");
  const [xml, setXml] = useState("");
  const [ready, setReady] = useState(false);
  const [frameSrc, setFrameSrc] = useState("");
  const [status, setStatus] = useState("正在加载 draw.io 预览引擎...");
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const xmlRef = useRef("");
  const svgRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    fetchLibraryTextFile(serverId, file.relativePath)
      .then((text) => {
        if (!cancelled) {
          xmlRef.current = text;
          setXml(text);
          setStatus("正在等待 draw.io 预览引擎...");
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatus("draw.io 文件读取失败。");
        onNotice(message);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, file.relativePath, onNotice]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (!svgRef.current) {
        setStatus("draw.io 预览生成超时。");
        onNotice("draw.io 预览生成超时：未收到 diagrams.net 的 export 响应。请检查本地 vendor/drawio 是否完整，或当前文件 XML 是否可被 draw.io 打开。");
      }
    }, 6000);
    return () => window.clearTimeout(timeout);
  }, [file.relativePath, drawioBaseUrl, onNotice]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = parseDrawioMessage(event.data);
      if (!data) return;
      if (data.event === "init") {
        setReady(true);
        setStatus("正在加载 draw.io 文件...");
      }
      if (data.event === "load" && xmlRef.current && frameRef.current?.contentWindow) {
        setStatus("正在导出 draw.io 预览...");
        frameRef.current.contentWindow.postMessage(JSON.stringify({ action: "export", format: "svg", xml: xmlRef.current, embedImages: true }), "*");
      }
      if (data.event === "export" && typeof data.data === "string") {
        svgRef.current = data.data;
        setSvg(data.data);
        setStatus("");
        onNotice(null);
      }
      if (data.event === "error") {
        setStatus("draw.io 预览导出失败。");
        onNotice("draw.io 预览导出失败。");
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onNotice]);

  useEffect(() => {
    setFrameSrc(drawioEmbedUrl(drawioBaseUrl));
    setReady(false);
    setSvg("");
    svgRef.current = "";
    setStatus("正在加载 draw.io 预览引擎...");
  }, [drawioBaseUrl, file.relativePath]);

  useEffect(() => {
    if (!ready || !xml || !frameRef.current?.contentWindow) return;
    setStatus("正在加载 draw.io 文件...");
    frameRef.current.contentWindow.postMessage(JSON.stringify({ action: "load", xml }), "*");
    const timeout = window.setTimeout(() => {
      if (!svgRef.current && frameRef.current?.contentWindow && xmlRef.current) {
        setStatus("正在导出 draw.io 预览...");
        frameRef.current.contentWindow.postMessage(JSON.stringify({ action: "export", format: "svg", xml: xmlRef.current, embedImages: true }), "*");
      }
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [ready, xml]);

  return (
    <div className="drawio-preview">
      {svg ? <img src={svg} alt={file.title} /> : <div className="library-empty-reader"><FileText size={38} /><p>{status || "正在生成 draw.io 预览..."}</p></div>}
      {frameSrc ? <iframe ref={frameRef} title="draw.io preview worker" className="drawio-hidden-frame" src={frameSrc} /> : null}
    </div>
  );
}


function LibraryFloatingChat({ open, position, selectedAgent, clientIdentity, activeServer, selectedFile, recentFiles, scopeKey, defaultFloatPosition, onPositionChange, onOpenChange, onRecommendedFiles, onWorkspaceChange }: {
  open: boolean;
  position: FloatPosition;
  selectedAgent: AgentSummary | null;
  clientIdentity: ClientIdentity | null;
  activeServer: LibraryServerConfig | null;
  selectedFile: SelectedFile | null;
  recentFiles: SelectedFile[];
  scopeKey: string;
  defaultFloatPosition: FloatPosition;
  onPositionChange: (next: FloatPosition) => void;
  onOpenChange: (open: boolean) => void;
  onRecommendedFiles: (files: Array<{ title?: string; absolutePath?: string; reason?: string; snippet?: string }>) => void;
  onWorkspaceChange: (next: LibraryWorkspaceState) => void;
}) {
  const workspaceState = getLibraryWorkspaceState(scopeKey, defaultFloatPosition);
  const sessionKey = workspaceState.sessionKey;
  const messages = workspaceState.librarianChat.messages;
  const draft = workspaceState.librarianChat.draft;
  const socketState = workspaceState.librarianChat.socketState;
  const lastRunId = workspaceState.librarianChat.lastRunId;
  const socketRef = useRef<WebSocket | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; x: number; y: number; dragging: boolean } | null>(null);
  const onRecommendedFilesRef = useRef(onRecommendedFiles);
  onRecommendedFilesRef.current = onRecommendedFiles;

  useEffect(() => {
    if (!open || !sessionKey) return;
    const params = new URLSearchParams({ sessionMode: "device" satisfies ChatSessionMode });
    const ws = new WebSocket(wsUrl(`/api/chat/${encodeURIComponent(sessionKey)}?${params}`));
    socketRef.current = ws;
    setLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, { socketState: "connecting" });
    ws.onopen = () => setLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, { socketState: "connected" });
    ws.onclose = () => setLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, { socketState: "closed" });
    ws.onerror = () => {
      setLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, { socketState: "error" });
      ws.close();
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ChatSocketServerEvent;
      if (data.type === "history") {
        setLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, {
          messages: data.payload.messages,
          hydratedFromHistory: true
        });
        const files = extractLibraryFilesFromMessages(data.payload.messages);
        if (files.length) onRecommendedFilesRef.current(files);
      } else if (data.type === "chat") {
        const message = chatMessageFromPayload(data.payload);
        if (message) {
          updateLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, (chat) => ({
            ...chat,
            messages: upsertLibraryChat(chat.messages, message)
          }));
          const files = extractLibraryFiles(message.text);
          if (files.length) onRecommendedFilesRef.current(files);
        }
      } else if (data.type === "sent") {
        setLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, { lastRunId: data.payload.runId ?? null });
      } else if (data.type === "error") {
        updateLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, (chat) => ({
          ...chat,
          messages: [...chat.messages, { id: crypto.randomUUID(), role: "system", text: data.message, timestamp: new Date().toISOString() }]
        }));
      }
    };
    return () => ws.close();
  }, [open, sessionKey, scopeKey, defaultFloatPosition]);

  function newSession() {
    if (!selectedAgent || !clientIdentity) return;
    const nextSessionKey = createLibrarySessionKey(scopeKey);
    const next = updateLibraryWorkspaceState(scopeKey, (current) => ({
      ...current,
      sessionKey: nextSessionKey,
      librarianChat: {
        ...current.librarianChat,
        messages: [],
        draft: "",
        socketState: "idle",
        lastRunId: null,
        hydratedFromHistory: false
      }
    }), defaultFloatPosition);
    onWorkspaceChange(next);
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
    updateLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, (chat) => ({
      ...chat,
      messages: [...chat.messages, { id: crypto.randomUUID(), role: "user", text, timestamp: new Date().toISOString() }],
      draft: ""
    }));
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
            {messages.map((message) => {
              const visibleText = displayLibraryChatText(message.text);
              return visibleText ? (
                <article className={`library-chat-message ${message.role}`} key={message.id}>
                  <span>{message.role}</span>
                  <p>{visibleText}</p>
                </article>
              ) : null;
            })}
          </div>
          <form className="library-chat-composer" onSubmit={send}>
            <input value={draft} onChange={(event) => setLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, { draft: event.target.value })} placeholder="询问 workspace 里的文档..." disabled={!selectedAgent || !activeServer?.agentRootPath || socketState !== "connected"} />
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

function setLibraryChatState(
  scopeKey: string,
  defaultFloatPosition: FloatPosition,
  onWorkspaceChange: (next: LibraryWorkspaceState) => void,
  patch: Partial<LibraryWorkspaceState["librarianChat"]>
) {
  updateLibraryChatState(scopeKey, defaultFloatPosition, onWorkspaceChange, (chat) => ({ ...chat, ...patch }));
}

function updateLibraryChatState(
  scopeKey: string,
  defaultFloatPosition: FloatPosition,
  onWorkspaceChange: (next: LibraryWorkspaceState) => void,
  updater: (chat: LibraryWorkspaceState["librarianChat"]) => LibraryWorkspaceState["librarianChat"]
) {
  const next = updateLibraryWorkspaceState(scopeKey, (current) => ({
    ...current,
    librarianChat: updater(current.librarianChat)
  }), defaultFloatPosition);
  onWorkspaceChange(next);
}

function extractLibraryFilesFromMessages(messages: ChatMessage[]): Array<{ title?: string; absolutePath?: string; reason?: string; snippet?: string }> {
  return messages.flatMap((message) => extractLibraryFiles(message.text));
}

function chatMessageFromPayload(payload: unknown): ChatMessage | null {
  const record = payload as Record<string, unknown>;
  const text = collectPayloadText(payload).join("\n").trim();
  if (!text) return null;
  const identity = streamIdentity(record);
  const runId = runIdentity(record);
  return {
    id: identity ?? crypto.randomUUID(),
    runId,
    role: roleFromGatewayPayload(record),
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

function upsertLibraryChat(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = findExistingLibraryMessage(messages, message);
  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = {
    ...next[index],
    runId: next[index].runId ?? message.runId,
    text: mergeLibraryStreamText(next[index].text, message.text, message.raw),
    timestamp: message.timestamp,
    raw: message.raw
  };
  return next;
}

function findExistingLibraryMessage(messages: ChatMessage[], message: ChatMessage): number {
  const byId = messages.findIndex((item) => item.id === message.id);
  if (byId >= 0) return byId;
  if (message.runId) {
    const byRun = messages.findIndex((item) => item.runId === message.runId && item.role === message.role);
    if (byRun >= 0) return byRun;
  }
  if (message.role !== "assistant") return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index];
    if (current.role === "user") return -1;
    if (current.role === "assistant") return index;
  }
  return -1;
}

function mergeLibraryStreamText(previous: string, incoming: string, raw: unknown): string {
  previous = collapseRepeatedText(previous);
  incoming = collapseRepeatedText(incoming);
  if (!previous || incoming === previous) return incoming || previous;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.includes(incoming)) return previous;
  if (incoming.includes(previous)) return incoming;
  const overlap = suffixPrefixOverlap(previous, incoming);
  if (overlap >= 16) return collapseRepeatedText(`${previous}${incoming.slice(overlap)}`);
  return isDeltaPayload(raw) ? collapseRepeatedText(`${previous}${incoming}`) : incoming.length >= previous.length ? incoming : collapseRepeatedText(`${previous}${incoming}`);
}

function isDeltaPayload(value: unknown, depth = 0): boolean {
  if (!value || depth > 4) return false;
  if (Array.isArray(value)) return value.some((item) => isDeltaPayload(item, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const eventType = String(record.type ?? record.event ?? record.kind ?? "").toLowerCase();
  if (eventType.includes("delta") || typeof record.delta === "string") return true;
  for (const key of ["payload", "message", "data", "event", "item"]) {
    if (isDeltaPayload(record[key], depth + 1)) return true;
  }
  return false;
}

function collapseRepeatedText(text: string): string {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = collapseRepeatedLines(collapseRepeatedChunks(current));
    if (next === current) return current;
    current = next;
  }
  return current;
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
    const maxSize = Math.min(500, Math.floor(current.length / 2));
    for (let size = maxSize; size >= 8; size -= 1) {
      const chunk = current.slice(current.length - size);
      if (!meaningfulRepeatChunk(chunk)) continue;
      const previousStart = current.length - size * 2;
      if (previousStart >= 0 && current.slice(previousStart, previousStart + size) === chunk) {
        current = `${current.slice(0, previousStart)}${chunk}`;
        changed = true;
        break;
      }
    }
  }
  return current;
}

function meaningfulRepeatChunk(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 4 && /[\p{L}\p{N}]/u.test(trimmed) && !trimmed.startsWith("```");
}

function suffixPrefixOverlap(previous: string, incoming: string): number {
  const max = Math.min(previous.length, incoming.length, 2000);
  for (let length = max; length >= 16; length -= 1) {
    if (previous.endsWith(incoming.slice(0, length))) return length;
  }
  return 0;
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

function displayLibraryChatText(text: string): string {
  return stripLibraryManagerPrompt(text)
    .replace(/```library-files\s*[\s\S]*?```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripLibraryManagerPrompt(text: string): string {
  const marker = "你是 Detaches 图书馆管理员";
  const start = text.indexOf(marker);
  if (start < 0) return text;
  const before = text.slice(0, start);
  const prompt = text.slice(start);
  const endPatterns = [
    /普通回答可以解释文件内容，但文件列表必须使用上面的 JSON 格式。\s*/u,
    /```library-files[\s\S]*?```\s*/u
  ];
  for (const pattern of endPatterns) {
    const match = pattern.exec(prompt);
    if (match?.index != null) return `${before}${prompt.slice(match.index + match[0].length)}`;
  }

  const contextLabels = [
    "当前图书馆 HTTP 服务：",
    "当前端口对应的 Agent 根目录：",
    "当前目录：",
    "当前打开文件：",
    "最近打开文件："
  ];
  const matchedLabels = contextLabels.filter((label) => prompt.includes(label)).length;
  if (matchedLabels >= 2) return before;
  return text;
}

function loadFloatPosition(): FloatPosition {
  return { x: Math.max(24, window.innerWidth - 88), y: Math.max(100, window.innerHeight - 120) };
}

function defaultLibraryHost(config: LibraryConfigResponse): string {
  if (config.suggestedHost && config.suggestedHost !== "127.0.0.1") return config.suggestedHost;
  return browserFallbackHost();
}

function browserFallbackHost(): string {
  const host = window.location.hostname;
  return host && host !== "localhost" ? host : "127.0.0.1";
}

function isPdfFile(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith(".pdf");
}

function isDrawioFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower.endsWith(".drawio") || lower.endsWith(".dio");
}

function fileKindLabel(relativePath: string): string {
  if (isPdfFile(relativePath)) return "PDF";
  if (isDrawioFile(relativePath)) return "draw.io";
  if (isMarkdownFile(relativePath)) return "Markdown";
  if (isTextFile(relativePath)) return "文本";
  return "文件";
}

function isMarkdownFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isTextFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return isMarkdownFile(lower) || lower.endsWith(".txt") || lower.endsWith(".log");
}

function pdfViewerUrl(serverId: string, relativePath: string): string {
  const file = libraryFileUrl(serverId, relativePath);
  return `/vendor/pdfjs/web/viewer.html?file=${encodeURIComponent(file)}`;
}

function drawioEmbedUrl(baseUrl = LOCAL_DRAWIO_URL): string {
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}embed=1&proto=json&spin=1&noSaveBtn=0&noExitBtn=0`;
}

function vendorLooksInstalled(url: string, html: string): boolean {
  const normalized = html.toLowerCase();
  if (url.includes("/pdfjs/")) return normalized.includes("pdf.js") || normalized.includes("pdfjs");
  if (url.includes("/drawio/")) return normalized.includes("draw.io") || normalized.includes("diagrams.net") || normalized.includes("mxgraph");
  return true;
}

function parseDrawioMessage(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
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
