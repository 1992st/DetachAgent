import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("detachesDesktop", {
  platform: process.platform
});
