import os from "node:os";
import { EventEmitter } from "node:events";
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, type IPty } from "node-pty";
import { nanoid } from "nanoid";
import type { TerminalInfo, TerminalStatus } from "@detaches/shared";
import { platformService, type ShellLaunch } from "../platform/platformService.js";

const require = createRequire(import.meta.url);

interface ManagedTerminal {
  id: string;
  sessionKey: string;
  status: TerminalStatus;
  createdAt: string;
  lastActiveAt: string;
  command: string;
  process: TerminalProcess;
  buffer: string;
  emitter: EventEmitter;
}

interface TerminalProcess {
  interactive: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

const MAX_REPLAY_CHARS = 120_000;

function sanitizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function terminalSessionName(sessionKey: string): string {
  return `detaches_${sanitizeId(sessionKey).slice(0, 80)}`;
}

class TerminalService {
  private terminals = new Map<string, ManagedTerminal>();

  async ensure(sessionKey: string, cols = 100, rows = 28, options: { requireInteractive?: boolean } = {}): Promise<ManagedTerminal> {
    const existing = this.terminals.get(sessionKey);
    if (existing && existing.status !== "exited") {
      if (options.requireInteractive && !existing.process.interactive) {
        this.disposeTerminal(existing, "restarting terminal because a real PTY is required");
        this.terminals.delete(sessionKey);
      } else {
        existing.lastActiveAt = new Date().toISOString();
        this.resize(existing, cols, rows);
        return existing;
      }
    }

    const terminalId = nanoid();
    const createdAt = new Date().toISOString();
    const launch = platformService.buildInteractiveShellLaunch({ sessionName: terminalSessionName(sessionKey) });
    const fallbackLaunch = platformService.buildFallbackShellLaunch();

    const child = this.spawnTerminal(launch, fallbackLaunch, cols, rows);

    const terminal: ManagedTerminal = {
      id: terminalId,
      sessionKey,
      status: "starting",
      createdAt,
      lastActiveAt: createdAt,
      command: launch.displayCommand,
      process: child.process,
      buffer: "",
      emitter: new EventEmitter()
    };
    terminal.emitter.setMaxListeners(100);
    this.terminals.set(sessionKey, terminal);

    child.onData((data) => {
      terminal.status = "connected";
      terminal.lastActiveAt = new Date().toISOString();
      terminal.buffer = `${terminal.buffer}${data}`.slice(-MAX_REPLAY_CHARS);
      terminal.emitter.emit("data", data);
      terminal.emitter.emit("status", this.info(terminal));
    });

    child.onExit((exitCode, signal) => {
      terminal.status = exitCode === 0 ? "exited" : "error";
      terminal.lastActiveAt = new Date().toISOString();
      const line = `\r\n[terminal exited: code=${exitCode} signal=${signal ?? ""}]\r\n`;
      terminal.buffer = `${terminal.buffer}${line}`.slice(-MAX_REPLAY_CHARS);
      terminal.emitter.emit("data", line);
      terminal.emitter.emit("status", this.info(terminal));
    });

    return terminal;
  }

  info(terminal: ManagedTerminal): TerminalInfo {
    return {
      terminalId: terminal.id,
      sessionKey: terminal.sessionKey,
      status: terminal.status,
      createdAt: terminal.createdAt,
      lastActiveAt: terminal.lastActiveAt,
      command: terminal.command
    };
  }

  replay(terminal: ManagedTerminal): string {
    return terminal.buffer;
  }

  async snapshot(sessionKey: string, options: { requireInteractive?: boolean } = {}): Promise<{ terminal: TerminalInfo; replay: string }> {
    const terminal = await this.ensure(sessionKey, 100, 28, options);
    return { terminal: this.info(terminal), replay: this.replay(terminal) };
  }

  write(terminal: ManagedTerminal, data: string): void {
    terminal.lastActiveAt = new Date().toISOString();
    terminal.process.write(data);
  }

