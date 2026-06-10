import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const { default: WebSocket } = await import(path.join(repoRoot, "apps/server/node_modules/ws/wrapper.mjs"));
const resultsDir = path.join(repoRoot, "testcase", "results");
const serverPort = Number(process.env.TESTCASE_SERVER_PORT ?? 39991);
const host = "127.0.0.1";

function nowIso() {
  return new Date().toISOString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(name, command, args, options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      resolve({
        name,
        status: "failed",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}${error.stack ?? error.message}`
      });
    });
    child.on("exit", (code) => {
      resolve({
        name,
        status: code === 0 ? "passed" : "failed",
        exitCode: code,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr
      });
    });
  });
}

async function waitForHttp(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function terminalPersistenceTest() {
  const startedAt = Date.now();
  const server = spawn("node", ["apps/server/dist/index.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DETACHES_SERVER_HOST: host,
      DETACHES_SERVER_PORT: String(serverPort),
      DETACHES_STORAGE_DIR: "./storage-smoke",
      OPENCLAW_GATEWAY_TRANSPORT: "direct",
      OPENCLAW_GATEWAY_DIRECT_HOST: "127.0.0.1",
      OPENCLAW_GATEWAY_REMOTE_PORT: "9",
      OPENCLAW_AUTH_MODE: "none"
    }
  });
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  server.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  function connectAndMaybeRun(run) {
    const url = `ws://${host}:${serverPort}/api/terminal/${encodeURIComponent("agent:testcase:detaches:persist")}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let output = "";
      let sent = false;
      const timer = setTimeout(() => {
        ws.close();
        resolve(output);
      }, 4500);
      ws.on("message", (data) => {
        const text = data.toString("utf8");
        output += `${text}\n`;
        if (run && text.includes("\"type\":\"ready\"") && !sent) {
          sent = true;
          ws.send(JSON.stringify({ type: "input", data: "echo testcase-terminal-proof\r" }));
        }
        if (run && output.includes("testcase-terminal-proof")) {
          clearTimeout(timer);
          setTimeout(() => {
            ws.close();
            resolve(output);
          }, 250);
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  try {
    await waitForHttp(`http://${host}:${serverPort}/`);
    const first = await connectAndMaybeRun(true);
    const second = await connectAndMaybeRun(false);
    const passed = first.includes("testcase-terminal-proof") && second.includes("testcase-terminal-proof");
    return {
      name: "terminal:persistence",
      status: passed ? "passed" : "failed",
      exitCode: passed ? 0 : 1,
      durationMs: Date.now() - startedAt,
      stdout: JSON.stringify({ first: first.slice(0, 1200), second: second.slice(0, 1200) }, null, 2),
      stderr: passed ? stderr : `${stderr}\nTerminal proof was not found in reconnect replay.`
    };
  } catch (error) {
    return {
      name: "terminal:persistence",
      status: "failed",
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr: `${stderr}\n${error.stack ?? error.message}`
    };
  } finally {
    server.kill("SIGTERM");
  }
}

function summarize(tests) {
  const passed = tests.filter((test) => test.status === "passed").length;
  const failed = tests.length - passed;
  return { total: tests.length, passed, failed };
}

async function main() {
  await fs.mkdir(resultsDir, { recursive: true });
  const tests = [];

  tests.push(await runCommand("typecheck", "pnpm", ["typecheck"]));
  tests.push(await runCommand("build", "pnpm", ["build"]));
  tests.push(await runCommand("adapter:openclaw-detaches", "pnpm", ["--filter", "@detaches/openclaw-detaches-adapter", "test"]));
  tests.push(await runCommand("smoke:gateway", "pnpm", ["smoke"]));
  tests.push(await terminalPersistenceTest());

  const result = {
    name: "detaches_agent full test",
    startedAt: nowIso(),
    summary: summarize(tests),
    tests
  };
  const resultPath = path.join(resultsDir, "full-test-latest.json");
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`Result: ${resultPath}`);
  process.exitCode = result.summary.failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
