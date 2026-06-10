import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({ path: ".env.local" });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, "../../../..");
export const DEFAULT_OPENCLAW_REMOTE_HOST = "100.74.38.97";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringEnv(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const appConfig = {
  serverHost: stringEnv("DETACHES_SERVER_HOST", "127.0.0.1"),
  serverPort: intEnv("DETACHES_SERVER_PORT", 38888),
  publicHost: stringEnv("DETACHES_PUBLIC_HOST"),
  publicBaseUrl: stringEnv("DETACHES_PUBLIC_BASE_URL"),
  remoteHost: stringEnv("OPENCLAW_REMOTE_HOST", DEFAULT_OPENCLAW_REMOTE_HOST),
  remoteSshPort: intEnv("OPENCLAW_REMOTE_SSH_PORT", 22),
  remoteUser: stringEnv("OPENCLAW_REMOTE_USER"),
  remoteIdentityPath: stringEnv("OPENCLAW_REMOTE_IDENTITY_PATH"),
  gatewayTransport: stringEnv("OPENCLAW_GATEWAY_TRANSPORT", "ssh") as "ssh" | "direct",
  gatewayDirectHost: stringEnv("OPENCLAW_GATEWAY_DIRECT_HOST", stringEnv("OPENCLAW_REMOTE_HOST", DEFAULT_OPENCLAW_REMOTE_HOST)),
  gatewayRemoteHost: stringEnv("OPENCLAW_GATEWAY_REMOTE_HOST", "127.0.0.1"),
  gatewayRemotePort: intEnv("OPENCLAW_GATEWAY_REMOTE_PORT", 18789),
  gatewayLocalPort: intEnv("OPENCLAW_GATEWAY_LOCAL_PORT", 18790),
  authMode: stringEnv("OPENCLAW_AUTH_MODE", "token") as "token" | "password" | "none",
  authToken: stringEnv("OPENCLAW_AUTH_TOKEN"),
  authPassword: stringEnv("OPENCLAW_AUTH_PASSWORD"),
  remoteWorkspaceRoot: stringEnv("OPENCLAW_REMOTE_WORKSPACE_ROOT", "~/.openclaw/workspace"),
  storageDir: path.resolve(repoRoot, stringEnv("DETACHES_STORAGE_DIR", "./storage")),
  maxUploadMb: intEnv("DETACHES_MAX_UPLOAD_MB", 100)
};

export type AppConfig = typeof appConfig;

export function publicServerBaseUrl(config: Pick<AppConfig, "publicBaseUrl" | "publicHost" | "serverHost" | "serverPort"> = appConfig): string {
  const configuredBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  if (configuredBaseUrl) return configuredBaseUrl;
  const tailscaleHost = stringEnv("TAILSCALE_IP");
  const configuredHost = config.publicHost || tailscaleHost || (config.serverHost === "0.0.0.0" ? "127.0.0.1" : config.serverHost);
  return `http://${configuredHost}:${config.serverPort}`;
}
