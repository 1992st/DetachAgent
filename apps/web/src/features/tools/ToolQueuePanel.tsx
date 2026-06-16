import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Eye, RefreshCw, Send, TerminalSquare, X, BellRing } from "lucide-react";
import type { ClientIdentity, ToolBrokerSocketEvent, ToolDecisionActor, ToolExecutionResultResponse, ToolRequestRecord, ToolTarget } from "@detaches/shared";
import { approveToolRequest, fetchToolRequestResult, fetchToolRequests, rejectToolRequest, retryToolResultForward } from "../../lib/api.js";
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
  const surfacedRequestIds = useRef<Set<string>>(new Set());

  const surfaceApproval = useCallback((request: ToolRequestRecord, options: { requireRecent?: boolean } = {}) => {
    if (!shouldSurfaceApproval(request, options)) return;
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
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ sessionKey });
    if (agentId) params.set("agentId", agentId);
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/tools/stream?${params}`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ToolBrokerSocketEvent;
      if (data.type === "request") {
        setRequests((current) => isQueueToolRequestVisible(data.request)
          ? upsertToolRequest(current, data.request)
          : current.filter((request) => request.id !== data.request.id));
        if (data.action === "created" || data.action === "ingested") {
          surfaceApproval(data.request);
        }
        void refresh();
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
      const response = await approveToolRequest(request.id, { riskAccepted: request.risk?.level === "elevated", actor: decisionActor(clientIdentity) });
      if (!response.execution?.wroteToTerminal) throw new Error(response.message || "Broker did not execute the request.");
      if (request.kind !== "file-transfer") onRevealTerminal();
      setAttentionRequest((current) => current?.id === request.id ? null : current);
      const result = await fetchToolRequestResult(request.id);
      setSummaries((current) => ({ ...current, [request.id]: toolResultSummary(result) }));
      await refresh();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy((current) => ({ ...current, [request.id]: false }));
    }
  }

  async function rejectRequest(request: ToolRequestRecord) {
    setBusy((current) => ({ ...current, [request.id]: true }));
    setError(null);
    try {
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

function upsertToolRequest(current: ToolRequestRecord[], next: ToolRequestRecord): ToolRequestRecord[] {
  const index = current.findIndex((request) => request.id === next.id);
  if (index === -1) return [next, ...current];
  return current.map((request, itemIndex) => itemIndex === index ? next : request);
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
