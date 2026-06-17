import os from "node:os";
import { EventEmitter } from "node:events";
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn, type IPty } from "node-pty";
import { nanoid } from "nanoid";
import type { TerminalInfo, TerminalStatus } from "@detaches/shared";
import { platformService, type ShellLaunch } from "../platform/platformService.js";

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
  write(data: string): void;
  resize(cols: number, rows: number): void;
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

  async ensure(sessionKey: string, cols = 100, rows = 28): Promise<ManagedTerminal> {
    const existing = this.terminals.get(sessionKey);
    if (existing && existing.status !== "exited") {
      existing.lastActiveAt = new Date().toISOString();
      this.resize(existing, cols, rows);
      return existing;
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

  async snapshot(sessionKey: string): Promise<{ terminal: TerminalInfo; replay: string }> {
    const terminal = await this.ensure(sessionKey);
    return { terminal: this.info(terminal), replay: this.replay(terminal) };
  }

  write(terminal: ManagedTerminal, data: string): void {
    terminal.lastActiveAt = new Date().toISOString();
    terminal.process.write(data);
  }

  async runCommand(sessionKey: string, command: string): Promise<TerminalInfo> {
    const cleaned = command.trimEnd();
    if (!cleaned.trim()) throw new Error("Command is empty.");
    const terminal = await this.ensure(sessionKey);
    this.write(terminal, `${cleaned}\r`);
    return this.info(terminal);
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
      const pty = spawn(launch.shell, launch.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: launch.cwd || os.homedir(),
        env: launch.env
      });
      return {
        process: {
          write: (data) => pty.write(data),
          resize: (nextCols, nextRows) => pty.resize(nextCols, nextRows)
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
        write: (data) => child.stdin.write(data.replaceAll("\r", "\n")),
        resize: () => undefined
      },
      onData: (handler) => {
        handler(`[node-pty unavailable: ${fallbackReason}; using pipe terminal fallback]\r\n`);
        child.stdout.on("data", (chunk: Buffer) => handler(chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => handler(chunk.toString("utf8")));
      },
      onExit: (handler) => child.on("exit", (code, signal) => handler(code ?? 0, typeof signal === "string" ? undefined : signal ?? undefined))
    };
  }
}

export const terminalService = new TerminalService();
