import { useEffect, useMemo, useState } from "react";
import { ExternalLink, FolderOpen, RefreshCw, Server, Settings, ShieldCheck } from "lucide-react";
import type { PublicSettings } from "@detaches/shared";
import { fetchSettings, testFileService } from "../../lib/api.js";

const DEFAULT_FILEBROWSER_PORT = 39999;

type ConnectionState = "idle" | "testing" | "connected" | "error";

export function FileBrowserPage() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(String(DEFAULT_FILEBROWSER_PORT));
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [frameFallbackVisible, setFrameFallbackVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingSettings(true);
      setSettingsError(null);
      try {
        const next = await fetchSettings();
        if (cancelled) return;
        setSettings(next);
        const defaultHost = defaultFileServiceHost(next);
        const configuredHost = next.fileServiceHost || defaultHost;
        const configuredPort = next.fileServicePort || DEFAULT_FILEBROWSER_PORT;
        setHost(configuredHost);
        setPort(String(configuredPort));
        const configured = next.fileServiceType === "filebrowser" && Boolean(next.fileServiceHost) && Boolean(next.fileServicePort);
        setState(configured && next.fileServiceLastStatus === "ok" ? "connected" : "idle");
        setError(configured && next.fileServiceLastStatus === "error" ? next.fileServiceLastError || "File Browser 连接失败。" : null);
        setShowConfig(!configured || next.fileServiceLastStatus !== "ok");
      } catch (loadError) {
        if (cancelled) return;
        setSettingsError(loadError instanceof Error ? loadError.message : String(loadError));
        setState("error");
      } finally {
        if (!cancelled) setLoadingSettings(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const fileBrowserUrl = useMemo(() => {
    const normalizedHost = host.trim();
    const normalizedPort = Number.parseInt(port, 10);
    if (!normalizedHost || !Number.isFinite(normalizedPort)) return "";
    return `http://${normalizedHost}:${normalizedPort}/`;
  }, [host, port]);

  useEffect(() => {
    if (showConfig || state !== "connected") {
      setFrameFallbackVisible(false);
      return;
    }
    // iframe 被 X-Frame-Options/CSP 拦截时没有稳定的 error 事件，延迟提示用户改用新窗口打开。
    const timeout = window.setTimeout(() => setFrameFallbackVisible(true), 3500);
    return () => window.clearTimeout(timeout);
  }, [frameKey, showConfig, state]);

  async function handleConnect() {
    const normalizedHost = host.trim();
    const normalizedPort = Number.parseInt(port, 10);
    if (!normalizedHost) {
      setState("error");
      setError("请输入 File Browser 服务 IP。");
      return;
    }
    if (!Number.isFinite(normalizedPort) || normalizedPort <= 0 || normalizedPort > 65535) {
      setState("error");
      setError("端口必须在 1 到 65535 之间。");
      return;
    }
    setState("testing");
    setError(null);
    try {
      await testFileService({ type: "filebrowser", host: normalizedHost, port: normalizedPort });
      const next = await fetchSettings();
      setSettings(next);
      setHost(normalizedHost);
      setPort(String(normalizedPort));
      setState("connected");
      setShowConfig(false);
      setFrameFallbackVisible(false);
      setFrameKey((current) => current + 1);
    } catch (connectError) {
      setState("error");
      setError(connectError instanceof Error ? connectError.message : String(connectError));
    }
  }

  const lastTestedAt = settings?.fileServiceLastTestedAt ? new Date(settings.fileServiceLastTestedAt).toLocaleString() : "";
  const displayState: ConnectionState = showConfig && state === "connected" ? "idle" : state;
  const statusText = displayState === "connected" ? "已连接" : displayState === "testing" ? "连接中" : displayState === "error" ? "连接失败" : "未配置";

  if (loadingSettings) {
    return (
      <div className="file-browser-workspace">
        <div className="file-browser-loading">正在读取文件服务配置...</div>
      </div>
    );
  }

  return (
    <div className="file-browser-workspace">
      {showConfig || state !== "connected" ? (
        <div className="file-browser-config-page">
          <section className="file-browser-service-panel" aria-label="File service type">
            <div className="file-browser-title">
              <FolderOpen size={22} />
              <div>
                <h1>文件浏览</h1>
                <p>连接服务器上的 File Browser 服务。</p>
              </div>
            </div>
            <button className="file-service-card selected" type="button">
              <Server size={20} />
              <span>
                <strong>File Browser</strong>
                <small>github.com/filebrowser/filebrowser</small>
              </span>
              <ShieldCheck size={18} />
            </button>
          </section>

          <section className="file-browser-form-panel" aria-label="File Browser connection">
            <div className="file-browser-form-heading">
              <div>
                <h2>连接配置</h2>
                <p>登录由 File Browser 自己处理，DetachAgent 不保存账号密码。</p>
              </div>
              <span className={`file-browser-status ${displayState}`}>{statusText}</span>
            </div>
            {settingsError ? <div className="panel-error">{settingsError}</div> : null}
            <label>
              IP
              <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="100.74.38.97" />
            </label>
            <label>
              Port
              <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" placeholder="39999" />
            </label>
            <div className="file-browser-form-note">
              <span>服务类型</span><strong>filebrowser</strong>
              <span>默认端口</span><strong>{DEFAULT_FILEBROWSER_PORT}</strong>
              <span>登录账号</span><strong>output</strong>
              <span>密码保存</span><strong>使用浏览器密码管理器</strong>
            </div>
            {error ? <div className="panel-error">{error}</div> : null}
            <FileBrowserConnectionHelp />
            <div className="file-browser-actions">
              {state === "connected" ? (
                <button type="button" className="secondary-button" onClick={() => setShowConfig(false)}>返回浏览</button>
              ) : null}
              <button type="button" className="primary-button" onClick={() => void handleConnect()} disabled={state === "testing"}>
                {state === "testing" ? "正在连接..." : "确认连接"}
              </button>
            </div>
          </section>
        </div>
      ) : (
        <div className="file-browser-frame-page">
          <header className="file-browser-toolbar">
            <div className="file-browser-toolbar-title">
              <FolderOpen size={17} />
              <strong>File Browser</strong>
              <span>{fileBrowserUrl}</span>
              <small>{lastTestedAt ? `最后测试 ${lastTestedAt}` : "连接已保存"}</small>
            </div>
            <div className="file-browser-toolbar-actions">
              <span className="file-browser-status connected">已连接</span>
              <button type="button" className="icon-button" title="刷新" onClick={() => setFrameKey((current) => current + 1)}>
                <RefreshCw size={15} />
              </button>
              <button type="button" className="icon-button" title="重新配置" onClick={() => setShowConfig(true)}>
                <Settings size={15} />
              </button>
              <a className="icon-button" title="在新窗口打开" href={fileBrowserUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={15} />
              </a>
            </div>
          </header>
          <div className="file-browser-iframe-wrap">
            <iframe
              key={frameKey}
              title="File Browser"
              src={fileBrowserUrl}
              onLoad={() => setFrameFallbackVisible(false)}
            />
            <div className={`file-browser-frame-fallback ${frameFallbackVisible ? "visible" : ""}`}>
              <p>如果内嵌页面没有显示，请在新窗口打开 File Browser。</p>
              <a className="secondary-button" href={fileBrowserUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={15} />
                在新窗口打开
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileBrowserConnectionHelp() {
  return (
    <div className="file-browser-help">
      <details>
        <summary>已经安装了 File Browser，如何排查无法连接？</summary>
        <div>
          <p>先在服务器上确认服务是否监听当前端口：</p>
          <code>ss -lntp | grep 39999</code>
          <p>再从服务器本机测试 HTTP 是否返回 File Browser 页面：</p>
          <code>curl -I http://127.0.0.1:39999</code>
          <p>如果本机可访问但 DetachAgent 连接失败，重点检查监听地址是否为 0.0.0.0、服务器防火墙、安全组、Tailscale/LAN 路由，以及页面里填写的 IP 是否是 Main Agent 可访问地址。</p>
        </div>
      </details>
      <details>
        <summary>服务器还没有 File Browser，如何安装启动？</summary>
        <div>
          <p>可以使用官方安装脚本安装单二进制版本：</p>
          <code>curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash</code>
          <p>启动示例，监听 39999 端口并绑定到所有网卡：</p>
          <code>filebrowser -a 0.0.0.0 -p 39999 -r /path/to/files</code>
          <p>也可以用 Docker 运行，确保把宿主机目录和 39999 端口映射出来：</p>
          <code>docker run -d --name filebrowser -p 39999:80 -v /path/to/files:/srv filebrowser/filebrowser</code>
        </div>
      </details>
    </div>
  );
}

function defaultFileServiceHost(settings: PublicSettings): string {
  // File Browser 跟 Main Agent 部署在同一台服务器上，优先复用当前 active profile 的连接主机。
  return settings.gatewayTransport === "direct"
    ? settings.gatewayDirectHost || settings.remoteHost
    : settings.remoteHost || settings.gatewayDirectHost;
}
