import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, FileText, FolderOpen, KeyRound, Wifi, X } from "lucide-react";
import type { AgentSummary, AgentTerminalSession, AppHealth, ChatSessionMode, ClientIdentity, InteractionRecord, LocalTerminalApp, RelationshipSkillStatus, SshCredentialSessionSnapshot, ToolBrokerSocketEvent, ToolRequestRecord, UploadedFileRef } from "@detaches/shared";
import { LOCAL_SERVER_DISCONNECTED_MESSAGE, approveToolRequest, authorizeAgentTerminalSession, dismissSshSessionPassword, fetchAgents, fetchAgentTerminalSessions, fetchClientIdentity, fetchDiagnostics, fetchHealth, fetchLocalTerminalApps, fetchSettings, fetchToolRequests, isLocalServerDisconnected, openLocalTerminalApp, rejectInteraction, rejectToolRequest, resolveInteraction, submitSshSessionPassword, uploadFile, wsUrl } from "../lib/api.js";
import { ConnectionBar } from "../features/connection/ConnectionBar.js";
import { AgentList } from "../features/agents/AgentList.js";
import { ChatPanel, type ChatPanelHandle } from "../features/chat/ChatPanel.js";
import { SettingsPanel } from "../features/settings/SettingsPanel.js";
import { ToolQueuePanel } from "../features/tools/ToolQueuePanel.js";
import { relationshipSkillInstallPrompt, relationshipSkillVersion } from "../features/skills/SkillInstallPanel.js";
import { FileBrowserPage } from "../features/files/FileBrowserPage.js";

type ViewMode = "chat" | "network" | "tool-queue" | "file-browser";
type LocalControlRuntimeState = "idle" | "checking" | "install_required" | "installing" | "ready" | "error";
// 仅用于 terminal toggle 的轻量展示，不代表 terminal websocket 的真实连接生命周期。
type TerminalActivityState = "connected" | "running";

interface RelationshipSkillState {
  status: RelationshipSkillStatus;
  message?: string;
  installedVersion?: string;
  requiredVersion?: string;
}

