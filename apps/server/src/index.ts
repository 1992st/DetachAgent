import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import cors from "cors";
import express from "express";
import { appConfig } from "./config/appConfig.js";
import { runtimeConfig } from "./config/settingsStore.js";
import { apiRoutes } from "./routes/apiRoutes.js";
import { attachChatSocket } from "./ws/chatSocket.js";
import { attachTerminalSocket } from "./ws/terminalSocket.js";
import { attachToolBrokerSocket } from "./ws/toolBrokerSocket.js";

async function ensureStorage(): Promise<void> {
  for (const dir of ["uploads", "downloads", "cache", "logs"]) {
    await fs.mkdir(path.join(appConfig.storageDir, dir), { recursive: true });
  }
}

async function main(): Promise<void> {
  await ensureStorage();
  const config = await runtimeConfig();
  // 本机 UI、桌面 preload、Vite 代理都依赖 loopback；gatewayTerminalLocalIp 只是额外给 Main Agent 回连的网卡监听。
  // 运行中修改监听 IP 无法热切换，保存新 IP 后需要重启 Detach Agent 才会新增/切换这个监听地址。
  const primaryHost = process.env.DETACHES_SERVER_HOST?.trim() || appConfig.serverHost;
  const callbackHost = config.gatewayTerminalLocalIp?.trim() || "";
  const listenHosts = uniqueListenHosts([primaryHost, callbackHost]);
  appConfig.serverHost = primaryHost;
  appConfig.serverListenHosts = [];
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "4mb" }));
  app.use("/vendor", express.static(vendorRoot(), { fallthrough: true }));
  app.use("/api", apiRoutes);
  app.get("/", (_req, res) => res.json({ ok: true, app: "detaches_agent server" }));

  const server = http.createServer(app);
  attachChatSocket(server);
  attachTerminalSocket(server);
  attachToolBrokerSocket(server);
  let listenAttempts = 0;
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && listenAttempts < 5) {
      listenAttempts += 1;
      console.error(`Port ${appConfig.serverPort} is busy on ${primaryHost}; retrying (${listenAttempts}/5)...`);
      setTimeout(() => server.listen(appConfig.serverPort, primaryHost), 500);
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${appConfig.serverPort} is already in use on ${primaryHost}. Stop the existing server or change DETACHES_SERVER_PORT.`);
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(appConfig.serverPort, primaryHost, () => {
    markListening(primaryHost);
    console.log(`detaches_agent server http://${primaryHost}:${appConfig.serverPort}`);
    for (const host of listenHosts.filter((host) => host !== primaryHost)) {
      startExtraListener(app, host);
    }
  });
}

function vendorRoot(): string {
  const resourcesDir = process.env.DETACHES_RESOURCES_DIR?.trim();
  if (resourcesDir) return path.join(resourcesDir, "app", "web", "public", "vendor");
  return path.join(process.cwd(), "..", "web", "public", "vendor");
}

function uniqueListenHosts(hosts: string[]): string[] {
  const normalized = hosts.map((host) => host.trim()).filter(Boolean);
  return [...new Set(normalized)];
}

function startExtraListener(app: express.Express, host: string): void {
  const extra = http.createServer(app);
  attachChatSocket(extra);
  attachTerminalSocket(extra);
  attachToolBrokerSocket(extra);
  extra.on("error", (error: NodeJS.ErrnoException) => {
    console.error(`Extra callback listener ${host}:${appConfig.serverPort} failed: ${error.message}`);
  });
  extra.listen(appConfig.serverPort, host, () => {
    markListening(host);
    const address = extra.address() as AddressInfo | null;
    console.log(`detaches_agent callback listener http://${address?.address || host}:${address?.port || appConfig.serverPort}`);
  });
}

function markListening(host: string): void {
  appConfig.serverListenHosts = uniqueListenHosts([...appConfig.serverListenHosts, host]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
