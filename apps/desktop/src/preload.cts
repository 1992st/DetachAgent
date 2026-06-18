import { contextBridge } from "electron";

const apiOriginArg = process.argv.find((arg) => arg.startsWith("--detaches-api-origin="));

contextBridge.exposeInMainWorld("detachesDesktop", {
  platform: process.platform,
  apiOrigin: apiOriginArg?.slice("--detaches-api-origin=".length) || "http://127.0.0.1:38888"
});
