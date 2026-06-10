import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import type { DiagnosticItem } from "@detaches/shared";

interface Props {
  items: DiagnosticItem[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function DiagnosticsPanel({ items, loading, error, onRefresh }: Props) {
  return (
    <section className="diagnostics-panel">
      <div className="panel-heading compact">
        <div>
          <h2>Diagnostics</h2>
          <p>{loading ? "Checking..." : `${items.length} 条状态`}</p>
        </div>
        <button className="icon-button" onClick={onRefresh} disabled={loading} title="Refresh diagnostics">
          <RefreshCw size={16} />
        </button>
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      {items.map((item) => (
        <article className={`diagnostic-item ${item.severity}`} key={item.id}>
          <div className="diagnostic-title">
            {item.severity === "info" ? <Info size={15} /> : <AlertTriangle size={15} />}
            <strong>{item.title}</strong>
          </div>
          <p>{item.message}</p>
          {item.action ? <small>{item.action}</small> : null}
        </article>
      ))}
    </section>
  );
}
