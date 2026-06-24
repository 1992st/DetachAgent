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
    "  doctor --context <context-json-file>",
    "  doctor --url <one-time-context-export-url> [--output-context <file>]",
    "  context-fetch <one-time-context-export-url> [--output <file> --print client-context|detaches|export]",
    "  broker-probe <detaches-agent-base-url-or-capabilities-url>",
    "  terminal-run --host <detach-agent-base-url> --command <command> --reason <reason> [--timeout-ms 120000]",
    "  terminal-session --host <detach-agent-base-url>",
    "  terminal-cancel --host <detach-agent-base-url> --run-id <run-id>",
    "  terminal-stream --host <detach-agent-base-url> --run-id <run-id>",
    "  terminal-request --command <command> --reason <reason> --source-event-id <id> --context <detaches-context-json> [--target <target> --format fence|broker-event --session-key <key> --agent-id <id> --submit-token <token> --submit-url <url> --submit]",
    "  ping-channel --context <detaches-context-json>",
    "  file-transfer-request --file-id <id> --target <target> --remote-path <path> --reason <reason> [--context <detaches-context-json> --format fence|broker-event --session-key <key> --agent-id <id> --source-event-id <id> --submit-token <token> --submit-url <url> --submit]",
    "  main-agent-save-file-request --file-id <id> --source-local-path <path> --display-name <name> --size <bytes> --user <ssh-user> --path <dest> --reason <reason> [--host <host> --port <port> --method rsync|scp --context <detaches-context-json> --format fence|broker-event --session-key <key> --agent-id <id> --source-event-id <id> --submit-token <token> --submit-url <url> --submit]",
    "  credential-request --reason <reason> --source-event-id <id> [--context <detaches-context-json> --prompt <text> --target-user <user> --target-host <host> --target-port <port> --submit-token <token> --submit-url <url> --wait --timeout-ms 300000]",
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
  if (file === "-") return detachesContextFrom(JSON.parse(fs.readFileSync(0, "utf8")));
  return detachesContextFrom(JSON.parse(fs.readFileSync(file, "utf8")));
}

function printableContextFromExport(payload, mode) {
  if (mode === "export") return payload;
  if (mode === "client-context") return payload?.clientContext ?? payload;
  if (mode === "detaches") return detachesContextFrom(payload);
  fail(`Unknown --print: ${mode}`);
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
  if (!context?.broker?.interactionEventEndpoint && !context?.localControl?.interactionEventEndpoint) {
    warnings.push("interaction event endpoint is missing; ask detaches_agent to resend updated context before requesting credentials.");
  }
  return {
    ok: errors.length === 0,
    errors,
    adapterId: manifest.id,
    app: context?.app,
    sessionKey: context?.sessionKey,
    agentId: context?.agentId ?? null,
    userDevice: context?.userDevice ?? null,
    localMachine: context?.localMachine ?? null,
    adapterStatus: adapterStatus ?? null,
    broker: context?.broker ?? null,
    localControl: context?.localControl ?? null,
    contextExport: context?.contextExport ?? null,
    terminalChannels: context?.terminalChannels ?? null,
    files: {
      staged: stagedFiles
    },
    capabilities,
    targetSupport,
    warnings,
    hardRules: manifest.hardRules
  };
}

function commandQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sourceEventIdHint(context, suffix) {
  const agentId = context?.agentId || "agent";
  const sessionKey = String(context?.sessionKey || "session").replace(/[^a-zA-Z0-9_.:-]/g, "-");
  return `${agentId}:${sessionKey}:${suffix}:$(date +%s)`;
}

function preferredTerminalChannel(context) {
  const channels = context?.terminalChannels;
  if (!channels && (context?.localControl?.toolEventEndpoint || context?.broker?.gatewayEventEndpoint)) return "gateway-terminal";
  const preferred = channels?.preferred || "chat-terminal";
  if (preferred === "gateway-terminal" || preferred === "ssh-terminal" || preferred === "chat-terminal") return preferred;
  return "chat-terminal";
}

function selectedTerminalEndpoint(context) {
  const channels = context?.terminalChannels;
  const preferred = preferredTerminalChannel(context);
  if (preferred === "gateway-terminal" && channels?.gatewayTerminal?.state === "ready") return channels.gatewayTerminal.toolEventEndpoint || context?.broker?.gatewayEventEndpoint || "";
  if (preferred === "ssh-terminal" && channels?.sshTerminal?.state === "ready") return channels.sshTerminal.toolEventEndpoint || context?.broker?.gatewayEventEndpoint || "";
  return "";
}