  async runCommand(sessionKey: string, command: string, options: { requireInteractive?: boolean } = {}): Promise<TerminalInfo> {
    const cleaned = command.trimEnd();
    if (!cleaned.trim()) throw new Error("Command is empty.");
    const terminal = await this.ensure(sessionKey, 100, 28, { requireInteractive: options.requireInteractive });
    if (options.requireInteractive && !terminal.process.interactive) {
      throw new Error("A real PTY terminal is required for this command, but node-pty is unavailable. Password prompts cannot work in the pipe fallback terminal.");
    }
    if (!terminal.process.interactive) {
      const visible = `\r\n[detaches_agent wrote command to pipe terminal; password prompts may not be interactive]\r\n${cleaned}\r\n`;
      terminal.buffer = `${terminal.buffer}${visible}`.slice(-MAX_REPLAY_CHARS);
      terminal.emitter.emit("data", visible);
      terminal.emitter.emit("status", this.info(terminal));
    }
    this.write(terminal, `${cleaned}\r`);
    return this.info(terminal);
  }

  interrupt(sessionKey: string): boolean {
    const terminal = this.terminals.get(sessionKey);
    if (!terminal || terminal.status === "exited") return false;
    this.write(terminal, "\x03");
    return true;
  }

  resize(terminal: ManagedTerminal, cols: number, rows: number): void {
    const safeCols = Math.min(Math.max(Math.floor(cols), 40), 240);
    const safeRows = Math.min(Math.max(Math.floor(rows), 10), 80);
    terminal.process.resize(safeCols, safeRows);
  }

  private spawnTerminal(launch: ShellLaunch, fallbackLaunch: ShellLaunch, cols: number, rows: number): {
    process: TerminalProcess;
    onData: (handler: (data: string) => void) => void;
    onExit: (handler: (exitCode: number, signal?: number) => void) => void;
  } {
    try {
      repairNodePtyHelperPermissions();
      const pty = spawn(launch.shell, launch.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: launch.cwd || os.homedir(),
        env: launch.env
      });
      return {
        process: {
          interactive: true,
          write: (data) => pty.write(data),
          resize: (nextCols, nextRows) => pty.resize(nextCols, nextRows),
          dispose: () => pty.kill()
        },
        onData: (handler) => pty.onData(handler),
        onExit: (handler) => pty.onExit(({ exitCode, signal }) => handler(exitCode, signal))
      };
    } catch (error) {
      const child = spawnProcess(fallbackLaunch.shell, fallbackLaunch.args, {
        cwd: fallbackLaunch.cwd || os.homedir(),
        env: fallbackLaunch.env,
        stdio: "pipe"
      });
      return this.wrapChildProcess(child, error instanceof Error ? error.message : String(error));
    }
  }

  private wrapChildProcess(child: ChildProcessWithoutNullStreams, fallbackReason: string): {
    process: TerminalProcess;
    onData: (handler: (data: string) => void) => void;
    onExit: (handler: (exitCode: number, signal?: number) => void) => void;
  } {
    return {
      process: {
        interactive: false,
        write: (data) => child.stdin.write(data.replaceAll("\r", "\n")),
        resize: () => undefined,
        dispose: () => child.kill()
      },
      onData: (handler) => {
        handler(`[node-pty unavailable: ${fallbackReason}; using pipe terminal fallback]\r\n`);
        child.stdout.on("data", (chunk: Buffer) => handler(chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => handler(chunk.toString("utf8")));
      },
      onExit: (handler) => child.on("exit", (code, signal) => handler(code ?? 0, typeof signal === "string" ? undefined : signal ?? undefined))
    };
  }

  private disposeTerminal(terminal: ManagedTerminal, reason: string): void {
    const line = `\r\n[detaches_agent] ${reason}\r\n`;
    terminal.buffer = `${terminal.buffer}${line}`.slice(-MAX_REPLAY_CHARS);
    terminal.emitter.emit("data", line);
    terminal.process.dispose();
  }
}

export const terminalService = new TerminalService();

function repairNodePtyHelperPermissions(): void {
  if (process.platform === "win32") return;
  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath) return;
  try {
    const stat = fs.statSync(helperPath);
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(helperPath, stat.mode | 0o755);
    }
  } catch {
    // Let node-pty surface the original spawn error; this repair is best effort.
  }
}

function resolveNodePtySpawnHelperPath(): string | null {
  try {
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");
    const packageRoot = path.dirname(path.dirname(unixTerminalPath));
    const candidates = [
      path.join(packageRoot, "build", "Release", "spawn-helper"),
      path.join(packageRoot, "build", "Debug", "spawn-helper"),
      path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  } catch {
    return null;
  }
}
