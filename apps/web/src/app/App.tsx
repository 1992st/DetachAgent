import { useCallback, useEffect, useState } from "react";
import type { AgentSummary, AppHealth, ChatSessionMode, ClientIdentity, DiagnosticItem, UploadedFileRef } from "@detaches/shared";
import { fetchAgents, fetchClientIdentity, fetchDiagnostics, fetchHealth, uploadFile } from "../lib/api.js";
import { ConnectionBar } from "../features/connection/ConnectionBar.js";
import { AgentList } from "../features/agents/AgentList.js";
import { ChatPanel } from "../features/chat/ChatPanel.js";
import { FilePanel } from "../features/files/FilePanel.js";
import { SettingsPanel } from "../features/settings/SettingsPanel.js";

type ViewMode = "chat" | "network";

export function App() {
  const [view, setView] = useState<ViewMode>("chat");
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
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
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, UploadedFileRef[]>>({});
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [remotePath, setRemotePath] = useState("");

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
    void refreshHealth();
    void refreshClientIdentity();
    void refreshAgents();
    void refreshDiagnostics();
  }, [refreshHealth, refreshClientIdentity, refreshAgents, refreshDiagnostics]);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedSession = selectedAgent ? sessionKeyForAgent(selectedAgent, sessionMode, clientIdentity) : null;
  const attachments = selectedSession ? attachmentsBySession[selectedSession] ?? [] : [];

  async function handleUpload(files: FileList) {
    if (!selectedSession) return;
    setUploading(true);
    setFileError(null);
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
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="shell">
      <ConnectionBar health={health} loading={healthLoading} error={healthError} onRefresh={refreshHealth} />
      <nav className="view-tabs" aria-label="Main views">
        <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>聊天</button>
        <button className={view === "network" ? "active" : ""} onClick={() => setView("network")}>网络与 SSH</button>
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
            sessionKey={selectedSession}
            agentId={selectedAgent?.id ?? null}
            sessionMode={sessionMode}
            clientIdentity={clientIdentity}
            attachments={attachments}
            onSessionModeChange={setSessionMode}
            onClearAttachments={() => {
              if (!selectedSession) return;
              setAttachmentsBySession((current) => ({ ...current, [selectedSession]: [] }));
            }}
            onNeedUpload={handleUpload}
          />
          <FilePanel
            files={attachments}
            uploading={uploading}
            error={fileError}
            remotePath={remotePath}
            diagnostics={diagnostics}
            diagnosticsLoading={diagnosticsLoading}
            diagnosticsError={diagnosticsError}
            onRemotePathChange={setRemotePath}
            onDiagnosticsRefresh={refreshDiagnostics}
          />
        </div>
      ) : (
        <div className="settings-workspace">
          <SettingsPanel
            onSaved={() => {
              void refreshHealth();
              void refreshAgents();
              void refreshDiagnostics();
            }}
          />
        </div>
      )}
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
