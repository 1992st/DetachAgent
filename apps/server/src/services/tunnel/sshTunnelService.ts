import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { runtimeConfig } from "../../config/settingsStore.js";

const execFileAsync = promisify(execFile);

export interface TunnelStatus {
  ok: boolean;
  message: string;
  localPort: number;
  pid?: number;
  stderr?: string;
  owner?: PortOwner | null;
  ownedByManagedProcess?: boolean;
}

interface PortOwner {
  command: string;
  pid: number;
  raw: string;
}

class SshTunnelService {
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stderr = "";
  private ensurePromise: Promise<TunnelStatus> | null = null;

  async ensure(): Promise<TunnelStatus> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureInternal();
    try {
      return await this.ensurePromise;
    } finally {
      this.ensurePromise = null;
    }
  }

  private async ensureInternal(): Promise<TunnelStatus> {
    const config = await runtimeConfig();
    if (!config.remoteUser) {
      return {
        ok: false,
        message: "OPENCLAW_REMOTE_USER is not configured; SSH tunnel disabled.",
        localPort: config.gatewayLocalPort
      };
    }

    if (!(await this.isTcpReachable(config.remoteHost, config.remoteSshPort, 2500))) {
      return {
        ok: false,
        message: `Remote SSH ${config.remoteHost}:${config.remoteSshPort} is not reachable.`,
        localPort: config.gatewayLocalPort
      };
    }

    if (await this.isPortListening(config.gatewayLocalPort)) {
      const ownedByThisProcess = Boolean(this.process?.pid && !this.process.killed);
      const owner = await this.portOwner(config.gatewayLocalPort);
      const ownedBySsh = owner?.command.toLowerCase().includes("ssh") ?? false;
      return {
        ok: ownedByThisProcess || ownedBySsh,
        message: ownedByThisProcess
          ? "SSH tunnel is already listening."
          : ownedBySsh
            ? "Configured local gateway port is owned by an external ssh process."
            : `Configured local gateway port is already owned by ${owner?.command ?? "another process"}; refusing to treat it as an SSH tunnel.`,
        localPort: config.gatewayLocalPort,
        pid: this.process?.pid ?? owner?.pid,
        owner,
        ownedByManagedProcess: ownedByThisProcess
      };
    }

    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    this.stderr = "";
    const args = [
      "-N",
      "-L",
      `${config.gatewayLocalPort}:${config.gatewayRemoteHost}:${config.gatewayRemotePort}`,
      "-p",
      String(config.remoteSshPort),
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3"
    ];
    if (config.remoteIdentityPath) {
      args.push("-i", config.remoteIdentityPath);
    }
    args.push(`${config.remoteUser}@${config.remoteHost}`);

    this.process = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const child = this.process;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
    });
    child.on("exit", () => {
      this.process = null;
    });

    const listening = await this.waitForListeningOrExit(child, config.gatewayLocalPort, 3500);
    return {
      ok: listening,
      message: listening ? "SSH tunnel is ready." : this.stderr || "SSH tunnel did not become ready.",
      localPort: config.gatewayLocalPort,
      pid: this.process?.pid,
      stderr: this.stderr || undefined
    };
  }

  stop(): void {
    this.ensurePromise = null;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
  }

  private isPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(700, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private isTcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private async portOwner(port: number): Promise<PortOwner | null> {
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

  async localPortOwner(port: number): Promise<PortOwner | null> {
    return this.portOwner(port);
  }

  private waitForListeningOrExit(child: ChildProcessByStdio<null, Readable, Readable>, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(value);
      };
      const onExit = () => finish(false);
      const poll = async () => {
        if (settled) return;
        if (await this.isPortListening(port)) {
          finish(true);
          return;
        }
        timer = setTimeout(poll, 100);
      };
      child.once("exit", onExit);
      timer = setTimeout(() => finish(false), timeoutMs);
      void poll();
    });
  }
}

export const sshTunnelService = new SshTunnelService();
