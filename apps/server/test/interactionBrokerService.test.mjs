import assert from "node:assert/strict";
import { InteractionBrokerService } from "../dist/services/interactions/interactionBrokerService.js";

const service = new InteractionBrokerService();

const created = service.create({
  kind: "credential.request",
  sessionKey: "agent:test:main",
  agentId: "test",
  reason: "need ssh password",
  source: "gateway-event",
  sourceEventId: "credential-1",
  payload: {
    prompt: "Enter SSH password",
    target: { user: "alice", host: "example.test", port: 22 }
  }
});

assert.equal(created.interaction.status, "pending");
assert.equal(created.interaction.source, "gateway-event");
assert.equal(created.interaction.expiresAt !== undefined, true);

const duplicate = service.create({
  kind: "credential.request",
  sessionKey: "agent:test:main",
  source: "gateway-event",
  sourceEventId: "credential-1",
  payload: {}
});
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.interaction.id, created.interaction.id);

const localOnly = service.resolve(created.interaction.id, {
  mode: "local-handle",
  secret: "local-secret"
});
assert.equal(localOnly.interaction.status, "resolved");
assert.equal(localOnly.result.mode, "local-handle");
assert.match(localOnly.result.credentialHandle, /^cred_/);
assert.equal(JSON.stringify(localOnly).includes("local-secret"), false);
assert.equal(service.secretForHandle(localOnly.result.credentialHandle), "local-secret");

const revealCreated = service.create({
  kind: "credential.request",
  sessionKey: "agent:test:main",
  source: "gateway-event",
  sourceEventId: "credential-2",
  payload: {}
});
service.resolve(revealCreated.interaction.id, {
  mode: "reveal-once",
  secret: "reveal-secret"
});
const firstReveal = service.get(revealCreated.interaction.id, { consumeRevealSecret: true });
assert.equal(firstReveal.result.secret, "reveal-secret");
const secondReveal = service.get(revealCreated.interaction.id, { consumeRevealSecret: true });
assert.equal(secondReveal.result.secret, undefined);

const rejectedCreated = service.create({
  kind: "ui.confirm",
  sessionKey: "agent:test:main",
  source: "gateway-event",
  sourceEventId: "confirm-1",
  payload: {}
});
const rejected = service.reject(rejectedCreated.interaction.id, { error: "no" });
assert.equal(rejected.interaction.status, "rejected");
assert.equal(rejected.interaction.error, "no");

assert.throws(() => service.create({
  kind: "credential.request",
  sessionKey: "agent:test:main",
  source: "gateway-event",
  payload: {}
}), /sourceEventId/);

console.log("interactionBrokerService: ok");
