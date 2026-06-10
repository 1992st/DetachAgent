import { CheckCircle2, Clipboard, KeyRound, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DetachesContextExportCreateResponse, OpenClawAdapterInstallPlan, OpenClawAdapterReadiness, ToolBrokerSocketEvent, ToolRequestRecord } from "@detaches/shared";
import { createDetachesContextExport, createToolRequest, fetchOpenClawAdapterInstallPlan, fetchOpenClawAdapterReadiness, fetchToolRequests } from "../../lib/api.js";

const defaultInstallDir = "~/.openclaw/detaches_agent";

export function AdapterStatusPanel({ sessionKey, agentId }: { sessionKey: string | null; agentId: string | null }) {
  const [installDir, setInstallDir] = useState(defaultInstallDir);
  const [readiness, setReadiness] = useState<OpenClawAdapterReadiness | null>(null);
  const [installPlan, setInstallPlan] = useState<OpenClawAdapterInstallPlan | null>(null);
  const [probe, setProbe] = useState<"local-fs" | "remote-ssh">("local-fs");
  const [loading, setLoading] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const [installRequest, setInstallRequest] = useState<ToolRequestRecord | null>(null);
  const [contextExport, setContextExport] = useState<DetachesContextExportCreateResponse | null>(null);
  const [contextMessage, setContextMessage] = useState<string | null>(null);

  const installCommands = useMemo(() => installPlan?.commands.join("\n") ?? "", [installPlan]);
  const remoteVerifyCommands = useMemo(() => installPlan?.verifyCommands.join("\n") ?? "", [installPlan]);
  const contextFetchCommand = useMemo(() => {
    if (!contextExport) return "";
    const cliPath = shellPath(`${installDir.replace(/\/+$/, "")}/bin/detaches-agent-adapter.mjs`);
    return [
      `node ${cliPath} context-fetch \\`,
      `  ${shellQuote(contextExport.consumeUrl)} \\`,
      "  --output /tmp/detaches-client-context.json",
      `node ${cliPath} inspect-context /tmp/detaches-client-context.json`
    ].join("\n");
  }, [contextExport, installDir]);

  async function refresh(nextProbe = probe) {
    setLoading(true);
    setError(null);
    try {
      const [nextReadiness, nextPlan] = await Promise.all([
        fetchOpenClawAdapterReadiness(nextProbe === "remote-ssh"
          ? { probe: "remote-ssh", target: "remote-agent-host", installDir }
          : { probe: "local-fs" }),
        fetchOpenClawAdapterInstallPlan({ installDir })
      ]);
      setReadiness(nextReadiness);
      setInstallPlan(nextPlan);
      await refreshInstallRequest();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sessionKey) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ sessionKey });
    if (agentId) params.set("agentId", agentId);
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/tools/stream?${params}`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ToolBrokerSocketEvent;
      if (data.type !== "request" || data.request.kind !== "adapter-install") return;
      if (!requestMatchesInstallDir(data.request, installDir)) return;
      setInstallRequest(data.request);
      if (data.request.status === "approved" || data.request.status === "failed") {
        setProbe("remote-ssh");
        void refresh("remote-ssh");
      }
    };
    ws.onerror = () => ws.close();
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, agentId, installDir]);

  async function copy(text: string) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
  }

  async function createInstallRequest() {
    if (!sessionKey) {
      setError("选择 Agent 后才能创建安装请求。");
      return;
    }
    setLoading(true);
    setError(null);
    setRequestMessage(null);
    try {
      const response = await createToolRequest({
        kind: "adapter-install",
        target: "remote-agent-host",
        sessionKey,
        agentId: agentId || undefined,
        reason: "Install detaches_agent OpenClaw adapter on the remote agent host after user approval.",
        source: "api",
        payload: { installDir }
      });
      setRequestMessage(`已创建安装审批请求：${response.request.id}`);
      setInstallRequest(response.request);
      setProbe("remote-ssh");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function createContextExport() {
    if (!sessionKey) {
      setError("选择 Agent 后才能生成本会话上下文。");
      return;
    }
    setLoading(true);
    setError(null);
    setContextMessage(null);
    try {
      const response = await createDetachesContextExport({ sessionKey, sessionMode: "main" });
      setContextExport(response);
      setContextMessage("已生成一次性上下文 URL。远端 agent host 消费后会立即失效。");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function refreshInstallRequest() {
    if (!sessionKey) {
      setInstallRequest(null);
      return;
    }
    const response = await fetchToolRequests({ sessionKey, agentId, limit: 50 });
    const request = response.requests.find((item) => requestMatchesInstallDir(item, installDir)) ?? null;
    setInstallRequest(request);
  }

  return (
    <section className="adapter-status-panel">
      <div className="panel-heading compact">
        <div>
          <h2>OpenClaw Adapter</h2>
          <p>{readiness ? stateText(readiness) : loading ? "Checking..." : "未检查"}</p>
        </div>
        <button type="button" className="icon-button" title="Refresh adapter status" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={16} />
        </button>
      </div>
      {error ? <div className="panel-error tight">{error}</div> : null}
      <div className="adapter-probe-toggle" aria-label="Adapter probe">
        <button type="button" className={probe === "local-fs" ? "active" : ""} onClick={() => {
          setProbe("local-fs");
          void refresh("local-fs");
        }}>
          本地分发包
        </button>
        <button type="button" className={probe === "remote-ssh" ? "active" : ""} onClick={() => {
          setProbe("remote-ssh");
          void refresh("remote-ssh");
        }}>
          远端 SSH 探测
        </button>
      </div>
      <label className="adapter-field">
        <span>远端安装目录（用于安装计划）</span>
        <input value={installDir} onChange={(event) => setInstallDir(event.target.value)} onBlur={() => void refresh()} />
      </label>
      {readiness ? (
        <div className={`adapter-state-card ${readiness.state}`}>
          <div>
            <ShieldCheck size={16} />
            <strong>{readiness.state}</strong>
          </div>
          <small>{readiness.probe === "remote-ssh" ? remoteProbeText(readiness) : "本地分发包检查，不代表远端机器已安装。"}</small>
          <small>{readiness.expectedAdapterId} · v{readiness.expectedVersion}</small>
          <ul>
            {readiness.checks.map((check) => (
              <li className={check.state} key={check.id}>
                <CheckCircle2 size={13} />
                <span>{check.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="adapter-actions">
        <button type="button" className="secondary-button compact" onClick={() => void createInstallRequest()} disabled={!sessionKey || loading}>
          <ShieldCheck size={14} />
          {installRequest?.status === "pending" ? "已有安装审批" : "创建安装审批"}
        </button>
        <button type="button" className="secondary-button compact" onClick={() => setPlanOpen((current) => !current)}>
          <Terminal size={14} />
          {planOpen ? "隐藏命令" : "安装/验证命令"}
        </button>
        <button type="button" className="icon-button small" title="Copy remote verify commands" disabled={!remoteVerifyCommands} onClick={() => void copy(remoteVerifyCommands)}>
          <Clipboard size={14} />
        </button>
      </div>
      {installRequest ? (
        <div className={`adapter-install-request ${installRequest.status}`}>
          <strong>安装请求：{installRequest.status}</strong>
          <small>{installRequest.id}</small>
          {installRequest.error ? <p>{installRequest.error}</p> : null}
          {installRequest.risk ? <p>Risk: {installRequest.risk.level}{installRequest.risk.reasons.length ? ` · ${installRequest.risk.reasons.join("; ")}` : ""}</p> : null}
        </div>
      ) : null}
      {requestMessage ? <p className="adapter-request-message">{requestMessage}</p> : null}
      {planOpen ? (
        <div className="adapter-command-box">
          <div>
            <strong>Install</strong>
            <button type="button" className="copy-button" title="Copy install commands" onClick={() => void copy(installCommands)}>
              <Clipboard size={13} />
            </button>
          </div>
          <pre>{installCommands}</pre>
          <div>
            <strong>Remote Verify</strong>
            <button type="button" className="copy-button" title="Copy remote verify commands" onClick={() => void copy(remoteVerifyCommands)}>
              <Clipboard size={13} />
            </button>
          </div>
          <pre>{remoteVerifyCommands}</pre>
        </div>
      ) : null}
      <div className="adapter-context-export">
        <div className="adapter-context-heading">
          <div>
            <strong>本会话上下文</strong>
            <small>给远端 OpenClaw adapter 拉取 session、broker 和能力信息。</small>
          </div>
          <button type="button" className="secondary-button compact" onClick={() => void createContextExport()} disabled={!sessionKey || loading}>
            <KeyRound size={14} />
            生成一次性 URL
          </button>
        </div>
        {contextMessage ? <p className="adapter-request-message">{contextMessage}</p> : null}
        {contextExport ? (
          <div className="adapter-command-box">
            <div>
              <strong>Context Fetch</strong>
              <button type="button" className="copy-button" title="Copy context fetch command" onClick={() => void copy(contextFetchCommand)}>
                <Clipboard size={13} />
              </button>
            </div>
            <small>过期时间：{formatTime(contextExport.expiresAt)}</small>
            <pre>{contextFetchCommand}</pre>
            <div>
              <strong>One-time URL</strong>
              <button type="button" className="copy-button" title="Copy one-time context URL" onClick={() => void copy(contextExport.consumeUrl)}>
                <Clipboard size={13} />
              </button>
            </div>
            <pre>{contextExport.consumeUrl}</pre>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function stateText(readiness: OpenClawAdapterReadiness): string {
  if (readiness.probe === "remote-ssh") {
    if (readiness.state === "ready") return "远端 adapter 已就绪";
    if (readiness.state === "missing") return "远端 adapter 未安装";
    if (readiness.state === "invalid") return "远端 adapter 不匹配";
    return "远端 adapter 探测失败";
  }
  if (readiness.state === "ready") return "本地分发包已就绪";
  if (readiness.state === "missing") return "本地分发包缺失";
  if (readiness.state === "invalid") return "本地分发包不匹配";
  return "本地分发包检查失败";
}

function remoteProbeText(readiness: OpenClawAdapterReadiness): string {
  const remote = [readiness.remoteUser, readiness.remoteHost].filter(Boolean).join("@");
  return remote ? `远端只读 SSH 探测：${remote}` : "远端只读 SSH 探测";
}

function requestMatchesInstallDir(request: ToolRequestRecord, installDir: string): boolean {
  return request.kind === "adapter-install"
    && request.target === "remote-agent-host"
    && (typeof request.payload.installDir !== "string" || request.payload.installDir === installDir);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellPath(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  if (normalized === "~") return "$HOME";
  if (normalized.startsWith("~/")) return `$HOME/${normalized.slice(2).replace(/'/g, "'\\''")}`;
  return shellQuote(normalized);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
