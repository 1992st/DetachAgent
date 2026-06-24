const host = process.env.DETACHES_SERVER_HOST || "127.0.0.1";
const port = Number(process.env.DETACHES_SERVER_PORT || 38888);
const timeoutMs = Number(process.env.DETACHES_WAIT_TIMEOUT_MS || 15000);
const startedAt = Date.now();
const url = `http://${host}:${port}/api/health`;

async function wait() {
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for detaches_agent server at ${url}: ${lastError || "no response"}`);
}

wait().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

