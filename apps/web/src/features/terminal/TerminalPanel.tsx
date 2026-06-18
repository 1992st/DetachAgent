import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Copy, Eraser, Minimize2, TerminalSquare, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalInfo, TerminalSocketServerEvent } from "@detaches/shared";
import { wsUrl } from "../../lib/api.js";

interface Props {
  sessionKey: string | null;
  title?: string;
  emptyText?: string;
  className?: string;
  autoOpenKey?: string | null;
  onClose?: () => void;
}

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
  const socketRef = useRef<WebSocket | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const outputRef = useRef("");

  useImperativeHandle(ref, () => ({
    reveal() {
      setOpen(true);
      setMinimized(false);
    }
  }), []);

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

    const params = new URLSearchParams({ cols: "120", rows: "32" });
    const ws = new WebSocket(wsUrl(`/api/terminal/${encodeURIComponent(sessionKey)}?${params}`));
    socketRef.current = ws;
    setSocketState("connecting");
    ws.onopen = () => setSocketState("connected");
    ws.onclose = () => setSocketState("closed");
    ws.onerror = () => setSocketState("error");
    ws.onmessage = (event) => {
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
  }, [emptyText, sessionKey]);

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

  return (
    <section className={`terminal-panel ${className} ${open ? "open" : ""} ${minimized ? "minimized" : ""}`}>
      <button type="button" className="terminal-toggle" onClick={() => setOpen((value) => !value)} disabled={!sessionKey}>
        <TerminalSquare size={16} />
        <span>{title}</span>
        <small>{status?.status ?? socketState}</small>
      </button>
      {open && minimized ? (
        <button type="button" className="terminal-mini" onClick={() => setMinimized(false)} disabled={!sessionKey}>
          <TerminalSquare size={15} />
          <span>{title}</span>
          <small>{status?.status ?? socketState}</small>
        </button>
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
              <button type="button" className="icon-button" title="Copy terminal output" onClick={() => void copyOutput()}>
                <Copy size={15} />
              </button>
              <button type="button" className="icon-button" title="Clear view" onClick={clearOutput}>
                <Eraser size={15} />
              </button>
              <button type="button" className="icon-button" title="缩小 terminal" onClick={() => setMinimized(true)}>
                <Minimize2 size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                title="关闭 terminal"
                onClick={() => {
                  setOpen(false);
                  onClose?.();
                }}
              >
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="terminal-output" ref={terminalHostRef} data-empty-text={emptyText} />
          </div>
        </div>
      ) : null}
    </section>
  );
});