function selectedTerminalBaseUrl(context) {
  const channels = context?.terminalChannels;
  const preferred = preferredTerminalChannel(context);
  if (preferred === "gateway-terminal") return channels?.gatewayTerminal?.baseUrl || context?.localControl?.baseUrl || "";
  if (preferred === "ssh-terminal") return channels?.sshTerminal?.baseUrl || context?.localControl?.baseUrl || "";
  return "";
}

function terminalMetadata(context, fallbackMode = undefined) {
  const preferred = preferredTerminalChannel(context);
  return {
    terminalChannel: fallbackMode ? "chat-terminal" : preferred,
    fallbackMode,
    preferredChannel: preferred,
    callbackBaseUrl: selectedTerminalBaseUrl(context) || undefined
  };
}

function adapterCliPathHint() {
  return "~/.detach_agent/bin/detaches-agent-adapter.mjs";
}

function doctorContext(context) {
  const inspection = inspectContext(context);
  const terminalCapability = inspection.capabilities.find((capability) => capability.name === "terminal");
  const fileCapability = inspection.capabilities.find((capability) => capability.name === "file-transfer");
  const mainAgentSaveCapability = inspection.capabilities.find((capability) => capability.name === "main-agent-save-file");
  const brokerEndpoint = inspection.broker?.gatewayEventEndpoint;
  const interactionEndpoint = inspection.broker?.interactionEventEndpoint || context?.localControl?.interactionEventEndpoint;
  const submitTokenAvailable = typeof inspection.broker?.submitToken === "string" && inspection.broker.submitToken.length > 0;
  const preferredFormat = inspection.broker?.requestFormats?.includes("broker-event") && brokerEndpoint && submitTokenAvailable
    ? "broker-event"
    : "fence";
  const localTerminalRequestable = terminalCapability?.supportedTargets?.includes("local-user-machine")
    && !terminalCapability?.unavailableTargets?.includes("local-user-machine");
  const localFileRequestable = fileCapability?.supportedTargets?.includes("local-user-machine")
    && !fileCapability?.unavailableTargets?.includes("local-user-machine");
  const mainAgentSaveRequestable = mainAgentSaveCapability?.supportedTargets?.includes("main-agent-machine")
    && !mainAgentSaveCapability?.unavailableTargets?.includes("main-agent-machine");
  const localMachine = inspection.localMachine;
  const reverseBridgeOk = inspection.localControl?.reverseBridge?.ok !== false;
  const preferredTerminal = inspection.terminalChannels?.preferred || "chat-terminal";
  const commandDialect = localMachine?.commandDialect || "the user's local OS shell";
  const pathStyle = localMachine?.pathStyle || "the user's local OS";
  const cli = adapterCliPathHint();
  const nextActions = [
    "Treat this as a detaches_agent mediated session, not plain webchat.",
    "Use the supported target list from this context; do not invent or fallback targets.",
    `The user's local machine is ${localMachine?.os || "unknown"}; local-user-machine commands must use ${commandDialect} syntax and ${pathStyle} paths.`,
    localMachineCommandRule(localMachine),
    `Preferred terminal channel is ${preferredTerminal}.`,
    preferredTerminal === "chat-terminal"
      ? "HTTP broker is not preferred. Emit exactly one fenced detaches-terminal request block for local-user-machine terminal requests."
      : "Use the selected terminal HTTP broker endpoint for terminal requests; if it is unreachable, report DETACHES_ENDPOINT_UNREACHABLE and fall back to exactly one detaches-terminal fenced block.",
    "To control the user's local machine, submit a terminal request for target local-user-machine; do not SSH into the user's machine and do not ask for local SSH credentials.",
    "local-user-machine terminal requests are executed by detaches_agent's local terminal after user approval; this path does not need an SSH password.",
    "If an SSH login or another real credential is required, submit credential.request to the interaction endpoint and wait up to 300000ms; do not ask the user to paste passwords into chat.",
    "This adapter script runs on the Host/Main Agent machine. Use context-provided broker/localControl URLs, not 127.0.0.1, unless that exact URL came from context.",
    "Submit broker-event requests when possible; otherwise emit exactly one fenced request block.",
    "Wait for detaches_agent approved tool output before claiming execution or file handling completed."
  ];
  if (!inspection.ok) {
    nextActions.unshift("Fix or refresh the detaches context before requesting any tool.");
  }
  if (!brokerEndpoint || !submitTokenAvailable) {
    nextActions.push("Broker endpoint or submit token is missing; ask the user to send a fresh detaches_agent message with current connection settings.");
  }
  const commands = {
    inspect: `node ${cli} inspect-context ${commandQuote("<context-json-file>")}`,
    terminalBrokerEvent: localTerminalRequestable
      ? [
          `node ${cli} terminal-request`,
          `  --context ${commandQuote("<context-json-file>")}`,
          "  --target local-user-machine",
          `  --command ${commandQuote("pwd")}`,
          `  --reason ${commandQuote("check the user's local working directory")}`,
          "  --format broker-event",
          `  --source-event-id ${commandQuote(sourceEventIdHint(context, "terminal"))}`,
          "  --submit"
        ].join(" \\\n")
      : null,
    fileTransferBrokerEvent: localFileRequestable && inspection.files.staged.length > 0
      ? [
          `node ${cli} file-transfer-request`,
          `  --context ${commandQuote("<context-json-file>")}`,
          `  --file-id ${commandQuote(inspection.files.staged[0].fileId || "file-id")}`,
          "  --target local-user-machine",
          `  --remote-path ${commandQuote("/tmp/input-file")}`,
          `  --reason ${commandQuote("copy the staged file before reading or archiving it")}`,
          "  --format broker-event",
          `  --source-event-id ${commandQuote(sourceEventIdHint(context, "file"))}`,
          "  --submit"
        ].join(" \\\n")
      : null,
    mainAgentSaveFileBrokerEvent: mainAgentSaveRequestable && inspection.files.staged.length > 0
      ? [
          `node ${cli} main-agent-save-file-request`,
          `  --context ${commandQuote("<context-json-file>")}`,
          `  --file-id ${commandQuote(inspection.files.staged[0].fileId || "file-id")}`,
          `  --source-local-path ${commandQuote(inspection.files.staged[0].localPath || "<sourceLocalPath-from-prompt>")}`,
          `  --display-name ${commandQuote(inspection.files.staged[0].displayName || inspection.files.staged[0].name || "file")}`,
          `  --size ${commandQuote(String(inspection.files.staged[0].size || 0))}`,
          `  --user ${commandQuote("<ssh-user-chosen-by-main-agent>")}`,
          `  --path ${commandQuote("<absolute-path-chosen-by-main-agent>")}`,
          `  --reason ${commandQuote("save the staged file to the Host/Main Agent machine")}`,
          "  --format broker-event",
          `  --source-event-id ${commandQuote(sourceEventIdHint(context, "main-agent-save-file"))}`,
          "  --submit"
        ].join(" \\\n")
      : null,
    credentialRequest: interactionEndpoint && submitTokenAvailable
      ? [
          `node ${cli} credential-request`,
          `  --context ${commandQuote("<context-json-file>")}`,
          `  --reason ${commandQuote("SSH login requires a password")}`,
          `  --prompt ${commandQuote("Enter the SSH password for this login")}`,
          `  --target-user ${commandQuote("<ssh-user>")}`,
          `  --target-host ${commandQuote("<ssh-host>")}`,
          `  --target-port ${commandQuote("22")}`,
          `  --source-event-id ${commandQuote(sourceEventIdHint(context, "credential"))}`,
          "  --wait",
          "  --timeout-ms 300000"
        ].join(" \\\n")
      : null
  };
  const blockedTargets = Object.fromEntries(Object.entries(inspection.targetSupport)
    .filter(([, status]) => status.requestable !== true)
    .map(([target, status]) => [target, {
      manifestStatus: status.manifestStatus,
      unavailableBy: status.unavailableBy,
      reason: status.unavailableBy.length > 0
        ? `Unavailable for ${status.unavailableBy.join(", ")} in this detaches context.`
        : "No capability currently marks this target requestable."
    }]));
  return {
    ok: inspection.ok,
    adapterId: inspection.adapterId,
    mode: "detaches-agent-doctor",
    session: {
      sessionKey: inspection.sessionKey,
      agentId: inspection.agentId,
      userDevice: inspection.userDevice
    },
    localMachine: inspection.localMachine,
    terminalChannels: inspection.terminalChannels ?? null,
    preferredRequestFormat: preferredFormat,
    broker: {
      endpoint: brokerEndpoint ?? null,
      interactionEndpoint: interactionEndpoint ?? null,
      submitTokenAvailable,
      submitTokenHeader: inspection.broker?.submitTokenHeader ?? null,
      idempotencyField: inspection.broker?.idempotencyField ?? null
    },
    requestableTargets: Object.fromEntries(Object.entries(inspection.targetSupport)
      .filter(([, status]) => status.requestable === true)
      .map(([target, status]) => [target, status.supportedBy])),
    blockedTargets,
    stagedFiles: inspection.files.staged,
    warnings: inspection.warnings,
    hardRules: inspection.hardRules,
    nextActions,
    commands
  };
}

