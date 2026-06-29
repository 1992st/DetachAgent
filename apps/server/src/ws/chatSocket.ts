import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatSessionMode, ChatSocketClientEvent, ChatSocketServerEvent, DetachesSessionContext, RelationshipSkillStatus, UploadedFileRef } from "@detaches/shared";
import { DETACH_AGENT_RELATIONSHIP_SKILL_VERSION } from "@detaches/shared";
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
        const skillStatus = parseRelationshipSkillStatus(payload);
        if (skillStatus) {
          send(socket, { type: "relationship-skill-status", ...skillStatus, raw: payload });
        }
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
          const includeLocalControlContext = event.includeLocalControlContext === true;
          const includeStagedFileContext = includeLocalControlContext && event.includeStagedFileContext === true;
          const detachesContext = includeLocalControlContext
            ? await buildDetachesSessionContext(sessionMode, sessionKey, includeStagedFileContext ? event.attachments : [], { createContextExport: true })
            : null;
          const clientContext = detachesContext
            ? await buildChatClientContext(sessionMode, sessionKey, includeStagedFileContext ? event.attachments : [], { detachesContext })
            : undefined;
          const response = await gatewayClient.sendChat({
            sessionKey,
            message: await buildOutboundMessage(
              event.message,
              detachesContext,
              includeStagedFileContext ? event.attachments : [],
              includeStagedFileContext ? event.attachmentContextOverride : undefined
            ),
            thinking: event.thinking,
            attachments: includeStagedFileContext ? undefined : event.attachments,
            idempotencyKey: event.idempotencyKey,
            clientContext,
            clientContextFallbackMessage: detachesContext ? renderDetachesClientContextFallback(detachesContext) : undefined,
            promptGate: {
              includeLocalControlContext,
              includeStagedFileContext,
              localControlScope: event.localControlScope,
              activationReason: event.activationReason
            }
          });
          const runId = typeof (response as any)?.runId === "string" ? (response as any).runId : "";
          if (runId) activeRunIds.add(runId);
          send(socket, { type: "sent", payload: { runId: (response as any)?.runId, raw: response } });
        } else if (event.type === "bootstrap-relationship-skill-check") {
          send(socket, { type: "relationship-skill-status", status: "checking", message: "Checking detach-agent-relationship skill..." });
          const response = await gatewayClient.sendChat({
            sessionKey,
            message: buildRelationshipSkillCheckPrompt(),
            idempotencyKey: event.idempotencyKey
          });
          const runId = typeof (response as any)?.runId === "string" ? (response as any).runId : "";
          if (runId) activeRunIds.add(runId);
          const parsed = parseRelationshipSkillStatus(response);
          if (parsed) send(socket, { type: "relationship-skill-status", ...parsed, raw: response });
        } else if (event.type === "track-run") {
          if (event.runId) activeRunIds.add(event.runId);
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

function buildRelationshipSkillCheckPrompt(): string {
  return [
    "[[DETACH_AGENT_RELATIONSHIP_SKILL_CHECK]]",
    "Purpose: enable Detach Agent local-control context for this current session only after user consent.",
    `请用最短方式检查 Main Agent 是否已安装并可见 detach-agent-relationship skill，且 VERSION 为 ${DETACH_AGENT_RELATIONSHIP_SKILL_VERSION} 或更高兼容版本。`,
    "Check only. Do not install. Do not run terminal commands. Do not request tools. Do not reinterpret Main Agent identity.",
    "如果能读取 VERSION，请读取后判断。",
    "只返回下面两行固定参数，不要解释：",
    "DETACH_AGENT_SKILL_STATUS: ready",
    `DETACH_AGENT_SKILL_VERSION: ${DETACH_AGENT_RELATIONSHIP_SKILL_VERSION}`,
    "或",
    "DETACH_AGENT_SKILL_STATUS: missing",
    "DETACH_AGENT_SKILL_VERSION: none",
    "或",
    "DETACH_AGENT_SKILL_STATUS: outdated",
    "DETACH_AGENT_SKILL_VERSION: <installed-version>"
  ].join("\n");
}

function parseRelationshipSkillStatus(response: unknown): {
  status: RelationshipSkillStatus;
  message: string;
  installedVersion?: string;
  requiredVersion: string;
} | null {
  const text = collectText(response).join("\n");
  const lowerText = text.toLowerCase();
  const installedVersion = parseReportedSkillVersion(text);
  const requiredVersion = DETACH_AGENT_RELATIONSHIP_SKILL_VERSION;
  if (/\bdetaches?_agent_skill_status\s*:\s*ready\b/.test(lowerText) || /\bdetach_agent_skill_status\s*:\s*ready\b/.test(lowerText)) {
    if (!installedVersion || installedVersion === "unknown") {
      return {
        status: "outdated",
        message: `detach-agent-relationship skill version is unknown. Please update to ${requiredVersion}.`,
        installedVersion: installedVersion || "unknown",
        requiredVersion
      };
    }
    if (compareSemver(installedVersion, requiredVersion) < 0) {
      return {
        status: "outdated",
        message: `detach-agent-relationship skill is ${installedVersion}. Please update to ${requiredVersion}.`,
        installedVersion,
        requiredVersion
      };
    }
    return {
      status: "ready",
      message: `detach-agent-relationship skill ${installedVersion} is ready.`,
      installedVersion,
      requiredVersion
    };
  }
  if (/\bdetaches?_agent_skill_status\s*:\s*missing\b/.test(lowerText) || /\bdetach_agent_skill_status\s*:\s*missing\b/.test(lowerText)) {
    return {
      status: "missing",
      message: `detach-agent-relationship skill is not installed. Please install ${requiredVersion}.`,
      installedVersion: installedVersion && installedVersion !== "none" ? installedVersion : undefined,
      requiredVersion
    };
  }
  if (/\bdetaches?_agent_skill_status\s*:\s*outdated\b/.test(lowerText) || /\bdetach_agent_skill_status\s*:\s*outdated\b/.test(lowerText)) {
    return {
      status: "outdated",
      message: `detach-agent-relationship skill is ${installedVersion || "outdated"}. Please update to ${requiredVersion}.`,
      installedVersion: installedVersion || "unknown",
      requiredVersion
    };
  }
  return null;
}

function parseReportedSkillVersion(text: string): string | undefined {
  const match = text.match(/\bDETACHES?_AGENT_SKILL_VERSION\s*:\s*([^\s,;]+)/i)
    ?? text.match(/\bDETACH_AGENT_SKILL_VERSION\s*:\s*([^\s,;]+)/i);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  if (/^(none|null|missing)$/i.test(value)) return "none";
  return value.replace(/^v/i, "");
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length, 3); index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

function collectText(value: unknown, output: string[] = [], depth = 0): string[] {
  if (value == null || depth > 5) return output;
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (typeof value === "number" || typeof value === "boolean") return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) collectText(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "message", "content", "output", "delta", "answer", "result", "payload", "raw"]) {
    collectText(record[key], output, depth + 1);
  }
  return output;
}

