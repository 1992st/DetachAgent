import os from "node:os";
import type { ChatSessionMode, ClientIdentity, DetachesSessionContext, DetachesStagedFileContext, DetachesTerminalChannels, TerminalChannelName, UploadedFileRef } from "@detaches/shared";
import { reverseBridgeBaseUrl } from "../config/appConfig.js";
import { runtimeConfig } from "../config/settingsStore.js";
import { loadOrCreateDeviceIdentity } from "./gateway/deviceIdentityService.js";
import { openclawDetachesAdapterService } from "./adapters/openclawDetachesAdapterService.js";
import { brokerTokenService } from "./tools/brokerTokenService.js";
import { contextExportService } from "./context/contextExportService.js";
import { buildLocalMachineContext } from "./platform/localMachineContext.js";
import { sshTunnelService } from "./tunnel/sshTunnelService.js";
import { adminTerminalService } from "./terminal/adminTerminalService.js";

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

type ReverseBridgeStatus = Awaited<ReturnType<typeof sshTunnelService.status>>;

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function channelEndpoints(baseUrl: string): { baseUrl: string; toolEventEndpoint: string; interactionEventEndpoint: string } {
  return {
    baseUrl,
    toolEventEndpoint: `${baseUrl}/api/tools/events/gateway`,
    interactionEventEndpoint: `${baseUrl}/api/interactions/events/gateway`
  };
}

function buildTerminalChannels(config: Awaited<ReturnType<typeof runtimeConfig>>, reverseBridgeStatus: ReverseBridgeStatus): DetachesTerminalChannels {
  const gatewayBaseUrl = cleanBaseUrl(config.publicBaseUrl);
  const gatewayConfigured = Boolean(gatewayBaseUrl);
  const gatewayReady = gatewayConfigured && config.gatewayTerminalLastStatus === "ok";
  const sshBaseUrl = reverseBridgeBaseUrl(config);
  const sshReady = config.localSshBridgeEnabled && reverseBridgeStatus.ok;
  // 三类 terminal 是入口差异，不是三套执行器：最终都进入 Tool Queue，用户审批后才由本机 terminalService 执行。
  // gateway-terminal 优先；ssh-terminal 是默认关闭的高级兼容入口；chat-terminal 永远保留为文本 fallback。
  const preferred: TerminalChannelName = gatewayReady ? "gateway-terminal" : sshReady ? "ssh-terminal" : "chat-terminal";
  const gatewayEndpoints = gatewayReady ? channelEndpoints(gatewayBaseUrl) : null;
  const sshEndpoints = sshReady ? channelEndpoints(sshBaseUrl) : null;
  return {
    preferred,
    gatewayTerminal: {
      state: gatewayReady ? "ready" : gatewayConfigured ? "error" : "disabled",
      ...(gatewayConfigured ? channelEndpoints(gatewayBaseUrl) : gatewayEndpoints),
      message: gatewayReady
        ? "gateway-terminal is ready through configured publicBaseUrl."
        : gatewayConfigured
          ? config.gatewayTerminalLastError || "gateway-terminal is configured but not tested successfully; chat-terminal fallback remains available."
          : "gateway-terminal is disabled until publicBaseUrl is configured and tested.",
      requiresApproval: true
    },
    sshTerminal: {
      state: sshReady ? "ready" : config.localSshBridgeEnabled ? "error" : "disabled",
      ...sshEndpoints,
      message: sshReady
        ? "ssh-terminal is ready through the advanced SSH reverse bridge."
        : config.localSshBridgeEnabled
          ? reverseBridgeStatus.message
          : "ssh-terminal is disabled by default.",
      requiresApproval: true
    },
    chatTerminal: {
      state: "available",
      requestFence: "detaches-terminal",
      source: "text-extract",
      requiresApproval: true,
      message: "chat-terminal is always available as the fenced-block fallback."
    }
  };
}

function selectedHttpChannel(channels: DetachesTerminalChannels): DetachesTerminalChannels["gatewayTerminal"] | DetachesTerminalChannels["sshTerminal"] | null {
  if (channels.preferred === "gateway-terminal" && channels.gatewayTerminal.state === "ready") return channels.gatewayTerminal;
  if (channels.preferred === "ssh-terminal" && channels.sshTerminal.state === "ready") return channels.sshTerminal;
  return null;
}

