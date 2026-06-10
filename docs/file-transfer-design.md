# File Transfer Design

Uploads first land in local `storage/uploads`. The server then tries to SFTP the file to:

```text
~/.openclaw/workspace/ui_uploads/<sessionKey>/
```

If SFTP fails or SSH is not configured, the local attachment remains available and the UI warns through the file card.

Downloads are allowed only from `OPENCLAW_REMOTE_WORKSPACE_ROOT`.
