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
      supportedTargets: ["remote-agent-host", "local-user-machine", "main-agent-machine"],
      defaultTarget: "main-agent-machine" as const,
      requiresApproval: true,
      remotePathRule: `For target=main-agent-machine, use a main-agent-save-file request. sourceLocalPath must be this staged localPath. destination.user must be the Host/Main Agent SSH/Linux user chosen by the Main Agent, and destination.path must be a complete absolute file path chosen by the Main Agent according to Host/Main Agent rules. destination.host/port may be omitted; detaches_agent broker fills them from its current Main Agent SSH/Gateway settings. After user approval, detaches_agent broker executes one structured rsync/scp transfer; any SSH password is entered in the detaches_agent UI and is not saved. Do not generate terminal commands or alternative upload methods.`
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
      interactionEventEndpoint: `${baseUrl}/api/interactions/events/gateway`,
      eventSource: "gateway-event",
      idempotencyField: "sourceEventId",
      submitToken: brokerTokenService.tokenForSession(sessionKey),
      submitTokenHeader: "Authorization",
      requestFormats: ["broker-event", "fence"]
    },
    localControl: {
      baseUrl,
      toolEventEndpoint: `${baseUrl}/api/tools/events/gateway`,
      interactionEventEndpoint: `${baseUrl}/api/interactions/events/gateway`,
      fixedPort: config.reverseBridgeRemotePort,
      submitTokenHeader: "Authorization",
      addressSource: "remote-reachable-context",
      note: "This URL is the detaches_agent server address reachable from the Host/Main Agent machine. The adapter script runs on the Host/Main Agent machine and must use this context-provided URL, not 127.0.0.1."
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
        ? "A one-time context URL was generated for this message. It is reachable from the remote agent host through the SSH reverse bridge when that bridge is ready and must be treated as sensitive."
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
      },
      {
        name: "main-agent-save-file",
        requestFence: "main-agent-save-file",
        supportedTargets: ["main-agent-machine"],
        unavailableTargets: ["gateway-managed", "remote-agent-host", "local-user-machine"],
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
  const consumeUrl = context.contextExport?.consumeUrl;
  return [
    "[detaches_agent 接入上下文]",
    "你正在通过 detaches_agent 本地 UI 与用户对话，不是普通 webchat。",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    consumeUrl ? `contextExport.consumeUrl: ${consumeUrl}` : "contextExport.consumeUrl: unavailable",
    `localControl.baseUrl: ${context.localControl?.baseUrl || "unavailable"}`,
    `localControl.interactionEventEndpoint: ${context.localControl?.interactionEventEndpoint || "unavailable"}`,
    "通道选择：1) 普通用户本机命令使用 detaches-terminal 或 broker terminal 请求；2) 需要密码/secret 时才使用 credential-request interaction；3) context/broker 直连使用 localControl/broker 提供的 URL。",
    "main agent 侧脚本运行在 main agent 的 PC/主机上；连接 detaches_agent server 时必须使用 localControl/broker 里提供的远端可达 URL，不要猜测或替换为 main agent 自己的 127.0.0.1。",
    "本机 terminal 控制不走 SSH，不询问用户本机 SSH 用户名/密码/端口；用户只审批 tool request，普通 terminal 操作不得触发密码弹窗。",
    "SSH 只用于 reverse bridge 可达性、保存 staged 文件到 Main Agent 机器、或用户明确批准的 SSH 登录/凭据请求。",
    "若远端已安装 detaches-agent skill，并且 contextExport.consumeUrl 可用，请在真实 Host/Main Agent machine 上运行 `node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --url \"$CONSUME_URL\" --output-context /tmp/detaches-client-context.json`；如果已经保存 context，则运行 `doctor --context <context-json>`。",
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
    `localControl.baseUrl: ${context.localControl?.baseUrl || "unavailable"}`,
    "本机普通命令输出 detaches-terminal 请求即可；需要密码/secret 时才使用 credential-request；脚本/API 必须连接 localControl/broker 提供的 detaches_agent 可达地址，不要把 main agent 自己的 127.0.0.1 当作用户本机 server。",
    "本机 terminal 不走 SSH；不要询问用户本机 SSH 用户名/密码/端口，也不要要求用户手动运行 ssh -R、scp、复制 broker token 或寻找本机 IP。",
    "如果 consumeUrl 暂时不可访问，应说明 broker/context 直连暂不可用；fenced detaches-terminal fallback 仍可用。",
    "如果需要 broker-event 或完整机器可读上下文，请只在真实 Host/Main Agent machine 上运行：",
    "node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --url \"$CONSUME_URL\" --output-context /tmp/detaches-client-context.json",
    "如果 contextExport.consumeUrl 是 unavailable，请向用户说明当前消息没有可消费的完整上下文入口，而不是编造 broker token 或要求读取 chat.send.clientContext.detaches。",
    "工具请求仍必须经过 detaches_agent UI 审批；不要声称命令、文件读取、传输或归档已完成，除非已收到 approved tool output。"
  ].join("\n");
}

function agentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || "";
}
