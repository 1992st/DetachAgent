import type { ChatSessionMode } from "./clientTypes.js";
import type { ToolTarget } from "./fileTypes.js";
import type { OpenClawAdapterReadinessState } from "./adapterTypes.js";

export interface DetachesToolCapability {
  name: "terminal" | "file-transfer" | "main-agent-save-file";
  requestFence: "detaches-terminal" | "detaches-file-transfer" | "main-agent-save-file";
  supportedTargets: ToolTarget[];
  unavailableTargets: ToolTarget[];
  approvalRequired: boolean;
  executionHost: "user-local-machine" | "remote-agent-host" | "gateway";
}

export interface DetachesLocalMachineContext {
  os: "darwin" | "linux" | "win32" | "ios" | "unknown";
  nodePlatform: string;
  arch: string;
  shell: string;
  pathStyle: "windows" | "posix" | "unknown";
  pathSeparator: string;
  commandDialect: "powershell" | "posix-shell" | "unknown";
  appDataDir: string;
}

export interface DetachesStagedFileContext {
  fileId: string;
  name: string;
  displayName: string;
  mimeType: string;
  size: number;
  localPath?: string;
  currentLocation: "user-local-staging";
  remotePath?: string;
  transfer: {
    requestFence: "detaches-file-transfer";
    supportedTargets: ToolTarget[];
    defaultTarget: ToolTarget;
    requiresApproval: boolean;
    remotePathRule?: string;
  };
}

export type TerminalChannelName = "gateway-terminal" | "ssh-terminal" | "chat-terminal";

export interface DetachesTerminalChannels {
  preferred: TerminalChannelName;
  gatewayTerminal: {
    state: "ready" | "error" | "disabled";
    baseUrl?: string;
    toolEventEndpoint?: string;
    interactionEventEndpoint?: string;
    message?: string;
    requiresApproval: true;
  };
  sshTerminal: {
    state: "ready" | "error" | "disabled";
    baseUrl?: string;
    toolEventEndpoint?: string;
    interactionEventEndpoint?: string;
    message?: string;
    requiresApproval: true;
  };
  chatTerminal: {
    state: "available";
    requestFence: "detaches-terminal";
    source: "text-extract";
    requiresApproval: true;
    message?: string;
  };
}

export interface DetachesSessionContext {
  app: "detaches_agent";
  version: 1;
  sessionMode: ChatSessionMode;
  sessionKey: string;
  agentId?: string;
  userDevice: {
    deviceId: string;
    deviceIdShort: string;
    displayName: string;
    sessionNamespace: string;
  };
  localMachine?: DetachesLocalMachineContext;
  adapterStatus?: {
    remoteAgentHost: {
      state: OpenClawAdapterReadinessState | "unknown";
      installDir?: string;
      checkedAt?: string;
      remoteHost?: string;
      remoteUser?: string;
      summary: string;
    };
  };
  files?: {
    staged: DetachesStagedFileContext[];
  };
  terminalChannels?: DetachesTerminalChannels;
  agentTerminal?: {
    state: "ready" | "fallback_chat";
    mode: TerminalChannelName;
    host?: string;
    adapterCommand: "terminal-run";
    approvalRequired: true;
    supportsWait: boolean;
    supportsStreaming: boolean;
    supportsCancel: boolean;
    note: string;
  };
  broker?: {
    gatewayEventEndpoint: string;
    interactionEventEndpoint?: string;
    eventSource: "gateway-event";
    idempotencyField: "sourceEventId";
    submitToken: string;
    submitTokenHeader: "Authorization";
    requestFormats: Array<"broker-event" | "fence">;
  };
  localControl?: {
    transport?: TerminalChannelName;
    baseUrl?: string;
    toolEventEndpoint?: string;
    interactionEventEndpoint?: string;
    fixedPort?: number;
    submitTokenHeader: "Authorization";
    addressSource: "remote-reachable-context";
    reverseBridge?: {
      ok: boolean;
      message: string;
      reverseBrokerUrl?: string;
      pid?: number;
    };
    note: string;
  };
  contextExport?: {
    createEndpoint: string;
    consumeEndpointPattern: string;
    consumeUrl?: string;
    createdBy: "detaches-ui-loopback" | "detaches-ui-direct-callback" | "detaches-ui-reverse-bridge";
    consumedBy: "remote-agent-host";
    oneTime: true;
    ttlSeconds: number;
    adapterCommand: "context-fetch";
    doctorCommand: "doctor";
    generatedForMessage?: boolean;
    note: string;
  };
  capabilities: DetachesToolCapability[];
  invariants: string[];
}

export interface DetachesContextExportResponse {
  sessionKey: string;
  sessionMode: ChatSessionMode;
  clientContext: Record<string, unknown>;
  detaches: DetachesSessionContext;
  redacted: {
    brokerSubmitToken: boolean;
  };
}

export interface DetachesContextExportCreateResponse {
  sessionKey: string;
  sessionMode: ChatSessionMode;
  expiresAt: string;
  consumeUrl: string;
  reverseBridge?: {
    ok: boolean;
    message: string;
    reverseBrokerUrl?: string;
    pid?: number;
  };
}
