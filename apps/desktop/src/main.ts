import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { app, BrowserWindow, dialog } from "electron";
import isDev from "electron-is-dev";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcessWithoutNullStreams | null = null;

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.appendFileSync(path.join(app.getPath("userData"), "desktop-main.log"), line);
  } catch {
    // Best-effort diagnostics only.
  }
}

function repoRoot(): string {
  return path.resolve(__dirname, "../../..");
}

function serverEntry(): string {
  if (isDev || process.env.DETACHES_DESKTOP_DEV === "1") {
    return path.join(repoRoot(), "apps", "server", "dist", "index.js");
  }
  return path.join(process.resourcesPath, "app", "server", "dist", "index.js");
}

function serverRuntimeRoot(): string {
  if (isDev || process.env.DETACHES_DESKTOP_DEV === "1") {
    return path.join(repoRoot(), "apps", "server");
  }
  return path.join(process.resourcesPath, "app", "server");
}

function serverOrigin(): string {
  const host = process.env.DETACHES_SERVER_HOST || "127.0.0.1";
  const port = process.env.DETACHES_SERVER_PORT || "38888";
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}

function webEntry(): string {
  if (isDev || process.env.DETACHES_DESKTOP_DEV === "1") {
    return process.env.DETACHES_WEB_URL || "http://127.0.0.1:5173";
  }
  const url = new URL(pathToFileURL(path.join(process.resourcesPath, "app", "web", "dist", "index.html")).toString());
  url.searchParams.set("detachesApiOrigin", serverOrigin());
  return url.toString();
}

function serverEnv(): NodeJS.ProcessEnv {
  const runtimeNodePath = path.join(serverRuntimeRoot(), "node_modules", ".pnpm", "node_modules");
  const existingNodePath = process.env.NODE_PATH;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_PATH: existingNodePath ? `${runtimeNodePath}${path.delimiter}${existingNodePath}` : runtimeNodePath
  };
  if (!isDev && process.env.DETACHES_DESKTOP_DEV !== "1") {
    env.DETACHES_RESOURCES_DIR = process.resourcesPath;
  }
  return env;
}

function startServer(): void {
  if (serverProcess) return;
  const entry = serverEntry();
  const env = serverEnv();
  log(`starting server entry=${entry} resourcesPath=${process.resourcesPath} nodePath=${env.NODE_PATH ?? ""}`);
  serverProcess = spawn(process.execPath, [entry], {
    env,
    stdio: "pipe"
  });
  serverProcess.stdout.on("data", (chunk) => {
    log(`[server stdout] ${chunk.toString("utf8").trimEnd()}`);
  });
  serverProcess.stderr.on("data", (chunk) => {
    log(`[server stderr] ${chunk.toString("utf8").trimEnd()}`);
  });
  serverProcess.on("error", (error) => {
    log(`[server spawn error] ${error.message}`);
  });
  serverProcess.on("exit", (code, signal) => {
    log(`[server exit] code=${code ?? ""} signal=${signal ?? ""}`);
    serverProcess = null;
    if (mainWindow && code !== 0) {
      void dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Detaches Agent server stopped",
        message: `The local server exited unexpectedly. code=${code ?? ""} signal=${signal ?? ""}`.trim()
      });
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServerReady(timeoutMs = 15_000): Promise<boolean> {
  const healthUrl = `${serverOrigin()}/api/health`;
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        log(`server ready ${healthUrl}`);
        return true;
      }
      lastError = `${res.status} ${res.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  log(`server readiness timed out after ${timeoutMs}ms url=${healthUrl} lastError=${lastError}`);
  return false;
}

function stopServer(): void {
  if (!serverProcess) return;
  serverProcess.kill();
  serverProcess = null;
}

async function createWindow(): Promise<void> {
  const url = webEntry();
  log(`loading web url=${url}`);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--detaches-api-origin=${serverOrigin()}`]
    }
  });

  await mainWindow.loadURL(url);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", async () => {
  startServer();
  await waitForServerReady();
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (!mainWindow) await createWindow();
});

app.on("before-quit", () => {
  stopServer();
});
