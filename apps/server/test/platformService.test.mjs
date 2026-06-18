import assert from "node:assert/strict";
import path from "node:path";
import { PlatformService } from "../dist/services/platform/platformService.js";

const win = new PlatformService({
  platform: "win32",
  homeDir: "C:\\Users\\alice",
  env: {
    COMSPEC: "C:\\Windows\\System32\\cmd.exe"
  }
});

const posix = new PlatformService({
  platform: "darwin",
  homeDir: "/Users/alice",
  env: {
    SHELL: "/bin/zsh"
  }
});

const linuxWithBash = new PlatformService({
  platform: "linux",
  homeDir: "/home/alice",
  env: {},
  pathExists: (filePath) => filePath === "/bin/bash"
});

const linuxWithoutBash = new PlatformService({
  platform: "linux",
  homeDir: "/home/alice",
  env: {},
  pathExists: () => false
});

assert.equal(
  win.getAppDataDir(),
  "C:\\Users\\alice\\.detach_agent",
  "Windows app data path should default to ~/.detach_agent"
);

assert.equal(
  posix.getAppDataDir(),
  "/Users/alice/.detach_agent",
  "POSIX app data path should default to ~/.detach_agent"
);

assert.equal(
  linuxWithBash.getAppDataDir(),
  "/home/alice/.detach_agent",
  "Linux app data path should default to ~/.detach_agent"
);

assert.equal(
  win.getDefaultIdentityPath(),
  "C:\\Users\\alice\\.ssh\\detaches_agent_ed25519",
  "Windows default SSH identity path should live under the user profile"
);

assert.equal(
  win.normalizeLocalPath("C:\\Users\\alice\\Downloads\\demo.txt"),
  "C:\\Users\\alice\\Downloads\\demo.txt",
  "Windows absolute local paths should be accepted"
);

assert.equal(win.normalizeLocalPath("Downloads\\demo.txt"), null, "Windows relative local paths should be rejected");

const powerShell = win.buildShellLaunch("Write-Host ok", { cwd: "C:\\Users\\alice" });
assert.equal(powerShell.shell, "powershell.exe", "Windows shell launch should default to PowerShell");
assert.deepEqual(
  powerShell.args.slice(0, 4),
  ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass"],
  "PowerShell launch should use non-interactive-safe flags"
);

assert.equal(linuxWithBash.getDefaultShell(), "/bin/bash", "Linux should fall back to /bin/bash when SHELL is unset and bash exists");
assert.equal(linuxWithoutBash.getDefaultShell(), "/bin/sh", "Linux should fall back to /bin/sh when bash is unavailable");

const linuxLaunch = linuxWithBash.buildInteractiveShellLaunch({ sessionName: "agent-main" });
assert.equal(linuxLaunch.shell, "/bin/bash", "Linux interactive launch should use the Linux fallback shell");
assert.match(linuxLaunch.displayCommand, /mkdir -p ~\/\.detach_agent\/workspaces/, "Linux terminal workspace should use ~/.detach_agent");
assert.match(linuxLaunch.displayCommand, /cd ~\/\.detach_agent\/workspaces/, "Linux terminal should cd into the unified workspace path");

const winLaunch = win.buildInteractiveShellLaunch();
assert.match(winLaunch.displayCommand, /\\.detach_agent\\workspaces/, "Windows terminal workspace should use ~/.detach_agent");

const winCurl = win.buildLocalCurlDownloadCommand("http://127.0.0.1:38888/file", "C:\\Users\\alice\\Downloads\\demo.txt");
assert.match(winCurl, /\$target = 'C:\\Users\\alice\\Downloads\\demo.txt'/, "Windows local download should target a PowerShell path");
assert.match(winCurl, /curl\.exe -fL/, "Windows local download should use curl.exe");

const posixCurl = posix.buildLocalCurlDownloadCommand("http://127.0.0.1:38888/file", "/tmp/demo.txt");
assert.match(posixCurl, /^mkdir -p '\/tmp' && curl -fL/, "POSIX local download should create the parent directory and use curl");

const winCompletion = win.wrapCommandForCompletion("Write-Output ok", "exec-123");
assert.match(winCompletion, /powershell\.exe/, "Windows completion wrapper should launch PowerShell");
assert.match(winCompletion, /-EncodedCommand/, "Windows completion wrapper should use encoded PowerShell script");

const posixCompletion = posix.wrapCommandForCompletion("printf ok", "exec-123");
assert.match(posixCompletion, /__DETACHES_TOOL_START__:exec-123/, "POSIX completion wrapper should print a start marker");
assert.match(posixCompletion, /__DETACHES_TOOL_END__:exec-123/, "POSIX completion wrapper should print an end marker");

assert.equal(
  posix.normalizeRemotePosixPath("~/workspace/file.txt", "/home/alice"),
  "/home/alice/workspace/file.txt",
  "POSIX remote home expansion should normalize under remote home"
);

assert.throws(
  () => posix.normalizeRemotePosixPath("relative/file.txt", "/home/alice"),
  /Remote path must be absolute/,
  "POSIX remote paths should reject relative values"
);

assert.equal(
  path.posix.normalize("/home/alice/workspace/../workspace/file.txt"),
  "/home/alice/workspace/file.txt",
  "Test harness should use posix normalization for remote path expectations"
);

console.log("platformService tests passed");
