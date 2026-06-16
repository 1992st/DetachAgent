import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { OpenClawAdapterInstallPlan, OpenClawAdapterReadiness, OpenClawAdapterReadinessCheck, OpenClawAdapterReadinessState } from "@detaches/shared";
import { repoRoot, reverseBridgeBaseUrl } from "../../config/appConfig.js";
import { runtimeConfig } from "../../config/settingsStore.js";

const gzip = promisify(zlib.gzip);
const execFileAsync = promisify(execFile);

const adapterRoot = path.join(repoRoot, "packages", "openclaw-detaches-adapter");
const adapterFiles = [
  { path: "package.json", mode: 0o644, mimeType: "application/json" },
  { path: "adapter.manifest.json", mode: 0o644, mimeType: "application/json" },
  { path: "skill.manifest.json", mode: 0o644, mimeType: "application/json" },
  { path: "README.md", mode: 0o644, mimeType: "text/markdown; charset=utf-8" },
  { path: "AGENT.md", mode: 0o644, mimeType: "text/markdown; charset=utf-8" },
  { path: "SKILL.md", mode: 0o644, mimeType: "text/markdown; charset=utf-8" },
  { path: "bin/detaches-agent-adapter.mjs", mode: 0o755, mimeType: "text/javascript; charset=utf-8" }
] as const;

let lastRemoteReadiness: OpenClawAdapterReadiness | null = null;

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

export interface OpenClawAdapterRemoteInstallCommand {
  command: string;
  installDir: string;
  remoteHost: string;
  remoteUser: string;
  bundleUrl: string;
  bundleSha256: string;
}

const defaultWorkspaceDir = "~/.openclaw/workspace";
const openClawSkillName = "detaches-agent";
const deterministicTarMtimeSeconds = 0;

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
  writeOctal(header, deterministicTarMtimeSeconds, 136, 12);
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

const expandPathShellLines = [
  "expand_path() {",
  "  case \"$1\" in",
  "    \"~\") printf '%s\\n' \"$HOME\" ;;",
  "    \"~/\"*) printf '%s/%s\\n' \"$HOME\" \"${1#~/}\" ;;",
  "    *) printf '%s\\n' \"$1\" ;;",
  "  esac",
  "}"
];

const openClawRuntimeVerifyShellLines = [
  "verify_openclaw_skill_runtime() {",
  "  if ! command -v openclaw >/dev/null 2>&1; then",
  "    printf 'openclaw CLI not found; skipped runtime skill visibility check.\\n'",
  "    return 0",
  "  fi",
  "  OPENCLAW_SKILL_JSON=$(cd \"$WORKSPACE_DIR\" && openclaw skills info detaches-agent --json 2>/tmp/detaches-openclaw-skills.err) || {",
  "    cat /tmp/detaches-openclaw-skills.err >&2 2>/dev/null || true",
  "    return 1",
  "  }",
  "  printf '%s' \"$OPENCLAW_SKILL_JSON\" | grep -q '\"name\"[[:space:]]*:[[:space:]]*\"detaches-agent\"'",
  "}",
  "verify_openclaw_skill_runtime"
];

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || "http://127.0.0.1:38888";
}

function normalizeInstallDir(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || "~/.detach_agent";
}

