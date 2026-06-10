import { CheckCircle2, Clipboard, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OpenClawAdapterInstallPlan, OpenClawAdapterReadiness } from "@detaches/shared";
import { fetchOpenClawAdapterInstallPlan, fetchOpenClawAdapterReadiness } from "../../lib/api.js";

const defaultInstallDir = "~/.openclaw/detaches_agent";

export function AdapterStatusPanel() {
  const [installDir, setInstallDir] = useState(defaultInstallDir);
  const [readiness, setReadiness] = useState<OpenClawAdapterReadiness | null>(null);
  const [installPlan, setInstallPlan] = useState<OpenClawAdapterInstallPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installCommands = useMemo(() => installPlan?.commands.join("\n") ?? "", [installPlan]);
  const remoteVerifyCommands = useMemo(() => installPlan?.verifyCommands.join("\n") ?? "", [installPlan]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextReadiness, nextPlan] = await Promise.all([
        fetchOpenClawAdapterReadiness(),
        fetchOpenClawAdapterInstallPlan({ installDir })
      ]);
      setReadiness(nextReadiness);
      setInstallPlan(nextPlan);
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

  async function copy(text: string) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
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
          <small>本地分发包检查，不代表远端机器已安装。</small>
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
        <button type="button" className="secondary-button compact" onClick={() => setPlanOpen((current) => !current)}>
          <Terminal size={14} />
          {planOpen ? "隐藏命令" : "安装/验证命令"}
        </button>
        <button type="button" className="icon-button small" title="Copy remote verify commands" disabled={!remoteVerifyCommands} onClick={() => void copy(remoteVerifyCommands)}>
          <Clipboard size={14} />
        </button>
      </div>
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
    </section>
  );
}

function stateText(readiness: OpenClawAdapterReadiness): string {
  if (readiness.state === "ready") return "本地分发包已就绪";
  if (readiness.state === "missing") return "本地分发包缺失";
  if (readiness.state === "invalid") return "本地分发包不匹配";
  return "本地分发包检查失败";
}
