import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import cors from "cors";
import express from "express";
import { appConfig } from "./config/appConfig.js";
import { apiRoutes } from "./routes/apiRoutes.js";
import { attachChatSocket } from "./ws/chatSocket.js";
import { attachTerminalSocket } from "./ws/terminalSocket.js";

async function ensureStorage(): Promise<void> {
  for (const dir of ["uploads", "downloads", "cache", "logs"]) {
    await fs.mkdir(path.join(appConfig.storageDir, dir), { recursive: true });
  }
}

async function main(): Promise<void> {
  await ensureStorage();
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "4mb" }));
  app.use("/api", apiRoutes);
  app.get("/", (_req, res) => res.json({ ok: true, app: "detaches_agent server" }));

  const server = http.createServer(app);
  attachChatSocket(server);
  attachTerminalSocket(server);
  let listenAttempts = 0;
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && listenAttempts < 5) {
      listenAttempts += 1;
      console.error(`Port ${appConfig.serverPort} is busy; retrying (${listenAttempts}/5)...`);
      setTimeout(() => server.listen(appConfig.serverPort, appConfig.serverHost), 500);
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${appConfig.serverPort} is already in use. Stop the existing server or change DETACHES_SERVER_PORT.`);
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(appConfig.serverPort, appConfig.serverHost, () => {
    console.log(`detaches_agent server http://${appConfig.serverHost}:${appConfig.serverPort}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
