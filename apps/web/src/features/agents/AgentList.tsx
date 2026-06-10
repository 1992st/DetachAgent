import { Bot, RefreshCw } from "lucide-react";
import type { AgentSummary } from "@detaches/shared";

interface Props {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (agentId: string) => void;
  onRefresh: () => void;
}

export function AgentList({ agents, selectedAgentId, loading, error, onSelect, onRefresh }: Props) {
  return (
    <aside className="agent-panel">
      <div className="panel-heading">
        <div>
          <h2>Agents</h2>
          <p>{agents.length ? `${agents.length} 个可聊天目标` : loading ? "正在读取远端 Agents" : "等待 Gateway Agents"}</p>
        </div>
        <button className="icon-button" onClick={onRefresh} disabled={loading} title="Refresh agents">
          <RefreshCw size={16} />
        </button>
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      <div className="agent-list">
        {agents.map((agent) => (
          <button
            className={`agent-row ${selectedAgentId === agent.id ? "active" : ""}`}
            key={agent.sessionKey}
            onClick={() => onSelect(agent.id)}
          >
            <Bot size={18} />
            <span>
              <strong>{agent.title}</strong>
              <small>{agent.preview || agent.status}</small>
            </span>
          </button>
        ))}
        {!loading && agents.length === 0 ? (
          <div className="empty-state">Gateway 已连接时会在这里显示当前可聊天 Agent。</div>
        ) : null}
      </div>
    </aside>
  );
}
