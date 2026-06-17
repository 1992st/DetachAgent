# Changelog

## 1.0.1

- Clarify staged file transfer rules for files added from Detach Agent Web.
- Document that `sourceLocalPath` is an absolute path on the Detach Agent machine, not on the Host/Main Agent machine.
- Restrict Main Agent save-file transfer requests to detaches_agent approved `rsync` or `scp`; `curl` and HTTP upload fallback are not supported by this skill.
- Clarify that installation should pull `detach-agent-relationship` from the GitHub repository into the Host/Main Agent OpenClaw shared/global skills path.

## 1.0.0

- Initial Host/Main Agent relationship rules for Detach Agent conversations.
