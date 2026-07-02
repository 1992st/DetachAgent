import path from "node:path";
import { nanoid } from "nanoid";
import type {
  LibraryConfigResponse,
  LibraryDirectoryResponse,
  LibraryEntry,
  LibraryPathResolution,
  LibraryServerConfig,
  LibraryServerSaveInput,
  LibraryUrlCheckResponse
} from "@detaches/shared";
import { settingsStore } from "../../config/settingsStore.js";

const DEFAULT_LIBRARY_PORT = 8000;

export const libraryService = {
  async config(): Promise<LibraryConfigResponse> {
    const settings = await settingsStore.publicSettings();
    return {
      servers: settings.libraryServers ?? [],
      activeServerId: settings.activeLibraryServerId,
      suggestedHost: suggestedLibraryHost(settings),
      suggestedAgentRootPath: settings.remoteWorkspaceRoot || ""
    };
  },

  async saveServer(input: LibraryServerSaveInput): Promise<LibraryConfigResponse> {
    const settings = await settingsStore.publicSettings();
    const host = sanitizeLibraryHost(input.host);
    const port = sanitizeLibraryPort(input.port);
    const agentRootPath = normalizeAbsolutePath(input.agentRootPath);
    if (!host) throw new Error("Host must be an IP address or hostname, without protocol, path, or port.");
    if (!port) throw new Error("Port must be between 1 and 65535.");
    if (!agentRootPath) throw new Error("Agent root path must be an absolute POSIX path.");
    const key = `${host}:${port}`;
    const existing = (settings.libraryServers ?? []).find((server) => `${server.host}:${server.port}` === key);
    const server: LibraryServerConfig = {
      ...(existing ?? {}),
      id: existing?.id || input.id || nanoid(),
      name: (input.name || existing?.name || key).trim() || key,
      host,
      port,
      agentRootPath
    };
    const servers = [
      ...(settings.libraryServers ?? []).filter((candidate) => `${candidate.host}:${candidate.port}` !== key),
      server
    ];
    await settingsStore.updateProfile(settings.activeProfileId, {
      libraryServers: servers,
      activeLibraryServerId: server.id
    });
    return this.config();
  },

  async activateServer(id: string): Promise<LibraryConfigResponse> {
    const settings = await settingsStore.publicSettings();
    const server = requireServer(settings.libraryServers ?? [], id);
    await settingsStore.updateProfile(settings.activeProfileId, { activeLibraryServerId: server.id });
    return this.config();
  },

  async testServer(id: string): Promise<LibraryConfigResponse> {
    const settings = await settingsStore.publicSettings();
    const servers = settings.libraryServers ?? [];
    const server = requireServer(servers, id);
    const checkedAt = new Date().toISOString();
    let status: "ok" | "error" = "ok";
    let error = "";
    try {
      const response = await fetchWithTimeout(baseUrl(server), { method: "GET" }, 5000);
      if (response.status >= 500) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (testError) {
      status = "error";
      error = describeLibraryFetchError(testError, server);
    }
    await updateServer(settings.activeProfileId, servers, server.id, {
      lastStatus: status,
      lastTestedAt: checkedAt,
      lastError: error
    });
    if (status === "error") {
      const refreshed = await this.config();
      const thrown = new Error(error);
      (thrown as Error & { config?: LibraryConfigResponse }).config = refreshed;
      throw thrown;
    }
    return this.config();
  },

  async listDirectory(id: string, relativePath: string): Promise<LibraryDirectoryResponse> {
    const settings = await settingsStore.publicSettings();
    const server = requireServer(settings.libraryServers ?? [], id);
    const safeRelativePath = sanitizeRelativePath(relativePath);
    const url = urlForRelativePath(server, safeRelativePath);
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" }
    }, 8000);
    if (!response.ok) throw new Error(`Directory request failed: HTTP ${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain/i.test(contentType)) {
      throw new Error("HTTP service did not return a directory HTML page.");
    }
    const html = await response.text();
    return {
      serverId: server.id,
      relativePath: safeRelativePath,
      entries: parsePythonHttpDirectory(html, server, safeRelativePath)
    };
  },

  async resolvePath(id: string, absolutePath: string): Promise<LibraryPathResolution> {
    const settings = await settingsStore.publicSettings();
    const server = requireServer(settings.libraryServers ?? [], id);
    return resolveLibraryPath({ absolutePath, server });
  },

  async checkUrl(id: string, relativePath: string): Promise<LibraryUrlCheckResponse> {
    const settings = await settingsStore.publicSettings();
    const server = requireServer(settings.libraryServers ?? [], id);
    const safeRelativePath = sanitizeRelativePath(relativePath);
    const url = urlForRelativePath(server, safeRelativePath);
    const response = await fetchWithTimeout(url, { method: "HEAD" }, 5000).catch(async (error) => {
      const fallback = await fetchWithTimeout(url, { method: "GET", headers: { Range: "bytes=0-0" } }, 5000).catch(() => {
        throw error;
      });
      return fallback;
    });
    return { ok: response.ok, status: response.status, statusText: response.statusText, url };
  }
};

export function resolveLibraryPath(input: { absolutePath: string; server: LibraryServerConfig }): LibraryPathResolution {
  const absolutePath = normalizeAbsolutePath(input.absolutePath);
  const agentRootPath = normalizeAbsolutePath(input.server.agentRootPath);
  if (!absolutePath) {
    return { status: "invalid", absolutePath: input.absolutePath, message: "Agent returned path is not an absolute POSIX path." };
  }
  if (!agentRootPath) {
    return { status: "invalid", absolutePath, message: "Current library server has no valid Agent root path." };
  }
  const relative = path.posix.relative(agentRootPath, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.posix.isAbsolute(relative)) {
    return {
      status: "unmapped",
      absolutePath,
      message: `Path is outside current Agent root path: ${agentRootPath}`
    };
  }
  return {
    status: "ok",
    absolutePath,
    relativePath: relative,
    displayPath: relative,
    url: urlForRelativePath(input.server, relative)
  };
}

function suggestedLibraryHost(settings: { gatewayDirectHost?: string; remoteHost?: string }): string {
  return (settings.gatewayDirectHost || settings.remoteHost || "").trim() || "127.0.0.1";
}

function sanitizeLibraryHost(value: string): string | null {
  const host = value.trim();
  if (!host || host.length > 253) return null;
  if (/^https?:\/\//i.test(host) || host.includes("/") || host.includes("?") || host.includes("#")) return null;
  if (host.includes("@") || host.includes(":")) return null;
  return host;
}

function sanitizeLibraryPort(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? DEFAULT_LIBRARY_PORT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function normalizeAbsolutePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !path.posix.isAbsolute(trimmed) || trimmed.includes("\0")) return null;
  return path.posix.normalize(trimmed).replace(/\/+$/, "") || "/";
}

function sanitizeRelativePath(value: string): string {
  const trimmed = safeDecodeURIComponent(String(value || "").trim()).replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") return "";
  if (trimmed.includes("\0") || /^https?:\/\//i.test(trimmed)) throw new Error("Invalid library path.");
  const normalized = path.posix.normalize(trimmed).replace(/^\/+/, "");
  if (normalized === "." || normalized === "") return "";
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) throw new Error("Library path is outside the service root.");
  return normalized;
}

function baseUrl(server: LibraryServerConfig): string {
  return `http://${server.host}:${server.port}/`;
}

function urlForRelativePath(server: LibraryServerConfig, relativePath: string): string {
  const encoded = sanitizeRelativePath(relativePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(encoded, baseUrl(server)).toString();
}

function requireServer(servers: LibraryServerConfig[], id: string): LibraryServerConfig {
  const server = servers.find((candidate) => candidate.id === id);
  if (!server) throw new Error(`Library server not found: ${id}`);
  return server;
}

async function updateServer(profileId: string, servers: LibraryServerConfig[], id: string, patch: Partial<LibraryServerConfig>): Promise<void> {
  const updated = servers.map((server) => server.id === id ? { ...server, ...patch } : server);
  await settingsStore.updateProfile(profileId, { libraryServers: updated });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function describeLibraryFetchError(error: unknown, server: LibraryServerConfig): string {
  if (error instanceof Error && error.name === "AbortError") {
    return `Connection timed out after 5000ms: ${server.host}:${server.port}.`;
  }
  const anyError = error as Error & { cause?: { code?: string; address?: string; port?: number; message?: string }; code?: string };
  const code = anyError.cause?.code || anyError.code;
  const address = anyError.cause?.address || server.host;
  const port = anyError.cause?.port || server.port;
  if (code === "ECONNREFUSED") return `Connection refused: ${address}:${port}. 请确认 http-server 已启动并监听该端口。`;
  if (code === "ETIMEDOUT") return `Connection timed out: ${address}:${port}. 请确认服务器 IP、端口和防火墙规则。`;
  if (code === "ENOTFOUND") return `Host not found: ${server.host}. 请确认 IP 或域名。`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `Host unreachable: ${address}:${port}. 请确认当前机器能访问服务器网络。`;
  return anyError.cause?.message || anyError.message || String(error);
}

function parsePythonHttpDirectory(html: string, server: LibraryServerConfig, currentRelativePath: string): LibraryEntry[] {
  const entries: LibraryEntry[] = [];
  const anchorPattern = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html))) {
    const rawHref = decodeHtml(match[2] || "").trim();
    const rawName = stripTags(decodeHtml(match[3] || "")).trim();
    if (!rawHref || rawHref.startsWith("?") || rawHref.startsWith("#")) continue;
    if (rawHref === "../" || rawName === "Parent Directory") continue;
    if (/^https?:\/\//i.test(rawHref)) continue;
    const type: "file" | "directory" = rawHref.endsWith("/") || rawName.endsWith("/") ? "directory" : "file";
    const hrefPath = rawHref.split(/[?#]/)[0] || "";
    const decodedPath = safeDecodeURIComponent(hrefPath).replace(/\/+$/, "");
    const name = (rawName || decodedPath.split("/").pop() || hrefPath).replace(/\/+$/, "");
    if (!name) continue;
    const relativePath = sanitizeRelativePath(path.posix.join(currentRelativePath, decodedPath.split("/").pop() || name));
    const absolutePath = path.posix.join(server.agentRootPath, relativePath);
    entries.push({
      name,
      type,
      absolutePath,
      relativePath,
      displayPath: relativePath,
      url: type === "file" ? urlForRelativePath(server, relativePath) : undefined
    });
  }
  return entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}
