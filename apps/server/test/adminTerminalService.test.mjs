import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { AdminTerminalService } from "../dist/services/terminal/adminTerminalService.js";

class MockSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];
  closeCode = null;
  closeReason = null;

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code, reason) {
    this.readyState = WebSocket.CLOSED;
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
    this.emit("close");
  }
}

const launches = [];
const service = new AdminTerminalService({
  platform: "win32",
  handshakeTimeoutMs: 5_000,
  launchElevated: async (session, cols, rows, script) => {
    launches.push({ session, cols, rows, script });
  }
});

const unsupported = new AdminTerminalService({ platform: "linux" });
assert.deepEqual(
  await unsupported.enable("session-linux"),
  {
    ok: false,
    supported: false,
    active: false,
    message: "Administrator terminal is only supported on Windows."
  },
  "non-Windows admin terminal requests should return unsupported"
);

const launching = await service.enable("session-a", 120, 32);
assert.equal(launching.ok, true, "Windows enable should request UAC launch");
assert.equal(launching.active, false, "enable should wait for helper websocket before becoming active");
assert.equal(launches.length, 1, "enable should launch one helper");
assert.match(launches[0].script, /\$psi\.Verb = 'runas'/, "launch script should use UAC RunAs");
const encodedMatch = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(launches[0].script);
assert.ok(encodedMatch, "launch script should carry an encoded elevated helper script");
const elevatedScript = Buffer.from(encodedMatch[1], "base64").toString("utf16le");
assert.match(
  elevatedScript,
  /dist\\services\\terminal\\adminTerminalHelper\.js/,
  "dev launches should use the built helper from dist instead of the TypeScript source directory"
);
assert.doesNotMatch(
  elevatedScript,
  /src\\services\\terminal\\adminTerminalHelper\.js/,
  "dev launches should not point UAC at a missing source-directory .js helper"
);

const socket = new MockSocket();
assert.equal(service.attachHelper(socket, launches[0].session.token, "session-a"), true, "helper should attach with the one-time token");
assert.equal(service.status("session-a").active, true, "attached helper should mark admin terminal active");
assert.equal(service.status("session-b").active, true, "administrator terminal should be local-global across chat sessions");
assert.equal(service.status("session-b").terminal.sessionKey, "session-b", "status should reflect the caller session while reusing the global admin terminal");

socket.emit("message", Buffer.from(JSON.stringify({ type: "hello", pid: 123, shell: "powershell.exe" })));
socket.emit("message", Buffer.from(JSON.stringify({ type: "data", data: "admin-ready\r\n" })));
assert.match(service.snapshot("session-a").replay, /admin-ready/, "replay should include helper output");
assert.match(service.snapshot("session-b").replay, /admin-ready/, "replay should be shared across sessions");

const handle = await service.ensure("session-a");
service.write(handle, "whoami\r");
service.resize(handle, 100, 30);
assert.deepEqual(socket.sent.at(-2), { type: "input", data: "whoami\r" }, "write should forward input to helper socket");
assert.deepEqual(socket.sent.at(-1), { type: "resize", cols: 100, rows: 30 }, "resize should forward dimensions to helper socket");

const duplicate = new MockSocket();
assert.equal(service.attachHelper(duplicate, launches[0].session.token, "session-a"), false, "token should not attach a second helper");
assert.equal(duplicate.closeCode, 1008, "invalid helper attach should close with policy violation");

await service.disable("session-a");
assert.equal(service.status("session-a").active, false, "disable should stop admin terminal");
assert.deepEqual(socket.sent.at(-1), { type: "stop" }, "disable should ask helper to stop");

console.log("adminTerminalService: ok");
