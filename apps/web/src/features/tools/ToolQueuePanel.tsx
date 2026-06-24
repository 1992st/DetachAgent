import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, KeyRound, RefreshCw, Send, TerminalSquare, X, BellRing } from "lucide-react";
import type { ClientIdentity, MainAgentFileTransferSnapshot, ToolBrokerSocketEvent, ToolDecisionActor, ToolExecutionResultResponse, ToolRequestRecord, ToolTarget } from "@detaches/shared";
import { approveToolRequest, fetchToolRequestResult, fetchToolRequests, rejectToolRequest, retryToolResultForward, submitMainAgentTransferPassword, wsUrl } from "../../lib/api.js";
import { isQueueToolRequestVisible, shouldSurfaceApproval, targetLabels, toolRequestSupported } from "./toolQueuePresentation.js";

const SUPPRESSED_APPROVALS_STORAGE_KEY = "detaches.toolQueue.suppressedApprovalTokens";
const LEGACY_SUPPRESSED_APPROVALS_STORAGE_KEY = "detaches.toolQueue.suppressedApprovalIds";
const MAX_SUPPRESSED_APPROVAL_TOKENS = 400;

interface Props {
  sessionKey: string | null;
  agentId: string | null;
  clientIdentity: ClientIdentity | null;
  onRevealTerminal: () => void;
}

