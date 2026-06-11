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
  reverseHost?: string;
  reversePort?: number;
  reverseBrokerUrl?: string;
  pid?: number;
  stderr?: string;
  owner?: PortOwner | null;
  ownedByManagedProcess?: boolean;
  localForwardManaged?: boolean;
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
        localPort: config.gatewayLocalPort,
        reverseHost: config.reverseBridgeRemoteHost,
        reversePort: config.reverseBridgeRemotePort,
        reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`
      };
    }

    if (!(await this.isTcpReachable(config.remoteHost, config.remoteSshPort, 2500))) {
      return {
        ok: false,
        message: `Remote SSH ${config.remoteHost}:${config.remoteSshPort} is not reachable.`,
        localPort: config.gatewayLocalPort,
        reverseHost: config.reverseBridgeRemoteHost,
        reversePort: config.reverseBridgeRemotePort,
        reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`
      };
    }

    let includeLocalForward = true;
    if (await this.isPortListening(config.gatewayLocalPort)) {
      const ownedByThisProcess = Boolean(this.process?.pid && !this.process.killed);
      const owner = await this.portOwner(config.gatewayLocalPort);
      const ownedBySsh = owner?.command.toLowerCase().includes("ssh") ?? false;
      if (ownedByThisProcess) {
        return {
          ok: true,
          message: "SSH tunnel is already listening.",
          localPort: config.gatewayLocalPort,
          reverseHost: config.reverseBridgeRemoteHost,
          reversePort: config.reverseBridgeRemotePort,
          reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`,
          pid: this.process?.pid,
          owner,
          ownedByManagedProcess: true,
          localForwardManaged: true
        };
      }
      if (ownedBySsh) {
        includeLocalForward = false;
      } else {
        return {
          ok: false,
          message: `Configured local gateway port is already owned by ${owner?.command ?? "another process"}; refusing to treat it as an SSH tunnel.`,
          localPort: config.gatewayLocalPort,
          reverseHost: config.reverseBridgeRemoteHost,
          reversePort: config.reverseBridgeRemotePort,
          reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`,
          pid: owner?.pid,
          owner,
          ownedByManagedProcess: false,
          localForwardManaged: false
        };
      }
    }

    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    this.stderr = "";
    const args = [
      "-N",
      ...(includeLocalForward
        ? ["-L", `${config.gatewayLocalPort}:${config.gatewayRemoteHost}:${config.gatewayRemotePort}`]
        : []),
      "-R",
      `${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}:127.0.0.1:${config.serverPort}`,
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

    const listening = includeLocalForward
      ? await this.waitForListeningOrExit(child, config.gatewayLocalPort, 3500)
      : await this.waitForProcessReadyOrExit(child, 1500);
    return {
      ok: listening,
      message: listening
        ? includeLocalForward
          ? "SSH tunnel is ready with local Gateway forward and remote reverse broker bridge."
          : "SSH reverse broker bridge is ready; local Gateway forward is owned by an external ssh process."
        : this.stderr || "SSH tunnel did not become ready.",
      localPort: config.gatewayLocalPort,
      reverseHost: config.reverseBridgeRemoteHost,
      reversePort: config.reverseBridgeRemotePort,
      reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`,
      pid: this.process?.pid,
      stderr: this.stderr || undefined,
      localForwardManaged: includeLocalForward
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

  private waitForProcessReadyOrExit(child: ChildProcessByStdio<null, Readable, Readable>, timeoutMs: number): Promise<boolean> {
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
      child.once("exit", onExit);
      timer = setTimeout(() => finish(!child.killed), timeoutMs);
    });
  }
}

export const sshTunnelService = new SshTunnelService();
