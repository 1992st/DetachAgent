import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { PublicSettings, RemoteProfile } from "@detaches/shared";
import { appConfig, repoRoot, type AppConfig } from "./appConfig.js";

export interface RuntimeSettings {
  remoteHost: string;
  remoteSshPort: number;
  remoteUser: string;
  remoteIdentityPath: string;
  mainAgentServiceEnabled: boolean;
  localSshBridgeEnabled: boolean;
  reverseBridgeRemoteHost: string;
  reverseBridgeRemotePort: number;
  gatewayTransport: "ssh" | "direct";
  gatewayDirectHost: string;
  gatewayDirectUrl: string;
  gatewayRemotePort: number;
  gatewayLocalPort: number;
  authMode: "token" | "password" | "none";
  authToken: string;
  authPassword: string;
  remoteWorkspaceRoot: string;
  publicBaseUrl: string;
  gatewayTerminalLocalIp?: string;
  gatewayTerminalLocalIpSource?: "auto" | "manual";
  gatewayTerminalLastStatus?: "ok" | "error";
  gatewayTerminalLastTestedAt?: string;
  gatewayTerminalLastError?: string;
}

type PersistedProfile = RuntimeSettings & {
  id: string;
  name: string;
  lastTestedAt?: string;
  lastStatus?: "ok" | "error";
};

type PersistedSettings = Partial<RuntimeSettings> & {
  activeProfileId?: string;
  profiles?: Partial<PersistedProfile>[];
};

const settingsPath = path.join(appConfig.storageDir, "cache", "settings.json");
const legacySettingsPath = path.join(repoRoot, "storage", "cache", "settings.json");

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

function sanitizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function defaultProfile(): PersistedProfile {
  return {
    id: "default",
    name: "Default",
    remoteHost: appConfig.remoteHost,
    remoteSshPort: appConfig.remoteSshPort,
    remoteUser: appConfig.remoteUser,
    remoteIdentityPath: appConfig.remoteIdentityPath,
    mainAgentServiceEnabled: appConfig.mainAgentServiceEnabled,
    localSshBridgeEnabled: appConfig.localSshBridgeEnabled,
    reverseBridgeRemoteHost: appConfig.reverseBridgeRemoteHost,
    reverseBridgeRemotePort: appConfig.reverseBridgeRemotePort,
    gatewayTransport: appConfig.gatewayTransport,
    gatewayDirectHost: appConfig.gatewayDirectHost,
    gatewayDirectUrl: appConfig.gatewayDirectUrl,
    gatewayRemotePort: appConfig.gatewayRemotePort,
    gatewayLocalPort: appConfig.gatewayLocalPort,
    authMode: appConfig.authMode,
    authToken: appConfig.authToken,
    authPassword: appConfig.authPassword,
    remoteWorkspaceRoot: appConfig.remoteWorkspaceRoot,
    publicBaseUrl: appConfig.publicBaseUrl
  };
}

function publicProfile(profile: PersistedProfile): RemoteProfile {
  const { authToken: _authToken, authPassword: _authPassword, ...rest } = profile;
  return {
    ...rest,
    hasAuthToken: Boolean(profile.authToken),
    hasAuthPassword: Boolean(profile.authPassword)
  };
}