function localMachineCommandRule(localMachine) {
  switch (localMachine?.os) {
    case "win32":
      return "For target local-user-machine, use Windows commands for the user's local machine: PowerShell/cmd-compatible syntax and Windows paths. Do not use macOS/Linux local commands such as open, defaults, plutil, /Applications, /Library, ~/Library, or /tmp.";
    case "darwin":
      return "For target local-user-machine, use macOS commands for the user's local machine: POSIX shell syntax and POSIX paths. Do not use Windows-only commands or paths unless the target is explicitly Windows.";
    case "linux":
      return "For target local-user-machine, use Linux commands for the user's local machine: POSIX shell syntax and POSIX paths. Do not use macOS-only or Windows-only commands unless the target is explicitly that system.";
    default:
      return "For target local-user-machine, use the local OS shown by localMachine, not assumptions from the Host/Main Agent OS. If the OS is unknown, ask before using OS-specific commands.";
  }
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

function optionalDestination(args) {
  const destination = { user: requireOption(args, "user"), path: requireOption(args, "path") };
  const host = optionalString(args, "host");
  const port = optionalString(args, "port");
  if (host) destination.host = host;
  if (port) destination.port = Number(port);
  return destination;
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
  if (payload?.contextExport?.oneTime !== true) errors.push("contextExport.oneTime must be true");
  if (payload?.contextExport?.adapterCommand !== "context-fetch") errors.push("contextExport.adapterCommand must be context-fetch");
  if (payload?.contextExport?.doctorCommand !== "doctor") errors.push("contextExport.doctorCommand must be doctor");
  if (payload?.adapterId !== "detaches_agent.openclaw.adapter") errors.push("adapterId mismatch");
  const result = { ok: errors.length === 0, url, errors, capabilities: payload };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exit(1);
}

async function fetchContextExport(value) {
  const url = String(value || "").trim();
  if (!url) fail("Missing one-time context export URL.");
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    fail(`Context fetch returned non-JSON response from ${url}: ${text}`);
  }
  if (!response.ok) fail(payload?.error || `HTTP ${response.status}`);
  const context = detachesContextFrom(payload);
  const errors = validateContext(context);
  if (errors.length) fail(`Fetched invalid detaches context: ${errors.join("; ")}`);
  return { url, payload, context };
}