export function App() {
  const [view, setView] = useState<ViewMode>("chat");
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [networkConfigured, setNetworkConfigured] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [clientIdentity, setClientIdentity] = useState<ClientIdentity | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [sessionMode, setSessionMode] = useState<ChatSessionMode>("device");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [sessionOverrides, setSessionOverrides] = useState<Record<string, string>>({});
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, UploadedFileRef[]>>({});
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
  const [relationshipSkillInstalledVersion, setRelationshipSkillInstalledVersion] = useState<string | undefined>(undefined);
  const [relationshipSkillRequiredVersion, setRelationshipSkillRequiredVersion] = useState<string | undefined>(undefined);
  const [relationshipSkillCheckNonce, setRelationshipSkillCheckNonce] = useState(0);
  const [relationshipSkillPromptOpen, setRelationshipSkillPromptOpen] = useState(false);
  // Consent 是用户对某个 Agent 窗口/模式的长期意图；runtime 是某个 session 的临时检查结果，二者不能合并。
  const [localControlConsentByScope, setLocalControlConsentByScope] = useState<Record<string, boolean>>({});
  const [localControlRuntimeBySession, setLocalControlRuntimeBySession] = useState<Record<string, LocalControlRuntimeState>>({});
  const [relationshipSkillByScope, setRelationshipSkillByScope] = useState<Record<string, RelationshipSkillState>>({});
  const [terminalActivityBySession, setTerminalActivityBySession] = useState<Record<string, TerminalActivityState>>({});
  const [agentTerminalSession, setAgentTerminalSession] = useState<AgentTerminalSession | null>(null);
  const [agentTerminalBusy, setAgentTerminalBusy] = useState(false);
  const [agentTerminalError, setAgentTerminalError] = useState<string | null>(null);
  const [agentTerminalToolRequest, setAgentTerminalToolRequest] = useState<ToolRequestRecord | null>(null);
  const [agentTerminalToolBusy, setAgentTerminalToolBusy] = useState(false);
  const [agentTerminalToolError, setAgentTerminalToolError] = useState<string | null>(null);
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
    try {
      const response = await fetchDiagnostics();
      setHealth(response.health);
      setHealthError(null);
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshClientIdentity();
    void refreshAgents();
    void refreshDiagnostics();
    void refreshNetworkGuide();
  }, [refreshClientIdentity, refreshAgents, refreshDiagnostics, refreshNetworkGuide]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshDiagnostics();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [refreshDiagnostics]);

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

  const refreshAgentTerminalAuthorization = useCallback(async () => {
    if (healthError === LOCAL_SERVER_DISCONNECTED_MESSAGE) return;
    try {
      const response = await fetchAgentTerminalSessions();
      setAgentTerminalSession((current) => {
        const currentStillPending = current
          ? response.sessions.find((session) => session.terminalSessionId === current.terminalSessionId && session.state === "pending_authorization")
          : null;
        if (currentStillPending) return currentStillPending;
        return response.sessions.find((session) => session.state === "pending_authorization") ?? null;
      });
    } catch (error) {
      if (isLocalServerDisconnected(error)) setHealthError(LOCAL_SERVER_DISCONNECTED_MESSAGE);
      // Agent Terminal authorization is opportunistic UI state; connection errors are shown by health/status surfaces.
    }
  }, [healthError]);

  const refreshAgentTerminalToolApproval = useCallback(async () => {
    if (healthError === LOCAL_SERVER_DISCONNECTED_MESSAGE) return;
    try {
      const response = await fetchToolRequests({ status: "pending", limit: 100 });
      setAgentTerminalToolRequest((current) => {
        const currentStillPending = current
          ? response.requests.find((request) => request.id === current.id && isGatewayTerminalRequest(request))
          : null;
        if (currentStillPending) return currentStillPending;
        return response.requests.find(isGatewayTerminalRequest) ?? null;
      });
    } catch (error) {
      if (isLocalServerDisconnected(error)) setHealthError(LOCAL_SERVER_DISCONNECTED_MESSAGE);
      // Tool Queue page and connection status surfaces own request-list errors.
    }
  }, [healthError]);

  useEffect(() => {
    void refreshAgentTerminalAuthorization();
    void refreshAgentTerminalToolApproval();
    const interval = window.setInterval(() => {
      void refreshAgentTerminalAuthorization();
      void refreshAgentTerminalToolApproval();
    }, 2000);
    return () => window.clearInterval(interval);
  }, [refreshAgentTerminalAuthorization, refreshAgentTerminalToolApproval]);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedSessionScope = selectedAgent ? sessionScopeKey(selectedAgent.id, sessionMode, clientIdentity) : null;
  const selectedSession = selectedAgent && selectedSessionScope
    ? sessionOverrides[selectedSessionScope] ?? sessionKeyForAgent(selectedAgent, sessionMode, clientIdentity)
    : null;
  const attachments = selectedSession ? attachmentsBySession[selectedSession] ?? [] : [];
  const selectedLocalControlConsent = selectedSessionScope ? localControlConsentByScope[selectedSessionScope] === true : false;
  const selectedLocalControlRuntime = selectedSession ? localControlRuntimeBySession[selectedSession] ?? "idle" : "idle";
  const selectedTerminalActivity = selectedSession ? terminalActivityBySession[selectedSession] ?? "connected" : "connected";
  const selectedRelationshipSkill = selectedSessionScope ? relationshipSkillByScope[selectedSessionScope] : undefined;

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
      setHealthError(`上传失败${fileNames ? ` (${fileNames})` : ""}: ${message}`);
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

  async function handleAuthorizeAgentTerminalSession() {
    if (!agentTerminalSession) return;
    setAgentTerminalBusy(true);
    setAgentTerminalError(null);
    try {
      await authorizeAgentTerminalSession(agentTerminalSession.terminalSessionId);
      setAgentTerminalSession(null);
      void refreshHealth();
      void refreshAgentTerminalAuthorization();
    } catch (error) {
      setAgentTerminalError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentTerminalBusy(false);
    }
  }

  async function handleApproveAgentTerminalToolRequest() {
    if (!agentTerminalToolRequest) return;
    // 全局 gateway-terminal 弹窗可能在非当前聊天视图出现，必须按 request.sessionKey 写回状态。
    const activitySession = agentTerminalToolRequest.kind === "terminal" ? agentTerminalToolRequest.sessionKey : null;
    setAgentTerminalToolBusy(true);
    setAgentTerminalToolError(null);
    try {
      if (activitySession) {
        setTerminalActivityBySession((current) => ({ ...current, [activitySession]: "running" }));
      }
      await approveToolRequest(agentTerminalToolRequest.id, {
        riskAccepted: agentTerminalToolRequest.risk?.level === "elevated",
        actor: decisionActor(clientIdentity)
      });
      setAgentTerminalToolRequest(null);
      void refreshAgentTerminalToolApproval();
    } catch (error) {
      setAgentTerminalToolError(error instanceof Error ? error.message : String(error));
    } finally {
      if (activitySession) {
        setTerminalActivityBySession((current) => ({ ...current, [activitySession]: "connected" }));
      }
      setAgentTerminalToolBusy(false);
    }
  }

  async function handleRejectAgentTerminalToolRequest() {
    if (!agentTerminalToolRequest) return;
    setAgentTerminalToolBusy(true);
    setAgentTerminalToolError(null);
    try {
      await rejectToolRequest(agentTerminalToolRequest.id, { actor: decisionActor(clientIdentity) });
      setAgentTerminalToolRequest(null);
      void refreshAgentTerminalToolApproval();
    } catch (error) {
      setAgentTerminalToolError(error instanceof Error ? error.message : String(error));
    } finally {
      setAgentTerminalToolBusy(false);
    }
  }

  const handleRelationshipSkillStatusChange = useCallback((status: RelationshipSkillStatus, message?: string, installedVersion?: string, requiredVersion?: string) => {
    const scope = selectedSessionScope;
    const session = selectedSession;
    if (scope) {
      setRelationshipSkillByScope((current) => ({
        ...current,
        [scope]: { status, message, installedVersion, requiredVersion }
      }));
    }
    if (session) {
      setLocalControlRuntimeBySession((current) => {
        const nextState: LocalControlRuntimeState = status === "ready" || status === "outdated"
          ? "ready"
          : status === "missing"
            ? "install_required"
            : status === "checking"
              ? "checking"
              : status === "error"
                ? "error"
                : current[session] ?? "idle";
        return { ...current, [session]: nextState };
      });
    }
    setRelationshipSkillStatus(status);
    setRelationshipSkillMessage(message);
    setRelationshipSkillInstalledVersion(installedVersion);
    setRelationshipSkillRequiredVersion(requiredVersion);
  }, [selectedSession, selectedSessionScope]);

  function handleNewSession() {
    if (!selectedAgent || !selectedSessionScope) return;
    const nextSession = newSessionKeyForAgent(selectedAgent, sessionMode, clientIdentity);
    setSessionOverrides((current) => ({ ...current, [selectedSessionScope]: nextSession }));
    setAttachmentsBySession((current) => ({ ...current, [nextSession]: [] }));
    setLocalControlRuntimeBySession((current) => ({ ...current, [nextSession]: "idle" }));
    if (localControlConsentByScope[selectedSessionScope]) {
      setLocalControlRuntimeBySession((current) => ({ ...current, [nextSession]: "checking" }));
      setRelationshipSkillStatus("checking");
      setRelationshipSkillMessage("Checking detach-agent-relationship skill...");
      setRelationshipSkillInstalledVersion(undefined);
      setRelationshipSkillRequiredVersion(undefined);
      setRelationshipSkillCheckNonce((current) => current + 1);
    }
  }

  function handleEnableLocalControl() {
    if (!selectedSession || !selectedSessionScope) return;
    setLocalControlConsentByScope((current) => ({ ...current, [selectedSessionScope]: true }));
    setLocalControlRuntimeBySession((current) => ({ ...current, [selectedSession]: "checking" }));
    setRelationshipSkillStatus("checking");
    setRelationshipSkillMessage("Checking detach-agent-relationship skill...");
    setRelationshipSkillInstalledVersion(undefined);
    setRelationshipSkillRequiredVersion(undefined);
    chatPanelRef.current?.requestRelationshipSkillCheck("user-click");
  }

  function handleDisableLocalControl() {
    if (!selectedSessionScope || !selectedSession) return;
    setLocalControlConsentByScope((current) => ({ ...current, [selectedSessionScope]: false }));
    setLocalControlRuntimeBySession((current) => ({ ...current, [selectedSession]: "idle" }));
  }

  function handleInstallRelationshipSkill() {
    if (!selectedSession || !selectedSessionScope) return;
    setLocalControlRuntimeBySession((current) => ({ ...current, [selectedSession]: "installing" }));
    setRelationshipSkillPromptOpen(false);
    chatPanelRef.current?.sendRelationshipSkillInstallPrompt(relationshipSkillInstallPrompt);
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
      {agentTerminalSession ? (
        <AgentTerminalAuthorizationDialog
          session={agentTerminalSession}
          busy={agentTerminalBusy}
          error={agentTerminalError}
          onAuthorize={() => void handleAuthorizeAgentTerminalSession()}
          onDismiss={() => setAgentTerminalSession(null)}
        />
      ) : null}
      {!agentTerminalSession && agentTerminalToolRequest ? (
        <AgentTerminalToolApprovalDialog
          request={agentTerminalToolRequest}
          busy={agentTerminalToolBusy}
          error={agentTerminalToolError}
          onApprove={() => void handleApproveAgentTerminalToolRequest()}
          onReject={() => void handleRejectAgentTerminalToolRequest()}
          onDismiss={() => setAgentTerminalToolRequest(null)}
        />
      ) : null}
      {relationshipSkillPromptOpen ? (
        <RelationshipSkillPromptDialog
          status={selectedRelationshipSkill?.status ?? relationshipSkillStatus}
          message={selectedRelationshipSkill?.message ?? relationshipSkillMessage}
          installedVersion={selectedRelationshipSkill?.installedVersion ?? relationshipSkillInstalledVersion}
          requiredVersion={selectedRelationshipSkill?.requiredVersion ?? relationshipSkillRequiredVersion}
          callbackHost={health?.config.publicBaseUrl}
          onInstall={() => handleInstallRelationshipSkill()}
          onDismiss={() => setRelationshipSkillPromptOpen(false)}
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
        relationshipSkillStatus={selectedRelationshipSkill?.status ?? relationshipSkillStatus}
        relationshipSkillMessage={selectedRelationshipSkill?.message ?? relationshipSkillMessage}
        relationshipSkillInstalledVersion={selectedRelationshipSkill?.installedVersion ?? relationshipSkillInstalledVersion}
        relationshipSkillRequiredVersion={selectedRelationshipSkill?.requiredVersion ?? relationshipSkillRequiredVersion}
        onRelationshipSkillAction={() => {
          setRelationshipSkillPromptOpen(true);
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
          <button className={view === "tool-queue" ? "active" : ""} onClick={() => setView("tool-queue")}>工具队列</button>
          <button className={view === "file-browser" ? "active" : ""} onClick={() => setView("file-browser")}>
            <FolderOpen size={15} />
            文件浏览
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
            relationshipSkillCheckNonce={relationshipSkillCheckNonce}
            localControlConsent={selectedLocalControlConsent}
            localControlRuntime={selectedLocalControlRuntime}
            localControlScope={selectedSessionScope ?? undefined}
            relationshipSkillStatus={selectedRelationshipSkill?.status ?? relationshipSkillStatus}
            relationshipSkillMessage={selectedRelationshipSkill?.message ?? relationshipSkillMessage}
            terminalActivity={selectedTerminalActivity}
            onSessionModeChange={setSessionMode}
            onNewSession={handleNewSession}
            onClearAttachments={() => {
              if (!selectedSession) return;
              setAttachmentsBySession((current) => ({ ...current, [selectedSession]: [] }));
            }}
            onNeedUpload={handleUpload}
            onRelationshipSkillStatusChange={handleRelationshipSkillStatusChange}
            onEnableLocalControl={handleEnableLocalControl}
            onDisableLocalControl={handleDisableLocalControl}
            onRelationshipSkillInstallRequired={() => setRelationshipSkillPromptOpen(true)}
            onTerminalActivityChange={(state) => {
              if (!selectedSession) return;
              setTerminalActivityBySession((current) => ({ ...current, [selectedSession]: state }));
            }}
          />
        </div>
      ) : view === "network" ? (
        <div className="settings-workspace">
          <SettingsPanel
            onSaved={() => {
              void refreshAgents();
              void refreshDiagnostics();
              void refreshNetworkGuide();
            }}
          />
        </div>
      ) : view === "tool-queue" ? (
        <div className="tool-queue-workspace">
          <ToolQueuePanel
            sessionKey={selectedSession}
            agentId={selectedAgent?.id ?? null}
            clientIdentity={clientIdentity}
            onTerminalActivityChange={(state) => {
              if (!selectedSession) return;
              setTerminalActivityBySession((current) => ({ ...current, [selectedSession]: state }));
            }}
            onRevealTerminal={() => {
              if (selectedLocalControlRuntime !== "ready") {
                setView("chat");
                window.setTimeout(() => chatPanelRef.current?.promptEnableLocalControl(), 50);
                return;
              }
              setView("chat");
              window.setTimeout(() => chatPanelRef.current?.revealTerminal(), 50);
            }}
          />
        </div>
      ) : (
        <FileBrowserPage />
      )}
    </div>
  );
}

function AgentTerminalAuthorizationDialog({
  session,
  busy,
  error,
  onAuthorize,
  onDismiss
}: {
  session: AgentTerminalSession;
  busy: boolean;
  error: string | null;
  onAuthorize: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="save-password-backdrop" role="presentation">
      <div className="save-password-dialog" role="dialog" aria-modal="true" aria-label="Gateway terminal authorization request">
        <header className="save-password-header">
          <KeyRound size={20} />
          <div>
            <strong>Gateway terminal 授权请求</strong>
            <small>{session.remoteAddress} · {session.agentId || "main-agent"}</small>
          </div>
          <button type="button" className="icon-button small" title="Dismiss" onClick={onDismiss}>
            <X size={15} />
          </button>
        </header>
        <div className="save-password-content">
          <section>
            <h3>Agent Terminal Session</h3>
            <div className="save-password-grid">
              <span>Remote</span><strong>{session.remoteAddress}</strong>
              <span>Agent</span><strong>{session.agentId || "main-agent"}</strong>
              <span>Session</span><strong>{session.sessionKey}</strong>
              <span>Created</span><strong>{session.createdAt}</strong>
            </div>
          </section>
          <section>
            <h3>Approval</h3>
            <p className="save-password-note">批准后，Main Agent 可以通过 gateway-terminal 提交命令请求。每条命令仍会进入 Tool Queue，并经过 Command Guard 和用户审批。</p>
            {error ? <p className="save-password-warning">{error}</p> : null}
          </section>
        </div>
        <footer className="save-password-actions">
          <button type="button" className="secondary-button" onClick={onDismiss} disabled={busy}>稍后</button>
          <button type="button" className="primary-button" onClick={onAuthorize} disabled={busy}>授权 gateway-terminal</button>
        </footer>
      </div>
    </div>
  );
}

function AgentTerminalToolApprovalDialog({
  request,
  busy,
  error,
  onApprove,
  onReject,
  onDismiss
}: {
  request: ToolRequestRecord;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
  onDismiss: () => void;
}) {
  const command = typeof request.payload.command === "string" ? request.payload.command : "";
  return (
    <div className="save-password-backdrop" role="presentation">
      <div className="save-password-dialog" role="dialog" aria-modal="true" aria-label="Gateway terminal command approval">
        <header className="save-password-header">
          <KeyRound size={20} />
          <div>
            <strong>Gateway terminal 命令审批</strong>
            <small>{request.agentId || "main-agent"} · {request.status}</small>
          </div>
          <button type="button" className="icon-button small" title="Dismiss" onClick={onDismiss}>
            <X size={15} />
          </button>
        </header>
        <div className="save-password-content">
          <section>
            <h3>Command</h3>
            {request.reason ? <p className="save-password-note">{request.reason}</p> : null}
            <code className="agent-terminal-command">{command}</code>
          </section>
          <section>
            <h3>Safety</h3>
            <div className="save-password-grid">
              <span>Channel</span><strong>{request.metadata?.terminalChannel || "gateway-terminal"}</strong>
              <span>Risk</span><strong>{request.risk?.level || "safe"}</strong>
              <span>Guard</span><strong>{request.guard?.decision || "allow"}</strong>
            </div>
            {request.risk?.reasons.length ? <p className="save-password-warning">{request.risk.reasons.join("; ")}</p> : null}
            {error ? <p className="save-password-warning">{error}</p> : null}
          </section>
        </div>
        <footer className="save-password-actions">
          <button type="button" className="secondary-button" onClick={onDismiss} disabled={busy}>稍后</button>
          <button type="button" className="secondary-button danger" onClick={onReject} disabled={busy}>拒绝</button>
          <button type="button" className="primary-button" onClick={onApprove} disabled={busy || request.status !== "pending"}>批准执行</button>
        </footer>
      </div>
    </div>
  );
}

function isGatewayTerminalRequest(request: ToolRequestRecord): boolean {
  return request.kind === "terminal"
    && request.status === "pending"
    && request.source === "gateway-event"
    && request.metadata?.terminalChannel === "gateway-terminal";
}

function decisionActor(identity: ClientIdentity | null) {
  return {
    deviceId: identity?.deviceId,
    deviceIdShort: identity?.deviceIdShort,
    displayName: identity?.displayName,
    source: "detaches-ui" as const
  };
}

function RelationshipSkillPromptDialog({
  status,
  message,
  installedVersion,
  requiredVersion,
  callbackHost,
  onInstall,
  onDismiss
}: {
  status: RelationshipSkillStatus;
  message?: string;
  installedVersion?: string;
  requiredVersion?: string;
  callbackHost?: string;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const targetVersion = requiredVersion || relationshipSkillVersion;
  const prompt = callbackHost
    ? `${relationshipSkillInstallPrompt}\n\n当前 Detach Agent callback host: ${callbackHost}\n安装/更新后，Main Agent 可用：\nnode ~/.detach_agent/bin/detaches-agent-adapter.mjs terminal-run --host ${callbackHost} --command 'pwd' --reason 'check gateway-terminal'`
    : relationshipSkillInstallPrompt;

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="save-password-backdrop" role="presentation">
      <section className="relationship-skill-prompt-dialog" role="dialog" aria-modal="true" aria-label="Relationship skill update prompt">
        <header className="save-password-header">
          <FileText size={20} />
          <div>
            <strong>Relationship skill 安装/更新</strong>
            <small>复制下面这段话发给 Main Agent，让它更新到 v{targetVersion}</small>
          </div>
          <button type="button" className="icon-button small" title="Dismiss" onClick={onDismiss}>
            <X size={15} />
          </button>
        </header>
        <div className="relationship-skill-prompt-meta">
          <span>状态：{status}</span>
          {installedVersion ? <span>当前版本：{installedVersion}</span> : null}
          <span>目标版本：{targetVersion}</span>
        </div>
        {message ? <p className="relationship-skill-prompt-message">{message}</p> : null}
        <div className="relationship-skill-prompt-box">
          <div>
            <strong>发给 Main Agent 的 Prompt</strong>
            <button type="button" className="copy-button" title="Copy prompt" onClick={() => void copyPrompt()}>
              <Copy size={14} />
            </button>
          </div>
          <pre>{prompt}</pre>
          {copied ? <small>已复制</small> : null}
        </div>
        <footer className="save-password-actions">
          <button type="button" className="secondary-button" onClick={onDismiss}>稍后</button>
          <button type="button" className="primary-button" onClick={onInstall}>安装并启用</button>
        </footer>
      </section>
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

function sessionScopeKey(agentId: string, sessionMode: ChatSessionMode, identity: ClientIdentity | null): string {
  const deviceScope = sessionMode === "device" ? identity?.deviceIdShort || "local" : "main";
  return `${normalizeAgentId(agentId)}:${sessionMode}:${deviceScope}`;
}
