import os from "node:os";
import type { ChatSessionMode, ClientIdentity, DetachesSessionContext, DetachesStagedFileContext, UploadedFileRef } from "@detaches/shared";
import { reverseBridgeBaseUrl } from "../config/appConfig.js";
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
  const baseUrl = reverseBridgeBaseUrl(config);
  const remoteUser = config.remoteUser || "remote-user";
  const remoteHome = remoteUser === "root" ? "/root" : `/home/${remoteUser}`;
  const remoteWorkspace = config.remoteWorkspaceRoot.startsWith("/")
    ? config.remoteWorkspaceRoot
    : `${remoteHome}/${config.remoteWorkspaceRoot.replace(/^~\/?/, "").replace(/^\/+/, "")}`;
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
      supportedTargets: ["remote-agent-host", "local-user-machine"],
      defaultTarget: "remote-agent-host" as const,
      requiresApproval: true,
      remotePathRule: `For target=remote-agent-host, remotePath must be an absolute path on ${remoteUser}@${config.remoteHost} inside the remote agent workspace (${remoteWorkspace}) or remote user home (${remoteHome}). Prefer ${remoteWorkspace.replace(/\/+$/, "")}/attachments/<file>; do not use relative paths, other users' home directories, or /Volumes external drives.`
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
      createdBy: "detaches-ui-reverse-bridge",
      consumedBy: "remote-agent-host",
      oneTime: true,
      ttlSeconds: 300,
      adapterCommand: "context-fetch",
      doctorCommand: "doctor",
      generatedForMessage: Boolean(contextExportRecord),
      note: contextExportRecord
        ? "A one-time context URL was generated for this message. It is reachable from the remote agent host through the SSH reverse bridge and must be treated as sensitive."
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
        supportedTargets: ["remote-agent-host", "local-user-machine"],
        unavailableTargets: ["gateway-managed"],
        approvalRequired: true,
        executionHost: "remote-agent-host"
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
  const consumeUrl = context.contextExport?.consumeUrl;
  return [
    "[detaches_agent 接入上下文]",
    "你正在通过 detaches_agent 本地 UI 与用户对话，不是普通 webchat。",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    consumeUrl ? `contextExport.consumeUrl: ${consumeUrl}` : "contextExport.consumeUrl: unavailable",
    "contextExport.consumeUrl 是远端 agent host 上可访问的一次性 SSH reverse bridge 地址；需要完整上下文或工具 broker 能力时，优先使用它获取机器可读上下文。",
    "若远端已安装 detaches-agent skill，并且 contextExport.consumeUrl 可用，请在真实 Detach Agent runtime machine / OpenClaw agent host 上运行 `node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --url \"$CONSUME_URL\" --output-context /tmp/detaches-client-context.json`；如果已经保存 context，则运行 `doctor --context <context-json>`。",
    "不要要求用户手动 scp、寻找本机局域网 IP、复制 broker token，或把远端请求改成本机执行。",
    "工具请求必须经过 detaches_agent 审批；不要声称命令、文件读取、传输或归档已完成，除非已收到 approved tool output。",
    "不要把 remote-agent-host/gateway-managed 请求退化成本机 local-user-machine。"
  ].join("\n");
}

export function renderDetachesClientContextFallback(context: DetachesSessionContext): string {
  const consumeUrl = context.contextExport?.consumeUrl;
  const remoteAdapter = context.adapterStatus?.remoteAgentHost;
  return [
    "[detaches_agent 兼容上下文]",
    "本条消息的结构化 clientContext.detaches 无法被当前宿主/Gateway 接收或已被判定不支持；detaches_agent 已把可恢复入口降级为这段可见文本。",
    "如果上方 [detaches_agent 接入上下文] 提到 clientContext.detaches，请以本兼容上下文为准：当前 agent 侧不应假设能直接读取 chat.send.clientContext.detaches。",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    consumeUrl ? `contextExport.consumeUrl: ${consumeUrl}` : "contextExport.consumeUrl: unavailable",
    "contextExport.consumeUrl 是远端 agent host 上可访问的一次性 SSH reverse bridge 地址，包含本会话 broker 能力；不要泄露、复用或要求用户手动复制文件/IP。",
    "如果需要本机控制、文件传输或完整机器可读上下文，请只在真实 OpenClaw agent host 上运行：",
    "node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --url \"$CONSUME_URL\" --output-context /tmp/detaches-client-context.json",
    "如果 contextExport.consumeUrl 是 unavailable，请向用户说明当前消息没有可消费的完整上下文入口，而不是编造 broker token 或要求读取 chat.send.clientContext.detaches。",
    "工具请求仍必须经过 detaches_agent UI 审批；不要声称命令、文件读取、传输或归档已完成，除非已收到 approved tool output。"
  ].join("\n");
}

function agentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || "";
}
