import os from "node:os";
import type { ChatSessionMode, ClientIdentity, DetachesSessionContext } from "@detaches/shared";
import { loadOrCreateDeviceIdentity } from "./gateway/deviceIdentityService.js";

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

export function buildDetachesSessionContext(sessionMode: ChatSessionMode, sessionKey: string): DetachesSessionContext {
  const identity = publicClientIdentity();
  const agentId = agentIdFromSessionKey(sessionKey);
  return {
    app: "detaches_agent",
    version: 1,
    sessionMode,
    sessionKey,
    agentId: agentId || undefined,
    userDevice: identity,
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
      "Remote-agent-host and gateway-managed execution are reserved capabilities until a server-side adapter enables them."
    ]
  };
}

export function buildChatClientContext(sessionMode: ChatSessionMode, sessionKey: string): Record<string, unknown> {
  const detaches = buildDetachesSessionContext(sessionMode, sessionKey);
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
  const terminal = context.capabilities.find((capability) => capability.name === "terminal");
  const transfer = context.capabilities.find((capability) => capability.name === "file-transfer");
  return [
    "[detaches_agent 接入上下文]",
    "你正在通过 detaches_agent 本地 UI 与用户对话，不是普通 webchat。",
    `sessionKey: ${context.sessionKey}`,
    context.agentId ? `agentId: ${context.agentId}` : "agentId: unknown",
    `userDevice: ${context.userDevice.displayName} (${context.userDevice.deviceIdShort})`,
    "当前用户这台电脑已经为本对话绑定了一个持久本机 terminal。这个 terminal 默认隐藏在用户界面里，用户可以点开查看活动。",
    `terminal targets: supported=${terminal?.supportedTargets.join(",") || "none"}; unavailable=${terminal?.unavailableTargets.join(",") || "none"}`,
    `file-transfer targets: supported=${transfer?.supportedTargets.join(",") || "none"}; unavailable=${transfer?.unavailableTargets.join(",") || "none"}`,
    "关键约束：",
    ...context.invariants.map((item) => `- ${item}`),
    "如果你需要控制/检查用户这台电脑，请向 UI 发起待审批命令请求：",
    "```detaches-terminal",
    "{\"target\":\"local-user-machine\",\"command\":\"pwd\",\"reason\":\"查看用户本机当前工作目录\"}",
    "```",
    "如果你需要处理本次附带文件，请先决定目标路径，然后向 UI 发起待审批文件传输请求：",
    "```detaches-file-transfer",
    "{\"fileId\":\"文件 id\",\"target\":\"local-user-machine\",\"remotePath\":\"/absolute/or/relative/target-file\",\"reason\":\"说明为什么需要传输\"}",
    "```",
    "只有用户批准后，UI 才会把请求写入本会话绑定的本机 terminal。"
  ].join("\n");
}

function agentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1] || "";
}
