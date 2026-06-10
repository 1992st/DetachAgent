import os from "node:os";
import type { ChatSessionMode, ClientIdentity, DetachesSessionContext, DetachesStagedFileContext, UploadedFileRef } from "@detaches/shared";
import { publicServerBaseUrl } from "../config/appConfig.js";
import { runtimeConfig } from "../config/settingsStore.js";
import { loadOrCreateDeviceIdentity } from "./gateway/deviceIdentityService.js";
import { openclawDetachesAdapterService } from "./adapters/openclawDetachesAdapterService.js";
import { brokerTokenService } from "./tools/brokerTokenService.js";
import { contextExportService } from "./context/contextExportService.js";

function deviceShortId(deviceId: string): string {
  return deviceId.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase() || "local";
}

export function publicClientIdentity(): ClientIdentity {
  const identity = loadOrCreateDeviceIdentity();
  const deviceIdShort = deviceShortId(identity.deviceId);
  return {
    deviceId: identity.deviceId,
    deviceIdShort,
    displayName: `${os.hostname()} detaches_agent`,
    sessionNamespace: `detaches:${deviceIdShort}`
  };
}

interface DetachesContextBuildOptions {
  createContextExport?: boolean;
  detachesContext?: DetachesSessionContext;
}

export async function buildDetachesSessionContext(
  sessionMode: ChatSessionMode,
  sessionKey: string,
  attachments: UploadedFileRef[] = [],
  options: DetachesContextBuildOptions = {}
): Promise<DetachesSessionContext> {
  const identity = publicClientIdentity();
  const agentId = agentIdFromSessionKey(sessionKey);
  const remoteAdapter = openclawDetachesAdapterService.lastRemoteReadiness();
  const config = await runtimeConfig();
  const baseUrl = publicServerBaseUrl(config);
  const contextExportRecord = options.createContextExport
    ? contextExportService.create({ sessionKey, sessionMode, attachments })
    : null;
  const stagedFiles: DetachesStagedFileContext[] = attachments.map((file) => ({
    fileId: file.id,
    name: file.name,
    displayName: file.displayName || file.name,
    mimeType: file.mimeType || "application/octet-stream",
    size: file.size,
    localPath: file.localPath,
    currentLocation: "user-local-staging" as const,
    remotePath: file.remotePath,
    transfer: {
      requestFence: "detaches-file-transfer" as const,
      supportedTargets: ["local-user-machine"],
      defaultTarget: "local-user-machine" as const,
      requiresApproval: true
    }
  }));
  return {
    app: "detaches_agent",
    version: 1,
    sessionMode,
    sessionKey,
    agentId: agentId || undefined,
    userDevice: identity,
    adapterStatus: {
      remoteAgentHost: {
        state: remoteAdapter?.state ?? "unknown",
        installDir: remoteAdapter?.installDir,
        checkedAt: remoteAdapter ? new Date().toISOString() : undefined,
        remoteHost: remoteAdapter?.remoteHost,
        remoteUser: remoteAdapter?.remoteUser,
        summary: remoteAdapter
          ? remoteAdapter.checks.map((check) => `${check.id}:${check.state}`).join(", ")
          : "Remote adapter readiness has not been probed in this server session."
      }
    },
    files: {
      staged: stagedFiles
    },
    broker: {
      gatewayEventEndpoint: `${baseUrl}/api/tools/events/gateway`,
      eventSource: "gateway-event",
      idempotencyField: "sourceEventId",
      submitToken: brokerTokenService.tokenForSession(sessionKey),
      submitTokenHeader: "Authorization",
      requestFormats: ["broker-event", "fence"]
    },
    contextExport: {
      createEndpoint: `${baseUrl}/api/context/exports`,
      consumeEndpointPattern: `${baseUrl}/api/context/exports/{token}`,
      consumeUrl: contextExportRecord
        ? `${baseUrl}/api/context/exports/${encodeURIComponent(contextExportRecord.token)}`
        : undefined,
      createdBy: "detaches-ui-loopback",
      consumedBy: "remote-agent-host",
      oneTime: true,
      ttlSeconds: 300,
      adapterCommand: "context-fetch",
      doctorCommand: "doctor",
      generatedForMessage: Boolean(contextExportRecord),
      note: contextExportRecord
        ? "A one-time context URL was generated for this message. Remote agent hosts should prefer doctor --url and must treat the URL as sensitive."
        : "Ask the user to generate a one-time context URL in the detaches_agent Adapter panel when the remote agent host needs a fresh full clientContext. Do not invent or request broker tokens in chat."
    },
    capabilities: [
      {
        name: "terminal",
        requestFence: "detaches-terminal",
        supportedTargets: ["local-user-machine"],
        unavailableTargets: ["remote-agent-host", "gateway-managed"],
        approvalRequired: true,
        executionHost: "user-local-machine"
      },
      {
        name: "file-transfer",
        requestFence: "detaches-file-transfer",
        supportedTargets: ["local-user-machine"],
        unavailableTargets: ["remote-agent-host", "gateway-managed"],
        approvalRequired: true,
        executionHost: "user-local-machine"
      }
    ],
    invariants: [
      "This conversation is mediated by detaches_agent, not plain webchat.",
      "The bound terminal runs on the user's local machine and is hidden unless the user opens it.",
      "Tools are never executed by assistant text alone; every tool request must use an approved fenced request block.",
      "Do not claim a file was read, transferred, downloaded, archived, or modified until the approved tool execution output proves it.",
      remoteAdapter?.state === "ready"
        ? "Remote-agent-host adapter assets have been detected, but remote execution still requires explicit detaches_agent approval and supported tool routing."
        : "Remote-agent-host and gateway-managed execution are reserved capabilities until a server-side adapter enables them."
    ]
  };
}

