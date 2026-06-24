import { Plus, RefreshCw, Server, ShieldAlert, TerminalSquare, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppHealth, LocalTerminalApp, RelationshipSkillStatus } from "@detaches/shared";

interface Props {
  health: AppHealth | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  terminalApps?: LocalTerminalApp[];
  terminalAppsLoading?: boolean;
  terminalAppsError?: string | null;
  onLoadTerminalApps?: () => void;
  onOpenTerminalApp?: (appId: string) => void;
  relationshipSkillStatus?: RelationshipSkillStatus;
  relationshipSkillMessage?: string;
  onRelationshipSkillAction?: () => void;
}

function pill(state: string, label: string, message?: string) {
  return (
    <span className={`status-pill ${state}`} title={message}>
      {label}
    </span>
  );
}

export function ConnectionBar({
  health,
  loading,
  error,
  onRefresh,
  terminalApps = [],
  terminalAppsLoading = false,
  terminalAppsError = null,
  onLoadTerminalApps,
  onOpenTerminalApp,
  relationshipSkillStatus = "unknown",
  relationshipSkillMessage,
  onRelationshipSkillAction
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function closeMenu(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", closeMenu);
    return () => document.removeEventListener("mousedown", closeMenu);
  }, [menuOpen]);

  return (
    <header className="connection-bar">
      <div className="brand">
        <Server size={20} />
        <div>
          <strong>detaches_agent</strong>
          <span>Local UI to remote OpenClaw</span>
        </div>
      </div>
      <div className="connection-actions">
        <div className="connection-status">
          {health ? (
            <>
              {pill(health.gateway.state, "Gateway", health.gateway.message)}
              {pill(health.ssh.state, health.config.localSshBridgeEnabled ? "SSH bridge" : "SSH", health.ssh.message)}
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
          {relationshipSkillStatus === "missing" || relationshipSkillStatus === "checking" || relationshipSkillStatus === "error" ? (
            <span className={`relationship-skill-alert ${relationshipSkillStatus}`} title={relationshipSkillMessage}>
              {relationshipSkillStatus === "checking" ? "Relationship skill 检测中" : relationshipSkillStatus === "error" ? "Skill 检测失败" : "Relationship skill 未安装"}
              {relationshipSkillStatus === "missing" ? (
                <button type="button" onClick={onRelationshipSkillAction}>安装 relationship skill</button>
              ) : null}
            </span>
          ) : null}
          <button className="icon-button" onClick={onRefresh} disabled={loading} title="Refresh connection">
            {loading ? <Wifi size={16} /> : <RefreshCw size={16} />}
          </button>
        </div>
        <div className="top-add-action" ref={menuRef}>
          <button
            type="button"
            className="top-add-button"
            title="新增工具"
            aria-label="新增工具"
            onClick={() => {
              setMenuOpen((value) => {
                const next = !value;
                if (next) onLoadTerminalApps?.();
                return next;
              });
            }}
          >
            <Plus size={22} />
          </button>
          {menuOpen ? (
            <div className="top-add-menu" role="menu">
              <div className="top-add-menu-heading">打开本机 Terminal App</div>
              {terminalAppsLoading ? <p>正在检查本机 terminal...</p> : null}
              {terminalAppsError ? <p className="error-inline">{terminalAppsError}</p> : null}
              {!terminalAppsLoading && terminalApps.length === 0 ? <p>没有找到可打开的本机 terminal app。</p> : null}
              {terminalApps.map((app) => (
                <button
                  type="button"
                  role="menuitem"
                  key={app.id}
                  disabled={!app.available}
                  onClick={() => {
                    onOpenTerminalApp?.(app.id);
                    setMenuOpen(false);
                  }}
                >
                  <TerminalSquare size={16} />
                  <span>{app.name}</span>
                  <small>{app.available ? app.appPath : "未安装"}</small>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
