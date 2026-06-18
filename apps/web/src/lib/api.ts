import type {
  AgentsListResponse,
  AppHealth,
  ClientIdentity,
  DetachesContextExportCreateResponse,
  DiagnosticsResponse,
  FileTransferPrepareResponse,
  FileUploadResponse,
  LocalTerminalAppsResponse,
  LocalTerminalOpenResponse,
  MainAgentFileTransferPasswordResponse,
  MainAgentFileTransferSnapshot,
  NetworkTestResponse,
  OpenClawAdapterInstallPlan,
  OpenClawAdapterReadiness,
  PublicSettings,
  RemoteProfileUpdate,
  SettingsUpdate,
  ToolGatewayEventInput,
  ToolRequestApproveInput,
  ToolRequestCreateInput,
  ToolRequestCreateResponse,
  ToolRequestDecisionResponse,
  ToolExecutionResultResponse,
  ToolRequestExtractResponse,
  ToolRequestListResponse,
  ToolRequestRejectInput,
  ToolRequestRecord,
  ToolTarget
} from "@detaches/shared";

const DEFAULT_DESKTOP_API_ORIGIN = "http://127.0.0.1:38888";

function apiOrigin(): string {
  if (window.location.protocol === "file:") {
    return window.detachesDesktop?.apiOrigin
      || new URLSearchParams(window.location.search).get("detachesApiOrigin")
      || import.meta.env.VITE_DETACHES_API_ORIGIN
      || DEFAULT_DESKTOP_API_ORIGIN;
  }
  return "";
}

export function apiUrl(path: string): string {
  return `${apiOrigin()}${path}`;
}