async function buildOutboundMessage(
  message: string,
  detachesContext: DetachesSessionContext | null,
  attachments?: UploadedFileRef[],
  attachmentContextOverride?: string
): Promise<string> {
  const blocks = [message];
  const attachmentContext = await buildCleanAttachmentContext(attachments, attachmentContextOverride);
  if (attachmentContext) blocks.push("", attachmentContext);
  if (detachesContext) blocks.push("", renderDetachesSessionContext(detachesContext));
  return blocks.join("\n");
}

async function buildCleanAttachmentContext(attachments?: UploadedFileRef[], override?: string): Promise<string | null> {
  const cleanedOverride = override?.trim();
  if (cleanedOverride) return cleanedOverride;
  if (!attachments?.length) return null;
  const config = await runtimeConfig();
  const configuredSshUser = config.remoteUser.trim();
  const exampleDestinationUser = configuredSshUser || "zhangst";
  return [
    "[[DETACH_AGENT_FILE_STAGED]]",
    "The user added file(s) in detaches_agent. These files currently exist only in detaches_agent local staging, not on the Host/Main Agent machine.",
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
      "   currentLocation: user-local-machine detaches_agent staging",
      "   remotePath: not uploaded",
      "   role: primary user input; confirm intended use before choosing a destination",
      ""
    ]),
    "If the user explicitly asks to save a staged file to the Main Agent machine, create exactly one main-agent-save-file request.",
    "destination.path must be chosen by the Main Agent according to its own rules and must be a complete absolute POSIX target file path: directory plus final filename and extension.",
    "destination.path cannot be a directory and cannot stop at generic folders such as screenshots/, docs/, or _staging/. If you only know a directory, derive a concrete filename from displayName first.",
    "If the file purpose or archive category is unclear, ask the user for the intended use; do not invent supplier/product/category folders or a _staging path without evidence.",
    "destination.user and destination.path are the core required fields. destination.user is the real remote SSH/Linux account that owns or can write the destination path.",
    configuredSshUser
      ? `Current configured Main Agent SSH user is "${configuredSshUser}". Use it as destination.user unless the chosen destination path clearly belongs to another Linux account.`
      : "If destination.path starts with /home/<account>/, destination.user must be that same <account>.",
    "If destination.path starts with /home/<account>/, destination.user must match <account>; do not use a different SSH user for another account's home directory.",
    "destination.host/port may be omitted; detaches_agent fills them from the current Main Agent SSH/Gateway settings.",
    "Do not put placeholders or example values in destination.user/host/port. If destination.user is unknown, say the save request cannot be created yet.",
    "Do not assume the Main Agent can read sourceLocalPath directly. That path exists only on the detaches_agent local machine and can only be used as the transfer source by detaches_agent.",
    "Do not start an HTTP upload server or invent a curl/http-upload method. main-agent-save-file supports only rsync or scp.",
    "Do not generate ssh/rsync/scp/curl commands and do not ask the user to run transfer commands in a terminal. Generate only the structured main-agent-save-file JSON request.",
    "detaches_agent only transfers the staged file to destination.path. It does not create remote directories, validate the remote file afterward, or organize the Main Agent filesystem.",
    "The request must be exactly one fenced code block:",
    "```main-agent-save-file",
    JSON.stringify({
      fileId: "file id listed above",
      sourceLocalPath: "sourceLocalPath listed above",
      displayName: "original filename",
      size: 12345,
      destination: { user: exampleDestinationUser, path: `/home/${exampleDestinationUser}/path/to/final-filename.ext` },
      methodPreference: "rsync",
      reason: "why this file should be saved to the Main Agent machine and why this destination path is correct"
    }),
    "```",
    "After user approval, detaches_agent broker performs the structured rsync/scp transfer. If SSH needs a password, detaches_agent UI shows a one-time password input.",
    "Before approval, do not pretend to have read the file. If transfer fails, report only the approved detaches_agent tool result and do not invent alternative transfer methods."
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
