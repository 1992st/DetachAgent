import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DetachesPlatform = "darwin" | "linux" | "win32" | "ios" | "unknown";
export type PlatformCommand = "ssh" | "ssh-keygen" | "curl" | "openclaw";

export interface PlatformInfo {
  os: DetachesPlatform;
  nodePlatform: NodeJS.Platform;
  arch: string;
  homeDir: string;
  appDataDir: string;
  pathSeparator: string;
}

export interface ResolvedCommand {
  name: PlatformCommand;
  command: string;
  argsPrefix: string[];
  available?: boolean;
  source: "path" | "bundled" | "default";
}

export interface ShellLaunch {
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  displayCommand: string;
}

export interface PortOwner {
  command: string;
  pid: number;
  raw: string;
}

export interface PlatformOverrides {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  resourcesDir?: string;
  appName?: string;
  pathExists?: (filePath: string) => boolean;
}

export class PlatformService {
  constructor(private readonly overrides: PlatformOverrides = {}) {}

  getPlatformInfo(): PlatformInfo {
    const nodePlatform = this.nodePlatform();
    return {
      os: this.detachesPlatform(nodePlatform),
      nodePlatform,
      arch: process.arch,
      homeDir: this.homeDir(),
      appDataDir: this.getAppDataDir(),
      pathSeparator: nodePlatform === "win32" ? "\\" : "/"
    };
  }

  getAppDataDir(): string {
    const env = this.env();
    const appName = this.overrides.appName || "detaches_agent";
    const configured = env.DETACHES_STORAGE_DIR?.trim();
    if (configured) return path.resolve(this.expandHome(configured));

    if (this.nodePlatform() === "win32") {
      return path.win32.join(this.homeDir(), ".detach_agent");
    }
    return path.join(this.homeDir(), ".detach_agent");
  }

  getDefaultIdentityPath(): string {
    if (this.nodePlatform() === "win32") {
      return path.win32.join(this.homeDir(), ".ssh", "detaches_agent_ed25519");
    }
    return path.join(this.homeDir(), ".ssh", "detaches_agent_ed25519");
  }

  expandHome(value: string): string {
    if (value === "~") return this.homeDir();
    if (value.startsWith("~/") || value.startsWith("~\\")) {
      const rest = value.slice(2);
      return this.nodePlatform() === "win32"
        ? path.win32.join(this.homeDir(), rest)
        : path.join(this.homeDir(), rest);
    }
    return value;
  }

  async resolveCommand(name: PlatformCommand): Promise<ResolvedCommand> {
    const bundled = await this.bundledCommand(name);
    if (bundled) return bundled;

    const command = this.defaultCommandName(name);
    const probe = this.nodePlatform() === "win32"
      ? { command: "where.exe", args: [command] }
      : { command: "command", args: ["-v", command] };
    try {
      await execFileAsync(probe.command, probe.args, { timeout: 1500 });
      return { name, command, argsPrefix: [], available: true, source: "path" };
    } catch {
      return { name, command, argsPrefix: [], available: false, source: "default" };
    }
  }

  getDefaultShell(): string {
    if (this.nodePlatform() === "win32") {
      return this.env().COMSPEC || "powershell.exe";
    }
    const shell = this.env().SHELL;
    if (shell?.startsWith("/") && shell.trim()) return shell;
    if (this.nodePlatform() === "linux") {
      if (this.pathExists("/bin/bash")) return "/bin/bash";
      return "/bin/sh";
    }
    return "/bin/zsh";
  }

  buildShellLaunch(command: string, options: { cwd?: string; login?: boolean } = {}): ShellLaunch {
    const cwd = options.cwd || this.homeDir();
    const env = this.processEnv();
    env.TERM = env.TERM || "xterm-256color";
    if (this.nodePlatform() === "win32") {
      const shell = this.env().POWERSHELL_EXE || "powershell.exe";
      const args = [
        "-NoLogo",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command
      ];
      return { shell, args, cwd, env, displayCommand: command };
    }
    const shell = this.getDefaultShell();
    const args = [options.login === false ? "-c" : "-lc", command];
    return { shell, args, cwd, env, displayCommand: command };
  }

