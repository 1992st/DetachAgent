import type { ChatSessionMode } from "./clientTypes.js";
import type { ToolTarget } from "./fileTypes.js";

export interface DetachesToolCapability {
  name: "terminal" | "file-transfer";
  requestFence: "detaches-terminal" | "detaches-file-transfer";
  supportedTargets: ToolTarget[];
  unavailableTargets: ToolTarget[];
  approvalRequired: boolean;
  executionHost: "user-local-machine" | "remote-agent-host" | "gateway";
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
  capabilities: DetachesToolCapability[];
  invariants: string[];
}
