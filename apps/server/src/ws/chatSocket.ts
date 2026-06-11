import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatSessionMode, ChatSocketClientEvent, ChatSocketServerEvent, DetachesSessionContext, UploadedFileRef } from "@detaches/shared";
import { gatewayClient } from "../services/gateway/gatewayClient.js";
import { mapHistory } from "../services/gateway/chatMapper.js";
import {
  buildChatClientContext,
  buildDetachesSessionContext,
  renderDetachesClientContextFallback,
  renderDetachesSessionContext
} from "../services/clientContextService.js";
import { runtimeConfig } from "../config/settingsStore.js";

function send(socket: WebSocket, event: ChatSocketServerEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

export function attachChatSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/chat/")) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", async (socket, request) => {
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const sessionKey = decodeURIComponent(url.pathname.replace("/api/chat/", ""));
    const sessionMode: ChatSessionMode = url.searchParams.get("sessionMode") === "main" ? "main" : "device";
    const activeRunIds = new Set<string>();
    send(socket, { type: "ready", sessionKey });

    const forwardChat = (payload: unknown, frame?: unknown) => {
      if (isGatewayEventForSession(sessionKey, activeRunIds, payload, frame)) {
        send(socket, { type: "chat", payload });
      }
    };
    const forwardAgent = (payload: unknown, frame?: unknown) => {
      if (isGatewayEventForSession(sessionKey, activeRunIds, payload, frame)) {
        send(socket, { type: "agent", payload });
      }
    };
    const forwardHealth = (payload: unknown) => send(socket, { type: "health", ok: Boolean((payload as any)?.ok ?? true), payload });
    gatewayClient.on("event:chat", forwardChat);
    gatewayClient.on("event:agent", forwardAgent);
    gatewayClient.on("event:health", forwardHealth);

    async function sendHistory() {
      try {
        const raw = await gatewayClient.chatHistory(sessionKey);
        send(socket, { type: "history", payload: mapHistory(sessionKey, raw) });
      } catch (error) {
        send(socket, {
          type: "error",
          message: `历史记录加载失败，但仍可继续聊天：${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    try {
      await gatewayClient.connect();
      await sendHistory();
    } catch (error) {
      send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) });
    }

    socket.on("message", async (data) => {
      let event: ChatSocketClientEvent;
      try {
        event = JSON.parse(data.toString("utf8"));
      } catch {
        send(socket, { type: "error", message: "Invalid client message." });
        return;
      }
      try {
        if (event.type === "history") {
          await sendHistory();
        } else if (event.type === "send") {
          const detachesContext = await buildDetachesSessionContext(sessionMode, sessionKey, event.attachments, { createContextExport: true });
          const clientContext = await buildChatClientContext(sessionMode, sessionKey, event.attachments, { detachesContext });
          const response = await gatewayClient.sendChat({
            sessionKey,
            message: await buildOutboundMessage(event.message, detachesContext, event.attachments, event.attachmentContextOverride),
            thinking: event.thinking,
            attachments: event.attachments,
            idempotencyKey: event.idempotencyKey,
            clientContext,
            clientContextFallbackMessage: renderDetachesClientContextFallback(detachesContext)
          });
          const runId = typeof (response as any)?.runId === "string" ? (response as any).runId : "";
          if (runId) activeRunIds.add(runId);
          send(socket, { type: "sent", payload: { runId: (response as any)?.runId, raw: response } });
        } else if (event.type === "abort") {
          activeRunIds.delete(event.runId);
          await gatewayClient.abortChat(sessionKey, event.runId);
        }
      } catch (error) {
        send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("close", () => {
      gatewayClient.off("event:chat", forwardChat);
      gatewayClient.off("event:agent", forwardAgent);
      gatewayClient.off("event:health", forwardHealth);
    });
  });
}

async function buildOutboundMessage(
  message: string,
  detachesContext: DetachesSessionContext,
  attachments?: UploadedFileRef[],
  attachmentContextOverride?: string
): Promise<string> {
  const blocks = [message];
  const attachmentContext = await buildAttachmentContext(attachments, attachmentContextOverride);
  if (attachmentContext) blocks.push("", attachmentContext);
  blocks.push("", renderDetachesSessionContext(detachesContext));
  return blocks.join("\n");
}

async function buildAttachmentContext(attachments?: UploadedFileRef[], override?: string): Promise<string | null> {
  const cleanedOverride = override?.trim();
  if (cleanedOverride) return cleanedOverride;
  if (!attachments?.length) return null;
  const config = await runtimeConfig();
  const remoteUser = config.remoteUser || "remote-user";
  const remoteHome = remoteUser === "root" ? "/root" : `/home/${remoteUser}`;
  const remoteWorkspace = config.remoteWorkspaceRoot.startsWith("/")
    ? config.remoteWorkspaceRoot
    : `${remoteHome}/${config.remoteWorkspaceRoot.replace(/^~\/?/, "").replace(/^\/+/, "")}`;
  const suggestedPath = `${remoteWorkspace.replace(/\/+$/, "")}/attachments/<file>`;
  return [
    "[detaches_agent 文件上下文]",
    `本次消息附带 ${attachments.length} 个文件。`,
    "",
    ...attachments.flatMap((file, index) => [
      `${index + 1}. ${file.displayName || file.name}`,
      `   fileId: ${file.id}`,
      `   mimeType: ${file.mimeType || "application/octet-stream"}`,
      `   size: ${formatFileSize(file.size)}`,
      `   localPath: ${file.localPath || "not exposed"}`,
      "   currentLocation: 用户本机 detaches_agent staging 区",
      "   remotePath: not uploaded",
      "   role: 主输入/待确认",
      ""
    ]),
    "这些文件目前只在用户本机，尚未自动上传到远端。",
    `重要：local-user-machine 只代表用户当前运行 detaches_agent 的本机，不代表 OpenClaw Gateway 主机，也不代表远端 Agent 主机 ${config.remoteHost}。`,
    `如果你的目标是让远端 Agent/Gateway 主机读取文件，请使用 target=remote-agent-host，并且 remotePath 必须是 ${remoteUser}@${config.remoteHost} 上的绝对路径。`,
    `允许写入范围：远端用户 home (${remoteHome}) 或远端 workspace (${remoteWorkspace})。`,
    `优先选择远端 workspace 下的可写路径，例如 ${suggestedPath}；不要使用相对路径，不要使用其他用户目录，不要默认写入 /Volumes 外部卷。`,
    "如果你只是要把文件保存到用户本机，才使用 target=local-user-machine。",
    "请求必须声明 target。当前可执行 target: local-user-machine、remote-agent-host；gateway-managed 仍需要服务端适配器，不能退化到本机执行。",
    "请求格式必须是唯一一个 fenced code block：",
    "```detaches-file-transfer",
    `{"fileId":"上面的文件 id","target":"remote-agent-host","remotePath":"${suggestedPath}","reason":"说明为什么远端 agent 需要读取这个文件"}`,
    "```",
    "用户批准后，detaches_agent 会生成一次性下载链接；target=remote-agent-host 时远端主机会通过 reverse bridge curl 下载到 workspace，target=local-user-machine 时会保存到用户本机。",
    "用户批准前不要假装已经读取文件；如果传输失败，请根据 terminal 输出继续处理。"
  ].join("\n").trimEnd();
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "unknown";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function isGatewayEventForSession(sessionKey: string, activeRunIds: Set<string>, payload: unknown, frame?: unknown): boolean {
  const keys = new Set<string>();
  collectSessionKeys(payload, keys);
  collectSessionKeys(frame, keys);
  if (keys.has(sessionKey)) return true;
  if (keys.size > 0) return false;
  const runIds = new Set<string>();
  collectRunIds(payload, runIds);
  collectRunIds(frame, runIds);
  if (runIds.size === 0) return false;
  return [...runIds].some((runId) => activeRunIds.has(runId));
}

function collectSessionKeys(value: unknown, keys: Set<string>, depth = 0): void {
  if (!value || depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectSessionKeys(item, keys, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionKey", "session", "conversationId", "threadId"]) {
    const found = record[key];
    if (typeof found === "string" && found.startsWith("agent:")) keys.add(found);
  }
  for (const key of ["payload", "message", "data", "event", "delta", "item"]) {
    collectSessionKeys(record[key], keys, depth + 1);
  }
}

function collectRunIds(value: unknown, runIds: Set<string>, depth = 0): void {
  if (!value || depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectRunIds(item, runIds, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const runId = record.runId;
  if (typeof runId === "string" && runId) runIds.add(runId);
  for (const key of ["payload", "message", "data", "event", "delta", "item"]) {
    collectRunIds(record[key], runIds, depth + 1);
  }
}
