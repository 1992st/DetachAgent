import { Copy, FileText, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  DETACH_AGENT_RELATIONSHIP_SKILL_NAME,
  DETACH_AGENT_RELATIONSHIP_SKILL_PROTOCOL_VERSION,
  DETACH_AGENT_RELATIONSHIP_SKILL_VERSION
} from "@detaches/shared";

export const relationshipSkillName = DETACH_AGENT_RELATIONSHIP_SKILL_NAME;
export const relationshipSkillVersion = DETACH_AGENT_RELATIONSHIP_SKILL_VERSION;
export const relationshipSkillProtocolVersion = DETACH_AGENT_RELATIONSHIP_SKILL_PROTOCOL_VERSION;
export const relationshipSkillPackageVersion = DETACH_AGENT_RELATIONSHIP_SKILL_VERSION;
export const relationshipSkillTargetDir = "~/.openclaw/skills";
export const relationshipSkillAdapterBinDir = "~/.detach_agent/bin";
export const relationshipSkillRepositoryUrl = "https://github.com/1992st/DetachAgent.git";
export const relationshipSkillSourcePath = "packages/openclaw-detaches-adapter/skills/detach-agent-relationship";
export const relationshipSkillAdapterSourcePath = "packages/openclaw-detaches-adapter/bin/detaches-agent-adapter.mjs";

export function SkillInstallPanel({ sessionKey: _sessionKey, agentId: _agentId }: { sessionKey?: string | null; agentId?: string | null }) {
  const [mode, setMode] = useState<"install" | "verify" | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => current === label ? null : current), 1600);
  }

  return (
    <section className="adapter-status-panel skill-install-panel" id="relationship-skill-install">
      <div className="panel-heading compact">
        <div>
          <h2>Detach relationship skill 安装/更新</h2>
          <p>OpenClaw 全局 Main Agent skill，用于让 Main Agent 理解 detaches_agent 上下文与文件转交协议。</p>
        </div>
        <ShieldCheck size={17} />
      </div>
      <div className="adapter-state-card">
        <div>
          <FileText size={16} />
          <strong>{relationshipSkillName}</strong>
        </div>
        <small>安装说明 · 需在 Main Agent 机器执行</small>
        <small>目标路径：{relationshipSkillTargetDir}/{relationshipSkillName}</small>
        <small>skill v{relationshipSkillVersion} · protocol v{relationshipSkillProtocolVersion} · package v{relationshipSkillPackageVersion}</small>
      </div>
      <div className="adapter-actions">
        <button type="button" className="secondary-button compact" onClick={() => setMode((current) => current === "install" ? null : "install")}>
          <ShieldCheck size={14} />
          安装/更新 Skill
        </button>
        <button type="button" className="secondary-button compact" onClick={() => setMode((current) => current === "verify" ? null : "verify")}>
          <RefreshCw size={14} />
          验证安装
        </button>
      </div>
      {mode ? (
        <div className="skill-install-instructions">
          <InstructionBlock
            title={mode === "install" ? "Main Agent 机器执行命令" : "Main Agent 机器验证命令"}
            description={mode === "install"
              ? "复制到 Main Agent 机器的 terminal 执行，从 GitHub 拉取 relationship skill 并安装或更新到当前要求版本。"
              : "复制到 Main Agent 机器的 terminal 执行，检查 skill 文件和版本。"}
            value={mode === "install" ? relationshipSkillInstallCommand : relationshipSkillVerifyCommand}
            copyLabel={`${mode}-command`}
            copied={copied}
            onCopy={copy}
          />
          <InstructionBlock
            title={mode === "install" ? "发给 Main Agent 的 Prompt" : "发给 Main Agent 的验证 Prompt"}
            description={mode === "install"
              ? "当用户希望 Main Agent 自己处理安装/更新时，复制这段 prompt 发给 Main Agent。"
              : "当用户希望 Main Agent 自己检查安装状态时，复制这段 prompt 发给 Main Agent。"}
            value={mode === "install" ? relationshipSkillInstallPrompt : relationshipSkillVerifyPrompt}
            copyLabel={`${mode}-prompt`}
            copied={copied}
            onCopy={copy}
          />
        </div>
      ) : null}
    </section>
  );
}

function InstructionBlock({
  title,
  description,
  value,
  copyLabel,
  copied,
  onCopy
}: {
  title: string;
  description: string;
  value: string;
  copyLabel: string;
  copied: string | null;
  onCopy: (value: string, label: string) => Promise<void>;
}) {
  return (
    <div className="adapter-command-box">
      <div>
        <div>
          <strong>{title}</strong>
          <small>{description}</small>
        </div>
        <button type="button" className="copy-button" title={`Copy ${title}`} onClick={() => void onCopy(value, copyLabel)}>
          <Copy size={14} />
        </button>
      </div>
      <pre>{value}</pre>
      {copied === copyLabel ? <small>已复制</small> : null}
    </div>
  );
}

