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
    "  broker-probe <detaches-agent-base-url-or-capabilities-url>",
    "  terminal-request --target <target> --command <command> --reason <reason> [--context <detaches-context-json> --format fence|broker-event --session-key <key> --agent-id <id> --source-event-id <id> --submit-token <token> --submit-url <url> --submit]",
    "  file-transfer-request --file-id <id> --target <target> --remote-path <path> --reason <reason> [--context <detaches-context-json> --format fence|broker-event --session-key <key> --agent-id <id> --source-event-id <id> --submit-token <token> --submit-url <url> --submit]",
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

function detachesContextFrom(value) {
  if (value?.app === "detaches_agent" && value?.version === 1 && value?.sessionKey) return value;
  if (value?.detaches?.app === "detaches_agent") return value.detaches;
  if (value?.clientContext?.detaches?.app === "detaches_agent") return value.clientContext.detaches;
  return value;
}

function readContextFile(file) {
  return detachesContextFrom(JSON.parse(fs.readFileSync(file, "utf8")));
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
  const stagedFiles = Array.isArray(context?.files?.staged) ? context.files.staged.map((file) => ({
    fileId: file?.fileId,
    name: file?.name,
    displayName: file?.displayName,
    mimeType: file?.mimeType,
    size: file?.size,
    currentLocation: file?.currentLocation,
    remotePath: file?.remotePath ?? null,
    transfer: file?.transfer ?? null
  })) : [];
  const warnings = [];
  for (const [target, status] of Object.entries(targetSupport)) {
    if (status.unavailableBy.length > 0) {
      warnings.push(`${target} is unavailable for: ${status.unavailableBy.join(", ")}`);
    }
  }
  if (adapterStatus?.state === "ready") {
    warnings.push("remote-agent-host adapter assets are detected, but tool routing still depends on detaches_agent capability targets and approval.");
  }
  if (!context?.broker?.gatewayEventEndpoint) {
    warnings.push("broker.gatewayEventEndpoint is missing; fall back to fenced requests or ask detaches_agent to resend updated context.");
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
    broker: context?.broker ?? null,
    files: {
      staged: stagedFiles
    },
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

function optionalString(args, name) {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readContextOption(args) {
  const contextPath = optionalString(args, "context");
  if (!contextPath) return null;
  const context = readContextFile(contextPath);
  const errors = validateContext(context);
  if (errors.length) fail(`Invalid --context: ${errors.join("; ")}`);
  return context;
}

function brokerCapabilitiesUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) fail("Missing detaches_agent base URL.");
  if (trimmed.endsWith("/api/tools/broker/capabilities")) return trimmed;
  return `${trimmed}/api/tools/broker/capabilities`;
}

async function brokerProbe(value) {
  const url = brokerCapabilitiesUrl(value);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    fail(`Broker probe returned non-JSON response from ${url}: ${text}`);
  }
  const errors = [];
  if (!response.ok) errors.push(`HTTP ${response.status}`);
  if (payload?.app !== "detaches_agent") errors.push("app must be detaches_agent");
  if (payload?.protocolVersion !== 1) errors.push("protocolVersion must be 1");
  if (payload?.eventSource !== "gateway-event") errors.push("eventSource must be gateway-event");
  if (payload?.idempotencyField !== "sourceEventId") errors.push("idempotencyField must be sourceEventId");
  if (payload?.submitTokenRequired !== true) errors.push("submitTokenRequired must be true");
  if (payload?.submitTokenHeader !== "Authorization") errors.push("submitTokenHeader must be Authorization");
  if (!Array.isArray(payload?.requestFormats) || !payload.requestFormats.includes("broker-event")) errors.push("requestFormats must include broker-event");
  if (payload?.adapterId !== "detaches_agent.openclaw.adapter") errors.push("adapterId mismatch");
  const result = { ok: errors.length === 0, url, errors, capabilities: payload };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exit(1);
}

function emitFence(fence, payload) {
  console.log(`\`\`\`${fence}`);
  console.log(JSON.stringify(payload));
  console.log("```");
}

async function emitRequest(args, kind, target, reason, payload, fence) {
  const context = readContextOption(args);
  const format = typeof args.format === "string" ? args.format : "fence";
  const submitUrl = optionalString(args, "submit-url") || (args.submit === true ? context?.broker?.gatewayEventEndpoint || "" : "");
  if (format === "fence") {
    if (submitUrl) fail("--submit-url requires --format broker-event");
    emitFence(fence, { target, ...payload, reason });
    return;
  }
  if (format !== "broker-event") fail(`Unknown --format: ${format}`);
  const sessionKey = optionalString(args, "session-key") || context?.sessionKey;
  if (!sessionKey) fail("Missing --session-key or --context with sessionKey");
  const sourceEventId = requireOption(args, "source-event-id");
  const submitToken = optionalString(args, "submit-token") || context?.broker?.submitToken;
  const agentId = optionalString(args, "agent-id") || context?.agentId || undefined;
  const event = {
    kind,
    target,
    sessionKey,
    agentId,
    reason,
    source: "gateway-event",
    sourceEventId,
    submitToken,
    payload
  };
  if (!submitUrl) {
    console.log(JSON.stringify(event, null, 2));
    return;
  }
  const response = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(submitToken ? { Authorization: `Bearer ${submitToken}` } : {})
    },
    body: JSON.stringify(event)
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(text || `HTTP ${response.status}`);
    process.exit(1);
  }
  console.log(text || JSON.stringify({ ok: true }));
}

function assertKnownTarget(target) {
  const manifest = readManifest();
  if (!Object.prototype.hasOwnProperty.call(manifest.targets, target)) {
    fail(`Unknown target: ${target}`);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage(0);

  if (command === "manifest") {
    console.log(JSON.stringify(readManifest(), null, 2));
    return;
  }

  if (command === "validate-context") {
    const file = rest[0];
    if (!file) usage(1);
    const context = readContextFile(file);
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
    const context = readContextFile(file);
    const result = inspectContext(context);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (command === "broker-probe") {
    await brokerProbe(rest[0]);
    return;
  }

  const args = parseArgs(rest);
  if (command === "terminal-request") {
    const target = requireOption(args, "target");
    assertKnownTarget(target);
    await emitRequest(args, "terminal", target, requireOption(args, "reason"), {
      command: requireOption(args, "command")
    }, "detaches-terminal");
    return;
  }

  if (command === "file-transfer-request") {
    const target = requireOption(args, "target");
    assertKnownTarget(target);
    await emitRequest(args, "file-transfer", target, requireOption(args, "reason"), {
      fileId: requireOption(args, "file-id"),
      remotePath: requireOption(args, "remote-path")
    }, "detaches-file-transfer");
    return;
  }

  usage(1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
