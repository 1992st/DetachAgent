import type { DetachesLocalMachineContext } from "@detaches/shared";
import { platformService } from "./platformService.js";

export function buildLocalMachineContext(): DetachesLocalMachineContext {
  const info = platformService.getPlatformInfo();
  const shell = platformService.getDefaultShell();
  const isWindows = info.os === "win32";
  const isPosix = info.os === "darwin" || info.os === "linux";
  return {
    os: info.os,
    nodePlatform: info.nodePlatform,
    arch: info.arch,
    shell,
    pathStyle: isWindows ? "windows" : isPosix ? "posix" : "unknown",
    pathSeparator: info.pathSeparator,
    commandDialect: isWindows ? "powershell" : isPosix ? "posix-shell" : "unknown",
    appDataDir: info.appDataDir
  };
}
