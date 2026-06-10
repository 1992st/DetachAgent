import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { repoRoot } from "../../config/appConfig.js";

const gzip = promisify(zlib.gzip);

const adapterRoot = path.join(repoRoot, "packages", "openclaw-detaches-adapter");
const adapterFiles = [
  { path: "package.json", mode: 0o644, mimeType: "application/json" },
  { path: "adapter.manifest.json", mode: 0o644, mimeType: "application/json" },
  { path: "AGENT.md", mode: 0o644, mimeType: "text/markdown; charset=utf-8" },
  { path: "bin/detaches-agent-adapter.mjs", mode: 0o755, mimeType: "text/javascript; charset=utf-8" }
] as const;

export interface OpenClawAdapterFile {
  path: string;
  size: number;
  sha256: string;
  mode: string;
  mimeType: string;
  downloadUrl: string;
}

export interface OpenClawAdapterInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  manifest: unknown;
  files: OpenClawAdapterFile[];
  bundle: {
    fileName: string;
    downloadUrl: string;
    sha256: string;
    size: number;
  };
  install: {
    shell: string;
    notes: string[];
  };
}

export interface OpenClawAdapterInstallPlan {
  target: "remote-agent-host";
  adapterId: string;
  version: string;
  baseUrl: string;
  installDir: string;
  bundleUrl: string;
  bundleSha256: string;
  commands: string[];
  verifyCommands: string[];
  notes: string[];
}

export type OpenClawAdapterReadinessState = "ready" | "missing" | "invalid" | "error";

export interface OpenClawAdapterReadinessCheck {
  id: string;
  state: OpenClawAdapterReadinessState;
  message: string;
  details?: unknown;
}

