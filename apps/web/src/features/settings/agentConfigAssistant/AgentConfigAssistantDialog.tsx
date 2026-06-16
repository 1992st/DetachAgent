import { ChangeEvent, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileInput, Loader2, Upload, XCircle } from "lucide-react";
import type {
  AgentConfigAssistantAgentType,
  AgentConfigAssistantResult,
  RemoteProfile,
  RemoteProfileUpdate
} from "@detaches/shared";
import { analyzeAgentConfig } from "@detaches/shared";

interface Props {
  profile: RemoteProfile;
  open: boolean;
  applying: boolean;
  onClose: () => void;
  onApply: (update: RemoteProfileUpdate) => Promise<void>;
}

interface AgentTypeOption {
  id: AgentConfigAssistantAgentType;
  name: string;
  description: string;
  enabled: boolean;
}

const agentTypes: AgentTypeOption[] = [
  { id: "openclaw", name: "OpenClaw", description: "读取 ~/.openclaw/openclaw.json 的 Gateway 配置。", enabled: true },
  { id: "claude-code", name: "Claude Code", description: "Coming soon", enabled: false },
  { id: "codex", name: "Codex", description: "Coming soon", enabled: false },
  { id: "other", name: "Other Agent", description: "Coming soon", enabled: false }
];

const fieldLabels: Record<string, string> = {
  gatewayTransport: "Gateway transport",
  gatewayDirectHost: "Direct Gateway host",
  gatewayDirectUrl: "Gateway URL / Tailscale Serve",
  gatewayRemotePort: "Gateway port",
  authMode: "Auth mode",
  authToken: "Gateway token",
  authPassword: "Gateway password",
  remoteHost: "Remote host",
  remoteWorkspaceRoot: "Remote workspace",
  publicBaseUrl: "Public base URL"
};

