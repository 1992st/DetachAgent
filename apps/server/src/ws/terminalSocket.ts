import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TerminalSocketClientEvent, TerminalSocketServerEvent } from "@detaches/shared";
import { terminalService } from "../services/terminal/terminalService.js";

function send(socket: WebSocket, event: TerminalSocketServerEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

export function attachTerminalSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/terminal/")) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", async (socket, request) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const sessionKey = decodeURIComponent(url.pathname.replace("/api/terminal/", ""));
    const cols = Number(url.searchParams.get("cols") ?? 100);
    const rows = Number(url.searchParams.get("rows") ?? 28);

    try {
      const terminal = await terminalService.ensure(sessionKey, cols, rows);
      const onData = (data: string) => send(socket, { type: "data", data });
      const onStatus = () => send(socket, { type: "status", terminal: terminalService.info(terminal) });
      terminal.emitter.on("data", onData);
      terminal.emitter.on("status", onStatus);
      send(socket, { type: "ready", terminal: terminalService.info(terminal), replay: terminalService.replay(terminal) });

      socket.on("message", (data) => {
        let event: TerminalSocketClientEvent;
        try {
          event = JSON.parse(data.toString("utf8"));
        } catch {
          send(socket, { type: "error", message: "Invalid terminal message." });
          return;
        }
        if (event.type === "input") {
          terminalService.write(terminal, event.data);
        } else if (event.type === "resize") {
          terminalService.resize(terminal, event.cols, event.rows);
        }
      });

      socket.on("close", () => {
        terminal.emitter.off("data", onData);
        terminal.emitter.off("status", onStatus);
      });
    } catch (error) {
      send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) });
      socket.close();
    }
  });
}
