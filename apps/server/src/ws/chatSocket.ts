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
  return [
    "[[DETACH_AGENT_FILE_STAGED]]",
    "用户已在 detaches_agent Web 添加文件。该文件当前只存在于 detaches_agent 本机，不在 Main Agent 机器上。",
    "",
    `fileCount: ${attachments.length}`,
    "",
    ...attachments.flatMap((file, index) => [
      `${index + 1}. ${file.displayName || file.name}`,
      `   fileId: ${file.id}`,
      `   displayName: ${file.displayName || file.name}`,
      `   size: ${file.size}`,
      `   mimeType: ${file.mimeType || "application/octet-stream"}`,
      `   sourceLocalPath: ${file.localPath || "not exposed"}`,
      "   currentLocation: 用户本机 detaches_agent staging 区",
      "   remotePath: not uploaded",
      "   role: 主输入/待确认",
      ""
    ]),
    "如果用户明确要求保存该文件到 Main Agent 机器，请阅读 detach-agent-relationship skill，并生成 main-agent-save-file 请求。",
    "destination.path 必须由 Main Agent 根据自己的规则决定，且必须是完整的绝对目标文件路径：包含目录、最终文件名和扩展名。",
    "destination.path 不能是目录，不能是只到 screenshots/、docs/、_staging/ 等目录的路径；如果只知道目录，必须先根据 displayName 生成确定的文件名。",
    "如果文件用途或归档目录不明确，不要编造分类目录或 _staging 目录；先询问用户用途，或选择 Main Agent 规则中明确允许的通用 screenshots/attachments 文件路径。",
    "destination.user 和 destination.path 是 Main Agent 必须决定的核心字段；destination.user 是远端 SSH/Linux 用户，例如 aispeech。",
    "destination.host/port 可省略，detaches_agent broker 会使用当前 Main Agent SSH/Gateway 配置补全。",
    "不要在 destination.user/host/port 中填写占位符、示例值或“请替换”文本；如果不知道 destination.user，先说明无法生成保存请求。",
    "不要假设 Main Agent 已经能直接读取 sourceLocalPath；该路径只能作为 detaches_agent 本机传输源。",
    "不要启动 HTTP 上传服务器，不要发明 curl/http-upload 方法；main-agent-save-file 只支持 rsync 或 scp。",
    "不要生成 ssh/rsync/scp/curl 命令，不要要求用户在 terminal 手动执行命令；只生成 main-agent-save-file JSON 请求。",
    "detaches_agent 只负责把 staged 文件传输到 destination.path，不负责创建远端目录、验证远端文件或整理 Main Agent 文件系统。",
    "请求格式必须是唯一一个 fenced code block：",
    "```main-agent-save-file",
    "{\"fileId\":\"上面的文件 id\",\"sourceLocalPath\":\"上面的 sourceLocalPath\",\"displayName\":\"原始文件名\",\"size\":12345,\"destination\":{\"user\":\"aispeech\",\"path\":\"/absolute/path/to/final-filename.ext\"},\"methodPreference\":\"rsync\",\"reason\":\"说明为什么需要保存到 Main Agent，以及为什么选择这个具体文件路径\"}",
    "```",
    "用户批准后，detaches_agent broker 会执行结构化 rsync/scp 传输；如果 SSH 需要密码，detaches_agent UI 会显示一次性密码输入框。",
    "用户批准前不要假装已经读取文件；如果传输失败，只根据 [detaches_agent 工具结果] 报告失败原因，不要尝试替代传输方法。"
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
