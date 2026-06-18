import assert from "node:assert/strict";
import { SshCredentialSessionService } from "../dist/services/ssh/sshCredentialSessionService.js";

const service = new SshCredentialSessionService();
const target = service.targetFromConfig({
  remoteHost: "example.test",
  remoteSshPort: 22,
  remoteUser: "alice"
});

assert.ok(target);
assert.equal(target.key, "alice@example.test:22");
assert.equal(service.status().state, "idle");
assert.equal(service.status().hasPassword, false);

const waiting = service.requestPassword(target, { message: "Need tunnel password." });
assert.equal(service.status().state, "waiting-password");
assert.equal(service.status().message, "Need tunnel password.");
assert.equal(JSON.stringify(service.status()).includes("secret-password"), false);

const provided = service.providePassword("secret-password");
assert.equal(provided.state, "ready");
assert.equal(provided.hasPassword, true);
assert.equal(JSON.stringify(provided).includes("secret-password"), false);
assert.equal(await waiting, "secret-password");
assert.equal(service.getPassword(target), "secret-password");

service.markFailed(target, "bad password", { clearPassword: true });
assert.equal(service.status().state, "failed");
assert.equal(service.status().hasPassword, false);
assert.equal(service.getPassword(target), null);

const waitingDismiss = service.requestPassword(target, { force: true });
const dismissed = service.dismiss();
assert.equal(dismissed.state, "dismissed");
await assert.rejects(waitingDismiss, /dismissed/);
await assert.rejects(() => service.requestPassword(target), /dismissed/);

const otherTarget = service.targetFromConfig({
  remoteHost: "other.test",
  remoteSshPort: 2222,
  remoteUser: "bob"
});
assert.ok(otherTarget);
const waitingOther = service.requestPassword(otherTarget);
assert.equal(service.status().target?.key, "bob@other.test:2222");
service.providePassword("other-secret");
assert.equal(await waitingOther, "other-secret");
assert.equal(service.getPassword(target), null);
assert.equal(service.getPassword(otherTarget), "other-secret");

service.clear(otherTarget);
assert.equal(service.status().state, "idle");
assert.equal(service.status().hasPassword, false);

console.log("sshCredentialSessionService: ok");
