import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { spawn, type IPty } from "node-pty";

interface HelperConfig {
  connectUrl: string;
  token: string;
  sessionKey: string;
  cols: number;
  rows: number;
}

function logPath(): string {
  return path.join(os.homedir(), ".detach_agent", "admin-terminal-helper.log");
}

function log(message: string): void {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging must never block the elevated helper.
  }
}

function parseArgs(argv: string[]): HelperConfig {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      args.set(item.slice(2), value);
      index += 1;
    } else {
      args.set(item.slice(2), "1");
    }
  }
  const connectUrl = args.get("connect-url") || "";
  const token = args.get("token") || "";
  const sessionKey = args.get("session-key") || "admin-terminal";
  if (!connectUrl || !token) throw new Error("Missing --connect-url or --token.");
  return {
    connectUrl,
    token,
    sessionKey,
    cols: safeDimension(args.get("cols"), 120, 40, 240),
    rows: safeDimension(args.get("rows"), 32, 10, 80)
  };
}

function safeDimension(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function powerShellExe(): string {
  return process.env.POWERSHELL_EXE || "powershell.exe";
}

function workspaceDir(): string {
  return path.join(os.homedir(), ".detach_agent", "admin-workspaces");
}

function startPty(config: HelperConfig): IPty {
  const startup = [
    `$workspace = '${workspaceDir().replace(/'/g, "''")}'`,
    "New-Item -ItemType Directory -Force -Path $workspace | Out-Null",
    "Set-Location $workspace",
    "Write-Output '[detaches_agent] Administrator terminal is ready.'"
  ].join("; ");
  log(`starting pty shell=${powerShellExe()} cwd=${os.homedir()} cols=${config.cols} rows=${config.rows}`);
  return spawn(powerShellExe(), [
    "-NoLogo",
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    startup
  ], {
    name: "xterm-256color",
    cols: config.cols,
    rows: config.rows,
    cwd: os.homedir(),
    env: process.env
  });
}

async function main(): Promise<void> {
  log(`helper start argv=${JSON.stringify(process.argv.slice(2))} execPath=${process.execPath} platform=${process.platform}`);
  if (process.platform !== "win32") throw new Error("Administrator terminal helper is Windows-only.");
  const config = parseArgs(process.argv.slice(2));
  const pty = startPty(config);
  const url = new URL(config.connectUrl);
  url.searchParams.set("token", config.token);
  url.searchParams.set("sessionKey", config.sessionKey);
  log(`connecting websocket ${url.origin}${url.pathname} sessionKey=${config.sessionKey}`);

  const socket = new WebSocket(url);
  let connected = false;

  socket.on("open", () => {
    connected = true;
    log("websocket open");
    socket.send(JSON.stringify({
      type: "hello",
      sessionKey: config.sessionKey,
      pid: process.pid,
      shell: powerShellExe()
    }));
  });

  pty.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "data", data }));
    }
  });

  pty.onExit(({ exitCode, signal }) => {
    log(`pty exit code=${exitCode} signal=${signal ?? ""}`);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "exit", exitCode, signal }));
      socket.close();
    }
    process.exit(exitCode || 0);
  });

  socket.on("message", (raw) => {
    let event: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      event = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number };
    } catch {
      return;
    }
    if (event.type === "input" && typeof event.data === "string") {
      pty.write(event.data);
    } else if (event.type === "resize") {
      pty.resize(safeDimension(String(event.cols ?? ""), config.cols, 40, 240), safeDimension(String(event.rows ?? ""), config.rows, 10, 80));
    } else if (event.type === "stop") {
      log("stop requested");
      pty.kill();
      socket.close();
      process.exit(0);
    }
  });

  socket.on("close", () => {
    log(`websocket close connected=${connected}`);
    pty.kill();
    process.exit(connected ? 0 : 1);
  });

  socket.on("error", (error) => {
    log(`websocket error ${error.message}`);
    pty.kill();
    process.exit(1);
  });
}

main().catch((error) => {
  log(`fatal ${error instanceof Error ? error.stack || error.message : String(error)}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
