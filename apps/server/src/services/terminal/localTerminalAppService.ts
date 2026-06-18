import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalTerminalApp, LocalTerminalAppsResponse, LocalTerminalOpenResponse } from "@detaches/shared";
import { platformService } from "../platform/platformService.js";

const execFileAsync = promisify(execFile);

const macTerminalApps: Array<Omit<LocalTerminalApp, "available">> = [
  { id: "terminal", name: "Terminal", appPath: "/System/Applications/Utilities/Terminal.app" },
  { id: "iterm", name: "iTerm", appPath: "/Applications/iTerm.app" },
  { id: "iterm2", name: "iTerm2", appPath: "/Applications/iTerm.app" },
  { id: "warp", name: "Warp", appPath: "/Applications/Warp.app" },
  { id: "ghostty", name: "Ghostty", appPath: "/Applications/Ghostty.app" },
  { id: "wezterm", name: "WezTerm", appPath: "/Applications/WezTerm.app" },
  { id: "alacritty", name: "Alacritty", appPath: "/Applications/Alacritty.app" },
  { id: "kitty", name: "kitty", appPath: "/Applications/kitty.app" }
];

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function macApps(): Promise<LocalTerminalApp[]> {
  const apps = await Promise.all(macTerminalApps.map(async (app) => ({ ...app, available: await exists(app.appPath) })));
  return apps.filter((app, index, all) => all.findIndex((candidate) => candidate.appPath === app.appPath) === index);
}

async function windowsApps(): Promise<LocalTerminalApp[]> {
  const candidates: Array<Omit<LocalTerminalApp, "available">> = [
    { id: "windows-terminal", name: "Windows Terminal", appPath: "wt.exe" },
    { id: "powershell", name: "PowerShell", appPath: "powershell.exe" },
    { id: "cmd", name: "Command Prompt", appPath: "cmd.exe" }
  ];
  const apps = await Promise.all(candidates.map(async (app) => {
    try {
      await execFileAsync("where.exe", [app.appPath], { timeout: 1500 });
      return { ...app, available: true };
    } catch {
      return { ...app, available: false };
    }
  }));
  return apps;
}

export const localTerminalAppService = {
  async list(): Promise<LocalTerminalAppsResponse> {
    const platform = platformService.currentNodePlatform();
    if (platform === "darwin") return { platform, apps: await macApps() };
    if (platform === "win32") return { platform, apps: await windowsApps() };
    return { platform, apps: [] };
  },

  async open(appId: string): Promise<LocalTerminalOpenResponse> {
    const platform = platformService.currentNodePlatform();
    if (platform === "win32") {
      const apps = await windowsApps();
      const app = apps.find((candidate) => candidate.id === appId);
      if (!app) throw new Error(`Unknown terminal app: ${appId}`);
      if (!app.available) throw new Error(`${app.name} is not available in PATH as ${app.appPath}.`);
      if (app.id === "windows-terminal") {
        await execFileAsync(app.appPath, [], { timeout: 5000 });
      } else if (app.id === "powershell") {
        await execFileAsync(app.appPath, ["-NoLogo"], { timeout: 5000 });
      } else {
        await execFileAsync(app.appPath, [], { timeout: 5000 });
      }
      return { ok: true, app, message: `${app.name} opened.` };
    }
    if (platform !== "darwin") {
      throw new Error("Opening local terminal apps is currently supported on macOS and Windows only.");
    }
    const apps = await macApps();
    const app = apps.find((candidate) => candidate.id === appId);
    if (!app) {
      throw new Error(`Unknown terminal app: ${appId}`);
    }
    if (!app.available) {
      throw new Error(`${app.name} is not installed at ${app.appPath}.`);
    }
    await execFileAsync("open", [app.appPath], { timeout: 5000 });
    return { ok: true, app, message: `${app.name} opened.` };
  }
};
