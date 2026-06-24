export type LogLevel = "debug" | "info" | "error";
export type LogFilterLevel = "error" | "info" | "debug";
export type LogModule = "chat" | "socket" | "prompt" | "tool" | "terminal" | "file" | "system";

export const DEFAULT_LOG_FILTER: LogFilterLevel = "info";
export const LOG_FILTER_LEVELS = ["error", "info", "debug"] as const;
export const MAX_REALTIME_LOG_ENTRIES = 500;
const visibleLevelsByFilter: Record<LogFilterLevel, readonly LogLevel[]> = {
  error: ["error"],
  info: ["error", "info"],
  debug: ["error", "info", "debug"]
};

export interface LogEntry {
  id: string;
  at: string;
  level: LogLevel;
  module: LogModule;
  event: string;
  detail?: unknown;
}

export interface LogInput {
  level: LogLevel;
  module: LogModule;
  event: string;
  detail?: unknown;
}

export type LogWriter = (level: LogLevel, module: LogModule, event: string, detail?: unknown) => void;

export function createLogInput(level: LogLevel, module: LogModule, event: string, detail?: unknown): LogInput {
  return detail === undefined
    ? { level, module, event }
    : { level, module, event, detail };
}

export function createLogEntry(input: LogInput): LogEntry {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...input
  };
}

export function appendRealtimeLog(
  logs: LogEntry[],
  input: LogInput,
  limit = MAX_REALTIME_LOG_ENTRIES
): LogEntry[] {
  const next = [...logs, createLogEntry(input)];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function visibleLevelsForFilter(filter: LogFilterLevel): Set<LogLevel> {
  return new Set(visibleLevelsByFilter[filter]);
}

export function filterRealtimeLogs(logs: LogEntry[], filter: LogFilterLevel): LogEntry[] {
  const visibleLevels = visibleLevelsForFilter(filter);
  return logs.filter((entry) => visibleLevels.has(entry.level));
}

export function formatLogDetail(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