function localControlNote(channels: DetachesTerminalChannels): string {
  // 这里故意把 OpenClaw Gateway 聊天连接和 Main Agent 回连 Detach Agent 的 terminal broker 分开描述，避免后续维护者混用。
  if (channels.preferred === "gateway-terminal") {
    return "gateway-terminal is preferred: Main Agent can reach the Detach Agent HTTP broker through configured publicBaseUrl. This is separate from the OpenClaw Gateway chat connection.";
  }
  if (channels.preferred === "ssh-terminal") {
    return "ssh-terminal is preferred: advanced SSH reverse bridge is ready. Use the context-provided loopback URL only for this channel.";
  }
  return "chat-terminal is preferred: HTTP broker access is unavailable. Output exactly one detaches-terminal fenced block for local-user-machine terminal requests.";
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
  const localMachine = buildLocalMachineContext();
  const reverseBridgeStatus = await sshTunnelService.status();
  const terminalChannels = buildTerminalChannels(config, reverseBridgeStatus);
  const preferredHttp = selectedHttpChannel(terminalChannels);
  const baseUrl = preferredHttp?.baseUrl || "";
  const adminTerminalStatus = adminTerminalService.status(sessionKey);
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
    terminalChannels,
    agentTerminal: {
      state: baseUrl ? "ready" : "fallback_chat",
      mode: terminalChannels.preferred,
      host: baseUrl || undefined,
      adapterCommand: "terminal-run",
      approvalRequired: true,
      supportsWait: true,
      supportsStreaming: true,
      supportsCancel: true,
      note: baseUrl
        ? "Use detaches-agent-adapter terminal-run --host <host> for local-user-machine commands. The adapter manages bootstrap, lease refresh, Tool Queue approval, waiting, and output."
        : "Agent Terminal Runtime is unavailable for this message; use chat-terminal fenced block fallback."
    },
    broker: {
      gatewayEventEndpoint: preferredHttp?.toolEventEndpoint || "",
      interactionEventEndpoint: preferredHttp?.interactionEventEndpoint,
      eventSource: "gateway-event",
      idempotencyField: "sourceEventId",
      submitToken: brokerTokenService.tokenForSession(sessionKey),
      submitTokenHeader: "Authorization",
      requestFormats: ["broker-event", "fence"]
    },
    localControl: {
      transport: terminalChannels.preferred,
      baseUrl,
      toolEventEndpoint: preferredHttp?.toolEventEndpoint,
      interactionEventEndpoint: preferredHttp?.interactionEventEndpoint,
      fixedPort: terminalChannels.preferred === "ssh-terminal" ? config.reverseBridgeRemotePort : config.serverPort,
      submitTokenHeader: "Authorization",
      addressSource: "remote-reachable-context",
      reverseBridge: {
        ok: reverseBridgeStatus.ok,
        message: reverseBridgeStatus.message,
        reverseBrokerUrl: reverseBridgeStatus.reverseBrokerUrl,
        pid: reverseBridgeStatus.pid
      },
      adminTerminal: {
        supported: adminTerminalStatus.supported,
        active: adminTerminalStatus.active,
        controlledBy: "local-ui",
        note: adminTerminalStatus.active
          ? "User-enabled Windows administrator terminal is active for this session; command routing still goes through Tool Queue approval."
          : "Administrator terminal can only be enabled or disabled by the user's local UI shield button."
      },
      note: localControlNote(terminalChannels)
    },
    contextExport: {
      createEndpoint: preferredHttp ? `${baseUrl}/api/context/exports` : "",
      consumeEndpointPattern: preferredHttp ? `${baseUrl}/api/context/exports/{token}` : "",
      consumeUrl: contextExportRecord && preferredHttp
        ? `${baseUrl}/api/context/exports/${encodeURIComponent(contextExportRecord.token)}`
        : undefined,
      createdBy: terminalChannels.preferred === "ssh-terminal"
        ? "detaches-ui-reverse-bridge"
        : terminalChannels.preferred === "gateway-terminal"
          ? "detaches-ui-direct-callback"
          : "detaches-ui-loopback",
      consumedBy: "remote-agent-host",
      oneTime: true,
      ttlSeconds: 300,
      adapterCommand: "context-fetch",
      doctorCommand: "doctor",
      generatedForMessage: Boolean(contextExportRecord),
      note: contextExportRecord
        ? preferredHttp
          ? `A one-time context URL was generated for this message through ${terminalChannels.preferred}. Treat it as sensitive.`
          : "No reachable HTTP terminal channel is available for this message. Use fenced detaches-terminal chat-terminal fallback for local-user-machine terminal requests."
        : "Ask the user to send a fresh detaches_agent message with current connection settings when the remote agent host needs a new full clientContext. Do not invent or request broker tokens in chat."
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
      adminTerminalStatus.active
        ? "Windows administrator terminal is active for this detaches_agent session; local-user-machine terminal commands will run in the user-enabled administrator terminal after Tool Queue approval."
        : "Windows administrator terminal is not active unless the user explicitly enables it in the Detach Agent UI.",
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
  const adminTerminalActive = adminTerminalService.status(context.sessionKey).active;
  const terminalChannelLines = renderTerminalChannelLines(context);
  return [
    "[detaches_agent context]",
    "You are talking to the user through the detaches_agent local UI, but this context describes request targets and approval routing; it does not redefine your Host/Main Agent identity.",
    "Use your own Main Agent tools for Host/Main Agent work. Use detaches_agent only when the requested target is the user's local machine or staged local files.",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `localMachine.os: ${localMachine?.os || "unknown"} (Detach Agent user's local machine, not the Host/Main Agent host identity)`,
    `localMachine.nodePlatform: ${localMachine?.nodePlatform || "unknown"}`,
    `localMachine.shell: ${localMachine?.shell || "unknown"}`,
    `localMachine.commandDialect: ${localMachine?.commandDialect || "unknown"}`,
    `localMachine.pathStyle: ${localMachine?.pathStyle || "unknown"}`,
    `localMachine.adminTerminalActive: ${adminTerminalActive}`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    ...terminalChannelLines,
    consumeUrl ? `contextExport.consumeUrl: ${consumeUrl}` : "contextExport.consumeUrl: unavailable",
    `agentTerminal.state: ${context.agentTerminal?.state || "fallback_chat"}`,
    `agentTerminal.host: ${context.agentTerminal?.host || "unavailable"}`,
    "Agent terminal command: node ~/.detach_agent/bin/detaches-agent-adapter.mjs terminal-run --host \"$DETACH_AGENT_HOST\" --command \"pwd\" --reason \"check local terminal\"",
    `localControl.baseUrl: ${context.localControl?.baseUrl || "unavailable"}`,
    `localControl.reverseBridge.ok: ${context.localControl?.reverseBridge?.ok ?? false}`,
    `localControl.reverseBridge.message: ${context.localControl?.reverseBridge?.message || "unknown"}`,
    terminalRoutingRule(context),
    "Terminal source mapping: terminal-run is the primary gateway-terminal runtime; source=text-extract is chat-terminal compatibility fallback.",
    localMachineCommandRule(localMachine),
    callbackEndpointRule(context),
    "Local terminal control does not use SSH. Do not ask for the user's local SSH username/password/port. The user only approves the tool request; ordinary local terminal commands must not trigger an SSH password dialog.",
    adminTerminalActive
      ? "Windows administrator terminal is currently active because the user enabled it in the local UI. It still requires Tool Queue approval for each command."
      : "Windows administrator terminal is not active. The Main Agent cannot enable it directly; the user must use the local UI shield button first.",
    "SSH is used only for reverse bridge reachability, saving staged files to the Main Agent machine, or a user-approved SSH credential/login request.",
    "Do not ask for broker tokens or endpoint names for terminal commands. Use terminal-run --host; contextExport remains a compatibility/bootstrap path only.",
    "Every tool request must be approved through detaches_agent. Do not claim that a command, file read, transfer, download, archive, or modification is complete until approved tool output proves it.",
    "Do not degrade remote-agent-host, gateway-managed, or main-agent-machine requests into local-user-machine."
  ].join("\n");
}

export function renderDetachesClientContextFallback(context: DetachesSessionContext): string {
  const consumeUrl = context.contextExport?.consumeUrl;
  const remoteAdapter = context.adapterStatus?.remoteAgentHost;
  const localMachine = context.localMachine;
  const adminTerminalActive = adminTerminalService.status(context.sessionKey).active;
  const terminalChannelLines = renderTerminalChannelLines(context);
  return [
    "[detaches_agent compatibility context]",
    "Structured clientContext.detaches was not accepted by the current host/Gateway, so detaches_agent included this readable fallback context. Treat it as authoritative for detaches_agent routing.",
    "This context describes request targets and approval routing; it does not redefine your Host/Main Agent identity.",
    "Use your own Main Agent tools for Host/Main Agent work. Use detaches_agent only when the requested target is the user's local machine or staged local files.",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    `localMachine.os: ${localMachine?.os || "unknown"} (Detach Agent user's local machine, not the Host/Main Agent host identity)`,
    `localMachine.nodePlatform: ${localMachine?.nodePlatform || "unknown"}`,
    `localMachine.shell: ${localMachine?.shell || "unknown"}`,
    `localMachine.commandDialect: ${localMachine?.commandDialect || "unknown"}`,
    `localMachine.pathStyle: ${localMachine?.pathStyle || "unknown"}`,
    `localMachine.adminTerminalActive: ${adminTerminalActive}`,
    `remoteAdapter: state=${remoteAdapter?.state || "unknown"}`,
    ...terminalChannelLines,
    consumeUrl ? `contextExport.consumeUrl: ${consumeUrl}` : "contextExport.consumeUrl: unavailable",
    `agentTerminal.state: ${context.agentTerminal?.state || "fallback_chat"}`,
    `agentTerminal.host: ${context.agentTerminal?.host || "unavailable"}`,
    "Agent terminal command: node ~/.detach_agent/bin/detaches-agent-adapter.mjs terminal-run --host \"$DETACH_AGENT_HOST\" --command \"pwd\" --reason \"check local terminal\"",
    `localControl.baseUrl: ${context.localControl?.baseUrl || "unavailable"}`,
    `localControl.reverseBridge.ok: ${context.localControl?.reverseBridge?.ok ?? false}`,
    `localControl.reverseBridge.message: ${context.localControl?.reverseBridge?.message || "unknown"}`,
    terminalRoutingRule(context),
    "Terminal source mapping: terminal-run is the primary gateway-terminal runtime; source=text-extract is chat-terminal compatibility fallback.",
    localMachineCommandRule(localMachine),
    "The local terminal path does not use SSH. Do not ask for the user's local SSH username/password/port, and do not ask the user to manually run ssh -R, scp, copy broker tokens, or find a local IP.",
    adminTerminalActive
      ? "Windows administrator terminal is currently active because the user enabled it in the local UI. It still requires Tool Queue approval for each command."
      : "Windows administrator terminal is not active. The Main Agent cannot enable it directly; the user must use the local UI shield button first.",
    "Do not ask for broker tokens or endpoint names for terminal commands. Use terminal-run --host; contextExport remains a compatibility/bootstrap path only.",
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

function renderTerminalChannelLines(context: DetachesSessionContext): string[] {
  const channels = context.terminalChannels;
  if (!channels) return ["terminalChannels.preferred: chat-terminal"];
  return [
    `terminalChannels.preferred: ${channels.preferred}`,
    `gateway-terminal: ${channels.gatewayTerminal.state}${channels.gatewayTerminal.baseUrl ? ` ${channels.gatewayTerminal.baseUrl}` : ""}`,
    `ssh-terminal: ${channels.sshTerminal.state}${channels.sshTerminal.baseUrl ? ` ${channels.sshTerminal.baseUrl}` : ""}`,
    `chat-terminal: ${channels.chatTerminal.state} fence=${channels.chatTerminal.requestFence}`
  ];
}

function terminalRoutingRule(context: DetachesSessionContext): string {
  // fallback prompt 必须在 Gateway 不支持结构化 clientContext 时也足够完整，Main Agent 只看文本也能选对 terminal channel。
  if (context.agentTerminal?.state === "ready" && context.agentTerminal.host) {
    return `Terminal routing: use Agent Terminal Runtime. Run node ~/.detach_agent/bin/detaches-agent-adapter.mjs terminal-run --host "${context.agentTerminal.host}" --command "<command>" --reason "<reason>". The adapter manages bootstrap, lease refresh, approval waiting, execution waiting, output, and exitCode. Do not use interactionEventEndpoint or raw broker endpoints for terminal commands.`;
  }
  const preferred = context.terminalChannels?.preferred ?? "chat-terminal";
  if (preferred === "gateway-terminal") {
    return [
      "Terminal routing: preferred gateway-terminal, but Agent Terminal Runtime is not ready. Do not build raw broker requests or use interactionEventEndpoint for terminal commands.",
      "Ask the user to confirm Detach Agent callback host readiness, or fall back to exactly one detaches-terminal fenced block when a command is needed now.",
      "Never run local-user-machine commands in the Main Agent shell, never ask for Detach Agent PC SSH credentials, and wait for Detach Agent Tool Queue approval."
    ].join(" ");
  }
  if (preferred === "ssh-terminal") {
    return [
      "Terminal routing: preferred ssh-terminal compatibility path. Use terminal-request --context only if a saved detaches context explicitly selects ssh-terminal.",
      "Do not use interactionEventEndpoint for terminal commands.",
      "Do not ask for SSH password and do not replace this URL with any guessed 127.0.0.1 value.",
      "If HTTP broker access fails, use exactly one detaches-terminal fenced block fallback."
    ].join(" ");
  }
  return "Terminal routing: preferred chat-terminal. HTTP broker/context direct access is unavailable; output exactly one detaches-terminal fenced block for local-user-machine terminal requests and wait for Detach Agent approval.";
}

function callbackEndpointRule(context: DetachesSessionContext): string {
  if (context.terminalChannels?.preferred === "gateway-terminal") {
    return "gateway-terminal uses publicBaseUrl from Detach Agent settings. It is not the OpenClaw Gateway chat connection and not SSH.";
  }
  if (context.terminalChannels?.preferred === "ssh-terminal") {
    return "ssh-terminal uses an advanced key-based SSH reverse bridge and can coexist with gateway-terminal. Use it only when the context selects it.";
  }
  return "chat-terminal fallback uses message parsing: source=text-extract means fenced-block fallback; source=gateway-event means an HTTP broker terminal path.";
}

function agentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || "";
}
