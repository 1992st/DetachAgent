import type { ToolRequestRecord, ToolTarget } from "@detaches/shared";

export const RECENT_REQUEST_POPUP_WINDOW_MS = 5 * 60 * 1000;

export function isQueueToolRequestVisible(request: ToolRequestRecord): boolean {
  if (isPlaceholderMainAgentSaveFile(request)) return false;
  if (request.status === "pending" || request.status === "running" || request.status === "blocked") return true;
  if (request.status !== "failed") return false;
  if (
    request.kind === "file-transfer"
    && /staged file not found|already transferred/i.test(request.error || "")
  ) {
    return false;
  }
  return true;
}

export function toolRequestSupported(request: Pick<ToolRequestRecord, "kind" | "target">): boolean {
  if (request.kind === "adapter-install") return request.target === "remote-agent-host";
  if (request.kind === "skill-install" || request.kind === "skill-verify") return request.target === "local-user-machine";
  if (request.kind === "main-agent-save-file") return request.target === "main-agent-machine";
  if (request.kind === "file-transfer") return request.target === "local-user-machine" || request.target === "remote-agent-host";
  if (request.kind === "terminal") return request.target === "local-user-machine";
  return false;
}

export function shouldSurfaceApproval(
  request: ToolRequestRecord,
  options: { requireRecent?: boolean; nowMs?: number } = {}
): boolean {
  if (!isQueueToolRequestVisible(request)) return false;
  if (request.status !== "pending") return false;
  if (!toolRequestSupported(request)) return false;
  if (!options.requireRecent) return true;
  const createdAtMs = Date.parse(request.createdAt);
  const nowMs = options.nowMs ?? Date.now();
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= RECENT_REQUEST_POPUP_WINDOW_MS;
}

export const targetLabels: Record<ToolTarget, string> = {
  "local-user-machine": "用户本机",
  "remote-agent-host": "远端 Agent 机器",
  "gateway-managed": "Gateway 托管",
  "main-agent-machine": "Main Agent 机器"
};

function isPlaceholderMainAgentSaveFile(request: ToolRequestRecord): boolean {
  if (request.kind !== "main-agent-save-file") return false;
  const destination = request.payload.destination && typeof request.payload.destination === "object" && !Array.isArray(request.payload.destination)
    ? request.payload.destination as Record<string, unknown>
    : {};
  const haystack = [
    request.payload.fileId,
    request.payload.sourceLocalPath,
    destination.path
  ].map((value) => typeof value === "string" ? value : JSON.stringify(value ?? "")).join("\n").toLowerCase();
  return /上面的|<file-id>|<absolute path|final-filename\.ext|原始文件名|请替换|替换为|your-|example\.|100\.x\.x\.x|192\.168\.x\.x|main agent.*ip|main agent.*host|detaches_agent.*host|detaches-agent.*host|ssh user/.test(haystack);
}