function normalizeWorkspaceDir(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || defaultWorkspaceDir;
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

function remoteReadinessScript(installDir: string, expectedAdapterId: string, expectedVersion: string, workspaceDir = defaultWorkspaceDir): string {
  return [
    "set +e",
    `INSTALL_DIR_INPUT=${shellQuote(installDir)}`,
    `WORKSPACE_DIR_INPUT=${shellQuote(workspaceDir)}`,
    ...expandPathShellLines,
    "INSTALL_DIR=$(expand_path \"$INSTALL_DIR_INPUT\")",
    "WORKSPACE_DIR=$(expand_path \"$WORKSPACE_DIR_INPUT\")",
    `EXPECTED_ADAPTER_ID=${shellQuote(expectedAdapterId)}`,
    `EXPECTED_VERSION=${shellQuote(expectedVersion)}`,
    "MANIFEST_PATH=\"$INSTALL_DIR/adapter.manifest.json\"",
    "SKILL_MANIFEST_PATH=\"$INSTALL_DIR/skill.manifest.json\"",
    "PACKAGE_PATH=\"$INSTALL_DIR/package.json\"",
    "CLI_PATH=\"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
    `SKILL_PATH="$WORKSPACE_DIR/skills/${openClawSkillName}/SKILL.md"`,
    "STATE=ready",
    "json_escape() { printf '%s' \"$1\" | sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g'; }",
    "emit_check() {",
    "  CHECK_ID=$(json_escape \"$1\")",
    "  CHECK_STATE=$(json_escape \"$2\")",
    "  CHECK_MESSAGE=$(json_escape \"$3\")",
    "  if [ -n \"$CHECKS\" ]; then CHECKS=\"$CHECKS,\"; fi",
    "  CHECKS=\"$CHECKS{\\\"id\\\":\\\"$CHECK_ID\\\",\\\"state\\\":\\\"$CHECK_STATE\\\",\\\"message\\\":\\\"$CHECK_MESSAGE\\\"}\"",
    "  if [ \"$2\" = error ]; then STATE=error; elif [ \"$STATE\" != error ] && [ \"$2\" = invalid ]; then STATE=invalid; elif [ \"$STATE\" = ready ] && [ \"$2\" = missing ]; then STATE=missing; fi",
    "}",
    "if [ -d \"$INSTALL_DIR\" ]; then",
    "  emit_check install-dir ready \"Adapter install directory exists: $INSTALL_DIR\"",
    "elif [ -e \"$INSTALL_DIR\" ]; then",
    "  emit_check install-dir invalid \"Adapter install path exists but is not a directory: $INSTALL_DIR\"",
    "else",
    "  emit_check install-dir missing \"Adapter install directory does not exist: $INSTALL_DIR\"",
    "fi",
    "if [ -f \"$MANIFEST_PATH\" ]; then",
    "  if grep -q \"\\\"id\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$MANIFEST_PATH\"; then",
    "    emit_check manifest ready \"Adapter manifest id is $EXPECTED_ADAPTER_ID.\"",
    "  else",
    "    emit_check manifest invalid \"Adapter manifest id mismatch: expected $EXPECTED_ADAPTER_ID.\"",
    "  fi",
    "else",
    "  emit_check manifest missing \"Adapter manifest is missing at $MANIFEST_PATH.\"",
    "fi",
    "if [ -f \"$SKILL_MANIFEST_PATH\" ]; then",
    "  if grep -q \"\\\"adapterId\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$SKILL_MANIFEST_PATH\"; then",
    "    emit_check skill-manifest ready \"Skill manifest references $EXPECTED_ADAPTER_ID.\"",
    "  else",
    "    emit_check skill-manifest invalid \"Skill manifest adapterId mismatch: expected $EXPECTED_ADAPTER_ID.\"",
    "  fi",
    "else",
    "  emit_check skill-manifest missing \"Skill manifest is missing at $SKILL_MANIFEST_PATH.\"",
    "fi",
    "if [ -f \"$PACKAGE_PATH\" ]; then",
    "  if grep -q \"\\\"version\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_VERSION\\\"\" \"$PACKAGE_PATH\"; then",
    "    emit_check version ready \"Adapter package version is $EXPECTED_VERSION.\"",
    "  else",
    "    emit_check version invalid \"Adapter package version mismatch: expected $EXPECTED_VERSION.\"",
    "  fi",
    "else",
    "  emit_check version missing \"Adapter package metadata is missing at $PACKAGE_PATH.\"",
    "fi",
    "if [ -f \"$CLI_PATH\" ]; then",
    "  emit_check cli ready \"Adapter CLI exists at $CLI_PATH.\"",
    "else",
    "  emit_check cli missing \"Adapter CLI is missing at $CLI_PATH.\"",
    "fi",
    "if [ -f \"$SKILL_PATH\" ]; then",
    "  if grep -q \"^name:[[:space:]]*detaches-agent\" \"$SKILL_PATH\"; then",
    "    emit_check openclaw-skill ready \"OpenClaw workspace skill exists at $SKILL_PATH.\"",
    "  else",
    "    emit_check openclaw-skill invalid \"OpenClaw workspace skill exists but does not declare name detaches-agent.\"",
    "  fi",
    "else",
    "  emit_check openclaw-skill missing \"OpenClaw workspace skill is missing at $SKILL_PATH.\"",
    "fi",
    "if command -v openclaw >/dev/null 2>&1; then",
    "  OPENCLAW_SKILL_OUTPUT=$(cd \"$WORKSPACE_DIR\" && openclaw skills info detaches-agent --json 2>&1)",
    "  OPENCLAW_SKILL_STATUS=$?",
    "  if [ \"$OPENCLAW_SKILL_STATUS\" -eq 0 ] && printf '%s' \"$OPENCLAW_SKILL_OUTPUT\" | grep -q '\"name\"[[:space:]]*:[[:space:]]*\"detaches-agent\"'; then",
    "    emit_check openclaw-skill-runtime ready \"OpenClaw CLI can see skill detaches-agent from $WORKSPACE_DIR.\"",
    "  else",
    "    OPENCLAW_SKILL_SUMMARY=$(printf '%s' \"$OPENCLAW_SKILL_OUTPUT\" | tr '\\n' ' ' | cut -c 1-400)",
    "    emit_check openclaw-skill-runtime invalid \"OpenClaw CLI cannot see skill detaches-agent from $WORKSPACE_DIR: $OPENCLAW_SKILL_SUMMARY\"",
    "  fi",
    "else",
    "  emit_check openclaw-skill-runtime ready \"OpenClaw CLI not found; skipped runtime skill visibility check.\"",
    "fi",
    "printf '{\"state\":\"%s\",\"checks\":[%s]}\\n' \"$STATE\" \"$CHECKS\""
  ].join("\n");
}

function sshArgs(config: Awaited<ReturnType<typeof runtimeConfig>>, command: string): string[] {
  const args = [
    "-p",
    String(config.remoteSshPort),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=1"
  ];
  if (config.remoteIdentityPath) args.push("-i", config.remoteIdentityPath);
  args.push(`${config.remoteUser}@${config.remoteHost}`, command);
  return args;
}

function shellJoin(command: string, args: string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}

function remoteInstallScript(plan: OpenClawAdapterInstallPlan): string {
  return [
    "set -euo pipefail",
    `INSTALL_DIR_INPUT=${shellQuote(plan.installDir)}`,
    `WORKSPACE_DIR_INPUT=${shellQuote(plan.workspaceDir)}`,
    ...expandPathShellLines,
    "INSTALL_DIR=$(expand_path \"$INSTALL_DIR_INPUT\")",
    "WORKSPACE_DIR=$(expand_path \"$WORKSPACE_DIR_INPUT\")",
    `EXPECTED_ADAPTER_ID=${shellQuote(plan.adapterId)}`,
    `BUNDLE_SHA256=${shellQuote(plan.bundleSha256)}`,
    "TMP_BUNDLE=${TMPDIR:-/tmp}/openclaw-detaches-adapter.tar.gz",
    "cat > \"$TMP_BUNDLE\"",
    "ACTUAL_SHA256=$(shasum -a 256 \"$TMP_BUNDLE\" | awk '{print $1}')",
    "test \"$ACTUAL_SHA256\" = \"$BUNDLE_SHA256\"",
    "mkdir -p \"$INSTALL_DIR\"",
    "tar -xzf \"$TMP_BUNDLE\" -C \"$INSTALL_DIR\" --strip-components=1",
    "chmod +x \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
    `mkdir -p "$WORKSPACE_DIR/skills/${openClawSkillName}"`,
    `cp "$INSTALL_DIR/SKILL.md" "$WORKSPACE_DIR/skills/${openClawSkillName}/SKILL.md"`,
    "grep -q \"\\\"id\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/adapter.manifest.json\"",
    "grep -q \"\\\"adapterId\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/skill.manifest.json\"",
    `grep -q "^name:[[:space:]]*${openClawSkillName}" "$WORKSPACE_DIR/skills/${openClawSkillName}/SKILL.md"`,
    "if command -v node >/dev/null 2>&1; then node \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" manifest >/dev/null; fi",
    ...openClawRuntimeVerifyShellLines,
    "printf 'detaches adapter installed: %s\\n' \"$INSTALL_DIR\""
  ].join("\n");
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
          "mkdir -p ~/.detach_agent",
          "tar -xzf /tmp/openclaw-detaches-adapter.tar.gz -C ~/.detach_agent --strip-components=1",
          "node ~/.detach_agent/bin/detaches-agent-adapter.mjs manifest"
        ].join("\n"),
        notes: [
          "Run this on the real Detach Agent runtime machine through the detaches_agent SSH reverse bridge.",
          "The adapter only emits/validates detaches_agent requests; it does not bypass UI approval."
        ]
      }
    };
  },

  async installPlan(input: { baseUrl?: string; installDir?: string; workspaceDir?: string } = {}): Promise<OpenClawAdapterInstallPlan> {
    const info = await this.info();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const installDir = normalizeInstallDir(input.installDir);
    const workspaceDir = normalizeWorkspaceDir(input.workspaceDir);
    const bundleUrl = `${baseUrl}/api/adapters/openclaw-detaches/bundle`;
    const quotedInstallDir = shellQuote(installDir);
    const quotedWorkspaceDir = shellQuote(workspaceDir);
    const quotedBundleUrl = shellQuote(bundleUrl);
    return {
      target: "remote-agent-host",
      adapterId: info.id,
      version: info.version,
      baseUrl,
      installDir,
      workspaceDir,
      bundleUrl,
      bundleSha256: info.bundle.sha256,
      commands: [
        "set -euo pipefail",
        `INSTALL_DIR_INPUT=${quotedInstallDir}`,
        `WORKSPACE_DIR_INPUT=${quotedWorkspaceDir}`,
        ...expandPathShellLines,
        "INSTALL_DIR=$(expand_path \"$INSTALL_DIR_INPUT\")",
        "WORKSPACE_DIR=$(expand_path \"$WORKSPACE_DIR_INPUT\")",
        `BUNDLE_URL=${quotedBundleUrl}`,
        `EXPECTED_ADAPTER_ID=${shellQuote(info.id)}`,
        `BUNDLE_SHA256=${shellQuote(info.bundle.sha256)}`,
        "TMP_BUNDLE=${TMPDIR:-/tmp}/openclaw-detaches-adapter.tar.gz",
        "mkdir -p \"$INSTALL_DIR\"",
        "curl -fL \"$BUNDLE_URL\" -o \"$TMP_BUNDLE\"",
        "ACTUAL_SHA256=$(shasum -a 256 \"$TMP_BUNDLE\" | awk '{print $1}')",
        "test \"$ACTUAL_SHA256\" = \"$BUNDLE_SHA256\"",
        "tar -xzf \"$TMP_BUNDLE\" -C \"$INSTALL_DIR\" --strip-components=1",
        "chmod +x \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
        "mkdir -p \"$WORKSPACE_DIR/skills/detaches-agent\"",
        "cp \"$INSTALL_DIR/SKILL.md\" \"$WORKSPACE_DIR/skills/detaches-agent/SKILL.md\"",
        "grep -q \"\\\"id\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/adapter.manifest.json\"",
        "grep -q \"\\\"adapterId\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/skill.manifest.json\"",
        "grep -q \"^name:[[:space:]]*detaches-agent\" \"$WORKSPACE_DIR/skills/detaches-agent/SKILL.md\"",
        "if command -v node >/dev/null 2>&1; then node \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" manifest >/dev/null; fi",
        ...openClawRuntimeVerifyShellLines,
        "printf 'detaches adapter installed: %s\\n' \"$INSTALL_DIR\""
      ],
      verifyCommands: [
        `INSTALL_DIR_INPUT=${quotedInstallDir}`,
        `WORKSPACE_DIR_INPUT=${quotedWorkspaceDir}`,
        ...expandPathShellLines,
        "INSTALL_DIR=$(expand_path \"$INSTALL_DIR_INPUT\")",
        "WORKSPACE_DIR=$(expand_path \"$WORKSPACE_DIR_INPUT\")",
        `EXPECTED_ADAPTER_ID=${shellQuote(info.id)}`,
        "test -x \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
        "grep -q \"\\\"id\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/adapter.manifest.json\"",
        "grep -q \"\\\"adapterId\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/skill.manifest.json\"",
        "grep -q \"^name:[[:space:]]*detaches-agent\" \"$WORKSPACE_DIR/skills/detaches-agent/SKILL.md\"",
        "if command -v node >/dev/null 2>&1; then node \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" --help >/dev/null; fi",
        ...openClawRuntimeVerifyShellLines
      ],
      notes: [
        "Run these commands on the real Detach Agent runtime machine, not inside the Host/Main Agent skill directory.",
        "The baseUrl should normally be the SSH reverse bridge URL on the remote host, for example http://127.0.0.1:38999.",
        "The adapter only validates/emits detaches_agent protocol requests; it does not bypass UI approval."
      ]
    };
  },

  async readiness(input: { installDir?: string; workspaceDir?: string; target?: "local-distribution" | "remote-agent-host" } = {}): Promise<OpenClawAdapterReadiness> {
    const info = await this.info();
    const target = input.target ?? (input.installDir ? "remote-agent-host" : "local-distribution");
    const installDir = input.installDir ? normalizeInstallDir(input.installDir) : adapterRoot;
    const workspaceDir = normalizeWorkspaceDir(input.workspaceDir);
    const absoluteInstallDir = input.installDir ? path.resolve(expandHomeDir(installDir)) : adapterRoot;
    const absoluteWorkspaceDir = path.resolve(expandHomeDir(workspaceDir));
    const manifestPath = path.join(absoluteInstallDir, "adapter.manifest.json");
    const skillManifestPath = path.join(absoluteInstallDir, "skill.manifest.json");
    const openClawSkillPath = input.installDir
      ? path.join(absoluteWorkspaceDir, "skills", openClawSkillName, "SKILL.md")
      : path.join(absoluteInstallDir, "SKILL.md");
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
      const skillManifest = await readJsonFile(skillManifestPath) as Record<string, unknown>;
      const adapterId = skillManifest.adapterId;
      checks.push({
        id: "skill-manifest",
        state: adapterId === info.id ? "ready" : "invalid",
        message: adapterId === info.id
          ? `Skill manifest references ${info.id}.`
          : `Skill manifest adapterId mismatch: expected ${info.id}, got ${String(adapterId || "missing")}.`,
        details: { adapterId }
      });
    } catch (error: any) {
      checks.push({
        id: "skill-manifest",
        state: error?.code === "ENOENT" ? "missing" : "error",
        message: error?.code === "ENOENT"
          ? `Skill manifest is missing at ${path.join(installDir, "skill.manifest.json")}.`
          : error?.message || "Failed to read skill manifest."
      });
    }

    try {
      const content = await fs.readFile(openClawSkillPath, "utf8");
      const ready = /^name:\s*detaches-agent/m.test(content);
      checks.push({
        id: "openclaw-skill",
        state: ready ? "ready" : "invalid",
        message: ready
          ? `OpenClaw skill entry is available at ${input.installDir ? path.join(workspaceDir, "skills", openClawSkillName, "SKILL.md") : "SKILL.md"}.`
          : "OpenClaw skill entry exists but does not declare name detaches-agent."
      });
    } catch (error: any) {
      checks.push({
        id: "openclaw-skill",
        state: error?.code === "ENOENT" ? "missing" : "error",
        message: error?.code === "ENOENT"
          ? `OpenClaw skill entry is missing at ${input.installDir ? path.join(workspaceDir, "skills", openClawSkillName, "SKILL.md") : "SKILL.md"}.`
          : error?.message || "Failed to read OpenClaw skill entry."
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
      workspaceDir,
      probe: "local-fs",
      expectedAdapterId: info.id,
      expectedVersion: info.version,
      state: aggregateReadiness(checks),
      checks,
      verifyCommands: [
        `INSTALL_DIR_INPUT=${shellQuote(installDir)}`,
        `WORKSPACE_DIR_INPUT=${shellQuote(workspaceDir)}`,
        ...expandPathShellLines,
        "INSTALL_DIR=$(expand_path \"$INSTALL_DIR_INPUT\")",
        "WORKSPACE_DIR=$(expand_path \"$WORKSPACE_DIR_INPUT\")",
        `EXPECTED_ADAPTER_ID=${shellQuote(info.id)}`,
        "test -d \"$INSTALL_DIR\"",
        "test -f \"$INSTALL_DIR/adapter.manifest.json\"",
        "test -f \"$INSTALL_DIR/skill.manifest.json\"",
        "test -f \"$WORKSPACE_DIR/skills/detaches-agent/SKILL.md\" || test -f \"$INSTALL_DIR/SKILL.md\"",
        "test -x \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" || test -f \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
        "grep -q \"\\\"id\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/adapter.manifest.json\"",
        "grep -q \"\\\"adapterId\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/skill.manifest.json\"",
        ...(input.installDir ? openClawRuntimeVerifyShellLines : [])
      ]
    };
  },

  async remoteReadiness(input: { installDir?: string; workspaceDir?: string } = {}): Promise<OpenClawAdapterReadiness> {
    const info = await this.info();
    const config = await runtimeConfig();
    const installDir = normalizeInstallDir(input.installDir);
    const workspaceDir = normalizeWorkspaceDir(input.workspaceDir);
    const base: OpenClawAdapterReadiness = {
      target: "remote-agent-host",
      installDir,
      workspaceDir,
      probe: "remote-ssh",
      remoteHost: config.remoteHost,
      remoteUser: config.remoteUser || undefined,
      expectedAdapterId: info.id,
      expectedVersion: info.version,
      state: "error",
      checks: [],
      verifyCommands: [
        `INSTALL_DIR_INPUT=${shellQuote(installDir)}`,
        `WORKSPACE_DIR_INPUT=${shellQuote(workspaceDir)}`,
        ...expandPathShellLines,
        "INSTALL_DIR=$(expand_path \"$INSTALL_DIR_INPUT\")",
        "WORKSPACE_DIR=$(expand_path \"$WORKSPACE_DIR_INPUT\")",
        `EXPECTED_ADAPTER_ID=${shellQuote(info.id)}`,
        "test -d \"$INSTALL_DIR\"",
        "test -f \"$INSTALL_DIR/adapter.manifest.json\"",
        "test -f \"$INSTALL_DIR/skill.manifest.json\"",
        "test -f \"$WORKSPACE_DIR/skills/detaches-agent/SKILL.md\"",
        "test -x \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\" || test -f \"$INSTALL_DIR/bin/detaches-agent-adapter.mjs\"",
        "grep -q \"\\\"id\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/adapter.manifest.json\"",
        "grep -q \"\\\"adapterId\\\"[[:space:]]*:[[:space:]]*\\\"$EXPECTED_ADAPTER_ID\\\"\" \"$INSTALL_DIR/skill.manifest.json\"",
        ...openClawRuntimeVerifyShellLines
      ]
    };
    if (!config.remoteUser) {
      const readiness: OpenClawAdapterReadiness = {
        ...base,
        checks: [{ id: "ssh-config", state: "error", message: "Remote SSH user is not configured." }]
      };
      lastRemoteReadiness = readiness;
      return readiness;
    }
    try {
      const script = remoteReadinessScript(installDir, info.id, info.version, workspaceDir);
      const { stdout, stderr } = await execFileAsync("ssh", sshArgs(config, script), { timeout: 12000, maxBuffer: 1024 * 256 });
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) throw new Error(stderr.trim() || "Remote readiness probe returned no output.");
      const parsed = JSON.parse(line) as { state?: OpenClawAdapterReadinessState; checks?: OpenClawAdapterReadinessCheck[] };
      const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
      const readiness: OpenClawAdapterReadiness = {
        ...base,
        state: parsed.state ?? aggregateReadiness(checks),
        checks: [
          { id: "ssh", state: "ready", message: `SSH probe reached ${config.remoteUser}@${config.remoteHost}.` },
          ...checks
        ]
      };
      lastRemoteReadiness = readiness;
      return readiness;
    } catch (error: any) {
      const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
      const readiness: OpenClawAdapterReadiness = {
        ...base,
        checks: [{
          id: "ssh",
          state: "error",
          message: output || error?.message || "Remote SSH readiness probe failed.",
          details: { code: error?.code, signal: error?.signal }
        }]
      };
      lastRemoteReadiness = readiness;
      return readiness;
    }
  },

  lastRemoteReadiness(): OpenClawAdapterReadiness | null {
    return lastRemoteReadiness;
  },

  async prepareRemoteInstallCommand(input: { installDir?: string; workspaceDir?: string } = {}): Promise<OpenClawAdapterRemoteInstallCommand> {
    const config = await runtimeConfig();
    if (!config.remoteUser) throw new Error("Remote SSH user is not configured.");
    const baseUrl = reverseBridgeBaseUrl(config);
    const plan = await this.installPlan({ baseUrl, installDir: input.installDir, workspaceDir: input.workspaceDir });
    const args = sshArgs(config, remoteInstallScript(plan));
    const bundleUrl = `${baseUrl}/api/adapters/openclaw-detaches/bundle`;
    return {
      command: `curl -fL ${shellQuote(bundleUrl)} | ${shellJoin("ssh", args)}`,
      installDir: plan.installDir,
      remoteHost: config.remoteHost,
      remoteUser: config.remoteUser,
      bundleUrl,
      bundleSha256: plan.bundleSha256
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
