import { FormEvent, forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Copy, Eraser, TerminalSquare } from "lucide-react";
import type { TerminalInfo, TerminalSocketServerEvent } from "@detaches/shared";

interface Props {
  sessionKey: string | null;
}

export interface TerminalPanelHandle {
  runCommand: (command: string) => boolean;
  reveal: () => void;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, Props>(function TerminalPanel({ sessionKey }, ref) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TerminalInfo | null>(null);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [socketState, setSocketState] = useState("idle");
  const socketRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLPreElement | null>(null);

  useImperativeHandle(ref, () => ({
    runCommand(command: string) {
      if (!command.trim() || socketRef.current?.readyState !== WebSocket.OPEN) return false;
      socketRef.current.send(JSON.stringify({ type: "input", data: `${command.trimEnd()}\r` }));
      return true;
    },
    reveal() {
      setOpen(true);
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

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ cols: "120", rows: "32" });
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/terminal/${encodeURIComponent(sessionKey)}?${params}`);
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
    <section className={`terminal-panel ${open ? "open" : ""}`}>
      <button type="button" className="terminal-toggle" onClick={() => setOpen((value) => !value)} disabled={!sessionKey}>
        <TerminalSquare size={16} />
        <span>Agent Terminal</span>
        <small>{status?.status ?? socketState}</small>
      </button>
      {open ? (
        <div className="terminal-body">
          <div className="terminal-toolbar">
            <div>
              <strong>{status?.terminalId ?? "terminal"}</strong>
              <small>{sessionKey}</small>
            </div>
            <div className="terminal-actions">
              <button type="button" className="icon-button" title="Copy terminal output" onClick={() => void copyOutput()}>
                <Copy size={15} />
              </button>
              <button type="button" className="icon-button" title="Clear view" onClick={() => setOutput("")}>
                <Eraser size={15} />
              </button>
            </div>
          </div>
          <pre className="terminal-output" ref={outputRef}>{output || "Local terminal is connected for this conversation. Commands approved from agent messages will run here."}</pre>
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
      ) : null}
    </section>
  );
});