  buildInteractiveShellLaunch(options: { cwd?: string; sessionName?: string } = {}): ShellLaunch {
    if (this.nodePlatform() === "win32") {
      const workspace = path.win32.join(this.homeDir(), ".detach_agent", "workspaces");
      const command = [
        `$workspace = ${this.powerShellQuote(workspace)}`,
        "New-Item -ItemType Directory -Force -Path $workspace | Out-Null",
        "Set-Location $workspace"
      ].join("; ");
      return this.buildShellLaunch(command, { cwd: options.cwd || this.homeDir(), login: false });
    }

    const shell = this.getDefaultShell();
    const quotedSessionName = this.posixShellQuote(options.sessionName || "detaches");
    const quotedShell = this.posixShellQuote(shell);
    const command = [
      "mkdir -p ~/.detach_agent/workspaces",
      "cd ~/.detach_agent/workspaces",
      `if command -v tmux >/dev/null 2>&1; then tmux new-session -A -s ${quotedSessionName}; else exec ${quotedShell} -l; fi`
    ].join(" && ");
    return this.buildShellLaunch(command, { cwd: options.cwd || this.homeDir() });
  }

  buildFallbackShellLaunch(options: { cwd?: string } = {}): ShellLaunch {
    if (this.nodePlatform() === "win32") {
      return this.buildInteractiveShellLaunch(options);
    }
    const shell = this.getDefaultShell();
    const quotedShell = this.posixShellQuote(shell);
    const command = [
      "mkdir -p ~/.detach_agent/workspaces",
      "cd ~/.detach_agent/workspaces",
      `exec ${quotedShell} -l`
    ].join(" && ");
    return this.buildShellLaunch(command, { cwd: options.cwd || this.homeDir() });
  }

  normalizeLocalPath(value: string): string | null {
    const cleaned = value.trim();
    if (!cleaned || cleaned.includes("\0")) return null;
    if (this.nodePlatform() === "win32") {
      return path.win32.isAbsolute(cleaned) ? path.win32.normalize(cleaned) : null;
    }
    return path.isAbsolute(cleaned) ? path.normalize(cleaned) : null;
  }

  normalizeRemotePosixPath(remotePath: string, remoteHome: string): string {
    const trimmed = remotePath.trim();
    const expanded = trimmed === "~" ? remoteHome : trimmed.startsWith("~/") ? `${remoteHome}/${trimmed.slice(2)}` : trimmed;
    const normalized = path.posix.normalize(expanded);
    if (!normalized.startsWith("/")) {
      throw new Error("Remote path must be absolute or start with ~/.");
    }
    return normalized.replace(/\/+$/, "") || "/";
  }

  async getPortOwner(port: number): Promise<PortOwner | null> {
    if (this.nodePlatform() === "win32") return this.windowsPortOwner(port);
    return this.posixPortOwner(port);
  }

  async chmodPrivateKeyBestEffort(privateKeyPath: string, publicKeyPath?: string): Promise<void> {
    if (this.nodePlatform() === "win32") return;
    await fs.chmod(privateKeyPath, 0o600).catch(() => undefined);
    if (publicKeyPath) await fs.chmod(publicKeyPath, 0o644).catch(() => undefined);
  }

  private async bundledCommand(name: PlatformCommand): Promise<ResolvedCommand | null> {
    const resourcesDir = this.overrides.resourcesDir || this.env().DETACHES_RESOURCES_DIR;
    if (!resourcesDir) return null;
    const platformDir = this.nodePlatform() === "win32" ? "win32" : this.nodePlatform();
    const command = path.join(resourcesDir, "bin", platformDir, this.defaultCommandName(name));
    try {
      await fs.access(command);
      return { name, command, argsPrefix: [], available: true, source: "bundled" };
    } catch {
      return null;
    }
  }

