import { spawn, spawnSync } from "node:child_process";

const children = new Set();

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function quoteForCmd(value) {
  const text = String(value);
  if (/^[\w@%+=:,./\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function spawnCommand(command, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: options.stdio || "inherit",
    shell: false
  };

  if (process.platform !== "win32") {
    return spawn(command, args, spawnOptions);
  }

  // Windows cannot launch .cmd/.bat with CreateProcess directly here.
  // Wrap pnpm.cmd with cmd.exe so Node spawn(shell:false) avoids EINVAL.
  const comspec = process.env.ComSpec || "cmd.exe";
  const commandLine = [command, ...args].map(quoteForCmd).join(" ");
  return spawn(comspec, ["/d", "/s", "/c", commandLine], spawnOptions);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, options);
    children.add(child);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      children.delete(child);
      if (signal) reject(new Error(`${command} ${args.join(" ")} exited with signal ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function start(command, args, options = {}) {
  const child = spawnCommand(command, args, { ...options, stdio: "inherit" });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

async function waitForWeb(timeoutMs = 20_000) {
  const url = process.env.DETACHES_WEB_URL || "http://127.0.0.1:5173";
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return url;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for web dev server at ${url}: ${lastError}`);
}

function stopChild(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Stop the exact process tree started by this dev helper. This prevents
    // stale Vite/Electron/server processes from keeping ports 5173/38888 busy.
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

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

async function main() {
  const pnpm = pnpmCommand();
  await run(pnpm, ["--filter", "@detaches/shared", "build"]);
  await run(pnpm, ["--filter", "@detaches/server", "build"]);
  await run(pnpm, ["--filter", "@detaches/desktop", "build"]);

  const web = start(pnpm, ["--filter", "@detaches/web", "dev"]);
  await waitForWeb();
  const desktop = start(pnpm, ["desktop:dev"]);

  await new Promise((resolve, reject) => {
    desktop.on("exit", (code) => {
      cleanup();
      if (code === 0 || code === null) resolve();
      else reject(new Error(`desktop:dev exited with code ${code}`));
    });
    web.on("exit", (code) => {
      cleanup();
      reject(new Error(`web dev server exited with code ${code ?? ""}`));
    });
  });
}

main().catch((error) => {
  cleanup();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
