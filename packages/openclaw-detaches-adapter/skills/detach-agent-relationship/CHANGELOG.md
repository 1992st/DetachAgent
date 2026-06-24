# Changelog

## 1.2.0

- Make `terminal-run --host <Detach Agent callback address>` the primary gateway-terminal path.
- Hide raw broker endpoints and submit tokens from normal terminal guidance.
- Add Agent Terminal Runtime behavior: wait for approval, wait for completion, return output/exitCode, and use stream/cancel helpers for long-running commands.
- Keep `context-fetch`, `terminal-request`, `chat-terminal`, and `ssh-terminal` as compatibility paths.

## 1.1.1

- Clarify that terminal commands must use `toolEventEndpoint` / `broker.gatewayEventEndpoint`, not `interactionEventEndpoint`.
- Add a raw HTTP terminal broker example for Host/Main Agent environments where the adapter CLI is not installed.
- Clarify that readable fallback prompts do not print `broker.submitToken`; Main Agent must use structured context or `contextExport.consumeUrl` to obtain it.

## 1.1.0

- Add versioned terminal channel guidance for `gateway-terminal`, `ssh-terminal`, and `chat-terminal`.
- Document that `gateway-terminal` is the preferred HTTP broker callback path through Detach Agent `publicBaseUrl`.
- Keep `chat-terminal` fenced block requests as the explicit fallback path and require logs/audit to distinguish `source=text-extract`.
- Clarify that `ssh-terminal` is an advanced, default-off, key-based reverse bridge path that can coexist with `gateway-terminal`.
- Align prompt/context and adapter CLI expectations for preferred terminal channel selection and fallback behavior.

## 1.0.1

- Clarify staged file transfer rules for files added from Detach Agent Web.
- Document that `sourceLocalPath` is an absolute path on the Detach Agent machine, not on the Host/Main Agent machine.
- Restrict Main Agent save-file transfer requests to detaches_agent approved `rsync` or `scp`; `curl` and HTTP upload fallback are not supported by this skill.
- Clarify that installation should pull `detach-agent-relationship` from the GitHub repository into the Host/Main Agent OpenClaw shared/global skills path.

## 1.0.0

- Initial Host/Main Agent relationship rules for Detach Agent conversations.