export class SettingsStore {
  private loaded = false;
  private persisted: { activeProfileId: string; profiles: PersistedProfile[] } = {
    activeProfileId: "default",
    profiles: [defaultProfile()]
  };

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedSettings;
      this.persisted = this.normalizePersisted(parsed);
    } catch {
      const migrated = await this.loadLegacySettings();
      if (migrated) {
        this.persisted = migrated;
        await this.save();
        return;
      }
      this.persisted = { activeProfileId: "default", profiles: [defaultProfile()] };
    }
  }

  async get(): Promise<RuntimeSettings> {
    await this.load();
    return this.activeProfile();
  }

  async publicSettings(): Promise<PublicSettings> {
    await this.load();
    const active = this.activeProfile();
    return {
      ...publicProfile(active),
      activeProfileId: active.id,
      profiles: this.persisted.profiles.map(publicProfile),
      serverHost: appConfig.serverHost,
      serverPort: appConfig.serverPort,
      serverListenHosts: appConfig.serverListenHosts.length ? appConfig.serverListenHosts : [appConfig.serverHost]
    };
  }

  async update(input: Record<string, unknown>): Promise<void> {
    await this.load();
    if (typeof input.activeProfileId === "string" && this.persisted.profiles.some((profile) => profile.id === input.activeProfileId)) {
      this.persisted.activeProfileId = input.activeProfileId;
    }
    const next = this.sanitizeProfileUpdate(input);
    this.persisted.profiles = this.persisted.profiles.map((profile) => {
      if (profile.id !== this.persisted.activeProfileId) return profile;
      return { ...profile, ...next };
    });
    await this.save();
  }

  async createProfile(input: Record<string, unknown>): Promise<PersistedProfile> {
    await this.load();
    const baseId = sanitizeString(input.copyFromProfileId);
    const base = baseId ? this.persisted.profiles.find((profile) => profile.id === baseId) : this.activeProfile();
    const profile: PersistedProfile = {
      ...(base ?? defaultProfile()),
      ...this.sanitizeProfileUpdate(input),
      id: nanoid(),
      name: sanitizeString(input.name) || "New remote"
    };
    this.persisted.profiles.push(profile);
    this.persisted.activeProfileId = profile.id;
    await this.save();
    return profile;
  }

  async updateProfile(id: string, input: Record<string, unknown>): Promise<PersistedProfile> {
    await this.load();
    const profile = this.requireProfile(id);
    const updated = { ...profile, ...this.sanitizeProfileUpdate(input) };
    this.persisted.profiles = this.persisted.profiles.map((item) => item.id === id ? updated : item);
    await this.save();
    return updated;
  }

  async activateProfile(id: string): Promise<void> {
    await this.load();
    this.requireProfile(id);
    this.persisted.activeProfileId = id;
    await this.save();
  }

  async deleteProfile(id: string): Promise<void> {
    await this.load();
    if (this.persisted.profiles.length <= 1) {
      throw new Error("At least one remote profile is required.");
    }
    this.requireProfile(id);
    this.persisted.profiles = this.persisted.profiles.filter((profile) => profile.id !== id);
    if (this.persisted.activeProfileId === id) {
      this.persisted.activeProfileId = this.persisted.profiles[0]?.id ?? "default";
    }
    await this.save();
  }

  async markProfileTested(id: string, status: "ok" | "error"): Promise<void> {
    await this.load();
    const profile = this.requireProfile(id);
    const updated = { ...profile, lastStatus: status, lastTestedAt: new Date().toISOString() };
    this.persisted.profiles = this.persisted.profiles.map((item) => item.id === id ? updated : item);
    await this.save();
  }

  private activeProfile(): PersistedProfile {
    return this.persisted.profiles.find((profile) => profile.id === this.persisted.activeProfileId)
      ?? this.persisted.profiles[0]
      ?? defaultProfile();
  }

  private requireProfile(id: string): PersistedProfile {
    const profile = this.persisted.profiles.find((item) => item.id === id);
    if (!profile) throw new Error(`Remote profile not found: ${id}`);
    return profile;
  }

  private normalizePersisted(input: PersistedSettings): { activeProfileId: string; profiles: PersistedProfile[] } {
    const legacy = { ...defaultProfile(), ...this.sanitizeProfileUpdate(input), id: "default", name: "Default" };
    const profiles = Array.isArray(input.profiles) && input.profiles.length
      ? input.profiles.map((profile, index) => {
        const base = index === 0 ? legacy : defaultProfile();
        return {
          ...base,
          ...this.sanitizeProfileUpdate(profile),
          id: sanitizeString(profile.id) || nanoid(),
          name: sanitizeString(profile.name) || base.name || `Remote ${index + 1}`,
          lastTestedAt: sanitizeString(profile.lastTestedAt),
          lastStatus: profile.lastStatus === "ok" || profile.lastStatus === "error" ? profile.lastStatus : undefined
        };
      })
      : [legacy];
    const activeProfileId = sanitizeString(input.activeProfileId);
    return {
      activeProfileId: activeProfileId && profiles.some((profile) => profile.id === activeProfileId) ? activeProfileId : profiles[0].id,
      profiles
    };
  }

  private async loadLegacySettings(): Promise<{ activeProfileId: string; profiles: PersistedProfile[] } | null> {
    if (process.env.DETACHES_DISABLE_LEGACY_SETTINGS_MIGRATION === "1") return null;
    if (path.resolve(settingsPath) === path.resolve(legacySettingsPath)) return null;
    try {
      const raw = await fs.readFile(legacySettingsPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedSettings;
      return this.normalizePersisted(parsed);
    } catch {
      return null;
    }
  }

  private sanitizeProfileUpdate(input: Record<string, unknown>): Partial<PersistedProfile> {
    const output: Partial<PersistedProfile> = {};
    const name = sanitizeString(input.name);
    if (name !== undefined) output.name = name || "Remote";
    const remoteHost = sanitizeString(input.remoteHost);
    if (remoteHost !== undefined) output.remoteHost = remoteHost;
    const remoteUser = sanitizeString(input.remoteUser);
    if (remoteUser !== undefined) output.remoteUser = remoteUser;
    const remoteIdentityPath = sanitizeString(input.remoteIdentityPath);
    if (remoteIdentityPath !== undefined) output.remoteIdentityPath = remoteIdentityPath;
    const mainAgentServiceEnabled = sanitizeBoolean(input.mainAgentServiceEnabled);
    if (mainAgentServiceEnabled !== undefined) output.mainAgentServiceEnabled = mainAgentServiceEnabled;
    const localSshBridgeEnabled = sanitizeBoolean(input.localSshBridgeEnabled);
    if (localSshBridgeEnabled !== undefined) output.localSshBridgeEnabled = localSshBridgeEnabled;
    const reverseBridgeRemoteHost = sanitizeString(input.reverseBridgeRemoteHost);
    if (reverseBridgeRemoteHost !== undefined) output.reverseBridgeRemoteHost = reverseBridgeRemoteHost || "127.0.0.1";
    const gatewayDirectHost = sanitizeString(input.gatewayDirectHost);
    if (gatewayDirectHost !== undefined) output.gatewayDirectHost = gatewayDirectHost;
    const gatewayDirectUrl = sanitizeString(input.gatewayDirectUrl);
    if (gatewayDirectUrl !== undefined) output.gatewayDirectUrl = gatewayDirectUrl.replace(/\/+$/, "");
    const remoteWorkspaceRoot = sanitizeString(input.remoteWorkspaceRoot);
    if (remoteWorkspaceRoot !== undefined) output.remoteWorkspaceRoot = remoteWorkspaceRoot;
    const publicBaseUrl = sanitizeString(input.publicBaseUrl);
    if (publicBaseUrl !== undefined) output.publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
    const gatewayTerminalLocalIp = sanitizeString(input.gatewayTerminalLocalIp);
    if (gatewayTerminalLocalIp !== undefined) output.gatewayTerminalLocalIp = gatewayTerminalLocalIp;
    if (input.gatewayTerminalLocalIpSource === "auto" || input.gatewayTerminalLocalIpSource === "manual") output.gatewayTerminalLocalIpSource = input.gatewayTerminalLocalIpSource;
    if (input.gatewayTerminalLastStatus === "ok" || input.gatewayTerminalLastStatus === "error") output.gatewayTerminalLastStatus = input.gatewayTerminalLastStatus;
    const gatewayTerminalLastTestedAt = sanitizeString(input.gatewayTerminalLastTestedAt);
    if (gatewayTerminalLastTestedAt !== undefined) output.gatewayTerminalLastTestedAt = gatewayTerminalLastTestedAt;
    const gatewayTerminalLastError = sanitizeString(input.gatewayTerminalLastError);
    if (gatewayTerminalLastError !== undefined) output.gatewayTerminalLastError = gatewayTerminalLastError;
    const authToken = sanitizeString(input.authToken);
    if (authToken !== undefined) output.authToken = authToken;
    const authPassword = sanitizeString(input.authPassword);
    if (authPassword !== undefined) output.authPassword = authPassword;
    if (input.clearAuthToken === true) output.authToken = "";
    if (input.clearAuthPassword === true) output.authPassword = "";
    const remoteSshPort = sanitizePort(input.remoteSshPort);
    if (remoteSshPort !== undefined) output.remoteSshPort = remoteSshPort;
    const reverseBridgeRemotePort = sanitizePort(input.reverseBridgeRemotePort);
    if (reverseBridgeRemotePort !== undefined) output.reverseBridgeRemotePort = reverseBridgeRemotePort;
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

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(this.persisted, null, 2)}\n`, { mode: 0o600 });
    try {
      await fs.chmod(settingsPath, 0o600);
    } catch {
      // best effort
    }
  }
}

export const settingsStore = new SettingsStore();

export async function runtimeConfig(): Promise<AppConfig & RuntimeSettings> {
  return { ...appConfig, ...(await settingsStore.get()) };
}