export async function buildChatClientContext(
  sessionMode: ChatSessionMode,
  sessionKey: string,
  attachments: UploadedFileRef[] = [],
  options: DetachesContextBuildOptions = {}
): Promise<Record<string, unknown>> {
  const detaches = options.detachesContext ?? await buildDetachesSessionContext(sessionMode, sessionKey, attachments, options);
  const identity = detaches.userDevice;
  return {
    app: "detaches_agent",
    provider: "detaches_agent",
    channel: "detaches_agent",
    sessionMode,
    sessionKey,
    agentId: detaches.agentId,
    device: identity,
    detaches,
    routeContext: {
      origin: {
        provider: "detaches_agent",
        deviceId: identity.deviceId,
        deviceIdShort: identity.deviceIdShort,
        deviceName: identity.displayName,
        sessionMode
      },
      active: {
        channel: "detaches_agent",
        deviceId: identity.deviceId
      },
      deliveryContext: {
        channel: "detaches_agent",
        client: "detaches_agent",
        deviceId: identity.deviceId,
        sessionKey
      }
    }
  };
}

export function renderDetachesSessionContext(context: DetachesSessionContext): string {
  const remoteAdapter = context.adapterStatus?.remoteAgentHost;
  return [
    "[detaches_agent 接入上下文]",
    "你正在通过 detaches_agent 本地 UI 与用户对话，不是普通 webchat。",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    "完整机器可读上下文已随 chat.send.clientContext.detaches 发送；请优先读取结构化 context，不要只依赖本段文字。",
    "若远端已安装 detaches-agent skill，请读取 clientContext.detaches.contextExport.consumeUrl，并在真实 OpenClaw agent host 上运行 `node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs doctor --url \"$CONSUME_URL\" --output-context /tmp/detaches-client-context.json`；如果已经保存 context，则运行 `doctor --context <context-json>`。",
    "工具请求必须经过 detaches_agent 审批；不要声称命令、文件读取、传输或归档已完成，除非已收到 approved tool output。",
    "不要把 remote-agent-host/gateway-managed 请求退化成本机 local-user-machine。"
  ].join("\n");
}

export function renderDetachesClientContextFallback(context: DetachesSessionContext): string {
  const consumeUrl = context.contextExport?.consumeUrl;
  const remoteAdapter = context.adapterStatus?.remoteAgentHost;
  return [
    "[detaches_agent 兼容上下文]",
    "当前 OpenClaw Gateway 不支持 chat.send.clientContext，detaches_agent 已降级为可见文本上下文。",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    consumeUrl ? `contextExport.consumeUrl: ${consumeUrl}` : "contextExport.consumeUrl: unavailable",
    "如果需要本机控制、文件传输或完整机器可读上下文，请在真实 OpenClaw agent host 上运行：",
    "node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs doctor --url \"$CONSUME_URL\" --output-context /tmp/detaches-client-context.json",
    "这个 consumeUrl 是一次性的，包含本会话工具 broker 能力；只在本次任务需要时消费，不要泄露或重复使用。",
    "工具请求仍必须经过 detaches_agent UI 审批；不要声称命令、文件读取、传输或归档已完成，除非已收到 approved tool output。"
  ].join("\n");
}

function agentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || "";
}
