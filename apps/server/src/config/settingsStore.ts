import fs from "node:fs/promises";
import path from "node:path";
import { appConfig, type AppConfig } from "./appConfig.js";

export interface RuntimeSettings {
  remoteHost: string;
  remoteSshPort: number;
  remoteUser: string;
  remoteIdentityPath: string;
  gatewayTransport: "ssh" | "direct";
  gatewayDirectHost: string;
  gatewayRemotePort: number;
  gatewayLocalPort: number;
  authMode: "token" | "password" | "none";
  authToken: string;
  authPassword: string;
  remoteWorkspaceRoot: string;
}

type PersistedSettings = Partial<RuntimeSettings>;

const settingsPath = path.join(appConfig.storageDir, "cache", "settings.json");

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim();
}

function sanitizePort(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return undefined;
  return parsed;
}

function sanitizeAuthMode(value: unknown): RuntimeSettings["authMode"] | undefined {
  return value === "token" || value === "password" || value === "none" ? value : undefined;
}

function sanitizeGatewayTransport(value: unknown): RuntimeSettings["gatewayTransport"] | undefined {
  return value === "ssh" || value === "direct" ? value : undefined;
}

export class SettingsStore {
  private loaded = false;
  private persisted: PersistedSettings = {};

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedSettings;
      this.persisted = this.sanitize(parsed);
    } catch {
      this.persisted = {};
    }
  }

  async get(): Promise<RuntimeSettings> {
    await this.load();
    return {
      remoteHost: this.persisted.remoteHost ?? appConfig.remoteHost,
      remoteSshPort: this.persisted.remoteSshPort ?? appConfig.remoteSshPort,
      remoteUser: this.persisted.remoteUser ?? appConfig.remoteUser,
      remoteIdentityPath: this.persisted.remoteIdentityPath ?? appConfig.remoteIdentityPath,
      gatewayTransport: this.persisted.gatewayTransport ?? appConfig.gatewayTransport,
      gatewayDirectHost: this.persisted.gatewayDirectHost ?? appConfig.gatewayDirectHost,
      gatewayRemotePort: this.persisted.gatewayRemotePort ?? appConfig.gatewayRemotePort,
      gatewayLocalPort: this.persisted.gatewayLocalPort ?? appConfig.gatewayLocalPort,
      authMode: this.persisted.authMode ?? appConfig.authMode,
      authToken: this.persisted.authToken ?? appConfig.authToken,
      authPassword: this.persisted.authPassword ?? appConfig.authPassword,
      remoteWorkspaceRoot: this.persisted.remoteWorkspaceRoot ?? appConfig.remoteWorkspaceRoot
    };
  }

  async publicSettings(): Promise<Omit<RuntimeSettings, "authToken" | "authPassword"> & {
    hasAuthToken: boolean;
    hasAuthPassword: boolean;
  }> {
    const settings = await this.get();
    return {
      remoteHost: settings.remoteHost,
      remoteSshPort: settings.remoteSshPort,
      remoteUser: settings.remoteUser,
      remoteIdentityPath: settings.remoteIdentityPath,
      gatewayTransport: settings.gatewayTransport,
      gatewayDirectHost: settings.gatewayDirectHost,
      gatewayRemotePort: settings.gatewayRemotePort,
      gatewayLocalPort: settings.gatewayLocalPort,
      authMode: settings.authMode,
      remoteWorkspaceRoot: settings.remoteWorkspaceRoot,
      hasAuthToken: Boolean(settings.authToken),
      hasAuthPassword: Boolean(settings.authPassword)
    };
  }

  async update(input: Record<string, unknown>): Promise<void> {
    await this.load();
    const next = this.sanitize(input);
    this.persisted = { ...this.persisted, ...next };
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(this.persisted, null, 2)}\n`, { mode: 0o600 });
    try {
      await fs.chmod(settingsPath, 0o600);
    } catch {
      // best effort
    }
  }

  private sanitize(input: Record<string, unknown>): PersistedSettings {
    const output: PersistedSettings = {};
    const remoteHost = sanitizeString(input.remoteHost);
    if (remoteHost !== undefined) output.remoteHost = remoteHost;
    const remoteUser = sanitizeString(input.remoteUser);
    if (remoteUser !== undefined) output.remoteUser = remoteUser;
    const remoteIdentityPath = sanitizeString(input.remoteIdentityPath);
    if (remoteIdentityPath !== undefined) output.remoteIdentityPath = remoteIdentityPath;
    const gatewayDirectHost = sanitizeString(input.gatewayDirectHost);
    if (gatewayDirectHost !== undefined) output.gatewayDirectHost = gatewayDirectHost;
    const remoteWorkspaceRoot = sanitizeString(input.remoteWorkspaceRoot);
    if (remoteWorkspaceRoot !== undefined) output.remoteWorkspaceRoot = remoteWorkspaceRoot;
    const authToken = sanitizeString(input.authToken);
    if (authToken !== undefined) output.authToken = authToken;
    const authPassword = sanitizeString(input.authPassword);
    if (authPassword !== undefined) output.authPassword = authPassword;
    if (input.clearAuthToken === true) output.authToken = "";
    if (input.clearAuthPassword === true) output.authPassword = "";
    const remoteSshPort = sanitizePort(input.remoteSshPort);
    if (remoteSshPort !== undefined) output.remoteSshPort = remoteSshPort;
    const gatewayRemotePort = sanitizePort(input.gatewayRemotePort);
    if (gatewayRemotePort !== undefined) output.gatewayRemotePort = gatewayRemotePort;
    const gatewayLocalPort = sanitizePort(input.gatewayLocalPort);
    if (gatewayLocalPort !== undefined) output.gatewayLocalPort = gatewayLocalPort;
    const authMode = sanitizeAuthMode(input.authMode);
    if (authMode !== undefined) output.authMode = authMode;
    const gatewayTransport = sanitizeGatewayTransport(input.gatewayTransport);
    if (gatewayTransport !== undefined) output.gatewayTransport = gatewayTransport;
    return output;
  }
}

export const settingsStore = new SettingsStore();

export async function runtimeConfig(): Promise<AppConfig & RuntimeSettings> {
  return { ...appConfig, ...(await settingsStore.get()) };
}
