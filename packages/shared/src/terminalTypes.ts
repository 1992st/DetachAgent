export type TerminalStatus = "starting" | "connected" | "exited" | "error";
export type TerminalPrivilege = "user" | "administrator";

export interface TerminalInfo {
  terminalId: string;
  sessionKey: string;
  status: TerminalStatus;
  privilege: TerminalPrivilege;
  createdAt: string;
  lastActiveAt: string;
  command: string;
}

export interface LocalTerminalApp {
  id: string;
  name: string;
  appPath: string;
  available: boolean;
}

export interface LocalTerminalAppsResponse {
  apps: LocalTerminalApp[];
  platform: string;
}

export interface LocalTerminalOpenResponse {
  ok: boolean;
  app: LocalTerminalApp;
  message: string;
}

export interface AdminTerminalStatusResponse {
  ok: boolean;
  supported: boolean;
  active: boolean;
  sessionKey?: string;
  terminal?: TerminalInfo;
  message?: string;
}

export type TerminalSocketServerEvent =
  | { type: "ready"; terminal: TerminalInfo; replay: string }
  | { type: "data"; data: string }
  | { type: "status"; terminal: TerminalInfo }
  | { type: "error"; message: string };

export type TerminalSocketClientEvent =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };
