import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { MainAgentFileTransferSnapshot, ToolBrokerSocketEvent, ToolRequestRecord } from "@detaches/shared";
import { toolBrokerService, type ToolBrokerEvent } from "../services/tools/toolBrokerService.js";
import { mainAgentFileTransferService } from "../services/files/mainAgentFileTransferService.js";

function send(socket: WebSocket, event: ToolBrokerSocketEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

export function attachToolBrokerSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (url.pathname !== "/api/tools/stream") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const sessionKey = url.searchParams.get("sessionKey")?.trim() || undefined;
    const agentId = url.searchParams.get("agentId")?.trim() || undefined;
    const onRequest = (event: ToolBrokerEvent) => {
      if (matches(event.request, sessionKey, agentId)) {
        send(socket, { type: "request", action: event.action, request: event.request });
      }
    };
    const onTransfer = (transfer: MainAgentFileTransferSnapshot) => {
      if (sessionKey && transfer.sessionKey !== sessionKey) return;
      if (agentId && transfer.agentId !== agentId) return;
      send(socket, { type: "transfer", transfer });
    };
    toolBrokerService.emitter.on("request", onRequest);
    mainAgentFileTransferService.emitter.on("transfer", onTransfer);
    send(socket, { type: "ready", filters: { sessionKey, agentId } });

    socket.on("close", () => {
      toolBrokerService.emitter.off("request", onRequest);
      mainAgentFileTransferService.emitter.off("transfer", onTransfer);
    });
  });
}

function matches(request: ToolRequestRecord, sessionKey?: string, agentId?: string): boolean {
  if (sessionKey && request.sessionKey !== sessionKey) return false;
  if (agentId && request.agentId !== agentId) return false;
  return true;
}
