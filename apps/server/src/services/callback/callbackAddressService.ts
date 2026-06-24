import os from "node:os";
import net from "node:net";
import type { RuntimeSettings } from "../../config/settingsStore.js";

export type CallbackIpKind = "lan-private" | "tailscale" | "public" | "loopback" | "link-local" | "virtual" | "unknown";

export interface CallbackIpCandidate {
  host: string;
  interfaceName: string;
  family: "IPv4";
  kind: CallbackIpKind;
  recommended: boolean;
  hidden: boolean;
  reason: string;
  baseUrl: string;
}

export interface CallbackIpSuggestion {
  recommendedBaseUrl: string;
  candidates: CallbackIpCandidate[];
}

function isPrivateLan(ip: string): boolean {
  const [a, b] = ip.split(".").map((part) => Number(part));
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isTailscale(ip: string): boolean {
  const [a, b] = ip.split(".").map((part) => Number(part));
  return a === 100 && b >= 64 && b <= 127;
}

function samePrefixScore(candidate: string, remote: string): number {
  const c = candidate.split(".");
  const r = remote.split(".");
  if (c.length !== 4 || r.length !== 4) return 0;
  if (c[0] === r[0] && c[1] === r[1] && c[2] === r[2]) return 60;
  if (c[0] === r[0] && c[1] === r[1]) return 40;
  if (c[0] === r[0]) return 20;
  return 0;
}

function interfaceLooksVirtual(name: string): boolean {
  return /docker|bridge|veth|vmnet|utun|llw|awdl|virtual|vbox|br-/i.test(name);
}

function classifyIp(ip: string, interfaceName: string): CallbackIpKind {
  if (ip.startsWith("127.")) return "loopback";
  if (ip.startsWith("169.254.")) return "link-local";
  if (interfaceLooksVirtual(interfaceName)) return "virtual";
  if (isTailscale(ip)) return "tailscale";
  if (isPrivateLan(ip)) return "lan-private";
  if (net.isIP(ip) === 4) return "public";
  return "unknown";
}

function candidateScore(candidate: CallbackIpCandidate, remoteHost: string): number {
  const remoteIp = net.isIP(remoteHost) === 4 ? remoteHost : "";
  const kindScore: Record<CallbackIpKind, number> = {
    "lan-private": 100,
    tailscale: 80,
    public: 50,
    unknown: 20,
    virtual: -20,
    "link-local": -40,
    loopback: -80
  };
  return kindScore[candidate.kind] + (remoteIp ? samePrefixScore(candidate.host, remoteIp) : 0);
}

export const callbackAddressService = {
  listCandidates(config: Pick<RuntimeSettings, "gatewayDirectHost" | "remoteHost"> & { serverPort: number }): CallbackIpSuggestion {
    const remoteHost = config.gatewayDirectHost || config.remoteHost;
    const rows: CallbackIpCandidate[] = [];
    const nets = os.networkInterfaces();
    for (const [interfaceName, entries] of Object.entries(nets)) {
      for (const entry of entries ?? []) {
        if (entry.family !== "IPv4") continue;
        const kind = classifyIp(entry.address, interfaceName);
        // 一台 PC 可能同时存在 Wi-Fi、有线、VPN、Tailscale、Docker、虚拟机网卡。
        // 不能直接取系统返回的第一个地址，否则很容易把 Main Agent 访问不到的地址写进回连配置。
        const hidden = kind === "loopback" || kind === "link-local" || kind === "virtual";
        rows.push({
          host: entry.address,
          interfaceName,
          family: "IPv4",
          kind,
          recommended: false,
          hidden,
          reason: reasonFor(kind, entry.address, remoteHost),
          baseUrl: `http://${entry.address}:${config.serverPort}`
        });
      }
    }
    rows.sort((a, b) => candidateScore(b, remoteHost) - candidateScore(a, remoteHost));
    const recommended = rows.find((item) => !item.hidden) ?? rows[0];
    if (recommended) recommended.recommended = true;
    return {
      recommendedBaseUrl: recommended?.baseUrl ?? "",
      candidates: rows
    };
  },

  validatePublicBaseUrl(value: string): { ok: boolean; message: string } {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, message: "publicBaseUrl is empty; chat-terminal fallback will be used." };
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, message: "publicBaseUrl must be a valid http(s) URL." };
    }
    if (!/^https?:$/.test(parsed.protocol)) return { ok: false, message: "publicBaseUrl must use http or https." };
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "0.0.0.0" || hostname === "::" || hostname === "::0") return { ok: false, message: "Bind addresses are not Main Agent reachable callback hosts." };
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.startsWith("127.")) {
      return { ok: false, message: "Loopback publicBaseUrl is only valid for local tests; Main Agent cannot use the Detach Agent PC loopback." };
    }
    if (hostname.startsWith("169.254.") || /^fe80:/i.test(hostname)) {
      return { ok: false, message: "Link-local publicBaseUrl is not stable across machines; choose a LAN, Tailscale, or reachable public address." };
    }
    // 公网 IP 允许高级用户选择，例如端口映射或专线场景；UI 必须提示暴露风险，避免误把本机服务开放到不受控网络。
    return { ok: true, message: "publicBaseUrl is syntactically valid." };
  },

  hostFromBaseUrl(value: string): string {
    try {
      return new URL(value.trim()).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return "";
    }
  }
};

function reasonFor(kind: CallbackIpKind, ip: string, remoteHost: string): string {
  if (kind === "lan-private") {
    const score = net.isIP(remoteHost) === 4 ? samePrefixScore(ip, remoteHost) : 0;
    if (score >= 60) return "内网地址，和 Main Agent 位于同一 /24 网段";
    if (score >= 40) return "内网地址，和 Main Agent 位于同一 /16 网段";
    return "内网地址";
  }
  if (kind === "tailscale") return "Tailscale 地址";
  if (kind === "public") return "公网地址，可选但需要确认防火墙和暴露风险";
  if (kind === "virtual") return "虚拟/容器网卡，通常不适合作为 Main Agent 回连地址";
  if (kind === "link-local") return "链路本地地址，通常不可跨主机访问";
  if (kind === "loopback") return "loopback 地址，Main Agent 不能用它访问 Detach Agent PC";
  return "未知地址类型";
}
