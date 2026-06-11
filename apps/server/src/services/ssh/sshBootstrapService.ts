import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import SftpClient from "ssh2-sftp-client";

const execFileAsync = promisify(execFile);

export interface SshBootstrapInput {
  host: string;
  port: number;
  user: string;
  password: string;
  identityPath?: string;
}

export interface SshBootstrapResult {
  ok: boolean;
  identityPath: string;
  publicKeyPath: string;
  message: string;
}

type PasswordSftpClient = SftpClient & {
  chmod(remotePath: string, mode: number): Promise<void>;
  get(remotePath: string): Promise<Buffer | string>;
  put(input: Buffer, remotePath: string): Promise<void>;
};

export async function bootstrapSshIdentity(input: SshBootstrapInput): Promise<SshBootstrapResult> {
  const host = input.host.trim();
  const user = input.user.trim();
  const password = input.password;
  if (!host) throw new Error("Remote host is required.");
  if (!user) throw new Error("SSH user is required.");
  if (!password) throw new Error("SSH password is required.");

  const identityPath = expandHome(safeIdentityPath(input.identityPath));
  const publicKeyPath = `${identityPath}.pub`;
  await ensureLocalKey(identityPath);
  const publicKey = (await fs.readFile(publicKeyPath, "utf8")).trim();
  if (!publicKey) throw new Error(`Public key is empty: ${publicKeyPath}`);

  const sftp = new SftpClient() as PasswordSftpClient;
  try {
    await sftp.connect({
      host,
      port: input.port || 22,
      username: user,
      password
    });
    await sftp.mkdir(".ssh", true);
    try {
      await sftp.chmod(".ssh", 0o700);
    } catch {
      // Some SFTP servers do not support chmod; SSH verification below is authoritative.
    }

    let authorizedKeys = "";
    try {
      const existing = await sftp.get(".ssh/authorized_keys");
      authorizedKeys = Buffer.isBuffer(existing) ? existing.toString("utf8") : String(existing);
    } catch {
      authorizedKeys = "";
    }
    const lines = authorizedKeys.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.includes(publicKey)) lines.push(publicKey);
    await sftp.put(Buffer.from(`${lines.join("\n")}\n`, "utf8"), ".ssh/authorized_keys");
    try {
      await sftp.chmod(".ssh/authorized_keys", 0o600);
    } catch {
      // Best effort; SSH verification will catch permission problems.
    }
  } finally {
    await sftp.end().catch(() => undefined);
  }

  await verifyKeyLogin({ host, port: input.port || 22, user, identityPath });
  return {
    ok: true,
    identityPath,
    publicKeyPath,
    message: `SSH key login verified for ${user}@${host}.`
  };
}

async function ensureLocalKey(identityPath: string): Promise<void> {
  try {
    await fs.access(identityPath);
    await fs.access(`${identityPath}.pub`);
    return;
  } catch {
    // Generate below.
  }
  await fs.mkdir(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  await execFileAsync("ssh-keygen", ["-t", "ed25519", "-f", identityPath, "-N", "", "-C", "detaches_agent"], { timeout: 15000 });
  await fs.chmod(identityPath, 0o600);
  await fs.chmod(`${identityPath}.pub`, 0o644);
}

async function verifyKeyLogin(input: { host: string; port: number; user: string; identityPath: string }): Promise<void> {
  await execFileAsync("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(input.port),
    "-i",
    input.identityPath,
    `${input.user}@${input.host}`,
    "true"
  ], { timeout: 15000 });
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function safeIdentityPath(value?: string): string {
  const trimmed = value?.trim() || "";
  if (!trimmed) return "~/.ssh/detaches_agent_ed25519";
  if (trimmed.startsWith("~/") || path.isAbsolute(trimmed)) return trimmed;
  return "~/.ssh/detaches_agent_ed25519";
}
