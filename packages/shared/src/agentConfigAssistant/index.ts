export * from "./types.js";
export * from "./openclawRules.js";

import { analyzeOpenClawConfig } from "./openclawRules.js";
import type { AgentConfigAssistantInput, AgentConfigAssistantResult } from "./types.js";

export function analyzeAgentConfig(input: AgentConfigAssistantInput): AgentConfigAssistantResult {
  if (input.agentType === "openclaw") return analyzeOpenClawConfig(input);
  return {
    status: "unsupported",
    agentType: input.agentType,
    title: "Agent 类型暂未支持",
    summary: "当前版本只支持 OpenClaw 配置导入。",
    proposedUpdate: {},
    findings: [{ level: "warning", message: "请选择 OpenClaw。" }],
    detected: {}
  };
}

