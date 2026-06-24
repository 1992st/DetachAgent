import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Wifi, X } from "lucide-react";
import type { AgentSummary, AppHealth, ChatSessionMode, ClientIdentity, DiagnosticItem, InteractionRecord, LocalTerminalApp, RelationshipSkillStatus, SshCredentialSessionSnapshot, ToolBrokerSocketEvent, UploadedFileRef } from "@detaches/shared";
import { dismissSshSessionPassword, fetchAgents, fetchClientIdentity, fetchDiagnostics, fetchHealth, fetchLocalTerminalApps, fetchSettings, openLocalTerminalApp, rejectInteraction, resolveInteraction, submitSshSessionPassword, uploadFile, wsUrl } from "../lib/api.js";
import { ConnectionBar } from "../features/connection/ConnectionBar.js";
import { AgentList } from "../features/agents/AgentList.js";
import { ChatPanel, type ChatPanelHandle } from "../features/chat/ChatPanel.js";
import { FilePanel } from "../features/files/FilePanel.js";
import { SettingsPanel } from "../features/settings/SettingsPanel.js";

type ViewMode = "chat" | "network";

export function App() {
  const [view, setView] = useState<ViewMode>("chat");
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [networkConfigured, setNetworkConfigured] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [clientIdentity, setClientIdentity] = useState<ClientIdentity | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [sessionMode, setSessionMode] = useState<ChatSessionMode>("device");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [sessionOverrides, setSessionOverrides] = useState<Record<string, string>>({});
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, UploadedFileRef[]>>({});
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [remotePath, setRemotePath] = useState("");
  const [terminalApps, setTerminalApps] = useState<LocalTerminalApp[]>([]);
  const [terminalAppsLoading, setTerminalAppsLoading] = useState(false);
  const [terminalAppsError, setTerminalAppsError] = useState<string | null>(null);
  const [sshCredential, setSshCredential] = useState<SshCredentialSessionSnapshot | null>(null);
  const [sshPassword, setSshPassword] = useState("");
  const [sshPasswordBusy, setSshPasswordBusy] = useState(false);
  const [sshPasswordError, setSshPasswordError] = useState<string | null>(null);
  const [credentialInteraction, setCredentialInteraction] = useState<InteractionRecord | null>(null);
  const [interactionSecret, setInteractionSecret] = useState("");
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [relationshipSkillStatus, setRelationshipSkillStatus] = useState<RelationshipSkillStatus>("unknown");
  const [relationshipSkillMessage, setRelationshipSkillMessage] = useState<string | undefined>(undefined);
  const chatPanelRef = useRef<ChatPanelHandle | null>(null);

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      setHealth(await fetchHealth());
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : String(error));
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const refreshNetworkGuide = useCallback(async () => {
    try {
      const settings = await fetchSettings();
      const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings;
      setNetworkConfigured(activeProfile.lastStatus === "ok");
    } catch {
      setNetworkConfigured(false);
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const response = await fetchAgents();
      setAgents(response.agents);
      setSelectedAgentId((current) => current ?? response.agents[0]?.id ?? null);
    } catch (error) {
      setAgentsError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  const refreshClientIdentity = useCallback(async () => {
    setClientError(null);
    try {
      setClientIdentity(await fetchClientIdentity());
    } catch (error) {
      setClientError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const response = await fetchDiagnostics();
      setDiagnostics(response.items);
      setHealth(response.health);
    } catch (error) {
      setDiagnosticsError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiagnosticsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshClientIdentity();
    void refreshAgents();
    void refreshDiagnostics();
    void refreshNetworkGuide();
  }, [refreshClientIdentity, refreshAgents, refreshDiagnostics, refreshNetworkGuide]);

  useEffect(() => {
    const ws = new WebSocket(wsUrl("/api/tools/stream"));
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ToolBrokerSocketEvent;
      if (data.type === "ssh-credential") {
        setSshCredential(data.credential);
        if (data.credential.state !== "waiting-password") {
          setSshPassword("");
          setSshPasswordError(null);
        }
      } else if (data.type === "interaction") {
        if (data.interaction.kind === "credential.request") {
          if (data.interaction.status === "pending") {
            setCredentialInteraction(data.interaction);
          } else {
            setCredentialInteraction((current) => current?.id === data.interaction.id ? null : current);
            setInteractionSecret("");
            setInteractionError(null);
          }
        }
      }
    };
    ws.onerror = () => ws.close();
    return () => ws.close();
  }, []);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedSessionScope = selectedAgent ? sessionScopeKey(selectedAgent.id, sessionMode) : null;
  const selectedSession = selectedAgent && selectedSessionScope
    ? sessionOverrides[selectedSessionScope] ?? sessionKeyForAgent(selectedAgent, sessionMode, clientIdentity)
    : null;
  const attachments = selectedSession ? attachmentsBySession[selectedSession] ?? [] : [];

  const loadTerminalApps = useCallback(async () => {
    setTerminalAppsLoading(true);
    setTerminalAppsError(null);
    try {
      const response = await fetchLocalTerminalApps();
      setTerminalApps(response.apps);
    } catch (error) {
      setTerminalAppsError(error instanceof Error ? error.message : String(error));
    } finally {
      setTerminalAppsLoading(false);
    }
  }, []);

  const openTerminalApp = useCallback(async (appId: string) => {
    setTerminalAppsError(null);
    try {
      await openLocalTerminalApp(appId);
    } catch (error) {
      setTerminalAppsError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  async function handleUpload(files: FileList) {
    if (!selectedSession) return;
    setUploading(true);
    setFileError(null);
    const fileNames = Array.from(files).map((file) => file.name).join(", ");
    try {
      const uploaded: UploadedFileRef[] = [];
      for (const file of Array.from(files)) {
        const response = await uploadFile(file, selectedSession);
        uploaded.push(response.file);
      }
      setAttachmentsBySession((current) => ({
        ...current,
        [selectedSession]: [...(current[selectedSession] ?? []), ...uploaded]
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(`上传失败${fileNames ? ` (${fileNames})` : ""}: ${message}`);
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmitSshPassword() {
    setSshPasswordBusy(true);
    setSshPasswordError(null);
    try {
      const response = await submitSshSessionPassword(sshPassword);
      setSshCredential(response.credential);
      setSshPassword("");
      void refreshHealth();
      void refreshDiagnostics();
    } catch (error) {
      setSshPasswordError(error instanceof Error ? error.message : String(error));
    } finally {
      setSshPasswordBusy(false);
    }
  }

  async function handleDismissSshPassword() {
    setSshPasswordBusy(true);
    setSshPasswordError(null);
    try {
      const response = await dismissSshSessionPassword();
      setSshCredential(response.credential);
      setSshPassword("");
    } catch (error) {
      setSshPasswordError(error instanceof Error ? error.message : String(error));
    } finally {
      setSshPasswordBusy(false);
    }
  }

  async function handleResolveCredentialInteraction(mode: "local-handle" | "reveal-once") {
    if (!credentialInteraction) return;
    setInteractionBusy(true);
    setInteractionError(null);
    try {
      const response = await resolveInteraction(credentialInteraction.id, {
        mode,
        secret: interactionSecret,
        actor: clientIdentity ? {
          deviceId: clientIdentity.deviceId,
          deviceIdShort: clientIdentity.deviceIdShort,
          displayName: clientIdentity.displayName,
          source: "detaches-ui"
        } : { source: "detaches-ui" }
      });
      setCredentialInteraction(response.interaction.status === "pending" ? response.interaction : null);
      setInteractionSecret("");
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setInteractionBusy(false);
    }
  }

  async function handleRejectCredentialInteraction() {
    if (!credentialInteraction) return;
    setInteractionBusy(true);
    setInteractionError(null);
    try {
      await rejectInteraction(credentialInteraction.id, "Credential request dismissed by user.");
      setCredentialInteraction(null);
      setInteractionSecret("");
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setInteractionBusy(false);
    }
  }

  const handleRelationshipSkillStatusChange = useCallback((status: RelationshipSkillStatus, message?: string) => {
    setRelationshipSkillStatus(status);
    setRelationshipSkillMessage(message);
  }, []);

  function handleNewSession() {
    if (!selectedAgent || !selectedSessionScope) return;
    const nextSession = newSessionKeyForAgent(selectedAgent, sessionMode, clientIdentity);
    setSessionOverrides((current) => ({ ...current, [selectedSessionScope]: nextSession }));
    setAttachmentsBySession((current) => ({ ...current, [nextSession]: [] }));
    setRelationshipSkillStatus("checking");
    setRelationshipSkillMessage("Checking detach-agent-relationship skill...");
  }

  return (
    <div className="shell">
      {sshCredential?.state === "waiting-password" ? (
        <SshSessionPasswordDialog
          credential={sshCredential}
          password={sshPassword}
          busy={sshPasswordBusy}
          error={sshPasswordError}
          onPasswordChange={setSshPassword}
          onSubmit={() => void handleSubmitSshPassword()}
          onDismiss={() => void handleDismissSshPassword()}
        />
      ) : null}
      {credentialInteraction ? (
        <CredentialInteractionDialog
          interaction={credentialInteraction}
          secret={interactionSecret}
          busy={interactionBusy}
          error={interactionError}
          onSecretChange={setInteractionSecret}
          onResolve={(mode) => void handleResolveCredentialInteraction(mode)}
          onDismiss={() => void handleRejectCredentialInteraction()}
        />
      ) : null}
      <ConnectionBar
        health={health}
        loading={healthLoading}
        error={healthError}
        onRefresh={refreshHealth}
        terminalApps={terminalApps}
        terminalAppsLoading={terminalAppsLoading}
        terminalAppsError={terminalAppsError}
        onLoadTerminalApps={loadTerminalApps}
        onOpenTerminalApp={(appId) => void openTerminalApp(appId)}
        relationshipSkillStatus={relationshipSkillStatus}
        relationshipSkillMessage={relationshipSkillMessage}
        onRelationshipSkillAction={() => {
          setView("chat");
          window.setTimeout(() => document.getElementById("relationship-skill-install")?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
        }}
      />
      <nav className="view-tabs" aria-label="Main views">
        <div className="view-tab-buttons">
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>聊天</button>
          <button
            className={`${view === "network" ? "active" : ""} ${!networkConfigured && view !== "network" ? "guide-breathe" : ""}`}
            onClick={() => setView("network")}
          >
            <Wifi size={15} />
            连接设置
          </button>
        </div>
        <div className="top-debug-terminal-slot" />
      </nav>
      {view === "chat" ? (
        <div className="workspace">
          <AgentList
            agents={agents}
            selectedAgentId={selectedAgentId}
            loading={agentsLoading}
            error={agentsError || clientError}
            onSelect={setSelectedAgentId}
            onRefresh={refreshAgents}
          />
          <ChatPanel
            ref={chatPanelRef}
            sessionKey={selectedSession}
            agentId={selectedAgent?.id ?? null}
            sessionMode={sessionMode}
            clientIdentity={clientIdentity}
            attachments={attachments}
            onSessionModeChange={setSessionMode}
            onNewSession={handleNewSession}
            onClearAttachments={() => {
              if (!selectedSession) return;
              setAttachmentsBySession((current) => ({ ...current, [selectedSession]: [] }));
            }}
            onNeedUpload={handleUpload}
            onRelationshipSkillStatusChange={handleRelationshipSkillStatusChange}
          />
          <FilePanel
            sessionKey={selectedSession}
            agentId={selectedAgent?.id ?? null}
            clientIdentity={clientIdentity}
            files={attachments}
            uploading={uploading}
            error={fileError}
            remotePath={remotePath}
            diagnostics={diagnostics}
            diagnosticsLoading={diagnosticsLoading}
            diagnosticsError={diagnosticsError}
            onRemotePathChange={setRemotePath}
            onDiagnosticsRefresh={refreshDiagnostics}
            onRevealTerminal={() => chatPanelRef.current?.revealTerminal()}
          />
        </div>
      ) : (
        <div className="settings-workspace">
          <SettingsPanel
            onSaved={() => {
              void refreshAgents();
              void refreshDiagnostics();
              void refreshNetworkGuide();
            }}
          />
        </div>
      )}
    </div>
  );
}

function CredentialInteractionDialog({
  interaction,
  secret,
  busy,
  error,
  onSecretChange,
  onResolve,
  onDismiss
}: {
  interaction: InteractionRecord;
  secret: string;
  busy: boolean;
  error: string | null;
  onSecretChange: (value: string) => void;
  onResolve: (mode: "local-handle" | "reveal-once") => void;
  onDismiss: () => void;
}) {
  const target = interactionCredentialTarget(interaction);
  const title = typeof interaction.payload.title === "string" ? interaction.payload.title : "Main agent credential request";
  const prompt = typeof interaction.payload.prompt === "string" ? interaction.payload.prompt : "Enter the credential requested by the main agent.";
  return (
    <div className="save-password-backdrop" role="presentation">
      <div className="save-password-dialog" role="dialog" aria-modal="true" aria-label="Main agent credential request">
        <header className="save-password-header">
          <KeyRound size={20} />
          <div>
            <strong>{title}</strong>
            <small>{target || interaction.reason || "detaches_agent local interaction"}</small>
          </div>
          <button type="button" className="icon-button small" title="Dismiss" onClick={onDismiss}>
            <X size={15} />
          </button>
        </header>
        <div className="save-password-content">
          <section>
            <h3>Request</h3>
            <div className="save-password-grid">
              <span>Kind</span><strong>{interaction.kind}</strong>
              <span>Session</span><strong>{interaction.sessionKey}</strong>
              <span>Source</span><strong>{interaction.agentId || "main-agent"}</strong>
            </div>
          </section>
          <section>
            <h3>Credential</h3>
            <p className="save-password-note">{prompt}</p>
            <input
              type="password"
              value={secret}
              autoFocus
              placeholder="Password or token"
              onChange={(event) => onSecretChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onResolve("local-handle");
              }}
            />
            <p className="save-password-note">Use local handle keeps the secret inside detaches_agent memory. Reveal once returns it to the main agent one time through the API result.</p>
            {error ? <p className="save-password-warning">{error}</p> : null}
          </section>
        </div>
        <footer className="save-password-actions">
          <button type="button" className="secondary-button" onClick={onDismiss} disabled={busy}>Dismiss</button>
          <button type="button" className="secondary-button" disabled={!secret || busy} onClick={() => onResolve("reveal-once")}>Reveal once</button>
          <button type="button" className="primary-button" disabled={!secret || busy} onClick={() => onResolve("local-handle")}>Use local handle</button>
        </footer>
      </div>
    </div>
  );
}

function interactionCredentialTarget(interaction: InteractionRecord): string {
  const target = interaction.payload.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return "";
  const record = target as Record<string, unknown>;
  const user = typeof record.user === "string" ? record.user : "";
  const host = typeof record.host === "string" ? record.host : "";
  const port = typeof record.port === "number" || typeof record.port === "string" ? String(record.port) : "";
  const label = typeof record.label === "string" ? record.label : "";
  if (user && host) return `${user}@${host}${port ? `:${port}` : ""}`;
  return label || host;
}

function SshSessionPasswordDialog({
  credential,
  password,
  busy,
  error,
  onPasswordChange,
  onSubmit,
  onDismiss
}: {
  credential: SshCredentialSessionSnapshot;
  password: string;
  busy: boolean;
  error: string | null;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}) {
  const target = credential.target;
  return (
    <div className="save-password-backdrop" role="presentation">
      <div className="save-password-dialog" role="dialog" aria-modal="true" aria-label="SSH tunnel password required">
        <header className="save-password-header">
          <KeyRound size={20} />
          <div>
            <strong>SSH tunnel password required</strong>
            <small>{target ? `${target.user}@${target.host}:${target.port}` : "SSH tunnel / reverse bridge"}</small>
          </div>
          <button type="button" className="icon-button small" title="Dismiss" onClick={onDismiss}>
            <X size={15} />
          </button>
        </header>
        <div className="save-password-content">
          <section>
            <h3>Connection</h3>
            <div className="save-password-grid">
              <span>Use</span><strong>SSH tunnel / reverse bridge</strong>
              <span>Scope</span><strong>This app session</strong>
            </div>
          </section>
          <section>
            <h3>Password</h3>
            <p className="save-password-note">密码只保存在当前 detaches_agent 进程内，用于保活和重连 SSH tunnel，不会写入本地文件。</p>
            <input
              type="password"
              value={password}
              autoFocus
              placeholder="SSH password"
              onChange={(event) => onPasswordChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSubmit();
              }}
            />
            {error ? <p className="save-password-warning">{error}</p> : null}
          </section>
        </div>
        <footer className="save-password-actions">
          <button type="button" className="secondary-button" onClick={onDismiss} disabled={busy}>Later</button>
          <button type="button" className="primary-button" disabled={!password || busy} onClick={onSubmit}>Continue</button>
        </footer>
      </div>
    </div>
  );
}

function normalizeAgentId(agentId: string): string {
  return agentId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "custom";
}

function sessionKeyForAgent(agent: AgentSummary, sessionMode: ChatSessionMode, identity: ClientIdentity | null): string {
  const agentId = normalizeAgentId(agent.id);
  if (sessionMode === "main") return `agent:${agentId}:main`;
  const namespace = identity?.sessionNamespace ?? "detaches:local";
  return `agent:${agentId}:${namespace}`;
}

function newSessionKeyForAgent(agent: AgentSummary, sessionMode: ChatSessionMode, identity: ClientIdentity | null): string {
  const base = sessionKeyForAgent(agent, sessionMode, identity);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${base}:new:${suffix}`;
}

function sessionScopeKey(agentId: string, sessionMode: ChatSessionMode): string {
  return `${normalizeAgentId(agentId)}:${sessionMode}`;
}