export function wsUrl(path: string): string {
  if (window.location.protocol === "file:") {
    const origin = apiOrigin();
    const url = new URL(path, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}${path}`;
}

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
  const res = await fetch(apiUrl("/api/health"));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchAgents(): Promise<AgentsListResponse> {
  const res = await fetch(apiUrl("/api/agents"));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchClientIdentity(): Promise<ClientIdentity> {
  const res = await fetch(apiUrl("/api/client"));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function createDetachesContextExport(input: { sessionKey: string; sessionMode?: "main" | "device" }): Promise<DetachesContextExportCreateResponse> {
  const res = await fetch(apiUrl("/api/context/exports"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchDiagnostics(): Promise<DiagnosticsResponse> {
  const res = await fetch(apiUrl("/api/diagnostics"));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function uploadFile(file: File, sessionKey: string): Promise<FileUploadResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("sessionKey", sessionKey);
  const res = await fetch(apiUrl("/api/files/upload"), { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function prepareFileTransfer(
  fileId: string,
  target: ToolTarget,
  remotePath: string,
  context?: { agentId?: string | null; sessionKey?: string | null }
): Promise<FileTransferPrepareResponse> {
  const res = await fetch(apiUrl("/api/files/transfer/prepare"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, target, remotePath, agentId: context?.agentId, sessionKey: context?.sessionKey })
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function createToolRequest(input: ToolRequestCreateInput): Promise<ToolRequestCreateResponse> {
  const res = await fetch(apiUrl("/api/tools/requests"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function ingestGatewayToolEvent(input: ToolGatewayEventInput): Promise<ToolRequestCreateResponse> {
  const res = await fetch(apiUrl("/api/tools/events/gateway"), {
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
  const res = await fetch(apiUrl(`/api/tools/requests${query ? `?${query}` : ""}`));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function extractToolRequests(input: { text: string; sessionKey: string; agentId?: string | null; sourceMessageId?: string; sourceRunId?: string | null }): Promise<ToolRequestExtractResponse> {
  const res = await fetch(apiUrl("/api/tools/requests/extract"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function approveToolRequest(requestId: string, input: ToolRequestApproveInput = {}): Promise<ToolRequestDecisionResponse> {
  const res = await fetch(apiUrl(`/api/tools/requests/${encodeURIComponent(requestId)}/approve`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchToolRequestResult(requestId: string): Promise<ToolExecutionResultResponse> {
  const res = await fetch(apiUrl(`/api/tools/requests/${encodeURIComponent(requestId)}/result`));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function retryToolResultForward(requestId: string): Promise<ToolExecutionResultResponse> {
  const res = await fetch(apiUrl(`/api/tools/requests/${encodeURIComponent(requestId)}/forward`), { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function submitMainAgentTransferPassword(transferId: string, password: string): Promise<MainAgentFileTransferPasswordResponse> {
  const res = await fetch(apiUrl(`/api/file-transfers/${encodeURIComponent(transferId)}/password`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchMainAgentTransfer(transferId: string): Promise<{ transfer: MainAgentFileTransferSnapshot }> {
  const res = await fetch(apiUrl(`/api/file-transfers/${encodeURIComponent(transferId)}`));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function rejectToolRequest(requestId: string, input: ToolRequestRejectInput = {}): Promise<{ request: ToolRequestRecord }> {
  const res = await fetch(apiUrl(`/api/tools/requests/${encodeURIComponent(requestId)}/reject`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchSettings(): Promise<PublicSettings> {
  const res = await fetch(apiUrl("/api/settings"));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function saveSettings(settings: SettingsUpdate): Promise<PublicSettings> {
  const res = await fetch(apiUrl("/api/settings"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function createRemoteProfile(profile: RemoteProfileUpdate & { copyFromProfileId?: string }): Promise<PublicSettings> {
  const res = await fetch(apiUrl("/api/settings/profiles"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function saveRemoteProfile(id: string, profile: RemoteProfileUpdate): Promise<PublicSettings> {
  const res = await fetch(apiUrl(`/api/settings/profiles/${encodeURIComponent(id)}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function activateRemoteProfile(id: string): Promise<PublicSettings> {
  const res = await fetch(apiUrl(`/api/settings/profiles/${encodeURIComponent(id)}/activate`), { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function deleteRemoteProfile(id: string): Promise<PublicSettings> {
  const res = await fetch(apiUrl(`/api/settings/profiles/${encodeURIComponent(id)}`), { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function bootstrapRemoteProfileSsh(id: string, input: { password: string; identityPath?: string }): Promise<{ ok: boolean; identityPath: string; publicKeyPath: string; message: string; settings: PublicSettings }> {
  const res = await fetch(apiUrl(`/api/settings/profiles/${encodeURIComponent(id)}/bootstrap-ssh`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function testNetwork(): Promise<NetworkTestResponse> {
  const res = await fetch(apiUrl("/api/network/test"), { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchLocalTerminalApps(): Promise<LocalTerminalAppsResponse> {
  const res = await fetch(apiUrl("/api/terminal/apps"));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function openLocalTerminalApp(appId: string): Promise<LocalTerminalOpenResponse> {
  const res = await fetch(apiUrl(`/api/terminal/apps/${encodeURIComponent(appId)}/open`), { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchOpenClawAdapterReadiness(input: { target?: "local-distribution" | "remote-agent-host"; installDir?: string; workspaceDir?: string; probe?: "local-fs" | "remote-ssh" } = {}): Promise<OpenClawAdapterReadiness> {
  const params = new URLSearchParams();
  if (input.target) params.set("target", input.target);
  if (input.installDir) params.set("installDir", input.installDir);
  if (input.workspaceDir) params.set("workspaceDir", input.workspaceDir);
  if (input.probe) params.set("probe", input.probe);
  const query = params.toString();
  const res = await fetch(apiUrl(`/api/adapters/openclaw-detaches/readiness${query ? `?${query}` : ""}`));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function fetchOpenClawAdapterInstallPlan(input: { baseUrl?: string; installDir?: string; workspaceDir?: string } = {}): Promise<OpenClawAdapterInstallPlan> {
  const params = new URLSearchParams();
  if (input.baseUrl) params.set("baseUrl", input.baseUrl);
  if (input.installDir) params.set("installDir", input.installDir);
  if (input.workspaceDir) params.set("workspaceDir", input.workspaceDir);
  const query = params.toString();
  const res = await fetch(apiUrl(`/api/adapters/openclaw-detaches/install-plan${query ? `?${query}` : ""}`));
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export function downloadUrl(remotePath: string): string {
  return apiUrl(`/api/files/download?remotePath=${encodeURIComponent(remotePath)}`);
}
