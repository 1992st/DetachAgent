import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const appDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = fileURLToPath(new URL("../../..", import.meta.url));
const env = { ...process.env, DETACHES_DESKTOP_DEV: "1" };
const args = ["."];
const children = new Set();

function configureWindowsConsoleEncoding() {
  if (process.platform !== "win32") return;
  spawnSync("cmd.exe", ["/d", "/s", "/c", "chcp 65001 > nul"], { stdio: "ignore" });
  env.LANG = env.LANG || "C.UTF-8";
  env.PYTHONIOENCODING = env.PYTHONIOENCODING || "utf-8";
}

configureWindowsConsoleEncoding();

if (process.platform === "win32") {
  args.unshift("--disable-gpu", "--disable-software-rasterizer");
}

delete env.ELECTRON_RUN_AS_NODE;

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function quoteForCmd(value) {
  const text = String(value);
  if (/^[\w@%+=:,./\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function spawnCommand(command, commandArgs, options = {}) {
  const spawnOptions = {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: options.stdio || "inherit",
    shell: false
  };

  if (process.platform !== "win32") {
    return spawn(command, commandArgs, spawnOptions);
  }

  const comspec = process.env.ComSpec || "cmd.exe";
  const commandLine = [command, ...commandArgs].map(quoteForCmd).join(" ");
  return spawn(comspec, ["/d", "/s", "/c", commandLine], spawnOptions);
}

function start(command, commandArgs, options = {}) {
  const child = spawnCommand(command, commandArgs, options);
  if (options.track !== false) {
    children.add(child);
    child.on("exit", () => children.delete(child));
  }
  return child;
}

function stopChild(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  child.kill();
}

function cleanup() {
  for (const child of children) {
    stopChild(child);
  }
}

async function isUrlReady(url, timeoutMs = 800) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForWeb(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for web dev server at ${url}: ${lastError}`);
}

async function ensureWebDevServer() {
  const url = env.DETACHES_WEB_URL || "http://127.0.0.1:5173";
  if (await isUrlReady(url)) {
    console.log(`web dev server already running ${url}; reusing existing server`);
    return;
  }

  console.log(`starting web dev server ${url}`);
  const web = start(pnpmCommand(), ["--filter", "@detaches/web", "dev"], {
    cwd: repoDir,
    env,
    stdio: "inherit"
  });

  await Promise.race([
    waitForWeb(url),
    new Promise((_, reject) => {
      web.once("exit", (code, signal) => {
        reject(new Error(`web dev server exited before ready code=${code ?? ""} signal=${signal ?? ""}`));
      });
    })
  ]);
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

try {
  await ensureWebDevServer();
  const child = start(electronPath, args, {
    cwd: appDir,
    env,
    stdio: "inherit",
    track: false
  });

  child.on("exit", (code, signal) => {
    cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 0;
  });
} catch (error) {
  cleanup();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
