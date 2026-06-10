import { spawn } from "node:child_process";
import type { AgentSummary } from "@detaches/shared";
import { runtimeConfig } from "../../config/settingsStore.js";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface SshTarget {
  host: string;
  baseArgs: string[];
}

export interface AgentCliDiscoveryResult {
  agents: AgentSummary[];
  raw?: unknown;
  skipped?: string;
  error?: string;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`ssh command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `ssh exited with code ${code ?? "unknown"}`));
    });
  });
}

function runSshCommand(args: string[], timeoutMs: number): Promise<CommandResult> {
  return runCommand("ssh", args, timeoutMs);
}

function parseDiskAgentLines(stdout: string): unknown[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const id = line.split("/").filter(Boolean).pop() ?? line;
      return {
        id,
        name: id,
        path: line,
        runtime: "disk",
        source: "remote-disk"
      };
    });
}

function buildAgentMainSessionKey(agentId: string): string {
  return `agent:${agentId.trim().toLowerCase() || "main"}:main`;
}

function summaryFromCliAgent(item: any, index: number): AgentSummary | null {
  const id = String(item.id ?? item.agentId ?? item.agent_id ?? item.name ?? `cli-agent-${index + 1}`).trim();
  if (!id) return null;
  const sessionKey = String(item.sessionKey ?? item.key ?? item.mainSessionKey ?? buildAgentMainSessionKey(id));
  const title = String(
    item.identity?.name ??
    item.displayName ??
    item.title ??
    item.label ??
    item.name ??
    id
  );
  const runtime = String(item.agentRuntime?.id ?? item.runtime ?? item.status ?? item.state ?? "cli");
  const model = String(item.model?.primary ?? item.model ?? item.workspace ?? item.path ?? "openclaw agents list");
  return {
    id,
    sessionKey,
    title,
    status: runtime,
    preview: model,
    raw: item
  };
}

export async function discoverAgentsViaCli(): Promise<AgentCliDiscoveryResult> {
  const config = await runtimeConfig();
  if (!config.remoteUser) {
    return { agents: [], skipped: "SSH user is not configured; CLI agent discovery skipped." };
  }

  const target: SshTarget = {
    host: `${config.remoteUser}@${config.remoteHost}`,
    baseArgs: [
    "-p", String(config.remoteSshPort),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=1"
    ]
  };
  if (config.remoteIdentityPath) {
    target.baseArgs.push("-i", config.remoteIdentityPath, "-o", "IdentitiesOnly=yes");
  }

  const diskCommand = "find \"$HOME/.openclaw/agents\" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort";
  const diskArgs = [...target.baseArgs, target.host, diskCommand];

  try {
    const diskResult = await runSshCommand(diskArgs, 8000);
    const raw = parseDiskAgentLines(diskResult.stdout);
    const agents = raw
      .map(summaryFromCliAgent)
      .filter(Boolean) as AgentSummary[];
    return { agents, raw: { source: "remote-disk", agents: raw } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { agents: [], error: message };
  }
}
