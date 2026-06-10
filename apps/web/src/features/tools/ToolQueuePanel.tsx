import { useCallback, useEffect, useState } from "react";
import { Check, Eye, RefreshCw, Send, TerminalSquare, X } from "lucide-react";
import type { ToolBrokerSocketEvent, ToolExecutionResultResponse, ToolRequestRecord, ToolTarget } from "@detaches/shared";
import { approveToolRequest, fetchToolRequestResult, fetchToolRequests, rejectToolRequest, retryToolResultForward } from "../../lib/api.js";

interface Props {
  sessionKey: string | null;
  agentId: string | null;
  onRevealTerminal: () => void;
}

export function ToolQueuePanel({ sessionKey, agentId, onRevealTerminal }: Props) {
  const [requests, setRequests] = useState<ToolRequestRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [summaries, setSummaries] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!sessionKey) {
      setRequests([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetchToolRequests({ sessionKey, agentId, limit: 50 });
      setRequests(response.requests);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setLoading(false);
    }
  }, [sessionKey, agentId]);

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
        setRequests((current) => upsertToolRequest(current, data.request));
        void refresh();
      }
    };
    ws.onerror = () => ws.close();
    return () => ws.close();
  }, [sessionKey, agentId, refresh]);

  async function runRequest(request: ToolRequestRecord) {
    setBusy((current) => ({ ...current, [request.id]: true }));
    setError(null);
    try {
      const response = await approveToolRequest(request.id);
      if (!response.execution?.wroteToTerminal) throw new Error(response.message || "Broker did not execute the request.");
      onRevealTerminal();
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
      await rejectToolRequest(request.id);
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
          const unsupported = !targetIsSupported(request.target);
          const disabled = busy[request.id] || request.status === "rejected" || unsupported;
          return (
            <div className={`terminal-request-card ${request.kind === "file-transfer" ? "file-transfer-card" : ""}`} key={request.id}>
              <div>
                <strong>{request.kind === "file-transfer" ? "File transfer" : "Terminal command"}</strong>
                <p className={`target-pill ${request.target}`}>Target: {targetLabels[request.target]}</p>
                {request.risk ? <p className={`risk-pill ${request.risk.level}`}>Risk: {request.risk.level}{request.risk.reasons.length ? ` · ${request.risk.reasons.join("; ")}` : ""}</p> : null}
                <small>{request.status} · {request.source || "unknown"}{request.sourceEventId ? ` · ${request.sourceEventId}` : ""}</small>
                {request.reason ? <p>{request.reason}</p> : null}
                <code>{toolRequestCode(request)}</code>
                {unsupported ? <p className="request-error">{unsupportedTargetMessage(request.target)}</p> : null}
                {summaries[request.id] ? <small>{summaries[request.id]}</small> : null}
              </div>
              <div className="terminal-request-actions">
                <button type="button" className="icon-button" title="Run" disabled={disabled || request.status === "approved"} onClick={() => void runRequest(request)}>
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

const targetLabels: Record<ToolTarget, string> = {
  "local-user-machine": "用户本机",
  "remote-agent-host": "远端 Agent 机器",
  "gateway-managed": "Gateway 托管"
};

function targetIsSupported(target: ToolTarget): boolean {
  return target === "local-user-machine";
}

function unsupportedTargetMessage(target: ToolTarget): string {
  return `${targetLabels[target]} 当前还没有执行 adapter，不能把请求退化到用户本机执行。`;
}

function toolRequestCode(request: ToolRequestRecord): string {
  if (request.kind === "terminal") {
    return typeof request.payload.command === "string" ? request.payload.command : JSON.stringify(request.payload, null, 2);
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
