import os from "node:os";
import type { ChatSessionMode, ClientIdentity, DetachesSessionContext, DetachesStagedFileContext, UploadedFileRef } from "@detaches/shared";
import { reverseBridgeBaseUrl } from "../config/appConfig.js";
import { runtimeConfig } from "../config/settingsStore.js";
import { loadOrCreateDeviceIdentity } from "./gateway/deviceIdentityService.js";
import { openclawDetachesAdapterService } from "./adapters/openclawDetachesAdapterService.js";
import { brokerTokenService } from "./tools/brokerTokenService.js";
import { contextExportService } from "./context/contextExportService.js";
import { buildLocalMachineContext } from "./platform/localMachineContext.js";
import { sshTunnelService } from "./tunnel/sshTunnelService.js";

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
  const localMachine = buildLocalMachineContext();
  const reverseBridgeStatus = await sshTunnelService.status();
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
      remotePathRule: "For target=main-agent-machine, use one main-agent-save-file request. sourceLocalPath is an absolute path on the detaches_agent local machine, not on the Host/Main Agent machine. destination.user must be the Host/Main Agent SSH/Linux user chosen by the Main Agent, and destination.path must be a complete absolute POSIX file path including the final filename. destination.host/port may be omitted; detaches_agent fills them from the current Main Agent SSH/Gateway settings. After user approval, detaches_agent executes one structured rsync/scp transfer; any SSH password is entered in the detaches_agent UI and is not saved. Do not generate terminal commands or alternative upload methods."
    }
  }));

  return {
    app: "detaches_agent",
    version: 1,
    sessionMode,
    sessionKey,
    agentId: agentId || undefined,
    userDevice: identity,
    localMachine,
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
      reverseBridge: {
        ok: reverseBridgeStatus.ok,
        message: reverseBridgeStatus.message,
        reverseBrokerUrl: reverseBridgeStatus.reverseBrokerUrl,
        pid: reverseBridgeStatus.pid
      },
      note: reverseBridgeStatus.ok
        ? "This URL is the detaches_agent server address reachable from the Host/Main Agent machine through the active SSH reverse bridge. The adapter script runs on the Host/Main Agent machine and must use this context-provided URL, not 127.0.0.1."
        : "The SSH reverse bridge is not ready, so this URL is not currently reachable from the Host/Main Agent machine. Use fenced detaches-terminal fallback for local-user-machine requests until the user fixes Network Test / SSH reverse bridge."
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
        ? reverseBridgeStatus.ok
          ? "A one-time context URL was generated for this message. It is reachable from the remote agent host through the active SSH reverse bridge and must be treated as sensitive."
          : "A one-time context URL was generated for this message, but the SSH reverse bridge is not ready, so it is not currently reachable from the remote agent host. Use fenced detaches-terminal fallback for local-user-machine requests."
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
      `The user's local machine is ${localMachine.os}; local-user-machine terminal commands must use ${localMachine.commandDialect} syntax and ${localMachine.pathStyle} paths.`,
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
  const localMachine = context.localMachine;
  return [
    "[detaches_agent context]",
    "You are talking to the user through the detaches_agent local UI, not plain webchat.",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `localMachine.os: ${localMachine?.os || "unknown"}`,
    `localMachine.nodePlatform: ${localMachine?.nodePlatform || "unknown"}`,
    `localMachine.shell: ${localMachine?.shell || "unknown"}`,
    `localMachine.commandDialect: ${localMachine?.commandDialect || "unknown"}`,
    `localMachine.pathStyle: ${localMachine?.pathStyle || "unknown"}`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    consumeUrl ? `contextExport.consumeUrl: ${consumeUrl}` : "contextExport.consumeUrl: unavailable",
    `localControl.baseUrl: ${context.localControl?.baseUrl || "unavailable"}`,
    `localControl.interactionEventEndpoint: ${context.localControl?.interactionEventEndpoint || "unavailable"}`,
    `localControl.reverseBridge.ok: ${context.localControl?.reverseBridge.ok ?? false}`,
    `localControl.reverseBridge.message: ${context.localControl?.reverseBridge.message || "unknown"}`,
    channelChoiceRule(context),
    localMachineCommandRule(localMachine),
    reverseBridgeRule(context),
    "Local terminal control does not use SSH. Do not ask for the user's local SSH username/password/port. The user only approves the tool request; ordinary local terminal commands must not trigger an SSH password dialog.",
    "SSH is used only for reverse bridge reachability, saving staged files to the Main Agent machine, or a user-approved SSH credential/login request.",
    "If the remote side has the detaches-agent skill and contextExport.consumeUrl is available, run this only on the real Host/Main Agent machine: `node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --url \"$CONSUME_URL\" --output-context /tmp/detaches-client-context.json`; if context is already saved, run `doctor --context <context-json>`.",
    "Every tool request must be approved through detaches_agent. Do not claim that a command, file read, transfer, download, archive, or modification is complete until approved tool output proves it.",
    "Do not degrade remote-agent-host, gateway-managed, or main-agent-machine requests into local-user-machine."
  ].join("\n");
}

