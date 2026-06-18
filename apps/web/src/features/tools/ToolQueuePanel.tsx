import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Eye, RefreshCw, Send, TerminalSquare, X, BellRing } from "lucide-react";
import type { ClientIdentity, MainAgentFileTransferSnapshot, ToolBrokerSocketEvent, ToolDecisionActor, ToolExecutionResultResponse, ToolRequestRecord, ToolTarget } from "@detaches/shared";
import { approveToolRequest, fetchToolRequestResult, fetchToolRequests, rejectToolRequest, retryToolResultForward, submitMainAgentTransferPassword, wsUrl } from "../../lib/api.js";
import { isQueueToolRequestVisible, shouldSurfaceApproval, targetLabels, toolRequestSupported } from "./toolQueuePresentation.js";

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
  const surfacedRequestIds = useRef<Set<string>>(new Set());

  const surfaceApproval = useCallback((request: ToolRequestRecord, options: { requireRecent?: boolean } = {}) => {
    if (!shouldSurfaceApproval(request, options)) return;
    if (options.requireRecent !== true && !isRecentlyCreated(request)) return;
    if (surfacedRequestIds.current.has(request.id)) return;
    surfacedRequestIds.current.add(request.id);
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
      const visibleRequests = response.requests.filter(isQueueToolRequestVisible);
      setRequests(visibleRequests);
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
          ? upsertToolRequest(current, data.request)
          : current.filter((request) => request.id !== data.request.id));
        if ((data.action === "created" || data.action === "ingested") && isRecentlyCreated(data.request)) {
          surfaceApproval(data.request);
        }
        void refresh();
      }
      if (data.type === "transfer") {
        setTransfers((current) => ({ ...current, [data.transfer.requestId]: data.transfer }));
        if (data.transfer.needsPassword || data.transfer.status === "waiting-password") {
          setPasswordTransfer(data.transfer);
        }
      }
    };
    ws.onerror = () => ws.close();
    return () => ws.close();
  }, [sessionKey, agentId, refresh]);

  async function runRequest(request: ToolRequestRecord) {
    if (!confirmElevatedRisk(request)) return;
    setBusy((current) => ({ ...current, [request.id]: true }));
    setError(null);
    try {
      surfacedRequestIds.current.add(request.id);
      const response = await approveToolRequest(request.id, { riskAccepted: request.risk?.level === "elevated", actor: decisionActor(clientIdentity) });
      if (!response.execution?.wroteToTerminal && request.kind !== "main-agent-save-file") throw new Error(response.message || "Broker did not execute the request.");
      if (request.kind !== "file-transfer") onRevealTerminal();
      setAttentionRequest((current) => current?.id === request.id ? null : current);
      const result = await fetchToolRequestResult(request.id);
      setSummaries((current) => ({ ...current, [request.id]: toolResultSummary(result) }));
      if (request.kind === "main-agent-save-file") {
        const transfer = transferFromResult(result);
        if (transfer) {
          setTransfers((current) => ({ ...current, [request.id]: transfer }));
          if (transfer.needsPassword || transfer.status === "waiting-password") setPasswordTransfer(transfer);
        }
      }
      await refresh();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy((current) => ({ ...current, [request.id]: false }));
    }
  }

  async function submitPassword() {
    if (!passwordTransfer) return;
    setBusy((current) => ({ ...current, [passwordTransfer.requestId]: true }));
    setError(null);
    try {
      const response = await submitMainAgentTransferPassword(passwordTransfer.transferId, password);
      setPassword("");
      setPasswordTransfer(null);
      setTransfers((current) => ({ ...current, [response.transfer.requestId]: response.transfer }));
    } catch (passwordError) {
      setError(passwordError instanceof Error ? passwordError.message : String(passwordError));
    } finally {
      setBusy((current) => ({ ...current, [passwordTransfer.requestId]: false }));
    }
  }

  async function rejectRequest(request: ToolRequestRecord) {
    setBusy((current) => ({ ...current, [request.id]: true }));
    setError(null);
    try {
      surfacedRequestIds.current.add(request.id);
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
              <button type="button" className="icon-button small" title="Dismiss" onClick={() => setAttentionRequest(null)}>
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
              <button type="button" className="secondary-button" onClick={() => setAttentionRequest(null)}>
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
        <div className="tool-approval-backdrop" role="presentation">
          <div className="tool-approval-dialog" role="dialog" aria-modal="true" aria-label="SSH password required">
            <div className="tool-approval-header">
              <TerminalSquare size={18} />
              <div>
                <strong>SSH password required</strong>
                <small>{passwordTransfer.destination.user}@{passwordTransfer.destination.host}:{passwordTransfer.destination.port}</small>
              </div>
              <button type="button" className="icon-button small" title="Dismiss" onClick={() => setPasswordTransfer(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="tool-approval-body">
              <p>密码仅用于本次传输，不会保存。</p>
              <code>{passwordTransfer.sourceLocalPath}{"\n"}→ {passwordTransfer.destination.path}</code>
              <input
                type="password"
                value={password}
                autoFocus
                placeholder="SSH password"
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitPassword();
                }}
              />
            </div>
            <div className="tool-approval-actions">
              <button type="button" className="secondary-button" onClick={() => setPasswordTransfer(null)}>
                Later
              </button>
              <button type="button" className="primary-button" disabled={!password || busy[passwordTransfer.requestId]} onClick={() => void submitPassword()}>
                Continue
              </button>
            </div>
          </div>
        </div>
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
          return (
            <div className={`terminal-request-card ${request.kind === "file-transfer" ? "file-transfer-card" : ""}`} key={request.id}>
              <div>
                <strong>{toolRequestTitle(request)}</strong>
                <p className={`target-pill ${request.target}`}>Target: {targetLabels[request.target]}</p>
                {request.risk ? <p className={`risk-pill ${request.risk.level}`}>Risk: {request.risk.level}{request.risk.reasons.length ? ` · ${request.risk.reasons.join("; ")}` : ""}</p> : null}
                <small>{request.status} · {request.source || "unknown"}{request.sourceEventId ? ` · ${request.sourceEventId}` : ""}</small>
                {request.reason ? <p>{request.reason}</p> : null}
                <code>{toolRequestCode(request)}</code>
                {unsupported ? <p className="request-error">{unsupportedTargetMessage(request)}</p> : null}
                {summaries[request.id] ? <small>{summaries[request.id]}</small> : null}
                {transfers[request.id] ? <TransferProgress transfer={transfers[request.id]} /> : null}
              </div>
              <div className="terminal-request-actions">
                <button type="button" className="icon-button" title={request.risk?.level === "elevated" ? "Confirm run" : "Run"} disabled={disabled || request.status === "approved"} onClick={() => void runRequest(request)}>
                  <Check size={15} />
                </button>
                <button type="button" className="icon-button" title="Reject" disabled={busy[request.id] || request.status !== "pending"} onClick={() => void rejectRequest(request)}>
                  <X size={15} />
                </button>
                <button type="button" className="icon-button" title="Show terminal" onClick={onRevealTerminal}>
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
        <p>工具执行由本机 broker 写入当前会话 terminal，并保留审批与审计记录。</p>
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
  return `${record.user ?? ""}@${record.host ?? ""}:${record.port ?? 22}${record.path ?? ""}`;
}

function TransferProgress({ transfer }: { transfer: MainAgentFileTransferSnapshot }) {
  const percent = typeof transfer.progress === "number" ? Math.round(transfer.progress * 100) : undefined;
  return (
    <div className={`transfer-progress ${transfer.status}`}>
      <small>{transfer.status}{typeof percent === "number" ? ` · ${percent}%` : ""}{transfer.speed ? ` · ${transfer.speed}` : ""}</small>
      <progress value={transfer.progress ?? 0} max={1} />
      <code>{transfer.sourceLocalPath}{"\n"}→ {transfer.destination.user}@{transfer.destination.host}:{transfer.destination.path}</code>
      {transfer.error ? <p className="request-error">{transfer.error}</p> : transfer.message ? <small>{transfer.message}</small> : null}
    </div>
  );
}

function upsertToolRequest(current: ToolRequestRecord[], next: ToolRequestRecord): ToolRequestRecord[] {
  const index = current.findIndex((request) => request.id === next.id);
  if (index === -1) return [next, ...current];
  return current.map((request, itemIndex) => itemIndex === index ? next : request);
}

function isRecentlyCreated(request: ToolRequestRecord, nowMs = Date.now()): boolean {
  const createdAtMs = Date.parse(request.createdAt);
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= 5 * 60 * 1000;
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
