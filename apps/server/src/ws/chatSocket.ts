import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatSessionMode, ChatSocketClientEvent, ChatSocketServerEvent, UploadedFileRef } from "@detaches/shared";
import { gatewayClient } from "../services/gateway/gatewayClient.js";
import { mapHistory } from "../services/gateway/chatMapper.js";
import { buildChatClientContext } from "../services/clientContextService.js";

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
    const clientContext = buildChatClientContext(sessionMode, sessionKey);
    send(socket, { type: "ready", sessionKey });

    const forwardChat = (payload: unknown, frame?: unknown) => {
      if (isGatewayEventForSession(sessionKey, payload, frame)) {
        send(socket, { type: "chat", payload });
      }
    };
    const forwardAgent = (payload: unknown, frame?: unknown) => {
      if (isGatewayEventForSession(sessionKey, payload, frame)) {
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
          const response = await gatewayClient.sendChat({
            sessionKey,
            message: buildOutboundMessage(event.message, sessionKey, event.attachments, event.attachmentContextOverride),
            thinking: event.thinking,
            attachments: event.attachments,
            idempotencyKey: event.idempotencyKey,
            clientContext
          });
          send(socket, { type: "sent", payload: { runId: (response as any)?.runId, raw: response } });
        } else if (event.type === "abort") {
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

function buildOutboundMessage(
  message: string,
  sessionKey: string,
  attachments?: UploadedFileRef[],
  attachmentContextOverride?: string
): string {
  const blocks = [message];
  const attachmentContext = buildAttachmentContext(attachments, attachmentContextOverride);
  if (attachmentContext) blocks.push("", attachmentContext);
  blocks.push("", withTerminalControlHint(sessionKey));
  return blocks.join("\n");
}

function buildAttachmentContext(attachments?: UploadedFileRef[], override?: string): string | null {
  const cleanedOverride = override?.trim();
  if (cleanedOverride) return cleanedOverride;
  if (!attachments?.length) return null;
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
    "如果你需要读取或处理文件，请先决定远端目标文件路径，然后向 UI 发起 detaches-file-transfer 待审批请求。",
    "请求必须声明 target。当前已支持 target: local-user-machine；remote-agent-host 和 gateway-managed 会显示为不可用，不能退化到本机执行。",
    "请求格式必须是唯一一个 fenced code block：",
    "```detaches-file-transfer",
    "{\"fileId\":\"上面的文件 id\",\"target\":\"local-user-machine\",\"remotePath\":\"/absolute/or/relative/target-file\",\"reason\":\"说明为什么需要传输\"}",
    "```",
    "用户批准后，detaches_agent 会生成一次性下载链接并在本会话 terminal 中执行 curl，把文件传到你指定的 remotePath。",
    "用户批准前不要假装已经读取文件；如果传输失败，请根据 terminal 输出继续处理。"
  ].join("\n").trimEnd();
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "unknown";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function withTerminalControlHint(sessionKey: string): string {
  return [
    "[detaches_agent 接入上下文]",
    "你正在通过 detaches_agent 本地 UI 与用户对话，不是普通 webchat。",
    "当前用户这台电脑已经为本对话绑定了一个持久本机 terminal。",
    `terminal sessionKey: ${sessionKey}`,
    "这个 terminal 默认隐藏在用户界面里，用户可以点开查看活动。",
    "命令请求必须声明 target。当前已支持 target: local-user-machine；remote-agent-host 和 gateway-managed 会显示为不可用，不能退化到本机执行。",
    "如果你需要控制/检查用户这台电脑，请不要假装已经执行；请向 UI 发起一个待审批命令请求。",
    "命令请求格式必须是唯一一个 fenced code block：",
    "```detaches-terminal",
    "{\"target\":\"local-user-machine\",\"command\":\"pwd\",\"reason\":\"查看用户本机当前工作目录\"}",
    "```",
    "UI 会展示审批卡。只有用户点击 Run 后，命令才会写入本对话对应的本机 terminal。",
    "你可以根据 terminal 输出继续下一步；如果需要多个命令，请一次请求一个，等待用户批准和结果。"
  ].join("\n");
}

function isGatewayEventForSession(sessionKey: string, payload: unknown, frame?: unknown): boolean {
  const keys = new Set<string>();
  collectSessionKeys(payload, keys);
  collectSessionKeys(frame, keys);
  if (keys.size === 0) return true;
  return keys.has(sessionKey);
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
