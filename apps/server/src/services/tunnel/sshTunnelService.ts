import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../../config/appConfig.js";
import { runtimeConfig } from "../../config/settingsStore.js";
import { platformService, type PortOwner } from "../platform/platformService.js";
import { sshCredentialSessionService } from "../ssh/sshCredentialSessionService.js";

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

type AskpassSecret = { dir: string; passwordPath: string; scriptPath: string };

class SshTunnelService {
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stderr = "";
  private ensurePromise: Promise<TunnelStatus> | null = null;
  private reverseEnsurePromise: Promise<TunnelStatus> | null = null;

  async ensure(): Promise<TunnelStatus> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureInternal({ includeLocalForward: true });
    try {
      return await this.ensurePromise;
    } finally {
      this.ensurePromise = null;
    }
  }

  async ensureReverseBridge(): Promise<TunnelStatus> {
    if (this.reverseEnsurePromise) return this.reverseEnsurePromise;
    this.reverseEnsurePromise = this.ensureInternal({ includeLocalForward: false });
    try {
      return await this.reverseEnsurePromise;
    } finally {
      this.reverseEnsurePromise = null;
    }
  }

  private async ensureInternal(options: { includeLocalForward: boolean }): Promise<TunnelStatus> {
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

    let includeLocalForward = options.includeLocalForward;
    if (await this.isPortListening(config.gatewayLocalPort)) {
      const ownedByThisProcess = Boolean(this.process?.pid && !this.process.killed);
      const owner = await platformService.getPortOwner(config.gatewayLocalPort);
      const ownedBySsh = owner?.command.toLowerCase().includes("ssh") ?? false;
      if (ownedByThisProcess && options.includeLocalForward) {
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
      if (ownedBySsh || !options.includeLocalForward) {
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

    const ssh = await platformService.resolveCommand("ssh");
    if (ssh.available === false) {
      return {
        ok: false,
        message: `SSH client is not available. Expected command: ${ssh.command}.`,
        localPort: config.gatewayLocalPort,
        reverseHost: config.reverseBridgeRemoteHost,
        reversePort: config.reverseBridgeRemotePort,
        reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`
      };
    }
    const credentialTarget = sshCredentialSessionService.targetFromConfig(config);
    if (!credentialTarget) {
      return {
        ok: false,
        message: "Remote SSH target is incomplete; SSH tunnel disabled.",
        localPort: config.gatewayLocalPort,
        reverseHost: config.reverseBridgeRemoteHost,
        reversePort: config.reverseBridgeRemotePort,
        reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`
      };
    }

    // ssh-terminal 是高级兼容通道：只用 Main Agent SSH key 建立反向桥，不收集或保存 SSH 密码。
    // includeLocalForward=true 仍用于旧的 SSH Gateway tunnel 兼容路径，因此密码兜底只保留给旧路径。
    const passwordFallbackAllowed = options.includeLocalForward;
    const baseArgs = [
      ...ssh.argsPrefix,
      "-N",
      ...(includeLocalForward
        ? ["-L", `${config.gatewayLocalPort}:${config.gatewayRemoteHost}:${config.gatewayRemotePort}`]
        : []),
      "-R",
      `${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}:127.0.0.1:${config.serverPort}`,
      "-p",
      String(config.remoteSshPort),
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3"
    ];
    if (config.remoteIdentityPath) {
      baseArgs.push("-i", config.remoteIdentityPath);
    }
    baseArgs.push(`${config.remoteUser}@${config.remoteHost}`);

    const cachedPassword = passwordFallbackAllowed ? sshCredentialSessionService.getPassword(credentialTarget) : null;
    const firstAttempt = cachedPassword
      ? await this.spawnTunnel(ssh.command, [...baseArgs, ...sshPasswordAuthArgs()], includeLocalForward, config.gatewayLocalPort, cachedPassword)
      : await this.spawnTunnel(ssh.command, [...baseArgs, ...sshBatchModeArgs()], includeLocalForward, config.gatewayLocalPort);
    let activeAttempt = firstAttempt;
    if (!firstAttempt.listening && cachedPassword) {
      sshCredentialSessionService.markFailed(credentialTarget, firstAttempt.stderr || "SSH password authentication failed.", { clearPassword: true });
    }
    if (!firstAttempt.listening && passwordFallbackAllowed && (cachedPassword || isPasswordAuthFailure(firstAttempt.stderr))) {
      let password: string;
      try {
        password = await sshCredentialSessionService.requestPassword(credentialTarget, {
          force: Boolean(cachedPassword),
          message: "SSH password required to open the tunnel and reverse bridge."
        });
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          localPort: config.gatewayLocalPort,
          reverseHost: config.reverseBridgeRemoteHost,
          reversePort: config.reverseBridgeRemotePort,
          reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`,
          stderr: firstAttempt.stderr || undefined,
          localForwardManaged: includeLocalForward
        };
      }
      activeAttempt = await this.spawnTunnel(ssh.command, [...baseArgs, ...sshPasswordAuthArgs()], includeLocalForward, config.gatewayLocalPort, password);
      if (!activeAttempt.listening) {
        sshCredentialSessionService.markFailed(credentialTarget, activeAttempt.stderr || "SSH tunnel did not become ready.", { clearPassword: true });
      }
    }
    if (activeAttempt.listening) {
      sshCredentialSessionService.markReady(credentialTarget, "SSH tunnel is ready; password remains in memory for this app session.");
    }
    const listening = activeAttempt.listening;
    return {
      ok: listening,
      message: listening
        ? includeLocalForward
          ? "SSH tunnel is ready with local Gateway forward and remote reverse broker bridge."
          : options.includeLocalForward
            ? "SSH reverse broker bridge is ready; local Gateway forward is owned by an external ssh process."
            : "SSH reverse broker bridge is ready."
        : activeAttempt.stderr || "SSH tunnel did not become ready.",
      localPort: config.gatewayLocalPort,
      reverseHost: config.reverseBridgeRemoteHost,
      reversePort: config.reverseBridgeRemotePort,
      reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`,
      pid: this.process?.pid,
      stderr: activeAttempt.stderr || undefined,
      localForwardManaged: includeLocalForward
    };
  }

  stop(): void {
    this.ensurePromise = null;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    void runtimeConfig().then((config) => {
      const target = sshCredentialSessionService.targetFromConfig(config);
      if (target) sshCredentialSessionService.clear(target);
    }).catch(() => sshCredentialSessionService.clear());
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

  async localPortOwner(port: number): Promise<PortOwner | null> {
    return platformService.getPortOwner(port);
  }

  async status(): Promise<TunnelStatus> {
    const config = await runtimeConfig();
    const running = Boolean(this.process?.pid && !this.process.killed);
    return {
      ok: running,
      message: running
        ? "SSH reverse bridge process is running."
        : "SSH reverse bridge is not running. Use the network test to establish it when broker/context reachability is needed.",
      localPort: config.gatewayLocalPort,
      reverseHost: config.reverseBridgeRemoteHost,
      reversePort: config.reverseBridgeRemotePort,
      reverseBrokerUrl: `http://${config.reverseBridgeRemoteHost}:${config.reverseBridgeRemotePort}`,
      pid: this.process?.pid,
      localForwardManaged: config.gatewayTransport === "ssh"
    };
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

  private async spawnTunnel(
    command: string,
    args: string[],
    includeLocalForward: boolean,
    gatewayLocalPort: number,
    password?: string
  ): Promise<{ listening: boolean; stderr: string }> {
    this.stderr = "";
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    let askpass: AskpassSecret | null = null;
    try {
      askpass = password ? await createAskpassSecret(password) : null;
      this.process = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: askpass ? askpassEnv(askpass) : process.env
      });
      const child = this.process;
      child.stderr.on("data", (chunk: Buffer) => {
        this.stderr += chunk.toString("utf8");
        if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
      });
      child.on("exit", () => {
        if (this.process === child) this.process = null;
      });

      const listening = includeLocalForward
        ? await this.waitForListeningOrExit(child, gatewayLocalPort, 3500)
        : await this.waitForProcessReadyOrExit(child, 1500);
      if (!listening && this.process === child && !child.killed) {
        child.kill();
      }
      return { listening, stderr: this.stderr };
    } finally {
      if (askpass) await cleanupAskpassSecret(askpass);
    }
  }
}

export const sshTunnelService = new SshTunnelService();

function sshBatchModeArgs(): string[] {
  return [
    "-o",
    "BatchMode=yes"
  ];
}

function sshPasswordAuthArgs(): string[] {
  return [
    "-o",
    "BatchMode=no",
    "-o",
    "PreferredAuthentications=publickey,password,keyboard-interactive",
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ];
}

function isPasswordAuthFailure(stderr: string): boolean {
  return /permission denied|password|keyboard-interactive|publickey|authentication failed|too many authentication failures/i.test(stderr);
}

async function createAskpassSecret(password: string): Promise<AskpassSecret> {
  const dir = await fs.mkdtemp(path.join(appConfig.storageDir, "cache", "ssh-tunnel-askpass-"));
  const passwordPath = path.join(dir, "password.txt");
  const scriptPath = path.join(dir, "askpass.sh");
  await fs.writeFile(passwordPath, password, { mode: 0o600 });
  await fs.writeFile(scriptPath, [
    "#!/bin/sh",
    `cat ${shellQuote(passwordPath)}`
  ].join("\n"), { mode: 0o700 });
  return { dir, passwordPath, scriptPath };
}

async function cleanupAskpassSecret(secret: AskpassSecret): Promise<void> {
  await fs.rm(secret.dir, { recursive: true, force: true }).catch(() => undefined);
}

function askpassEnv(secret: AskpassSecret): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SSH_ASKPASS: secret.scriptPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: process.env.DISPLAY || "detaches-agent:0"
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
