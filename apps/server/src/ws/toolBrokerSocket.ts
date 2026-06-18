import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { InteractionRecord, MainAgentFileTransferSnapshot, SshCredentialSessionSnapshot, ToolBrokerSocketEvent, ToolRequestRecord } from "@detaches/shared";
import { toolBrokerService, type ToolBrokerEvent } from "../services/tools/toolBrokerService.js";
import { mainAgentFileTransferService } from "../services/files/mainAgentFileTransferService.js";
import { sshCredentialSessionService } from "../services/ssh/sshCredentialSessionService.js";
import { interactionBrokerService } from "../services/interactions/interactionBrokerService.js";

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
    const onCredential = (credential: SshCredentialSessionSnapshot) => {
      send(socket, { type: "ssh-credential", credential });
    };
    const onInteraction = (event: { action: "created" | "updated" | "duplicate" | "resolved" | "rejected" | "expired"; interaction: InteractionRecord }) => {
      if (matchesInteraction(event.interaction, sessionKey, agentId)) {
        send(socket, { type: "interaction", action: event.action, interaction: event.interaction });
      }
    };
    toolBrokerService.emitter.on("request", onRequest);
    mainAgentFileTransferService.emitter.on("transfer", onTransfer);
    sshCredentialSessionService.emitter.on("credential", onCredential);
    interactionBrokerService.emitter.on("interaction", onInteraction);
    send(socket, { type: "ready", filters: { sessionKey, agentId } });
    send(socket, { type: "ssh-credential", credential: sshCredentialSessionService.status() });

    socket.on("close", () => {
      toolBrokerService.emitter.off("request", onRequest);
      mainAgentFileTransferService.emitter.off("transfer", onTransfer);
      sshCredentialSessionService.emitter.off("credential", onCredential);
      interactionBrokerService.emitter.off("interaction", onInteraction);
    });
  });
}

function matches(request: ToolRequestRecord, sessionKey?: string, agentId?: string): boolean {
  if (sessionKey && request.sessionKey !== sessionKey) return false;
  if (agentId && request.agentId !== agentId) return false;
  return true;
}

function matchesInteraction(interaction: InteractionRecord, sessionKey?: string, agentId?: string): boolean {
  if (sessionKey && interaction.sessionKey !== sessionKey) return false;
  if (agentId && interaction.agentId !== agentId) return false;
  return true;
}
