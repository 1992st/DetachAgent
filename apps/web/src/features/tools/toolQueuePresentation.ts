import type { ToolRequestRecord, ToolTarget } from "@detaches/shared";

export const RECENT_REQUEST_POPUP_WINDOW_MS = 5 * 60 * 1000;

export function isQueueToolRequestVisible(request: ToolRequestRecord): boolean {
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
  "gateway-managed": "Gateway 托管"
};
