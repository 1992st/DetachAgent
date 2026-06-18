import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const runtimeRoot = path.join(repoRoot, ".desktop-runtime", "app");

async function main() {
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await fs.mkdir(runtimeRoot, { recursive: true });

  await runPnpm(["--filter", "@detaches/server", "deploy", "--prod", "--no-optional", "--ignore-scripts", path.join(runtimeRoot, "server")]);
  await fs.rm(path.join(runtimeRoot, "server", "src"), { recursive: true, force: true });
  await fs.rm(path.join(runtimeRoot, "server", "test"), { recursive: true, force: true });
  await fs.rm(path.join(runtimeRoot, "server", "scripts"), { recursive: true, force: true });
  await fs.rm(path.join(runtimeRoot, "server", "tsconfig.json"), { force: true });

  await copyDir(path.join(repoRoot, "apps", "web", "dist"), path.join(runtimeRoot, "web", "dist"));
  await copyDir(path.join(repoRoot, "apps", "web", "public"), path.join(runtimeRoot, "web", "public"));
  await copyDir(path.join(repoRoot, "packages", "openclaw-detaches-adapter"), path.join(runtimeRoot, "packages", "openclaw-detaches-adapter"));
}

function runPnpm(args) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args]);
  }
  if (process.platform === "win32") {
    return run(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", "pnpm", ...args]);
  }
  return run("pnpm", args);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function copyDir(source, destination) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (item) => !item.includes(`${path.sep}node_modules${path.sep}`)
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
