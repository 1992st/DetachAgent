import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { app, BrowserWindow, dialog } from "electron";
import isDev from "electron-is-dev";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcessWithoutNullStreams | null = null;

function repoRoot(): string {
  return path.resolve(__dirname, "../../..");
}

function serverEntry(): string {
  if (isDev || process.env.DETACHES_DESKTOP_DEV === "1") {
    return path.join(repoRoot(), "apps", "server", "dist", "index.js");
  }
  return path.join(process.resourcesPath, "app.asar", "apps", "server", "dist", "index.js");
}

function webEntry(): string {
  if (isDev || process.env.DETACHES_DESKTOP_DEV === "1") {
    return process.env.DETACHES_WEB_URL || "http://127.0.0.1:5173";
  }
  return `file://${path.join(process.resourcesPath, "app.asar", "apps", "web", "dist", "index.html")}`;
}

function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DETACHES_RESOURCES_DIR: process.resourcesPath
  };
}

function startServer(): void {
  if (serverProcess) return;
  const entry = serverEntry();
  serverProcess = spawn(process.execPath, [entry], {
    env: serverEnv(),
    stdio: "pipe"
  });
  serverProcess.stdout.on("data", (chunk) => {
    console.log(`[server] ${chunk.toString("utf8").trimEnd()}`);
  });
  serverProcess.stderr.on("data", (chunk) => {
    console.error(`[server] ${chunk.toString("utf8").trimEnd()}`);
  });
  serverProcess.on("exit", (code, signal) => {
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

function stopServer(): void {
  if (!serverProcess) return;
  serverProcess.kill();
  serverProcess = null;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadURL(webEntry());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("ready", async () => {
  startServer();
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