export interface OpenClawAdapterReadiness {
  target: "local-distribution" | "remote-agent-host";
  installDir: string;
  expectedAdapterId: string;
  expectedVersion: string;
  state: OpenClawAdapterReadinessState;
  checks: OpenClawAdapterReadinessCheck[];
  verifyCommands: string[];
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function adapterFileSpec(filePath: string): (typeof adapterFiles)[number] | undefined {
  const normalized = filePath.replace(/^\/+/, "").replace(/\\/g, "/");
  return adapterFiles.find((file) => file.path === normalized);
}

async function readAdapterFile(filePath: string): Promise<{ spec: (typeof adapterFiles)[number]; buffer: Buffer }> {
  const spec = adapterFileSpec(filePath);
  if (!spec) throw new Error("Adapter file is not distributable.");
  const absolutePath = path.join(adapterRoot, spec.path);
  const buffer = await fs.readFile(absolutePath);
  return { spec, buffer };
}

function writeString(header: Buffer, value: string, offset: number, length: number): void {
  header.fill(0, offset, offset + length);
  Buffer.from(value).copy(header, offset, 0, Math.min(Buffer.byteLength(value), length));
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeString(header, `${encoded}\0`, offset, length);
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  writeString(header, name, 0, 100);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  writeString(header, "0", 156, 1);
  writeString(header, "ustar", 257, 6);
  writeString(header, "00", 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function tarEntry(name: string, buffer: Buffer, mode: number): Buffer {
  const paddingLength = (512 - (buffer.length % 512)) % 512;
  return Buffer.concat([
    tarHeader(name, buffer.length, mode),
    buffer,
    Buffer.alloc(paddingLength, 0)
  ]);
}

async function buildBundle(): Promise<Buffer> {
  const entries = await Promise.all(adapterFiles.map(async (file) => {
    const buffer = await fs.readFile(path.join(adapterRoot, file.path));
    return tarEntry(`openclaw-detaches-adapter/${file.path}`, buffer, file.mode);
  }));
  return gzip(Buffer.concat([...entries, Buffer.alloc(1024, 0)]));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || "http://127.0.0.1:38888";
}

function normalizeInstallDir(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || "~/.openclaw/detaches_agent";
}

function expandHomeDir(value: string): string {
  if (value === "~") return process.env.HOME || value;
  if (value.startsWith("~/")) return path.join(process.env.HOME || "~", value.slice(2));
  return value;
}

function aggregateReadiness(checks: OpenClawAdapterReadinessCheck[]): OpenClawAdapterReadinessState {
  if (checks.some((check) => check.state === "error")) return "error";
  if (checks.some((check) => check.state === "invalid")) return "invalid";
  if (checks.some((check) => check.state === "missing")) return "missing";
  return "ready";
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export const openclawDetachesAdapterService = {
  async info(basePath = "/api/adapters/openclaw-detaches"): Promise<OpenClawAdapterInfo> {
    const manifestBuffer = await fs.readFile(path.join(adapterRoot, "adapter.manifest.json"));
    const packageBuffer = await fs.readFile(path.join(adapterRoot, "package.json"));
    const manifest = JSON.parse(manifestBuffer.toString("utf8"));
    const packageJson = JSON.parse(packageBuffer.toString("utf8"));
    const files = await Promise.all(adapterFiles.map(async (file) => {
      const buffer = await fs.readFile(path.join(adapterRoot, file.path));
      return {
        path: file.path,
        size: buffer.length,
        sha256: sha256(buffer),
        mode: `0${file.mode.toString(8)}`,
        mimeType: file.mimeType,
        downloadUrl: `${basePath}/files/${encodeURIComponent(file.path)}`
      };
    }));
    const bundleBuffer = await buildBundle();
    return {
      id: manifest.id,
      name: manifest.name,
      version: packageJson.version,
      description: manifest.description,
      manifest,
      files,
      bundle: {
        fileName: "openclaw-detaches-adapter.tar.gz",
        downloadUrl: `${basePath}/bundle`,
        sha256: sha256(bundleBuffer),
        size: bundleBuffer.length
      },
      install: {
        shell: [
          "curl -fL http://127.0.0.1:38888/api/adapters/openclaw-detaches/bundle -o /tmp/openclaw-detaches-adapter.tar.gz",
          "mkdir -p ~/.openclaw/detaches_agent",
          "tar -xzf /tmp/openclaw-detaches-adapter.tar.gz -C ~/.openclaw/detaches_agent --strip-components=1",
          "node ~/.openclaw/detaches_agent/bin/detaches-agent-adapter.mjs manifest"
        ].join("\n"),
        notes: [
          "Run this on the real OpenClaw agent host when it can reach the detaches_agent local server.",
          "The adapter only emits/validates detaches_agent requests; it does not bypass UI approval."
        ]
      }
    };
  },

  async installPlan(input: { baseUrl?: string; installDir?: string } = {}): Promise<OpenClawAdapterInstallPlan> {
    const info = await this.info();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const installDir = normalizeInstallDir(input.installDir);
    const bundleUrl = `${baseUrl}/api/adapters/openclaw-detaches/bundle`;
    const quotedInstallDir = shellQuote(installDir);
    const quotedBundleUrl = shellQuote(bundleUrl);
    return {
      target: "remote-agent-host",
      adapterId: info.id,
      version: info.version,
      baseUrl,
      installDir,
      bundleUrl,
      bundleSha256: info.bundle.sha256,
      commands: [
        "set -euo pipefail",
        `INSTALL_DIR=${quotedInstallDir}`,
        `BUNDLE_URL=${quotedBundleUrl}`,
        `BUNDLE_SHA256=${shellQuote(info.bundle.sha256)}`,
        "TMP_BUNDLE=${TMPDIR:-/tmp}/openclaw-detaches-adapter.tar.gz",
        "mkdir -p \"$INSTALL_DIR\"",
        "curl -fL \"$BUNDLE_URL\" -o \"$TMP_BUNDLE\"",
        "ACTUAL_SHA256=$(shasum -a 256 \"$TMP_BUNDLE\" | awk '{print $1}')",
        "test \"$ACTUAL_SHA256\" = \"$BUNDLE_SHA256\"",
        "tar -xzf \"$TMP_BUNDLE\" -C \"$INSTALL_DIR\" --strip-components=1",
        "chmod +x \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
        "node \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" manifest"
      ],
      verifyCommands: [
        `INSTALL_DIR=${quotedInstallDir}`,
        "test -x \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
        "node \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" manifest | grep -q 'detaches_agent.openclaw.adapter'",
        "node \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" --help >/dev/null"
      ],
      notes: [
        "Run these commands on the real OpenClaw agent host, not inside the user's local detaches_agent terminal.",
        "The remote host must be able to reach the detaches_agent server baseUrl.",
        "The adapter only validates/emits detaches_agent protocol requests; it does not bypass UI approval."
      ]
    };
  },

  async readiness(input: { installDir?: string; target?: "local-distribution" | "remote-agent-host" } = {}): Promise<OpenClawAdapterReadiness> {
    const info = await this.info();
    const target = input.target ?? (input.installDir ? "remote-agent-host" : "local-distribution");
    const installDir = input.installDir ? normalizeInstallDir(input.installDir) : adapterRoot;
    const absoluteInstallDir = input.installDir ? path.resolve(expandHomeDir(installDir)) : adapterRoot;
    const manifestPath = path.join(absoluteInstallDir, "adapter.manifest.json");
    const cliPath = path.join(absoluteInstallDir, "bin", "detaches-agent-adapter.mjs");
    const checks: OpenClawAdapterReadinessCheck[] = [];

    try {
      const stats = await fs.stat(absoluteInstallDir);
      checks.push({
        id: "install-dir",
        state: stats.isDirectory() ? "ready" : "invalid",
        message: stats.isDirectory()
          ? `Adapter install directory exists: ${installDir}`
          : `Adapter install path exists but is not a directory: ${installDir}`
      });
    } catch (error: any) {
      checks.push({
        id: "install-dir",
        state: error?.code === "ENOENT" ? "missing" : "error",
        message: error?.code === "ENOENT"
          ? `Adapter install directory does not exist: ${installDir}`
          : error?.message || "Failed to inspect adapter install directory."
      });
    }

    try {
      const manifest = await readJsonFile(manifestPath) as Record<string, unknown>;
      const id = manifest.id;
      checks.push({
        id: "manifest",
        state: id === info.id ? "ready" : "invalid",
        message: id === info.id
          ? `Adapter manifest id is ${info.id}.`
          : `Adapter manifest id mismatch: expected ${info.id}, got ${String(id || "missing")}.`,
        details: { id }
      });
    } catch (error: any) {
      checks.push({
        id: "manifest",
        state: error?.code === "ENOENT" ? "missing" : "error",
        message: error?.code === "ENOENT"
          ? `Adapter manifest is missing at ${path.join(installDir, "adapter.manifest.json")}.`
          : error?.message || "Failed to read adapter manifest."
      });
    }

    try {
      const packageJson = await readJsonFile(path.join(absoluteInstallDir, "package.json")) as Record<string, unknown>;
      const version = packageJson.version;
      checks.push({
        id: "version",
        state: version === info.version ? "ready" : "invalid",
        message: version === info.version
          ? `Adapter package version is ${info.version}.`
          : `Adapter package version mismatch: expected ${info.version}, got ${String(version || "missing")}.`,
        details: { version }
      });
    } catch (error: any) {
      checks.push({
        id: "version",
        state: error?.code === "ENOENT" ? "missing" : "error",
        message: error?.code === "ENOENT"
          ? `Adapter package metadata is missing at ${path.join(installDir, "package.json")}.`
          : error?.message || "Failed to read adapter package metadata."
      });
    }

    try {
      const stats = await fs.stat(cliPath);
      checks.push({
        id: "cli",
        state: stats.isFile() ? "ready" : "invalid",
        message: stats.isFile()
          ? `Adapter CLI exists at ${path.join(installDir, "bin", "detaches-agent-adapter.mjs")}.`
          : "Adapter CLI path exists but is not a file."
      });
    } catch (error: any) {
      checks.push({
        id: "cli",
        state: error?.code === "ENOENT" ? "missing" : "error",
        message: error?.code === "ENOENT"
          ? `Adapter CLI is missing at ${path.join(installDir, "bin", "detaches-agent-adapter.mjs")}.`
          : error?.message || "Failed to inspect adapter CLI."
      });
    }

    return {
      target,
      installDir,
      expectedAdapterId: info.id,
      expectedVersion: info.version,
      state: aggregateReadiness(checks),
      checks,
      verifyCommands: [
        `INSTALL_DIR=${shellQuote(installDir)}`,
        "test -d \"$INSTALL_DIR\"",
        "test -f \"$INSTALL_DIR/adapter.manifest.json\"",
        "test -x \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" || test -f \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
        "node \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" manifest | grep -q 'detaches_agent.openclaw.adapter'"
      ]
    };
  },

  async file(filePath: string): Promise<{ buffer: Buffer; path: string; mimeType: string }> {
    const { spec, buffer } = await readAdapterFile(filePath);
    return { buffer, path: spec.path, mimeType: spec.mimeType };
  },

  async bundle(): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    return {
      buffer: await buildBundle(),
      fileName: "openclaw-detaches-adapter.tar.gz",
      mimeType: "application/gzip"
    };
  }
};