  private defaultCommandName(name: PlatformCommand): string {
    if (this.nodePlatform() !== "win32") return name;
    if (name === "ssh" || name === "curl") return `${name}.exe`;
    if (name === "ssh-keygen") return "ssh-keygen.exe";
    return "openclaw.exe";
  }

  private async posixPortOwner(port: number): Promise<PortOwner | null> {
    return await this.lsofPortOwner(port)
      ?? (this.nodePlatform() === "linux" ? await this.ssPortOwner(port) : null)
      ?? (this.nodePlatform() === "linux" ? await this.netstatPortOwner(port) : null);
  }

  private async lsofPortOwner(port: number): Promise<PortOwner | null> {
    try {
      const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "cp"], { timeout: 1500 });
      const command = /^c(.+)$/m.exec(stdout)?.[1];
      const pid = Number(/^p(\d+)$/m.exec(stdout)?.[1]);
      if (!command || !Number.isFinite(pid)) return null;
      return { command, pid, raw: stdout };
    } catch {
      return null;
    }
  }

  private async ssPortOwner(port: number): Promise<PortOwner | null> {
    try {
      const { stdout } = await execFileAsync("ss", ["-ltnp"], { timeout: 1500, maxBuffer: 1024 * 1024 });
      return this.parseLinuxPortOwner(stdout, port);
    } catch {
      return null;
    }
  }

  private async netstatPortOwner(port: number): Promise<PortOwner | null> {
    try {
      const { stdout } = await execFileAsync("netstat", ["-ltnp"], { timeout: 1500, maxBuffer: 1024 * 1024 });
      return this.parseLinuxPortOwner(stdout, port);
    } catch {
      return null;
    }
  }

  private parseLinuxPortOwner(stdout: string, port: number): PortOwner | null {
    const line = stdout.split(/\r?\n/).find((item) => {
      const columns = item.trim().split(/\s+/);
      return columns.some((column) => column.endsWith(`:${port}`));
    });
    if (!line) return null;
    const processMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(line)
      ?? /(?:^|\s)(\d+)\/([^\s]+)\s*$/.exec(line);
    if (!processMatch) return { command: "unknown", pid: 0, raw: line };
    if (processMatch.length === 3 && /^\d+$/.test(processMatch[1] ?? "")) {
      return { command: processMatch[2] ?? "unknown", pid: Number(processMatch[1]), raw: line };
    }
    return { command: processMatch[1] ?? "unknown", pid: Number(processMatch[2]), raw: line };
  }

  private async windowsPortOwner(port: number): Promise<PortOwner | null> {
    try {
      const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], { timeout: 2500, maxBuffer: 1024 * 1024 });
      const line = stdout.split(/\r?\n/).find((item) => {
        const columns = item.trim().split(/\s+/);
        return columns.length >= 5 && columns[1]?.endsWith(`:${port}`) && columns[3] === "LISTENING";
      });
      if (!line) return null;
      const pid = Number(line.trim().split(/\s+/).at(-1));
      if (!Number.isFinite(pid)) return null;
      return { command: `pid:${pid}`, pid, raw: line };
    } catch {
      return null;
    }
  }

  private detachesPlatform(platform: NodeJS.Platform): DetachesPlatform {
    if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
    return "unknown";
  }

  private nodePlatform(): NodeJS.Platform {
    return this.overrides.platform || process.platform;
  }

  private env(): NodeJS.ProcessEnv {
    return this.overrides.env || process.env;
  }

  private homeDir(): string {
    return this.overrides.homeDir || os.homedir();
  }

  private pathExists(filePath: string): boolean {
    if (this.overrides.pathExists) return this.overrides.pathExists(filePath);
    try {
      fsSync.statSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private processEnv(): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env())) {
      if (typeof value === "string") output[key] = value;
    }
    return output;
  }

  private posixShellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private powerShellQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }
}

export const platformService = new PlatformService();