export function ToolQueuePanel({ sessionKey, agentId, clientIdentity, onRevealTerminal }: Props) {
  const [requests, setRequests] = useState<ToolRequestRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [attentionRequest, setAttentionRequest] = useState<ToolRequestRecord | null>(null);
  const [transfers, setTransfers] = useState<Record<string, MainAgentFileTransferSnapshot>>({});
  const [passwordTransfer, setPasswordTransfer] = useState<MainAgentFileTransferSnapshot | null>(null);
  const [password, setPassword] = useState("");
  const [dismissedPasswordTransfers, setDismissedPasswordTransfers] = useState<Set<string>>(() => new Set());
  const surfacedRequestIds = useRef<Set<string>>(loadSuppressedApprovalIds());

  const dismissAttentionRequest = useCallback((request: ToolRequestRecord) => {
    suppressApprovalRequest(surfacedRequestIds.current, request);
    setAttentionRequest((current) => current?.id === request.id ? null : current);
  }, []);

  const surfaceApproval = useCallback((request: ToolRequestRecord, options: { requireRecent?: boolean } = {}) => {
    if (!shouldSurfaceApproval(request, options)) return;
    if (options.requireRecent !== true && !isRecentlyCreated(request)) return;
    if (isApprovalSuppressed(surfacedRequestIds.current, request)) return;
    setAttentionRequest(request);
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionKey) {
      setRequests([]);
      setAttentionRequest(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetchToolRequests({ sessionKey, agentId, limit: 50 });
      const visibleRequests = dedupeVisibleToolRequests(response.requests.filter(isQueueToolRequestVisible));
      setRequests(visibleRequests);
      void refreshRequestSnapshots(visibleRequests);
      const latestPending = visibleRequests.find((request) => shouldSurfaceApproval(request, { requireRecent: true }));
      if (latestPending) surfaceApproval(latestPending, { requireRecent: true });
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setLoading(false);
    }
  }, [sessionKey, agentId, surfaceApproval]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!sessionKey) return;
    const params = new URLSearchParams({ sessionKey });
    if (agentId) params.set("agentId", agentId);
    const ws = new WebSocket(wsUrl(`/api/tools/stream?${params}`));
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ToolBrokerSocketEvent;
      if (data.type === "request") {
        setRequests((current) => isQueueToolRequestVisible(data.request)
          ? dedupeVisibleToolRequests(upsertToolRequest(current, data.request))
          : current.filter((request) => request.id !== data.request.id));
        if ((data.action === "created" || data.action === "ingested") && isRecentlyCreated(data.request)) {
          surfaceApproval(data.request);
        }
        void refresh();
      }
      if (data.type === "transfer") {
        setTransfers((current) => ({ ...current, [data.transfer.requestId]: data.transfer }));
        setPasswordTransfer((current) => {
          if (current && current.transferId !== data.transfer.transferId) return current;
          return shouldOpenPasswordDialog(data.transfer, dismissedPasswordTransfers) ? data.transfer : null;
        });
        if (data.transfer.status === "succeeded" || data.transfer.status === "failed") {
          setPassword("");
        }
        if (shouldOpenPasswordDialog(data.transfer, dismissedPasswordTransfers)) {
          setPasswordTransfer((current) => current ?? data.transfer);
        }
      }
    };
    ws.onerror = () => ws.close();
    return () => ws.close();
  }, [sessionKey, agentId, refresh, dismissedPasswordTransfers]);

  async function runRequest(request: ToolRequestRecord) {
    if (!confirmElevatedRisk(request)) return;
    setBusy((current) => ({ ...current, [request.id]: true }));
    setError(null);
    try {
      suppressApprovalRequest(surfacedRequestIds.current, request);
      const response = await approveToolRequest(request.id, { riskAccepted: request.risk?.level === "elevated", actor: decisionActor(clientIdentity) });
      if (!response.execution?.wroteToTerminal && request.kind !== "main-agent-save-file") throw new Error(response.message || "Broker did not execute the request.");
      if (request.kind !== "file-transfer" && request.kind !== "main-agent-save-file") onRevealTerminal();
      setAttentionRequest((current) => current?.id === request.id ? null : current);
      const result = await fetchToolRequestResult(request.id);
      setSummaries((current) => ({ ...current, [request.id]: toolResultSummary(result) }));
      if (request.kind === "main-agent-save-file") {
        const transfer = transferFromResult(result);
        if (transfer) {
          setTransfers((current) => ({ ...current, [request.id]: transfer }));
          if (shouldOpenPasswordDialog(transfer, dismissedPasswordTransfers)) setPasswordTransfer(transfer);
        }
      }
      await refresh();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy((current) => ({ ...current, [request.id]: false }));
    }
  }

  async function refreshRequestSnapshots(nextRequests: ToolRequestRecord[]) {
    const snapshotRequests = nextRequests.filter((request) => request.status !== "pending" || request.kind === "main-agent-save-file");
    const results = await Promise.allSettled(snapshotRequests.map(async (request) => ({
      request,
      result: await fetchToolRequestResult(request.id)
    })));
    const nextSummaries: Record<string, string> = {};
    const nextTransfers: Record<string, MainAgentFileTransferSnapshot> = {};
    for (const item of results) {
      if (item.status !== "fulfilled") continue;
      nextSummaries[item.value.request.id] = toolResultSummary(item.value.result);
      const transfer = transferFromResult(item.value.result);
      if (transfer) nextTransfers[item.value.request.id] = transfer;
    }
    if (Object.keys(nextSummaries).length) {
      setSummaries((current) => ({ ...current, ...nextSummaries }));
    }
    if (Object.keys(nextTransfers).length) {
      setTransfers((current) => ({ ...current, ...nextTransfers }));
      setPasswordTransfer((current) => current ?? nextPasswordTransfer(nextTransfers, dismissedPasswordTransfers));
    }
  }

  async function submitPassword() {
    if (!passwordTransfer) return;
    setBusy((current) => ({ ...current, [passwordTransfer.requestId]: true }));
    setError(null);
    try {
      const response = await submitMainAgentTransferPassword(passwordTransfer.transferId, password);
      setPassword("");
      setTransfers((current) => {
        const nextTransfers = { ...current, [response.transfer.requestId]: response.transfer };
        setPasswordTransfer(nextPasswordTransfer(nextTransfers, dismissedPasswordTransfers, response.transfer.transferId));
        return nextTransfers;
      });
    } catch (passwordError) {
      setError(passwordError instanceof Error ? passwordError.message : String(passwordError));
    } finally {
      setBusy((current) => ({ ...current, [passwordTransfer.requestId]: false }));
    }
  }

  function dismissPasswordDialog(transfer: MainAgentFileTransferSnapshot) {
    let nextDismissed = dismissedPasswordTransfers;
    setDismissedPasswordTransfers((current) => {
      nextDismissed = new Set(current).add(transfer.transferId);
      return nextDismissed;
    });
    setPasswordTransfer(nextPasswordTransfer(transfers, nextDismissed, transfer.transferId));
    setPassword("");
  }

  function reopenPasswordDialog(transfer: MainAgentFileTransferSnapshot) {
    setDismissedPasswordTransfers((current) => {
      const next = new Set(current);
      next.delete(transfer.transferId);
      return next;
    });
    setPasswordTransfer(transfer);
  }

  async function rejectRequest(request: ToolRequestRecord) {
    setBusy((current) => ({ ...current, [request.id]: true }));
    setError(null);
    try {
      suppressApprovalRequest(surfacedRequestIds.current, request);
      await rejectToolRequest(request.id, { actor: decisionActor(clientIdentity) });
      setAttentionRequest((current) => current?.id === request.id ? null : current);
      await refresh();
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : String(rejectError));
    } finally {
      setBusy((current) => ({ ...current, [request.id]: false }));
    }
  }

  async function retryForward(request: ToolRequestRecord) {
    setBusy((current) => ({ ...current, [request.id]: true }));
    setError(null);
    try {
      const response = await retryToolResultForward(request.id);
      setSummaries((current) => ({ ...current, [request.id]: toolResultSummary(response) }));
      await refresh();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setBusy((current) => ({ ...current, [request.id]: false }));
    }
  }

  return (
    <section className="tool-queue">
      {attentionRequest ? (
        <div className="tool-approval-backdrop" role="presentation">
          <div className="tool-approval-dialog" role="dialog" aria-modal="true" aria-label="Tool approval request">
            <div className="tool-approval-header">
              <BellRing size={18} />
              <div>
                <strong>{toolRequestTitle(attentionRequest)}</strong>
                <small>{attentionRequest.source || "unknown"} · {attentionRequest.status}</small>
              </div>
              <button type="button" className="icon-button small" title="Dismiss" onClick={() => dismissAttentionRequest(attentionRequest)}>
                <X size={15} />
              </button>
            </div>
            <div className="tool-approval-body">
              <p className={`target-pill ${attentionRequest.target}`}>Target: {targetLabels[attentionRequest.target]}</p>
              {attentionRequest.risk ? <p className={`risk-pill ${attentionRequest.risk.level}`}>Risk: {attentionRequest.risk.level}{attentionRequest.risk.reasons.length ? ` · ${attentionRequest.risk.reasons.join("; ")}` : ""}</p> : null}
              {attentionRequest.reason ? <p>{attentionRequest.reason}</p> : null}
              <code>{toolRequestCode(attentionRequest)}</code>
            </div>
            <div className="tool-approval-actions">
              <button type="button" className="secondary-button" onClick={() => dismissAttentionRequest(attentionRequest)}>
                Later
              </button>
              <button type="button" className="secondary-button danger" disabled={busy[attentionRequest.id] || attentionRequest.status !== "pending"} onClick={() => void rejectRequest(attentionRequest)}>
                Reject
              </button>
              <button type="button" className="primary-button" disabled={busy[attentionRequest.id] || attentionRequest.status !== "pending" || !toolRequestSupported(attentionRequest)} onClick={() => void runRequest(attentionRequest)}>
                Approve
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {passwordTransfer ? (
        <SaveFilePasswordDialog
          transfer={passwordTransfer}
          password={password}
          busy={Boolean(busy[passwordTransfer.requestId])}
          error={error}
          onPasswordChange={setPassword}
          onSubmit={() => void submitPassword()}
          onDismiss={() => dismissPasswordDialog(passwordTransfer)}
        />
      ) : null}
      <div className="panel-heading compact">
        <div>
          <h2>Tool Queue</h2>
          <p>{loading ? "Refreshing..." : `${requests.length} 个请求`}</p>
        </div>
        <button type="button" className="icon-button small" title="Refresh tools" onClick={() => void refresh()} disabled={!sessionKey}>
          <RefreshCw size={15} />
        </button>
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      {!sessionKey ? <div className="empty-state">选择 Agent 后显示工具请求。</div> : null}
      {sessionKey && !requests.length && !loading ? <div className="empty-state">暂无待处理工具请求。</div> : null}
      <div className="tool-queue-list">
        {requests.map((request) => {
          const unsupported = !toolRequestSupported(request);
          const disabled = busy[request.id] || (request.status !== "pending" && request.status !== "failed") || unsupported;
          const transfer = transfers[request.id];
          return (
            <div className={`terminal-request-card ${request.kind === "file-transfer" ? "file-transfer-card" : ""}`} key={request.id}>
              <div>
                <strong>{toolRequestTitle(request)}</strong>
                <p className={`target-pill ${request.target}`}>Target: {targetLabels[request.target]}</p>
                {request.risk ? <p className={`risk-pill ${request.risk.level}`}>Risk: {request.risk.level}{request.risk.reasons.length ? ` · ${request.risk.reasons.join("; ")}` : ""}</p> : null}
                <small>{request.status} · {request.source || "unknown"}{request.sourceEventId ? ` · ${request.sourceEventId}` : ""}</small>
                {request.reason ? <p>{request.reason}</p> : null}
                <code>{toolRequestCode(request)}</code>
                {request.error ? <p className="request-error">{request.error}</p> : null}
                {unsupported ? <p className="request-error">{unsupportedTargetMessage(request)}</p> : null}
                {summaries[request.id] ? <small>{summaries[request.id]}</small> : null}
                {transfer ? <TransferProgress transfer={transfer} onEnterPassword={reopenPasswordDialog} /> : null}
              </div>
              <div className="terminal-request-actions">
                <button type="button" className="secondary-button compact" title={toolRequestActionTitle(request, transfer)} disabled={disabled || request.status === "approved"} onClick={() => void runRequest(request)}>
                  <Check size={15} />
                  {toolRequestActionLabel(request, transfer, Boolean(busy[request.id]))}
                </button>
                <button type="button" className="icon-button" title="Reject" disabled={busy[request.id] || request.status !== "pending"} onClick={() => void rejectRequest(request)}>
                  <X size={15} />
                </button>
                <button type="button" className="icon-button" title={request.kind === "main-agent-save-file" ? "Show log" : "Show terminal"} onClick={onRevealTerminal}>
                  <Eye size={15} />
                </button>
                {request.status === "approved" ? (
                  <button type="button" className="icon-button" title="Retry result forward" disabled={busy[request.id]} onClick={() => void retryForward(request)}>
                    <Send size={15} />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="control-reserve slim">
        <TerminalSquare size={16} />
        <p>工具由本机 broker 审批执行；terminal 仅用于普通命令或人工观察。</p>
      </div>
    </section>
  );
}

function decisionActor(identity: ClientIdentity | null): ToolDecisionActor {
  return {
    deviceId: identity?.deviceId,
    deviceIdShort: identity?.deviceIdShort,
    displayName: identity?.displayName,
    source: "detaches-ui"
  };
}

function unsupportedTargetMessage(request: ToolRequestRecord): string {
  if (request.target === "remote-agent-host") {
    return `${toolRequestTitle(request)} 当前不支持直接在远端执行，不能退化到用户本机执行。`;
  }
  return `${targetLabels[request.target]} 当前还没有执行 adapter，不能把请求退化到用户本机执行。`;
}

function toolRequestTitle(request: ToolRequestRecord): string {
  if (request.kind === "main-agent-save-file") return "Save file to Main Agent";
  if (request.kind === "file-transfer") return "File transfer";
  if (request.kind === "adapter-install") return "Adapter install";
  if (request.kind === "skill-install") return "Skill install";
  if (request.kind === "skill-verify") return "Skill verify";
  return "Terminal command";
}

function toolRequestActionLabel(request: ToolRequestRecord, transfer: MainAgentFileTransferSnapshot | undefined, busy: boolean): string {
  if (busy) return "Running";
  if (request.status === "running") {
    if (transfer?.status === "waiting-password" || transfer?.needsPassword) return "Waiting password";
    if (transfer?.status === "transferring") return "Transferring";
    return "Running";
  }
  if (request.status === "succeeded") return "Succeeded";
  if (request.status === "approved") return "Approved";
  if (request.status === "failed") return "Retry";
  if (request.risk?.level === "elevated") return "Confirm";
  return request.kind === "main-agent-save-file" ? "Save" : "Run";
}

function toolRequestActionTitle(request: ToolRequestRecord, transfer: MainAgentFileTransferSnapshot | undefined): string {
  if (request.status === "running") return transfer?.message || "Tool request is already running.";
  if (request.status === "failed") return "Retry failed request";
  return request.risk?.level === "elevated" ? "Confirm run" : "Run";
}

function confirmElevatedRisk(request: ToolRequestRecord): boolean {
  if (request.risk?.level !== "elevated") return true;
  const reason = request.risk.reasons.join("; ") || "Elevated-risk tool request";
  return window.confirm(`确认执行高风险工具请求？\n\n${reason}`);
}

function toolRequestCode(request: ToolRequestRecord): string {
  if (request.kind === "terminal") {
    return typeof request.payload.command === "string" ? request.payload.command : JSON.stringify(request.payload, null, 2);
  }
  if (request.kind === "adapter-install") {
    return [
      `installDir: ${typeof request.payload.installDir === "string" ? request.payload.installDir : "~/.detach_agent"}`,
      "action: install detaches adapter on remote-agent-host"
    ].join("\n");
  }
  if (request.kind === "main-agent-save-file") {
    const destination = destinationPayload(request.payload.destination);
    return [
      `fileId: ${typeof request.payload.fileId === "string" ? request.payload.fileId : ""}`,
      `sourceLocalPath: ${typeof request.payload.sourceLocalPath === "string" ? request.payload.sourceLocalPath : ""}`,
      `destination: ${destination}`,
      `method: ${typeof request.payload.methodPreference === "string" ? request.payload.methodPreference : "rsync"}`
    ].join("\n");
  }
  if (request.kind === "skill-install" || request.kind === "skill-verify") {
    return [
      `skillName: ${typeof request.payload.skillName === "string" ? request.payload.skillName : "detach-agent-relationship"}`,
      `targetAgent: ${typeof request.payload.targetAgent === "string" ? request.payload.targetAgent : "openclaw"}`,
      `targetDir: ${typeof request.payload.targetDir === "string" ? request.payload.targetDir : "~/.openclaw/skills"}`,
      `action: ${request.kind === "skill-install" ? "install/update host skill" : "verify host skill"}`
    ].join("\n");
  }
  return [
    `fileId: ${typeof request.payload.fileId === "string" ? request.payload.fileId : ""}`,
    `remotePath: ${typeof request.payload.remotePath === "string" ? request.payload.remotePath : ""}`
  ].join("\n");
}

function destinationPayload(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const user = typeof record.user === "string" && record.user.trim() ? record.user.trim() : "(missing user)";
  const pathValue = typeof record.path === "string" && record.path.trim() ? record.path.trim() : "(missing path)";
  const host = typeof record.host === "string" && record.host.trim() ? record.host.trim() : "current Main Agent SSH config";
  const port = typeof record.port === "number" && record.port > 0 ? `:${record.port}` : "";
  return `user: ${user}\nconnection: ${host}${port}\npath: ${pathValue}`;
}

function TransferProgress({ transfer, onEnterPassword }: { transfer: MainAgentFileTransferSnapshot; onEnterPassword: (transfer: MainAgentFileTransferSnapshot) => void }) {
  const percent = typeof transfer.progress === "number" ? Math.round(transfer.progress * 100) : undefined;
  const needsPassword = transfer.status === "waiting-password" || transfer.needsPassword;
  return (
    <div className={`transfer-progress ${transfer.status}`}>
      <small>{transfer.status}{typeof percent === "number" ? ` · ${percent}%` : ""}{transfer.speed ? ` · ${transfer.speed}` : ""}</small>
      <progress value={transfer.progress ?? 0} max={1} />
      <code>{transfer.sourceLocalPath}{"\n"}→ {transfer.destination.user}@{transfer.destination.host}:{transfer.destination.path}</code>
      {transfer.commandPreview ? <code>{transfer.commandPreview}</code> : null}
      {transfer.warnings?.map((warning) => <p className="request-warning" key={warning}>{warning}</p>)}
      {transfer.error ? <p className="request-error">{transfer.error}</p> : transfer.message ? <small>{transfer.message}</small> : null}
      {needsPassword ? (
        <button type="button" className="secondary-button compact" onClick={() => onEnterPassword(transfer)}>
          Enter password {passwordCountdown(transfer)}
        </button>
      ) : null}
    </div>
  );
}

function SaveFilePasswordDialog({
  transfer,
  password,
  busy,
  error,
  onPasswordChange,
  onSubmit,
  onDismiss
}: {
  transfer: MainAgentFileTransferSnapshot;
  password: string;
  busy: boolean;
  error: string | null;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remainingMs = transfer.passwordExpiresAt ? Math.max(0, Date.parse(transfer.passwordExpiresAt) - now) : undefined;
  const remaining = typeof remainingMs === "number" ? formatRemaining(remainingMs) : "";
  const canSubmit = Boolean(password) && !busy && remainingMs !== 0;
  return (
    <div className="save-password-backdrop" role="presentation">
      <div className="save-password-dialog" role="dialog" aria-modal="true" aria-label="SSH password required">
        <header className="save-password-header">
          <KeyRound size={20} />
          <div>
            <strong>SSH password required</strong>
            <small>{transfer.destination.user}@{transfer.destination.host}:{transfer.destination.port}</small>
          </div>
          <button type="button" className="icon-button small" title="Dismiss" onClick={onDismiss}>
            <X size={15} />
          </button>
        </header>
        <div className="save-password-content">
          {transfer.warnings?.map((warning) => <p className="save-password-warning" key={warning}>{warning}</p>)}
          <section>
            <h3>Connection</h3>
            <div className="save-password-grid">
              <span>Method</span><strong>{transfer.method}</strong>
              <span>Expires</span><strong>{remaining || "3:00"}</strong>
            </div>
          </section>
          <section>
            <h3>File</h3>
            <p title={transfer.sourceLocalPath}><span>From</span>{middleEllipsis(transfer.sourceLocalPath)}</p>
            <p title={transfer.destination.path}><span>To</span>{middleEllipsis(transfer.destination.path)}</p>
          </section>
          <section>
            <div className="save-password-section-title">
              <h3>Command</h3>
              <button type="button" className="icon-button small" title="Copy command" onClick={() => void navigator.clipboard.writeText(transfer.commandPreview || "")} disabled={!transfer.commandPreview}>
                <Copy size={14} />
              </button>
            </div>
            <code>{transfer.commandPreview || "Command preview is not available yet."}</code>
          </section>
          <section>
            <h3>Password</h3>
            <p className="save-password-note">密码仅用于本次 SSH 传输，不会保存。</p>
            <input
              type="password"
              value={password}
              autoFocus
              placeholder="SSH password"
              onChange={(event) => onPasswordChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) onSubmit();
              }}
            />
          </section>
          {error ? <p className="save-password-error">{error}</p> : null}
        </div>
        <footer className="save-password-actions">
          <button type="button" className="secondary-button" onClick={onDismiss}>Later</button>
          <button type="button" className="primary-button" disabled={!canSubmit} onClick={onSubmit}>{busy ? "Continuing..." : "Continue"}</button>
        </footer>
      </div>
    </div>
  );
}

function shouldOpenPasswordDialog(transfer: MainAgentFileTransferSnapshot, dismissed: Set<string>): boolean {
  if (dismissed.has(transfer.transferId)) return false;
  if (transfer.status === "succeeded" || transfer.status === "failed") return false;
  return transfer.status === "waiting-password" || transfer.needsPassword;
}

function nextPasswordTransfer(
  transfers: Record<string, MainAgentFileTransferSnapshot>,
  dismissed: Set<string>,
  excludeTransferId?: string
): MainAgentFileTransferSnapshot | null {
  return Object.values(transfers)
    .filter((transfer) => transfer.transferId !== excludeTransferId)
    .find((transfer) => shouldOpenPasswordDialog(transfer, dismissed)) ?? null;
}

function passwordCountdown(transfer: MainAgentFileTransferSnapshot): string {
  if (!transfer.passwordExpiresAt) return "";
  const remaining = Math.max(0, Date.parse(transfer.passwordExpiresAt) - Date.now());
  return `(${formatRemaining(remaining)})`;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function middleEllipsis(value: string): string {
  if (value.length <= 72) return value;
  return `${value.slice(0, 34)}...${value.slice(-34)}`;
}

function upsertToolRequest(current: ToolRequestRecord[], next: ToolRequestRecord): ToolRequestRecord[] {
  const index = current.findIndex((request) => request.id === next.id);
  if (index === -1) return [next, ...current];
  return current.map((request, itemIndex) => itemIndex === index ? next : request);
}

function dedupeVisibleToolRequests(requests: ToolRequestRecord[]): ToolRequestRecord[] {
  const visible = requests.filter(isQueueToolRequestVisible);
  const seen = new Set<string>();
  return visible.filter((request) => {
    const key = visibleToolRequestKey(request);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function visibleToolRequestKey(request: ToolRequestRecord): string | null {
  if (request.kind !== "main-agent-save-file" && request.kind !== "file-transfer") return null;
  return [
    request.kind,
    request.target,
    String(request.payload.fileId ?? ""),
    String(request.payload.sourceLocalPath ?? ""),
    String(request.payload.remotePath ?? ""),
    destinationFingerprint(request.payload.destination)
  ].join("\0");
}

function isRecentlyCreated(request: ToolRequestRecord, nowMs = Date.now()): boolean {
  const createdAtMs = Date.parse(request.createdAt);
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= 5 * 60 * 1000;
}

function loadSuppressedApprovalIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SUPPRESSED_APPROVALS_STORAGE_KEY) || "[]");
    const tokens = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
    const legacy = JSON.parse(window.localStorage.getItem(LEGACY_SUPPRESSED_APPROVALS_STORAGE_KEY) || "[]");
    if (Array.isArray(legacy)) {
      legacy.filter((id): id is string => typeof id === "string").forEach((id) => tokens.add(approvalIdToken(id)));
    }
    return tokens;
  } catch {
    return new Set();
  }
}

function suppressApprovalRequest(ids: Set<string>, requestIdOrRequest: string | ToolRequestRecord) {
  const tokens = typeof requestIdOrRequest === "string"
    ? [approvalIdToken(requestIdOrRequest)]
    : approvalSuppressionTokens(requestIdOrRequest);
  tokens.forEach((token) => {
    ids.delete(token);
    ids.add(token);
  });
  while (ids.size > MAX_SUPPRESSED_APPROVAL_TOKENS) {
    const oldest = ids.values().next().value;
    if (typeof oldest !== "string") break;
    ids.delete(oldest);
  }
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SUPPRESSED_APPROVALS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Best-effort UI preference; approval safety still lives in the broker.
  }
}

function isApprovalSuppressed(ids: Set<string>, request: ToolRequestRecord): boolean {
  return approvalSuppressionTokens(request).some((token) => ids.has(token));
}

function approvalSuppressionTokens(request: ToolRequestRecord): string[] {
  return [approvalIdToken(request.id), `fp:${toolRequestFingerprint(request)}`];
}

function approvalIdToken(requestId: string): string {
  return requestId.startsWith("id:") ? requestId : `id:${requestId}`;
}

function toolRequestFingerprint(request: ToolRequestRecord): string {
  return [
    request.kind,
    request.target,
    String(request.payload.command ?? ""),
    String(request.payload.fileId ?? ""),
    String(request.payload.remotePath ?? ""),
    String(request.payload.sourceLocalPath ?? ""),
    destinationFingerprint(request.payload.destination)
  ].join("\0");
}

function destinationFingerprint(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return [
    String(record.host ?? ""),
    String(record.port ?? ""),
    String(record.user ?? ""),
    String(record.path ?? "")
  ].join("\0");
}

function toolResultSummary(response: ToolExecutionResultResponse): string {
  const result = response.result;
  const status = result.completed
    ? `completed${typeof result.exitCode === "number" ? `, exit ${result.exitCode}` : ""}`
    : "still running";
  const forward = result.forwardStatus === "sent"
    ? "forwarded to agent"
    : result.forwardStatus === "failed"
      ? `forward failed${result.forwardError ? `: ${result.forwardError}` : ""}`
      : result.forwardStatus === "pending"
        ? "forward pending"
        : "forward not started";
  return `${status}; ${forward}; captured ${result.outputBytes} bytes from terminal ${result.terminalId || ""}`.trim();
}

function transferFromResult(response: ToolExecutionResultResponse): MainAgentFileTransferSnapshot | null {
  if (response.request.kind !== "main-agent-save-file" || !response.result.output) return null;
  try {
    const parsed = JSON.parse(response.result.output) as MainAgentFileTransferSnapshot;
    return parsed?.transferId && parsed?.requestId ? parsed : null;
  } catch {
    return null;
  }
}
