import { Download, FileUp } from "lucide-react";
import type { ClientIdentity, DiagnosticItem, UploadedFileRef } from "@detaches/shared";
import { downloadUrl } from "../../lib/api.js";
import { AdapterStatusPanel } from "../adapters/AdapterStatusPanel.js";
import { DiagnosticsPanel } from "../connection/DiagnosticsPanel.js";
import { SkillInstallPanel } from "../skills/SkillInstallPanel.js";
import { ToolQueuePanel } from "../tools/ToolQueuePanel.js";

interface Props {
  sessionKey: string | null;
  agentId: string | null;
  clientIdentity: ClientIdentity | null;
  files: UploadedFileRef[];
  uploading: boolean;
  error: string | null;
  remotePath: string;
  diagnostics: DiagnosticItem[];
  diagnosticsLoading: boolean;
  diagnosticsError: string | null;
  onRemotePathChange: (value: string) => void;
  onDiagnosticsRefresh: () => void;
  onRevealTerminal: () => void;
}

export function FilePanel({
  sessionKey,
  agentId,
  clientIdentity,
  files,
  uploading,
  error,
  remotePath,
  diagnostics,
  diagnosticsLoading,
  diagnosticsError,
  onRemotePathChange,
  onDiagnosticsRefresh,
  onRevealTerminal
}: Props) {
  return (
    <aside className="file-panel">
      <DiagnosticsPanel items={diagnostics} loading={diagnosticsLoading} error={diagnosticsError} onRefresh={onDiagnosticsRefresh} />
      <SkillInstallPanel sessionKey={sessionKey} agentId={agentId} />
      <AdapterStatusPanel sessionKey={sessionKey} agentId={agentId} />
      <ToolQueuePanel sessionKey={sessionKey} agentId={agentId} clientIdentity={clientIdentity} onRevealTerminal={onRevealTerminal} />
      <div className="panel-heading">
        <div>
          <h2>Files</h2>
          <p>{uploading ? "Uploading..." : `${files.length} 个附件`}</p>
        </div>
        <FileUp size={18} />
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      <div className="file-list">
        {files.map((file) => (
          <div className="file-row" key={file.id}>
            <strong>{file.name}</strong>
            <small>{Math.ceil(file.size / 1024)} KB</small>
            {file.remotePath ? <code>{file.remotePath}</code> : <span className="muted">仅本地暂存</span>}
          </div>
        ))}
      </div>
      <div className="download-box">
        <h3>下载远端文件</h3>
        <input value={remotePath} onChange={(event) => onRemotePathChange(event.target.value)} placeholder="~/.openclaw/workspace/..." />
        <a className={`download-button ${remotePath ? "" : "disabled"}`} href={remotePath ? downloadUrl(remotePath) : undefined}>
          <Download size={16} />
          Download
        </a>
      </div>
      <div className="control-reserve">
        <h3>Remote control</h3>
        <p>远控功能已预留，后续会加入审批、审计、超时和权限边界。</p>
      </div>
    </aside>
  );
}
