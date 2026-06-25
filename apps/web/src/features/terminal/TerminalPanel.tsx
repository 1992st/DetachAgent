import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Copy, Eraser, Minimize2, Shield, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AdminTerminalStatusResponse, TerminalInfo, TerminalPrivilege, TerminalSocketServerEvent } from "@detaches/shared";
import { disableAdminTerminal, enableAdminTerminal, fetchAdminTerminalStatus, wsUrl } from "../../lib/api.js";

interface Props {
  sessionKey: string | null;
  title?: string;
  emptyText?: string;
  className?: string;
  autoOpenKey?: string | null;
  onClose?: () => void;
}

const ADMIN_STATUS_POLL_MS = 1500;
const ADMIN_ENABLE_WAIT_MS = 60_000;

export interface TerminalPanelHandle {
  reveal: () => void;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, Props>(function TerminalPanel({
  sessionKey,
  title = "Agent Control Terminal",
  emptyText = "Local control terminal is connected for this conversation. Commands approved from cloud agent messages will run here.",
  className = "",
  autoOpenKey = null,
  onClose
}, ref) {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [status, setStatus] = useState<TerminalInfo | null>(null);
  const [socketState, setSocketState] = useState("idle");
  const [privilege, setPrivilege] = useState<TerminalPrivilege>("user");
  const [adminStatus, setAdminStatus] = useState<AdminTerminalStatusResponse | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const outputRef = useRef("");
  const mountedRef = useRef(true);

  useImperativeHandle(ref, () => ({
    reveal() {
      setOpen(true);
      setMinimized(false);
    }
  }), []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshAdminStatus = useCallback(async (): Promise<AdminTerminalStatusResponse | null> => {
    if (!sessionKey) return null;
    try {
      const next = await fetchAdminTerminalStatus(sessionKey);
      if (!mountedRef.current) return next;
      setAdminStatus(next);
      if (next.supported && next.active && privilege !== "administrator") {
        setPrivilege("administrator");
      } else if (next.supported && !next.active && privilege === "administrator") {
        setPrivilege("user");
      }
      if (next.ok || !next.message) setAdminError(null);
      return next;
    } catch (error) {
      if (mountedRef.current) setAdminError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [privilege, sessionKey]);

  useEffect(() => {
    if (!sessionKey) {
      setAdminStatus(null);
      setAdminError(null);
      setPrivilege("user");
      return;
    }
    let cancelled = false;
    void refreshAdminStatus();
    const timer = window.setInterval(() => {
      if (!cancelled) void refreshAdminStatus();
    }, ADMIN_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshAdminStatus, sessionKey]);

  useEffect(() => {
    socketRef.current?.close();
    socketRef.current = null;
    outputRef.current = "";
    terminalRef.current?.clear();
    setStatus(null);
    if (!sessionKey) {
      setSocketState("idle");
      return;
    }

    const params = new URLSearchParams({ cols: "120", rows: "32", privilege });
    const ws = new WebSocket(wsUrl(`/api/terminal/${encodeURIComponent(sessionKey)}?${params}`));
    socketRef.current = ws;
    setSocketState("connecting");
    ws.onopen = () => {
      if (socketRef.current === ws) setSocketState("connected");
    };
    ws.onclose = () => {
      if (socketRef.current === ws) setSocketState("closed");
    };
    ws.onerror = () => {
      if (socketRef.current === ws) setSocketState("error");
    };
    ws.onmessage = (event) => {
      if (socketRef.current !== ws) return;
      const data = JSON.parse(event.data) as TerminalSocketServerEvent;
      if (data.type === "ready") {
        setStatus(data.terminal);
        outputRef.current = data.replay;
        terminalRef.current?.reset();
        if (data.replay) terminalRef.current?.write(data.replay);
      } else if (data.type === "data") {
        outputRef.current = `${outputRef.current}${data.data}`.slice(-120_000);
        terminalRef.current?.write(data.data);
      } else if (data.type === "status") {
        setStatus(data.terminal);
      } else if (data.type === "error") {
        const message = `\r\n[terminal error] ${data.message}\r\n`;
        outputRef.current = `${outputRef.current}${message}`.slice(-120_000);
        terminalRef.current?.write(message);
      }
    };
    return () => ws.close();
  }, [privilege, sessionKey]);

  useEffect(() => {
    if (!open || minimized || !terminalHostRef.current || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.35,
      theme: {
        background: "#020617",
        foreground: "#d1fae5",
        cursor: "#e2e8f0",
        selectionBackground: "#334155"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHostRef.current);
    terminal.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    fitAddon.fit();
    if (outputRef.current) terminal.write(outputRef.current);
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      socketRef.current?.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    });
    resizeObserver.observe(terminalHostRef.current);
    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [minimized, open]);

  useEffect(() => {
    if (!open || minimized) return;
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const terminal = terminalRef.current;
      if (terminal) {
        socketRef.current?.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    });
  }, [minimized, open]);

  useEffect(() => {
    if (!autoOpenKey || !sessionKey) return;
    setOpen(true);
    setMinimized(false);
  }, [autoOpenKey, sessionKey]);

  async function copyOutput() {
    await navigator.clipboard.writeText(outputRef.current);
  }

  function clearOutput() {
    outputRef.current = "";
    terminalRef.current?.clear();
  }

  async function waitForAdminActive(): Promise<AdminTerminalStatusResponse | null> {
    const deadline = Date.now() + ADMIN_ENABLE_WAIT_MS;
    let latest: AdminTerminalStatusResponse | null = null;
    while (mountedRef.current && Date.now() < deadline) {
      latest = await refreshAdminStatus();
      if (latest?.active) return latest;
      if (latest && !latest.ok && latest.message) return latest;
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    return latest;
  }

  async function toggleAdminTerminal() {
    if (!sessionKey || adminBusy) return;
    setAdminBusy(true);
    setAdminError(null);
    try {
      if (adminStatus?.active) {
        const next = await disableAdminTerminal(sessionKey);
        setAdminStatus(next);
        setPrivilege("user");
        return;
      }

      const launched = await enableAdminTerminal(sessionKey);
      setAdminStatus(launched);
      if (!launched.supported) {
        setAdminError(launched.message || "Administrator terminal is only supported on Windows.");
        return;
      }
      if (!launched.ok && launched.message) {
        setAdminError(launched.message);
        return;
      }
      const active = launched.active ? launched : await waitForAdminActive();
      if (active?.active) {
        setAdminStatus(active);
        setPrivilege("administrator");
      } else {
        setAdminError(active?.message || "Administrator terminal helper did not connect before the timeout.");
      }
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setAdminBusy(false);
    }
  }

  const adminActive = adminStatus?.active === true;
  const adminSupported = adminStatus?.supported !== false;
  const terminalLabel = `${status?.privilege === "administrator" ? "admin " : ""}${status?.status ?? socketState}`;
  const adminTitle = adminActive
    ? "Close administrator terminal"
    : adminBusy
      ? "Waiting for Windows UAC confirmation"
      : adminSupported
        ? "Request administrator terminal"
        : "Administrator terminal is Windows-only";
  const AdminIcon = adminActive ? ShieldCheck : Shield;

  function renderAdminButton(variant: "toggle" | "mini" | "toolbar") {
    return (
      <button
        type="button"
        className={`admin-terminal-button ${variant} ${adminActive ? "active" : ""}`}
        title={adminTitle}
        aria-label={adminTitle}
        aria-pressed={adminActive}
        onClick={() => void toggleAdminTerminal()}
        disabled={!sessionKey || adminBusy || !adminSupported}
      >
        <AdminIcon size={variant === "toolbar" ? 15 : 16} />
      </button>
    );
  }

  return (
    <section className={`terminal-panel ${className} ${open ? "open" : ""} ${minimized ? "minimized" : ""}`}>
      <div className="terminal-toggle-row">
        {/* 灰色表示普通权限；蓝色表示管理员 helper 已连接，但每条命令仍然需要 Tool Queue 审批。 */}
        {renderAdminButton("toggle")}
        <button type="button" className="terminal-toggle" onClick={() => setOpen((value) => !value)} disabled={!sessionKey}>
          <TerminalSquare size={16} />
          <span>{title}</span>
          <small>{terminalLabel}</small>
        </button>
      </div>
      {open && minimized ? (
        <div className="terminal-mini-row">
          {renderAdminButton("mini")}
          <button type="button" className="terminal-mini" onClick={() => setMinimized(false)} disabled={!sessionKey}>
            <TerminalSquare size={15} />
            <span>{title}</span>
            <small>{terminalLabel}</small>
          </button>
        </div>
      ) : null}
      {open && !minimized ? (
        <div className="terminal-popover" role="dialog" aria-label="Local terminal">
          <div className="terminal-body">
            <div className="terminal-toolbar">
              <div>
                <strong>{title}</strong>
                <small>{sessionKey}</small>
              </div>
              <div className="terminal-actions">
                {renderAdminButton("toolbar")}
                <button type="button" className="icon-button" title="Copy terminal output" onClick={() => void copyOutput()}>
                  <Copy size={15} />
                </button>
                <button type="button" className="icon-button" title="Clear view" onClick={clearOutput}>
                  <Eraser size={15} />
                </button>
                <button type="button" className="icon-button" title="Minimize terminal" onClick={() => setMinimized(true)}>
                  <Minimize2 size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Close terminal"
                  onClick={() => {
                    setOpen(false);
                    onClose?.();
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            {adminError ? <div className="terminal-admin-error">{adminError}</div> : null}
            <div className="terminal-output" ref={terminalHostRef} data-empty-text={emptyText} />
          </div>
        </div>
      ) : null}
    </section>
  );
});
