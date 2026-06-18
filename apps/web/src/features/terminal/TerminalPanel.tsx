import { FormEvent, forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Copy, Eraser, Minimize2, TerminalSquare, X } from "lucide-react";
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
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [socketState, setSocketState] = useState("idle");
  const socketRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);

  useImperativeHandle(ref, () => ({
    reveal() {
      setOpen(true);
      setMinimized(false);
    }
  }), []);

  useEffect(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setOutput("");
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
        setOutput(data.replay);
      } else if (data.type === "data") {
        setOutput((current) => `${current}${data.data}`.slice(-120_000));
      } else if (data.type === "status") {
        setStatus(data.terminal);
      } else if (data.type === "error") {
        setOutput((current) => `${current}\n[terminal error] ${data.message}\n`);
      }
    };
    return () => ws.close();
  }, [sessionKey]);

  useEffect(() => {
    if (!outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (!autoOpenKey || !sessionKey) return;
    setOpen(true);
    setMinimized(false);
  }, [autoOpenKey, sessionKey]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!input || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "input", data: `${input}\r` }));
    setInput("");
  }

  async function copyOutput() {
    await navigator.clipboard.writeText(output);
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
              <button type="button" className="icon-button" title="Clear view" onClick={() => setOutput("")}>
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
          <pre className="terminal-output" ref={outputRef}>{output || emptyText}</pre>
          <form className="terminal-input-row" onSubmit={submit}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="输入本机命令后按 Enter..."
              disabled={socketRef.current?.readyState !== WebSocket.OPEN}
            />
            <button className="secondary-button" disabled={!input || socketRef.current?.readyState !== WebSocket.OPEN}>Enter</button>
          </form>
          </div>
        </div>
      ) : null}
    </section>
  );
});