export function AgentConfigAssistantDialog({ profile, open, applying, onClose, onApply }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [agentType, setAgentType] = useState<AgentConfigAssistantAgentType>("openclaw");
  const [configText, setConfigText] = useState("");
  const [mainAgentAddress, setMainAgentAddress] = useState(defaultMainAgentAddress(profile));
  const [analysis, setAnalysis] = useState<AgentConfigAssistantResult | null>(null);
  const [fileStatus, setFileStatus] = useState<string | null>(null);

  const selectedOption = agentTypes.find((option) => option.id === agentType) ?? agentTypes[0];
  const canAnalyze = selectedOption.enabled && configText.trim().length > 0;
  const canApply = analysis?.status === "ready" && !applying;
  const diffs = useMemo(() => analysis ? buildDiffs(profile, analysis.proposedUpdate) : [], [analysis, profile]);

  if (!open) return null;

  function resetAndClose() {
    setStep(1);
    setAnalysis(null);
    setFileStatus(null);
    onClose();
  }

  async function readConfigFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      setConfigText(text);
      setFileStatus(`已读取 ${file.name}`);
      setAnalysis(null);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function runAnalysis() {
    const result = analyzeAgentConfig({
      agentType,
      configText,
      mainAgentAddress,
      existingProfile: profile
    });
    setAnalysis(result);
    setStep(3);
  }

  async function applyUpdate() {
    if (!analysis || analysis.status !== "ready") return;
    await onApply(analysis.proposedUpdate);
    resetAndClose();
  }

  return (
    <div className="agent-config-assistant-backdrop" role="presentation">
      <section className="agent-config-assistant-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-config-assistant-title">
        <header className="agent-config-assistant-header">
          <div>
            <h2 id="agent-config-assistant-title">导入 Agent 配置</h2>
            <p>基于规则解析配置文件，生成当前 profile 的网络设置。</p>
          </div>
          <button type="button" className="icon-button" onClick={resetAndClose} aria-label="关闭">
            <XCircle size={18} />
          </button>
        </header>

        <div className="agent-config-assistant-steps" aria-label="导入步骤">
          <span className={step === 1 ? "active" : ""}>1 Agent 类型</span>
          <span className={step === 2 ? "active" : ""}>2 配置输入</span>
          <span className={step === 3 ? "active" : ""}>3 预览应用</span>
        </div>

        {step === 1 ? (
          <div className="agent-config-assistant-body">
            <div className="agent-type-grid">
              {agentTypes.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={`agent-type-option ${option.id === agentType ? "selected" : ""}`}
                  onClick={() => setAgentType(option.id)}
                >
                  <strong>{option.name}</strong>
                  <span>{option.description}</span>
                  {!option.enabled ? <small>Coming soon</small> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="agent-config-assistant-body">
            <label>
              OpenClaw 配置内容
              <textarea
                value={configText}
                rows={12}
                spellCheck={false}
                placeholder="粘贴 ~/.openclaw/openclaw.json 内容"
                onChange={(event) => {
                  setConfigText(event.target.value);
                  setAnalysis(null);
                }}
              />
            </label>
            <div className="assistant-file-row">
              <label className="secondary-button compact">
                <Upload size={16} />
                上传配置文件
                <input type="file" accept=".json,application/json,text/plain" onChange={readConfigFile} />
              </label>
              {fileStatus ? <span>{fileStatus}</span> : null}
            </div>
            <label>
              Main Agent 地址或 Tailscale Serve URL
              <input
                value={mainAgentAddress}
                placeholder="100.x.x.x 或 https://main-agent.tailnet.ts.net"
                onChange={(event) => {
                  setMainAgentAddress(event.target.value);
                  setAnalysis(null);
                }}
              />
              <small className="field-hint">Serve/Funnel 模式请填 HTTPS URL；tailnet/lan/custom 非 loopback 模式请填可访问的 IP 或 MagicDNS。</small>
            </label>
          </div>
        ) : null}

        {step === 3 && analysis ? (
          <div className="agent-config-assistant-body">
            <div className={`assistant-result-card ${analysis.status}`}>
              <strong>{analysis.title}</strong>
              <p>{analysis.summary}</p>
            </div>

            <div className="assistant-summary-grid">
              <Metric label="bind" value={analysis.detected.bind} />
              <Metric label="tailscale" value={analysis.detected.tailscaleMode} />
              <Metric label="port" value={analysis.detected.port?.toString()} />
              <Metric label="auth" value={analysis.detected.authMode} />
              <Metric label="token" value={analysis.proposedUpdate.authToken ? redactSecret(analysis.proposedUpdate.authToken) : analysis.detected.hasAuthToken ? "已检测" : "未检测"} />
              <Metric label="password" value={analysis.proposedUpdate.authPassword ? redactSecret(analysis.proposedUpdate.authPassword) : analysis.detected.hasAuthPassword ? "已检测" : "未检测"} />
            </div>

            <section className="assistant-preview-section">
              <h3>将写入当前 profile</h3>
              {diffs.length ? (
                <div className="assistant-diff-list">
                  {diffs.map((diff) => (
                    <div className="assistant-diff-row" key={diff.key}>
                      <strong>{diff.label}</strong>
                      <span>{diff.before}</span>
                      <span>{diff.after}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">没有检测到需要变更的字段。</p>
              )}
            </section>

            <section className="assistant-preview-section">
              <h3>风险和缺失项</h3>
              <div className="assistant-finding-list">
                {analysis.findings.length ? analysis.findings.map((finding, index) => (
                  <p className={`assistant-finding ${finding.level}`} key={`${finding.level}-${index}`}>
                    {finding.level === "error" ? <XCircle size={15} /> : finding.level === "warning" ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
                    {finding.message}
                  </p>
                )) : (
                  <p className="assistant-finding info">
                    <CheckCircle2 size={15} />
                    配置完整，可应用后自动测试网络。
                  </p>
                )}
              </div>
            </section>
          </div>
        ) : null}

        <footer className="agent-config-assistant-actions">
          {step > 1 ? <button type="button" className="secondary-button" onClick={() => setStep(step === 3 ? 2 : 1)}>上一步</button> : null}
          {step === 1 ? (
            <button type="button" className="save-button" disabled={!selectedOption.enabled} onClick={() => setStep(2)}>
              <FileInput size={16} />
              继续
            </button>
          ) : null}
          {step === 2 ? (
            <button type="button" className="save-button" disabled={!canAnalyze} onClick={runAnalysis}>
              分析配置
            </button>
          ) : null}
          {step === 3 ? (
            <button type="button" className="save-button" disabled={!canApply} onClick={applyUpdate}>
              {applying ? <Loader2 size={16} className="spin-icon" /> : <CheckCircle2 size={16} />}
              应用到当前配置
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value?: string }) {
  return (
    <div className="assistant-metric">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
  );
}

function defaultMainAgentAddress(profile: RemoteProfile): string {
  return profile.gatewayDirectUrl || profile.gatewayDirectHost || profile.remoteHost;
}

function buildDiffs(profile: RemoteProfile, update: RemoteProfileUpdate) {
  return Object.entries(update)
    .filter(([key]) => key !== "remoteWorkspaceRoot" && key !== "publicBaseUrl")
    .map(([key, value]) => ({
      key,
      label: fieldLabels[key] ?? key,
      before: formatDiffValue(key, (profile as unknown as Record<string, unknown>)[key]),
      after: formatDiffValue(key, value)
    }))
    .filter((diff) => diff.before !== diff.after || diff.key === "authToken" || diff.key === "authPassword");
}

function formatDiffValue(key: string, value: unknown): string {
  if (key === "authToken" || key === "authPassword") {
    return typeof value === "string" && value ? redactSecret(value) : "未写入新值";
  }
  if (value === undefined || value === null || value === "") return "空";
  return String(value);
}

function redactSecret(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
