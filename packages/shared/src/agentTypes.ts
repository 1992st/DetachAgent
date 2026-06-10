export interface AgentSummary {
  id: string;
  sessionKey: string;
  title: string;
  status: string;
  preview: string;
  updatedAt?: string;
  raw?: unknown;
}

export interface AgentsListResponse {
  agents: AgentSummary[];
  source: "gateway-sessions" | "gateway-agents" | "gateway-agents+sessions" | "gateway-agents+sessions+ssh-cli" | "fallback";
  raw?: unknown;
}