export const relationshipSkillInstallCommand = [
  "tmp_dir=$(mktemp -d)",
  `git clone --depth 1 ${relationshipSkillRepositoryUrl} "$tmp_dir/DetachAgent"`,
  `mkdir -p ${relationshipSkillTargetDir}`,
  `rm -rf ${relationshipSkillTargetDir}/${relationshipSkillName}`,
  `cp -R "$tmp_dir/DetachAgent/${relationshipSkillSourcePath}" ${relationshipSkillTargetDir}/${relationshipSkillName}`,
  `test -f ${relationshipSkillTargetDir}/${relationshipSkillName}/SKILL.md`,
  `test -f ${relationshipSkillTargetDir}/${relationshipSkillName}/README.md`,
  `test -f ${relationshipSkillTargetDir}/${relationshipSkillName}/VERSION`,
  `test -f ${relationshipSkillTargetDir}/${relationshipSkillName}/CHANGELOG.md`,
  `cat ${relationshipSkillTargetDir}/${relationshipSkillName}/VERSION`,
  `mkdir -p ${relationshipSkillAdapterBinDir}`,
  `cp "$tmp_dir/DetachAgent/${relationshipSkillAdapterSourcePath}" ${relationshipSkillAdapterBinDir}/detaches-agent-adapter.mjs`,
  `chmod +x ${relationshipSkillAdapterBinDir}/detaches-agent-adapter.mjs`,
  `test -f ${relationshipSkillAdapterBinDir}/detaches-agent-adapter.mjs`,
  "rm -rf \"$tmp_dir\""
].join(" && ");

export const relationshipSkillVerifyCommand = [
  `test -f ${relationshipSkillTargetDir}/${relationshipSkillName}/SKILL.md`,
  `test -f ${relationshipSkillTargetDir}/${relationshipSkillName}/README.md`,
  `test -f ${relationshipSkillTargetDir}/${relationshipSkillName}/VERSION`,
  `test -f ${relationshipSkillTargetDir}/${relationshipSkillName}/CHANGELOG.md`,
  `printf 'detach-agent-relationship version: '`,
  `cat ${relationshipSkillTargetDir}/${relationshipSkillName}/VERSION`,
  `test -f ${relationshipSkillAdapterBinDir}/detaches-agent-adapter.mjs`
].join(" && ");

export const relationshipSkillInstallPrompt = `请在 Main Agent 机器上安装或更新 OpenClaw relationship skill 到当前要求版本。

目标 skill: ${relationshipSkillName}
目标版本: ${relationshipSkillVersion}
GitHub 仓库: ${relationshipSkillRepositoryUrl}
仓库内路径: ${relationshipSkillSourcePath}
安装路径: ${relationshipSkillTargetDir}/${relationshipSkillName}
Adapter CLI 路径: ${relationshipSkillAdapterBinDir}/detaches-agent-adapter.mjs

请在 Main Agent 机器执行以下步骤：
1. 从 GitHub clone 仓库。
2. 将 ${relationshipSkillSourcePath} 复制到 ${relationshipSkillTargetDir}/${relationshipSkillName}。
3. 确认安装目录包含 SKILL.md、README.md、VERSION、CHANGELOG.md。
4. 确认 VERSION 内容为 ${relationshipSkillVersion}。
5. 如果已有旧版本，请覆盖更新到 ${relationshipSkillVersion}。
6. 同步安装 adapter CLI 到 ${relationshipSkillAdapterBinDir}/detaches-agent-adapter.mjs，并设置可执行权限。
7. 安装后刷新或重启 Main Agent / OpenClaw skill 索引，让新 skill 生效。

不要把这个 skill 安装到 Detach Agent 机器，除非这台机器同时也是 Main Agent 机器。`;

export const relationshipSkillVerifyPrompt = `请在 Main Agent 机器上验证 OpenClaw relationship skill 是否安装正确。

目标 skill: ${relationshipSkillName}
期望版本: ${relationshipSkillVersion}
安装路径: ${relationshipSkillTargetDir}/${relationshipSkillName}
Adapter CLI 路径: ${relationshipSkillAdapterBinDir}/detaches-agent-adapter.mjs

请检查：
1. ${relationshipSkillTargetDir}/${relationshipSkillName}/SKILL.md 存在。
2. ${relationshipSkillTargetDir}/${relationshipSkillName}/README.md 存在。
3. ${relationshipSkillTargetDir}/${relationshipSkillName}/VERSION 存在，内容为 ${relationshipSkillVersion}。
4. ${relationshipSkillTargetDir}/${relationshipSkillName}/CHANGELOG.md 存在。
5. ${relationshipSkillAdapterBinDir}/detaches-agent-adapter.mjs 存在且可执行。
6. Main Agent / OpenClaw 已刷新或重启 skill 索引，可以加载该 skill。

请返回 installedPath、version、packageStructureStatus、reloadOrReindexStatus。`;
