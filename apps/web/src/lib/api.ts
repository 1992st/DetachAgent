import type {
  AgentsListResponse,
  AppHealth,
  ClientIdentity,
  DiagnosticsResponse,
  FileTransferPrepareResponse,
  FileUploadResponse,
  NetworkTestResponse,
  PublicSettings,
  SettingsUpdate,
  ToolGatewayEventInput,
  ToolRequestCreateInput,
  ToolRequestCreateResponse,
  ToolRequestDecisionResponse,
  ToolExecutionResultResponse,
  ToolRequestExtractResponse,
  ToolRequestListResponse,
  ToolRequestRecord,
  ToolTarget
} from "@detaches/shared";

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed.error || parsed.message || text;
  } catch {
    return text || `${res.status} ${res.statusText}`;
  }
}

export async function fetchHealth(): Promise<AppHealth> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchAgents(): Promise<AgentsListResponse> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchClientIdentity(): Promise<ClientIdentity> {
  const res = await fetch("/api/client");
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchDiagnostics(): Promise<DiagnosticsResponse> {
  const res = await fetch("/api/diagnostics");
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function uploadFile(file: File, sessionKey: string): Promise<FileUploadResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("sessionKey", sessionKey);
  const res = await fetch("/api/files/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function prepareFileTransfer(
  fileId: string,
  target: ToolTarget,
  remotePath: string,
  context?: { agentId?: string | null; sessionKey?: string | null }
): Promise<FileTransferPrepareResponse> {
  const res = await fetch("/api/files/transfer/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, target, remotePath, agentId: context?.agentId, sessionKey: context?.sessionKey })
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function createToolRequest(input: ToolRequestCreateInput): Promise<ToolRequestCreateResponse> {
  const res = await fetch("/api/tools/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function ingestGatewayToolEvent(input: ToolGatewayEventInput): Promise<ToolRequestCreateResponse> {
  const res = await fetch("/api/tools/events/gateway", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchToolRequests(input: { sessionKey?: string | null; agentId?: string | null; status?: string; limit?: number } = {}): Promise<ToolRequestListResponse> {
  const params = new URLSearchParams();
  if (input.sessionKey) params.set("sessionKey", input.sessionKey);
  if (input.agentId) params.set("agentId", input.agentId);
  if (input.status) params.set("status", input.status);
  if (input.limit) params.set("limit", String(input.limit));
  const query = params.toString();
  const res = await fetch(`/api/tools/requests${query ? `?${query}` : ""}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function extractToolRequests(input: { text: string; sessionKey: string; agentId?: string | null }): Promise<ToolRequestExtractResponse> {
  const res = await fetch("/api/tools/requests/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function approveToolRequest(requestId: string): Promise<ToolRequestDecisionResponse> {
  const res = await fetch(`/api/tools/requests/${encodeURIComponent(requestId)}/approve`, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchToolRequestResult(requestId: string): Promise<ToolExecutionResultResponse> {
  const res = await fetch(`/api/tools/requests/${encodeURIComponent(requestId)}/result`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function retryToolResultForward(requestId: string): Promise<ToolExecutionResultResponse> {
  const res = await fetch(`/api/tools/requests/${encodeURIComponent(requestId)}/forward`, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function rejectToolRequest(requestId: string): Promise<{ request: ToolRequestRecord }> {
  const res = await fetch(`/api/tools/requests/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchSettings(): Promise<PublicSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function saveSettings(settings: SettingsUpdate): Promise<PublicSettings> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function testNetwork(): Promise<NetworkTestResponse> {
  const res = await fetch("/api/network/test", { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export function downloadUrl(remotePath: string): string {
  return `/api/files/download?remotePath=${encodeURIComponent(remotePath)}`;
}
