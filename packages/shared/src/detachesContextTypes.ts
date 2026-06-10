import type { ChatSessionMode } from "./clientTypes.js";
import type { ToolTarget } from "./fileTypes.js";
import type { OpenClawAdapterReadinessState } from "./adapterTypes.js";

export interface DetachesToolCapability {
  name: "terminal" | "file-transfer";
  requestFence: "detaches-terminal" | "detaches-file-transfer";
  supportedTargets: ToolTarget[];
  unavailableTargets: ToolTarget[];
  approvalRequired: boolean;
  executionHost: "user-local-machine" | "remote-agent-host" | "gateway";
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
  broker?: {
    gatewayEventEndpoint: string;
    eventSource: "gateway-event";
    idempotencyField: "sourceEventId";
    submitToken: string;
    submitTokenHeader: "Authorization";
    requestFormats: Array<"broker-event" | "fence">;
  };
  contextExport?: {
    createEndpoint: string;
    consumeEndpointPattern: string;
    consumeUrl?: string;
    createdBy: "detaches-ui-loopback";
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
}