async function contextFetch(value, args) {
  const { payload, context } = await fetchContextExport(value);
  const printMode = optionalString(args, "print") || "client-context";
  const selected = printableContextFromExport(payload, printMode);
  const output = optionalString(args, "output");
  if (output) {
    fs.writeFileSync(output, `${JSON.stringify(selected, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: true,
      output,
      sessionKey: context.sessionKey,
      agentId: context.agentId ?? null,
      redacted: payload?.redacted ?? null
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(selected, null, 2));
}

async function doctorFromArgs(args) {
  const contextPath = optionalString(args, "context");
  const exportUrl = optionalString(args, "url");
  if (contextPath && exportUrl) fail("Use either --context or --url, not both.");
  if (contextPath) {
    return { context: readContextOption(args), fetched: null };
  }
  if (!exportUrl) fail("Missing --context or --url");
  const fetched = await fetchContextExport(exportUrl);
  const outputContext = optionalString(args, "output-context");
  if (outputContext) {
    fs.writeFileSync(outputContext, `${JSON.stringify(fetched.context, null, 2)}\n`);
  }
  return { context: fetched.context, fetched: { url: fetched.url, outputContext: outputContext ?? null } };
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

async function submitTerminalRequest(args) {
  const context = readContextOption(args);
  const target = optionalString(args, "target") || "local-user-machine";
  assertKnownTarget(target);
  const reason = requireOption(args, "reason");
  const payload = { command: requireOption(args, "command") };
  const preferred = preferredTerminalChannel(context);
  const explicitFormat = optionalString(args, "format");
  const format = explicitFormat || (preferred === "chat-terminal" ? "fence" : "broker-event");
  if (format === "fence") {
    emitFence("detaches-terminal", { target, ...payload, reason, metadata: terminalMetadata(context, preferred === "chat-terminal" ? "chat-fenced-block" : undefined) });
    return;
  }
  const submitUrl = optionalString(args, "submit-url") || (args.submit === true ? selectedTerminalEndpoint(context) : "");
  const sessionKey = optionalString(args, "session-key") || context?.sessionKey;
  if (!sessionKey) failWithCode("DETACHES_CONTEXT_INVALID", "Missing --session-key or --context with sessionKey.");
  const submitToken = optionalString(args, "submit-token") || context?.broker?.submitToken;
  const event = {
    kind: "terminal",
    target,
    sessionKey,
    agentId: optionalString(args, "agent-id") || context?.agentId || undefined,
    reason,
    source: "gateway-event",
    sourceEventId: requireOption(args, "source-event-id"),
    submitToken,
    metadata: terminalMetadata(context),
    payload
  };
  if (!submitUrl && args.submit !== true) {
    console.log(JSON.stringify(event, null, 2));
    return;
  }
  if (!submitUrl) {
    console.error(JSON.stringify({ ok: false, errorCode: "DETACHES_CHANNEL_UNAVAILABLE", error: "Selected terminal HTTP channel is unavailable; emitting chat-terminal fallback." }, null, 2));
    emitFence("detaches-terminal", { target, ...payload, reason, metadata: terminalMetadata(context, "chat-fenced-block") });
    return;
  }
  const response = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(submitToken ? { Authorization: `Bearer ${submitToken}` } : {})
    },
    body: JSON.stringify(event)
  }).catch((error) => ({ ok: false, status: 0, text: async () => error instanceof Error ? error.message : String(error) }));
  if (!response.ok) {
    const text = await response.text();
    console.error(JSON.stringify({ ok: false, errorCode: "DETACHES_ENDPOINT_UNREACHABLE", error: text || `HTTP ${response.status}` }, null, 2));
    emitFence("detaches-terminal", { target, ...payload, reason, metadata: terminalMetadata(context, "chat-fenced-block") });
    return;
  }
  console.log(await response.text() || JSON.stringify({ ok: true }));
}

async function pingChannel(args) {
  const context = readContextOption(args);
  const preferred = preferredTerminalChannel(context);
  const endpoint = selectedTerminalEndpoint(context);
  if (preferred === "chat-terminal") {
    console.log(JSON.stringify({ ok: true, preferred, httpRequired: false, message: "chat-terminal does not require HTTP broker reachability." }, null, 2));
    return;
  }
  if (!endpoint) failWithCode("DETACHES_CHANNEL_UNAVAILABLE", `Preferred terminal channel ${preferred} has no endpoint.`);
  const baseUrl = endpoint.replace(/\/api\/tools\/events\/gateway\/?$/, "");
  const response = await fetch(`${baseUrl}/api/ping`, { headers: { Accept: "application/json" } });
  const payload = await parseJsonResponse(response);
  console.log(JSON.stringify({ ok: payload?.app === "detaches_agent", preferred, baseUrl, payload }, null, 2));
}

function interactionSubmitUrlFromContext(context, args) {
  return optionalString(args, "submit-url")
    || context?.broker?.interactionEventEndpoint
    || context?.localControl?.interactionEventEndpoint
    || "";
}

async function submitCredentialRequest(args) {
  const context = readContextOption(args);
  const sessionKey = optionalString(args, "session-key") || context?.sessionKey;
  if (!sessionKey) failWithCode("DETACHES_CONTEXT_INVALID", "Missing --session-key or --context with sessionKey.");
  const submitToken = optionalString(args, "submit-token") || context?.broker?.submitToken;
  if (!submitToken) failWithCode("DETACHES_AUTH_REQUIRED", "Missing submit token.");
  const submitUrl = interactionSubmitUrlFromContext(context, args);
  if (!submitUrl) failWithCode("DETACHES_ENDPOINT_UNREACHABLE", "Missing interaction submit URL.");
  const targetPort = optionalString(args, "target-port");
  const event = {
    kind: "credential.request",
    sessionKey,
    agentId: optionalString(args, "agent-id") || context?.agentId || undefined,
    reason: requireOption(args, "reason"),
    source: "gateway-event",
    sourceEventId: requireOption(args, "source-event-id"),
    payload: {
      title: optionalString(args, "title") || "Main agent credential request",
      prompt: optionalString(args, "prompt") || "Enter the credential requested by the main agent.",
      target: {
        user: optionalString(args, "target-user"),
        host: optionalString(args, "target-host"),
        port: targetPort ? Number(targetPort) : undefined,
        label: optionalString(args, "target-label")
      }
    }
  };
  const submitted = await postJson(submitUrl, event, submitToken);
  if (args.wait !== true) {
    console.log(JSON.stringify(submitted, null, 2));
    return;
  }
  const interactionId = submitted?.interaction?.id;
  if (!interactionId) failWithCode("DETACHES_PROTOCOL_ERROR", "Interaction create response did not include interaction.id.");
  const resultUrl = interactionResultUrl(submitUrl, interactionId, submitToken);
  const timeoutMs = parseTimeoutMs(optionalString(args, "timeout-ms"));
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    await sleep(1000);
    const result = await getJson(resultUrl);
    const status = result?.interaction?.status;
    if (status === "resolved") {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    if (status === "rejected") failWithCode("DETACHES_INTERACTION_REJECTED", result?.interaction?.error || "Credential request rejected.");
    if (status === "expired") failWithCode("DETACHES_INTERACTION_EXPIRED", result?.interaction?.error || "Credential request expired.");
  }
  failWithCode("DETACHES_INTERACTION_TIMEOUT", `Timed out after ${timeoutMs}ms waiting for credential interaction.`);
}

function interactionResultUrl(submitUrl, interactionId, submitToken) {
  const url = new URL(submitUrl);
  url.pathname = url.pathname.replace(/\/events\/gateway\/?$/, `/${encodeURIComponent(interactionId)}`);
  url.search = "";
  url.searchParams.set("submitToken", submitToken);
  return url.toString();
}

async function postJson(url, body, submitToken) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${submitToken}`
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    failWithCode("DETACHES_ENDPOINT_UNREACHABLE", error instanceof Error ? error.message : String(error));
  }
  return parseJsonResponse(response);
}

async function postJsonOptionalAuth(url, body, token) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    failWithCode("DETACHES_TERMINAL_HOST_UNREACHABLE", error instanceof Error ? error.message : String(error));
  }
  return parseJsonResponse(response);
}