export function renderDetachesClientContextFallback(context: DetachesSessionContext): string {
  const consumeUrl = context.contextExport?.consumeUrl;
  const remoteAdapter = context.adapterStatus?.remoteAgentHost;
  const localMachine = context.localMachine;
  return [
    "[detaches_agent compatibility context]",
    "Structured clientContext.detaches was not accepted by the current host/Gateway, so detaches_agent included this readable fallback context. Treat it as authoritative for detaches_agent routing.",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `localMachine.os: ${localMachine?.os || "unknown"}`,
    `localMachine.nodePlatform: ${localMachine?.nodePlatform || "unknown"}`,
    `localMachine.shell: ${localMachine?.shell || "unknown"}`,
    `localMachine.commandDialect: ${localMachine?.commandDialect || "unknown"}`,
    `localMachine.pathStyle: ${localMachine?.pathStyle || "unknown"}`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    consumeUrl ? `contextExport.consumeUrl: ${consumeUrl}` : "contextExport.consumeUrl: unavailable",
    `localControl.baseUrl: ${context.localControl?.baseUrl || "unavailable"}`,
    `localControl.reverseBridge.ok: ${context.localControl?.reverseBridge.ok ?? false}`,
    `localControl.reverseBridge.message: ${context.localControl?.reverseBridge.message || "unknown"}`,
    channelChoiceRule(context),
    localMachineCommandRule(localMachine),
    "The local terminal path does not use SSH. Do not ask for the user's local SSH username/password/port, and do not ask the user to manually run ssh -R, scp, copy broker tokens, or find a local IP.",
    "If consumeUrl or localControl/broker URLs are unreachable, say broker/context direct access is unavailable; fenced detaches-terminal fallback is still available.",
    "If broker-event or full machine-readable context is needed, run this only on the real Host/Main Agent machine:",
    "node ~/.detach_agent/bin/detaches-agent-adapter.mjs doctor --url \"$CONSUME_URL\" --output-context /tmp/detaches-client-context.json",
    "If contextExport.consumeUrl is unavailable, tell the user this message has no consumable full-context entry; do not invent broker tokens or ask to read chat.send.clientContext.detaches.",
    "Tool requests still require detaches_agent UI approval. Do not claim that a command, file read, transfer, download, archive, or modification is complete until approved tool output proves it."
  ].join("\n");
}

function localMachineCommandRule(localMachine: DetachesSessionContext["localMachine"]): string {
  switch (localMachine?.os) {
    case "win32":
      return "For target=local-user-machine, write Windows commands for the user's local machine: use PowerShell/cmd-compatible syntax and Windows paths such as C:\\Users\\name\\file.txt. Do not use macOS/Linux local commands like open, defaults, plutil, /Applications, /Library, ~/Library, or /tmp unless the user explicitly asks for a remote POSIX target.";
    case "darwin":
      return "For target=local-user-machine, write macOS commands for the user's local machine: use POSIX shell syntax and POSIX paths. Do not use Windows-only commands or paths such as powershell.exe, cmd.exe, C:\\Users\\name, or backslash-separated paths unless the target is explicitly Windows.";
    case "linux":
      return "For target=local-user-machine, write Linux commands for the user's local machine: use POSIX shell syntax and POSIX paths. Do not use macOS-only commands such as open/defaults/plutil or Windows-only commands/paths unless the user explicitly targets those systems.";
    default:
      return `For target=local-user-machine, write commands for the user's detected local OS, command dialect, and path style shown above (${localMachine?.commandDialect || "unknown"} / ${localMachine?.pathStyle || "unknown"}). If the OS is unknown, prefer portable checks or ask for clarification before using OS-specific commands.`;
  }
}

function channelChoiceRule(context: DetachesSessionContext): string {
  if (context.localControl?.reverseBridge.ok) {
    return "Channel choice: (1) ordinary commands on the user's local machine use detaches-terminal or a broker terminal request; (2) use credential-request only when a real secret is needed; (3) scripts/API calls may use the reachable localControl/broker URL supplied by this context.";
  }
  return "Channel choice: localControl/broker URLs are not reachable from the Host/Main Agent because the SSH reverse bridge is not ready. For ordinary local-user-machine commands, output exactly one fenced detaches-terminal request block in chat and wait for detaches_agent approval/output; do not run the command in the Host/Main Agent shell, do not use host=node, and do not POST to broker URLs.";
}

function reverseBridgeRule(context: DetachesSessionContext): string {
  if (context.localControl?.reverseBridge.ok) {
    return "The Host/Main Agent script runs on the Host/Main Agent machine. When it connects back to detaches_agent, it must use the context-provided localControl/broker URL; do not guess or replace it with the Host/Main Agent's own 127.0.0.1.";
  }
  return "The Host/Main Agent script runs on the Host/Main Agent machine, but the SSH reverse bridge is not ready. Do not treat localControl.baseUrl or contextExport.consumeUrl as reachable from that machine, and do not try to execute local-user-machine commands in the Host/Main Agent shell. Use fenced detaches-terminal fallback.";
}

function agentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || "";
}
