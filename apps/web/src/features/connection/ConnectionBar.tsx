import { RefreshCw, Server, ShieldAlert, Wifi } from "lucide-react";
import type { AppHealth } from "@detaches/shared";

interface Props {
  health: AppHealth | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function pill(state: string, label: string, message?: string) {
  return (
    <span className={`status-pill ${state}`} title={message}>
      {label}
    </span>
  );
}

export function ConnectionBar({ health, loading, error, onRefresh }: Props) {
  return (
    <header className="connection-bar">
      <div className="brand">
        <Server size={20} />
        <div>
          <strong>detaches_agent</strong>
          <span>Local UI to remote OpenClaw</span>
        </div>
      </div>
      <div className="connection-status">
        {health ? (
          <>
            {pill(health.ssh.state, "SSH", health.ssh.message)}
            {pill(health.gateway.state, "Gateway", health.gateway.message)}
            <span className="remote-host">{health.config.remoteHost}</span>
          </>
        ) : (
          <span className="muted">{loading ? "Checking connection..." : "Not checked"}</span>
        )}
        {error ? (
          <span className="error-inline">
            <ShieldAlert size={15} />
            {error}
          </span>
        ) : null}
        <button className="icon-button" onClick={onRefresh} disabled={loading} title="Refresh connection">
          {loading ? <Wifi size={16} /> : <RefreshCw size={16} />}
        </button>
      </div>
    </header>
  );
}