async function getJson(url) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    failWithCode("DETACHES_ENDPOINT_UNREACHABLE", error instanceof Error ? error.message : String(error));
  }
  return parseJsonResponse(response);
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    failWithCode("DETACHES_PROTOCOL_ERROR", `Non-JSON response: ${text}`);
  }
  if (!response.ok) failWithCode(payload?.code || payload?.errorCode || "DETACHES_PROTOCOL_ERROR", payload?.error || `HTTP ${response.status}`);
  return payload;
}

function parseTimeoutMs(value) {
  const parsed = Number(value || 300000);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300000;
  return Math.min(parsed, 300000);
}

function normalizeHost(value) {
  const raw = String(value || "").trim();
  if (!raw) failWithCode("DETACHES_TERMINAL_HOST_UNREACHABLE", "--host is required.");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

function runtimeCachePath(host) {
  const safe = Buffer.from(host).toString("base64url").slice(0, 80);
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".detach_agent", "runtime", safe, "terminal-session.json");
}

function readSessionCache(host) {
  try {
    return JSON.parse(fs.readFileSync(runtimeCachePath(host), "utf8"));
  } catch {
    return null;
  }
}

function writeSessionCache(host, payload) {
  const file = runtimeCachePath(host);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

async function bootstrapTerminal(host, args = {}) {
  const baseUrl = normalizeHost(host);
  const cached = readSessionCache(baseUrl);
  if (cached?.leaseToken && cached?.leaseExpiresAt && Date.parse(cached.leaseExpiresAt) > Date.now() + 60_000) {
    return { baseUrl, ...cached };
  }
  const response = await postJsonOptionalAuth(`${baseUrl}/api/agent-terminal/bootstrap`, {
    sessionKey: optionalString(args, "session-key"),
    agentId: optionalString(args, "agent-id"),
    displayName: optionalString(args, "display-name") || "Main Agent"
  });
  const cache = {
    terminalSession: response.terminalSession,
    leaseToken: response.leaseToken,
    leaseExpiresAt: response.leaseExpiresAt,
    refreshAfter: response.refreshAfter,
    capabilities: response.capabilities
  };
  writeSessionCache(baseUrl, cache);
  return { baseUrl, ...cache };
}

async function terminalRun(args) {
  const bootstrap = await bootstrapTerminal(requireOption(args, "host"), args);
  const timeoutMs = parseTimeoutMs(optionalString(args, "timeout-ms") || "120000");
  const response = await postJsonOptionalAuth(
    `${bootstrap.baseUrl}/api/agent-terminal/runs?wait=true&timeoutMs=${encodeURIComponent(String(timeoutMs))}`,
    {
      command: requireOption(args, "command"),
      reason: optionalString(args, "reason") || "gateway-terminal command",
      workingDirectory: optionalString(args, "cwd") || null,
      sourceEventId: optionalString(args, "source-event-id") || `terminal-run:${Date.now()}:${Math.random().toString(16).slice(2)}`
    },
    bootstrap.leaseToken
  );
  console.log(JSON.stringify(response, null, 2));
  if (!response.ok && response.status !== "waiting_for_approval" && response.status !== "running") process.exit(1);
}

async function terminalSession(args) {
  const bootstrap = await bootstrapTerminal(requireOption(args, "host"), args);
  console.log(JSON.stringify({ ok: true, ...bootstrap }, null, 2));
}

async function terminalCancel(args) {
  const bootstrap = await bootstrapTerminal(requireOption(args, "host"), args);
  const response = await postJsonOptionalAuth(
    `${bootstrap.baseUrl}/api/agent-terminal/runs/${encodeURIComponent(requireOption(args, "run-id"))}/cancel`,
    {},
    bootstrap.leaseToken
  );
  console.log(JSON.stringify(response, null, 2));
}

async function terminalStream(args) {
  const bootstrap = await bootstrapTerminal(requireOption(args, "host"), args);
  const response = await fetch(`${bootstrap.baseUrl}/api/agent-terminal/runs/${encodeURIComponent(requireOption(args, "run-id"))}/stream`, {
    headers: { Authorization: `Bearer ${bootstrap.leaseToken}`, Accept: "text/event-stream" }
  });
  if (!response.ok) failWithCode("DETACHES_TERMINAL_INTERNAL_ERROR", await response.text() || `HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) failWithCode("DETACHES_TERMINAL_INTERNAL_ERROR", "Response body is not readable.");
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    process.stdout.write(decoder.decode(value));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failWithCode(code, message) {
  console.error(JSON.stringify({ ok: false, errorCode: code, error: message }, null, 2));
  process.exit(1);
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

  if (command === "doctor") {
    const args = parseArgs(rest);
    const { context, fetched } = await doctorFromArgs(args);
    const result = doctorContext(context);
    if (fetched) {
      result.contextSource = {
        type: "one-time-url",
        url: fetched.url,
        savedTo: fetched.outputContext
      };
    } else {
      result.contextSource = {
        type: "file",
        path: optionalString(args, "context")
      };
    }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (command === "context-fetch") {
    await contextFetch(rest[0], parseArgs(rest.slice(1)));
    return;
  }

  if (command === "broker-probe") {
    await brokerProbe(rest[0]);
    return;
  }

  const args = parseArgs(rest);
  if (command === "terminal-run") {
    await terminalRun(args);
    return;
  }

  if (command === "terminal-session") {
    await terminalSession(args);
    return;
  }

  if (command === "terminal-cancel") {
    await terminalCancel(args);
    return;
  }

  if (command === "terminal-stream") {
    await terminalStream(args);
    return;
  }

  if (command === "terminal-request") {
    await submitTerminalRequest(args);
    return;
  }

  if (command === "ping-channel") {
    await pingChannel(args);
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

  if (command === "main-agent-save-file-request") {
    await emitRequest(args, "main-agent-save-file", "main-agent-machine", requireOption(args, "reason"), {
      fileId: requireOption(args, "file-id"),
      sourceLocalPath: requireOption(args, "source-local-path"),
      displayName: requireOption(args, "display-name"),
      size: Number(requireOption(args, "size")),
      destination: optionalDestination(args),
      methodPreference: optionalString(args, "method") === "scp" ? "scp" : "rsync"
    }, "main-agent-save-file");
    return;
  }

  if (command === "credential-request") {
    await submitCredentialRequest(args);
    return;
  }

  usage(1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
