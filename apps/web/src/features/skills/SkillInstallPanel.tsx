import { CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { ToolRequestRecord } from "@detaches/shared";
import { createToolRequest } from "../../lib/api.js";

const skillName = "detach-agent-relationship";
const skillVersion = "1.0.0";
const protocolVersion = "1.0.0";
const packageVersion = "1.0.0";
const targetDir = "~/.openclaw/skills";

export function SkillInstallPanel({ sessionKey, agentId }: { sessionKey: string | null; agentId: string | null }) {
  const [busy, setBusy] = useState<"install" | "verify" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<ToolRequestRecord | null>(null);

  async function createSkillRequest(action: "install" | "verify") {
    if (!sessionKey) {
      setError("选择 Agent 后才能创建 Skill 请求。");
      return;
    }
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      const response = await createToolRequest({
        kind: action === "install" ? "skill-install" : "skill-verify",
        target: "local-user-machine",
        sessionKey,
        agentId: agentId || undefined,
        reason: action === "install"
          ? "Install or update detach-agent-relationship into the Host/Main Agent OpenClaw global skills path."
          : "Verify detach-agent-relationship is installed in the Host/Main Agent OpenClaw global skills path.",
        source: "api",
        payload: buildPayload(action)
      });
      setLastRequest(response.request);
      setMessage(action === "install"
        ? `已创建 Skill 安装审批：${response.request.id}`
        : `已创建 Skill 验证审批：${response.request.id}`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="adapter-status-panel skill-install-panel">
      <div className="panel-heading compact">
        <div>
          <h2>Detach Skill</h2>
          <p>OpenClaw 全局 Main Agent skill</p>
        </div>
        <ShieldCheck size={17} />
      </div>
      <div className="adapter-state-card ready">
        <div>
          <CheckCircle2 size={16} />
          <strong>{skillName}</strong>
        </div>
        <small>目标路径：{targetDir}</small>
        <small>skill v{skillVersion} · protocol v{protocolVersion}</small>
      </div>
      <div className="adapter-actions">
        <button type="button" className="secondary-button compact" onClick={() => void createSkillRequest("install")} disabled={!sessionKey || busy !== null}>
          <ShieldCheck size={14} />
          {busy === "install" ? "创建中" : "安装/更新 Skill"}
        </button>
        <button type="button" className="secondary-button compact" onClick={() => void createSkillRequest("verify")} disabled={!sessionKey || busy !== null}>
          <RefreshCw size={14} />
          {busy === "verify" ? "创建中" : "验证安装"}
        </button>
      </div>
      {lastRequest ? (
        <div className={`adapter-install-request ${lastRequest.status}`}>
          <strong>Skill 请求：{lastRequest.status}</strong>
          <small>{lastRequest.id}</small>
          <p>已进入 Tool Queue，审批后执行。</p>
        </div>
      ) : null}
      {message ? <p className="adapter-request-message">{message}</p> : null}
      {error ? <div className="panel-error tight">{error}</div> : null}
    </section>
  );
}

function buildPayload(action: "install" | "verify"): Record<string, unknown> {
  return {
    targetAgent: "openclaw",
    targetRole: "host_main_agent",
    installScope: "shared_managed",
    action: action === "install" ? "install_or_update_skill" : "verify_skill_install",
    skillName,
    skillVersion,
    protocolVersion,
    packageVersion,
    targetDir,
    targetPathPolicy: "openclaw_global_shared_skills",
    prompt: action === "install"
      ? "Install or update the complete attached skill package into the OpenClaw shared/global skills path for the Host/Main Agent. Do not install into a workspace or Detach Agent machine unless explicitly requested."
      : "Verify the complete detach-agent-relationship skill is installed in the OpenClaw shared/global skills path for the Host/Main Agent.",
    attachment: {
      name: "detach-agent-relationship.skill.zip",
      type: "application/zip",
      path: "/skills/detach-agent-relationship.skill.zip",
      url: `${window.location.origin}/skills/detach-agent-relationship.skill.zip`
    },
    expectedPackage: {
      root: "detach-agent-relationship",
      files: ["SKILL.md", "VERSION", "README.md"]
    }
  };
}
