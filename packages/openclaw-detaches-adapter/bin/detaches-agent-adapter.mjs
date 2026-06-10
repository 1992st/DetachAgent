#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const adapterDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(adapterDir, "adapter.manifest.json");

function usage(exitCode = 0) {
  const out = [
    "detaches-agent-adapter",
    "",
    "Commands:",
    "  manifest",
    "  validate-context <context-json-file>",
    "  inspect-context <context-json-file>",
    "  terminal-request --target <target> --command <command> --reason <reason>",
    "  file-transfer-request --file-id <id> --target <target> --remote-path <path> --reason <reason>",
    "",
    "This CLI does not execute tools. It only validates context and emits detaches_agent request blocks."
  ].join("\n");
  (exitCode === 0 ? console.log : console.error)(out);
  process.exit(exitCode);
}

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const key = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function validateContext(context) {
  const manifest = readManifest();
  const missing = manifest.requiredContextFields.filter((field) => context?.[field] === undefined);
  const errors = [];
  if (missing.length) errors.push(`missing required fields: ${missing.join(", ")}`);
  if (context?.app !== "detaches_agent") errors.push("app must be detaches_agent");
  if (context?.version !== 1) errors.push("version must be 1");
  if (typeof context?.sessionKey !== "string" || !context.sessionKey) errors.push("sessionKey must be a non-empty string");
  if (!Array.isArray(context?.capabilities)) errors.push("capabilities must be an array");
  if (!Array.isArray(context?.invariants)) errors.push("invariants must be an array");
  return errors;
}

function listCapabilities(context) {
  return Array.isArray(context?.capabilities) ? context.capabilities : [];
}

function inspectContext(context) {
  const manifest = readManifest();
  const errors = validateContext(context);
  const capabilities = listCapabilities(context).map((capability) => ({
    name: capability?.name,
    requestFence: capability?.requestFence,
    supportedTargets: Array.isArray(capability?.supportedTargets) ? capability.supportedTargets : [],
    unavailableTargets: Array.isArray(capability?.unavailableTargets) ? capability.unavailableTargets : [],
    approvalRequired: Boolean(capability?.approvalRequired),
    executionHost: capability?.executionHost
  }));
  const targetSupport = Object.fromEntries(Object.keys(manifest.targets).map((target) => {
    const supportedBy = capabilities
      .filter((capability) => capability.supportedTargets.includes(target))
      .map((capability) => capability.name);
    const unavailableBy = capabilities
      .filter((capability) => capability.unavailableTargets.includes(target))
      .map((capability) => capability.name);
    return [target, {
      manifestStatus: manifest.targets[target].status,
      supportedBy,
      unavailableBy,
      requestable: supportedBy.length > 0 && unavailableBy.length === 0
    }];
  }));
  const adapterStatus = context?.adapterStatus?.remoteAgentHost;
  const warnings = [];
  for (const [target, status] of Object.entries(targetSupport)) {
    if (status.unavailableBy.length > 0) {
      warnings.push(`${target} is unavailable for: ${status.unavailableBy.join(", ")}`);
    }
  }
  if (adapterStatus?.state === "ready") {
    warnings.push("remote-agent-host adapter assets are detected, but tool routing still depends on detaches_agent capability targets and approval.");
  }
  return {
    ok: errors.length === 0,
    errors,
    adapterId: manifest.id,
    app: context?.app,
    sessionKey: context?.sessionKey,
    agentId: context?.agentId ?? null,
    userDevice: context?.userDevice ?? null,
    adapterStatus: adapterStatus ?? null,
    capabilities,
    targetSupport,
    warnings,
    hardRules: manifest.hardRules
  };
}

function requireOption(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) fail(`Missing --${name}`);
  return value.trim();
}

function emitFence(fence, payload) {
  console.log(`\`\`\`${fence}`);
  console.log(JSON.stringify(payload));
  console.log("```");
}

function assertKnownTarget(target) {
  const manifest = readManifest();
  if (!Object.prototype.hasOwnProperty.call(manifest.targets, target)) {
    fail(`Unknown target: ${target}`);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage(0);

  if (command === "manifest") {
    console.log(JSON.stringify(readManifest(), null, 2));
    return;
  }

  if (command === "validate-context") {
    const file = rest[0];
    if (!file) usage(1);
    const context = JSON.parse(fs.readFileSync(file, "utf8"));
    const errors = validateContext(context);
    if (errors.length) {
      console.error(JSON.stringify({ ok: false, errors }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true }, null, 2));
    return;
  }

  if (command === "inspect-context") {
    const file = rest[0];
    if (!file) usage(1);
    const context = JSON.parse(fs.readFileSync(file, "utf8"));
    const result = inspectContext(context);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  const args = parseArgs(rest);
  if (command === "terminal-request") {
    const target = requireOption(args, "target");
    assertKnownTarget(target);
    emitFence("detaches-terminal", {
      target,
      command: requireOption(args, "command"),
      reason: requireOption(args, "reason")
    });
    return;
  }

  if (command === "file-transfer-request") {
    const target = requireOption(args, "target");
    assertKnownTarget(target);
    emitFence("detaches-file-transfer", {
      fileId: requireOption(args, "file-id"),
      target,
      remotePath: requireOption(args, "remote-path"),
      reason: requireOption(args, "reason")
    });
    return;
  }

  usage(1);
}

main();
