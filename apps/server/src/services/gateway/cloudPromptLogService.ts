import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../../config/appConfig.js";

export interface CloudPromptLogEntry {
  ts: string;
  event: "chat.send" | "chat.result";
  phase: "initial" | "fallback";
  method: "chat.send";
  sessionKey: string;
  idempotencyKey?: string;
  includeClientContext: boolean;
  includeLocalControlContext?: boolean;
  includeStagedFileContext?: boolean;
  localControlScope?: string;
  activationReason?: string;
  payload: unknown;
  ok?: boolean;
  durationMs?: number;
  error?: string;
}

export interface CloudPromptLogListResponse {
  path: string;
  entries: CloudPromptLogEntry[];
}

class CloudPromptLogService {
  logPath(): string {
    return path.join(appConfig.storageDir, "logs", "cloud-prompts.jsonl");
  }

  async logChatSend(entry: Omit<CloudPromptLogEntry, "ts" | "event" | "method">): Promise<void> {
    const record: CloudPromptLogEntry = {
      ts: new Date().toISOString(),
      event: "chat.send",
      method: "chat.send",
      ...entry
    };
    const logPath = this.logPath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  async logChatResult(entry: Omit<CloudPromptLogEntry, "ts" | "event" | "method" | "payload"> & { payload?: unknown }): Promise<void> {
    const record: CloudPromptLogEntry = {
      ts: new Date().toISOString(),
      event: "chat.result",
      method: "chat.send",
      payload: entry.payload,
      ...entry
    };
    const logPath = this.logPath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  async list(limit = 100): Promise<CloudPromptLogListResponse> {
    const logPath = this.logPath();
    let text = "";
    try {
      text = await fs.readFile(logPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const entries = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CloudPromptLogEntry)
      .slice(-limit);
    return { path: logPath, entries };
  }
}

export const cloudPromptLogService = new CloudPromptLogService();
