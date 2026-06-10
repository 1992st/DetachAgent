import type {
  AgentsListResponse,
  AppHealth,
  ClientIdentity,
  DiagnosticsResponse,
  FileUploadResponse,
  NetworkTestResponse,
  PublicSettings,
  SettingsUpdate
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
