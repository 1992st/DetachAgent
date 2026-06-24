import { Copy, FileText, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";

const skillName = "detach-agent-relationship";
const skillVersion = "1.0.1";
const protocolVersion = "1.0.0";
const packageVersion = "1.0.1";
const targetDir = "~/.openclaw/skills";
const repositoryUrl = "https://github.com/1992st/DetachAgent.git";
const skillSourcePath = "packages/openclaw-detaches-adapter/skills/detach-agent-relationship";

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
          <h2>Detach relationship skill 安装</h2>
          <p>OpenClaw 全局 Main Agent skill，用于让 Main Agent 理解 detaches_agent 上下文与文件转交协议。</p>
        </div>
        <ShieldCheck size={17} />
      </div>
      <div className="adapter-state-card">
        <div>
          <FileText size={16} />
          <strong>{skillName}</strong>
        </div>
        <small>安装说明 · 需在 Main Agent 机器执行</small>
        <small>目标路径：{targetDir}/{skillName}</small>
        <small>skill v{skillVersion} · protocol v{protocolVersion} · package v{packageVersion}</small>
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
              ? "复制到 Main Agent 机器的 terminal 执行，从 GitHub 拉取 relationship skill 并安装到 OpenClaw shared/global skills 路径。"
              : "复制到 Main Agent 机器的 terminal 执行，检查 skill 文件和版本。"}
            value={mode === "install" ? installCommand : verifyCommand}
            copyLabel={`${mode}-command`}
            copied={copied}
            onCopy={copy}
          />
          <InstructionBlock
            title={mode === "install" ? "发给 Main Agent 的 Prompt" : "发给 Main Agent 的验证 Prompt"}
            description={mode === "install"
              ? "当用户希望 Main Agent 自己处理安装时，复制这段 prompt 发给 Main Agent。"
              : "当用户希望 Main Agent 自己检查安装状态时，复制这段 prompt 发给 Main Agent。"}
            value={mode === "install" ? installPrompt : verifyPrompt}
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

const installCommand = [
  "tmp_dir=$(mktemp -d)",
  `git clone --depth 1 ${repositoryUrl} "$tmp_dir/DetachAgent"`,
  `mkdir -p ${targetDir}`,
  `rm -rf ${targetDir}/${skillName}`,
  `cp -R "$tmp_dir/DetachAgent/${skillSourcePath}" ${targetDir}/${skillName}`,
  `test -f ${targetDir}/${skillName}/SKILL.md`,
  `test -f ${targetDir}/${skillName}/README.md`,
  `test -f ${targetDir}/${skillName}/VERSION`,
  `test -f ${targetDir}/${skillName}/CHANGELOG.md`,
  `cat ${targetDir}/${skillName}/VERSION`,
  "rm -rf \"$tmp_dir\""
].join(" && ");

const verifyCommand = [
  `test -f ${targetDir}/${skillName}/SKILL.md`,
  `test -f ${targetDir}/${skillName}/README.md`,
  `test -f ${targetDir}/${skillName}/VERSION`,
  `test -f ${targetDir}/${skillName}/CHANGELOG.md`,
  `printf 'detach-agent-relationship version: '`,
  `cat ${targetDir}/${skillName}/VERSION`
].join(" && ");

const installPrompt = `请在 Main Agent 机器上安装或更新 OpenClaw relationship skill。

目标 skill: ${skillName}
目标版本: ${skillVersion}
GitHub 仓库: ${repositoryUrl}
仓库内路径: ${skillSourcePath}
安装路径: ${targetDir}/${skillName}

请在 Main Agent 机器执行以下步骤：
1. 从 GitHub clone 仓库。
2. 将 ${skillSourcePath} 复制到 ${targetDir}/${skillName}。
3. 确认安装目录包含 SKILL.md、README.md、VERSION、CHANGELOG.md。
4. 确认 VERSION 内容为 ${skillVersion}。
5. 安装后刷新或重启 Main Agent / OpenClaw skill 索引，让新 skill 生效。

不要把这个 skill 安装到 Detach Agent 机器，除非这台机器同时也是 Main Agent 机器。`;

const verifyPrompt = `请在 Main Agent 机器上验证 OpenClaw relationship skill 是否安装正确。

目标 skill: ${skillName}
期望版本: ${skillVersion}
安装路径: ${targetDir}/${skillName}

请检查：
1. ${targetDir}/${skillName}/SKILL.md 存在。
2. ${targetDir}/${skillName}/README.md 存在。
3. ${targetDir}/${skillName}/VERSION 存在，内容为 ${skillVersion}。
4. ${targetDir}/${skillName}/CHANGELOG.md 存在。
5. Main Agent / OpenClaw 已刷新或重启 skill 索引，可以加载该 skill。

请返回 installedPath、version、packageStructureStatus、reloadOrReindexStatus。`;
