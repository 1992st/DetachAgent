import type { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TerminalInfo, TerminalSocketClientEvent, TerminalSocketServerEvent } from "@detaches/shared";
import { terminalService, type ManagedTerminal } from "../services/terminal/terminalService.js";
import { adminTerminalService, type AdminTerminalHandle } from "../services/terminal/adminTerminalService.js";

interface TerminalSocketBackend {
  handle: { emitter: EventEmitter };
  info(): TerminalInfo;
  replay(): string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

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
    if (url.pathname === "/api/terminal/admin/helper") {
      const token = url.searchParams.get("token") || "";
      const sessionKey = url.searchParams.get("sessionKey") || "";
      // 管理员 helper 通过一次性 token 连回本机 websocket，避免其他本机进程伪装成 elevated helper。
      if (!adminTerminalService.attachHelper(socket, token, sessionKey)) return;
      return;
    }

    const sessionKey = decodeURIComponent(url.pathname.replace("/api/terminal/", ""));
    const cols = Number(url.searchParams.get("cols") ?? 100);
    const rows = Number(url.searchParams.get("rows") ?? 28);
    const privilege = url.searchParams.get("privilege") === "administrator" ? "administrator" : "user";

    try {
      // 管理员 terminal 是 UAC helper 维护的独立 session，不是把普通 terminal 原地升级。
      const terminalApi = privilege === "administrator"
        ? await adminBackend(sessionKey, cols, rows)
        : await userBackend(sessionKey, cols, rows);
      const onData = (data: string) => send(socket, { type: "data", data });
      const onStatus = () => send(socket, { type: "status", terminal: terminalApi.info() });
      terminalApi.handle.emitter.on("data", onData);
      terminalApi.handle.emitter.on("status", onStatus);
      send(socket, { type: "ready", terminal: terminalApi.info(), replay: terminalApi.replay() });

      socket.on("message", (data) => {
        let event: TerminalSocketClientEvent;
        try {
          event = JSON.parse(data.toString("utf8"));
        } catch {
          send(socket, { type: "error", message: "Invalid terminal message." });
          return;
        }
        if (event.type === "input") {
          terminalApi.write(event.data);
        } else if (event.type === "resize") {
          terminalApi.resize(event.cols, event.rows);
        }
      });

      socket.on("close", () => {
        terminalApi.handle.emitter.off("data", onData);
        terminalApi.handle.emitter.off("status", onStatus);
      });
    } catch (error) {
      send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) });
      socket.close();
    }
  });
}

async function userBackend(sessionKey: string, cols: number, rows: number): Promise<TerminalSocketBackend> {
  const terminal: ManagedTerminal = await terminalService.ensure(sessionKey, cols, rows);
  return {
    handle: terminal,
    info: () => terminalService.info(terminal),
    replay: () => terminalService.replay(terminal),
    write: (data) => terminalService.write(terminal, data),
    resize: (nextCols, nextRows) => terminalService.resize(terminal, nextCols, nextRows)
  };
}

async function adminBackend(sessionKey: string, cols: number, rows: number): Promise<TerminalSocketBackend> {
  const terminal: AdminTerminalHandle = await adminTerminalService.ensure(sessionKey, cols, rows);
  return {
    handle: terminal,
    info: () => adminTerminalService.info(terminal, sessionKey),
    replay: () => adminTerminalService.replay(terminal),
    write: (data) => adminTerminalService.write(terminal, data),
    resize: (nextCols, nextRows) => adminTerminalService.resize(terminal, nextCols, nextRows)
  };
}
