import { FormEvent, useEffect, useState } from "react";
import { Copy, FileInput, Play, Plus, Save, Settings2, ShieldCheck, Trash2, Wifi, X } from "lucide-react";
import type { NetworkTestResponse, PublicSettings, RemoteProfile, RemoteProfileUpdate } from "@detaches/shared";
import { activateRemoteProfile, createRemoteProfile, deleteRemoteProfile, fetchSettings, saveRemoteProfile, testNetwork } from "../../lib/api.js";
import { AgentConfigAssistantDialog } from "./agentConfigAssistant/AgentConfigAssistantDialog.js";

interface Props {
  onSaved: () => void;
}

export function SettingsPanel({ onSaved }: Props) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NetworkTestResponse | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantApplying, setAssistantApplying] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [guideStage, setGuideStage] = useState<"idle" | "import-agent" | "gateway-health" | "test-network">("idle");
  const [copiedPairingCommand, setCopiedPairingCommand] = useState(false);

  useEffect(() => {
    fetchSettings()
      .then((value) => {
        setSettings(value);
        setSelectedProfileId(value.activeProfileId);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);

  const selectedProfile = settings?.profiles.find((profile) => profile.id === selectedProfileId) ?? settings ?? null;
  const gatewayHealthStep = testResult?.steps.find((step) => step.id === "gateway-health") ?? null;
  const gatewayConnected = gatewayHealthStep?.state === "ok";
  const gatewayNeedsPairing = Boolean(gatewayHealthStep && networkStepApproveCommand(gatewayHealthStep.details));
  const selectedIdentityPath = selectedProfile?.remoteIdentityPath ?? "";
  const identityLooksInvalid = Boolean(selectedIdentityPath)
    && !selectedIdentityPath.startsWith("/")
    && !selectedIdentityPath.startsWith("~/");
  const mainAgentGatewayHost = selectedProfile?.gatewayDirectHost || selectedProfile?.remoteHost || "100.x.x.x";
  const mainAgentGatewayPort = Number(selectedProfile?.gatewayRemotePort) || 18789;
  const mainAgentGatewayUrl = selectedProfile?.gatewayDirectUrl || `https://<main-agent-device>.tail09cff1.ts.net`;
  const mainAgentAuthMode = selectedProfile?.authMode === "password" ? "password" : "token";
  const mainAgentAuthField = mainAgentAuthMode === "password" ? "password" : "token";
  const mainAgentAuthPlaceholder = mainAgentAuthMode === "password" ? "<gateway-password>" : "<gateway-token>";
  const customBindDemo = JSON.stringify({
    gateway: {
      bind: "custom",
      customBindHost: mainAgentGatewayHost,
      port: mainAgentGatewayPort,
      auth: {
        mode: mainAgentAuthMode,
        [mainAgentAuthField]: mainAgentAuthPlaceholder
      }
    }
  }, null, 2);
  const tailnetBindDemo = JSON.stringify({
    gateway: {
      bind: "tailnet",
      port: mainAgentGatewayPort,
      auth: {
        mode: mainAgentAuthMode,
        [mainAgentAuthField]: mainAgentAuthPlaceholder
      }
    }
  }, null, 2);
  const detachesDemo = JSON.stringify({
    gatewayTransport: "direct",
    gatewayDirectUrl: mainAgentGatewayUrl,
    gatewayDirectHost: mainAgentGatewayHost,
    gatewayRemotePort: mainAgentGatewayPort,
    authMode: mainAgentAuthMode,
    publicBaseUrl: selectedProfile?.publicBaseUrl || "http://<detaches-pc-tailnet-ip>:38888"
  }, null, 2);

  function updateSelectedProfile(patch: Partial<RemoteProfileUpdate>) {
    if (!settings || !selectedProfile) return;
    const nextProfiles = settings.profiles.map((profile) => profile.id === selectedProfile.id ? { ...profile, ...patch } : profile);
    const nextSelected = nextProfiles.find((profile) => profile.id === selectedProfile.id) ?? selectedProfile;
    setSettings({
      ...settings,
      ...(settings.activeProfileId === selectedProfile.id ? nextSelected : {}),
      profiles: nextProfiles
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings || !selectedProfile) return;
    setStatus("Saving...");
    const update: RemoteProfileUpdate = {
      name: selectedProfile.name,
      remoteHost: selectedProfile.remoteHost,
      remoteSshPort: Number(selectedProfile.remoteSshPort),
      remoteUser: selectedProfile.remoteUser,
      remoteIdentityPath: selectedProfile.remoteIdentityPath,
      mainAgentServiceEnabled: selectedProfile.mainAgentServiceEnabled,
      localSshBridgeEnabled: selectedProfile.localSshBridgeEnabled,
      reverseBridgeRemoteHost: selectedProfile.reverseBridgeRemoteHost,
      reverseBridgeRemotePort: Number(selectedProfile.reverseBridgeRemotePort),
      gatewayTransport: selectedProfile.gatewayTransport,
      gatewayDirectHost: selectedProfile.gatewayDirectHost,
      gatewayDirectUrl: selectedProfile.gatewayDirectUrl,
      gatewayRemotePort: Number(selectedProfile.gatewayRemotePort),
      gatewayLocalPort: Number(selectedProfile.gatewayLocalPort),
      authMode: selectedProfile.authMode,
      remoteWorkspaceRoot: selectedProfile.remoteWorkspaceRoot,
      publicBaseUrl: selectedProfile.publicBaseUrl
    };
    if (token.trim()) update.authToken = token.trim();
    if (password.trim()) update.authPassword = password.trim();
    if (clearToken) update.clearAuthToken = true;
    if (clearPassword) update.clearAuthPassword = true;
    try {
      const saved = await saveRemoteProfile(selectedProfile.id, update);
      setSettings(saved);
      setSelectedProfileId(selectedProfile.id);
      setToken("");
      setPassword("");
      setClearToken(false);
      setClearPassword(false);
      setStatus(selectedProfile.id === saved.activeProfileId ? "Saved. Active connection will use the new settings." : "Saved profile. Activate it to use this remote.");
      if (selectedProfile.id === saved.activeProfileId) onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function runTest() {
    setTesting(true);
    setStatus(null);
    try {
      const result = await testNetwork();
      setTestResult(result);
      const gatewayStep = result.steps.find((step) => step.id === "gateway-health");
      if (gatewayStep?.state === "ok") {
        setGuideStage("idle");
        setCopiedPairingCommand(false);
      } else if (gatewayStep && networkStepApproveCommand(gatewayStep.details)) {
        setGuideStage("gateway-health");
        setCopiedPairingCommand(false);
      }
      onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  async function createProfile(copy = true) {
    if (!settings) return;
    setStatus("Creating profile...");
    try {
      const saved = await createRemoteProfile({
        name: copy && selectedProfile ? `${selectedProfile.name} copy` : "New remote",
        copyFromProfileId: copy ? selectedProfile?.id : undefined
      });
      setSettings(saved);
      setSelectedProfileId(saved.activeProfileId);
      setTestResult(null);
      setCopiedPairingCommand(false);
      setGuideStage("import-agent");
      setStatus("Created profile.");
      onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function activateProfile() {
    if (!selectedProfile) return;
    setStatus("Activating profile...");
    try {
      const saved = await activateRemoteProfile(selectedProfile.id);
      setSettings(saved);
      setSelectedProfileId(saved.activeProfileId);
      setStatus("Activated. Connection will use this remote.");
      onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeProfile() {
    if (!settings || !selectedProfile) return;
    setStatus("Deleting profile...");
    try {
      const saved = await deleteRemoteProfile(selectedProfile.id);
      setSettings(saved);
      setSelectedProfileId(saved.activeProfileId);
      setStatus("Deleted profile.");
      onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function quickDirectSetup() {
    if (!selectedProfile) return;
    setStatus("正在保存直连配置...");
    try {
      const update: RemoteProfileUpdate = {
        name: selectedProfile.name,
        remoteHost: selectedProfile.remoteHost,
        gatewayTransport: "direct",
        localSshBridgeEnabled: false,
        gatewayDirectUrl: selectedProfile.gatewayDirectUrl,
        gatewayDirectHost: selectedProfile.gatewayDirectHost || selectedProfile.remoteHost,
        gatewayRemotePort: Number(selectedProfile.gatewayRemotePort),
        authMode: selectedProfile.authMode,
        remoteWorkspaceRoot: selectedProfile.remoteWorkspaceRoot,
        publicBaseUrl: selectedProfile.publicBaseUrl
      };
      if (token.trim()) update.authToken = token.trim();
      if (password.trim()) update.authPassword = password.trim();
      if (clearToken) update.clearAuthToken = true;
      if (clearPassword) update.clearAuthPassword = true;
      const saved = await saveRemoteProfile(selectedProfile.id, update);
      setSettings(saved);
      if (saved.activeProfileId !== selectedProfile.id) {
        setSettings(await activateRemoteProfile(selectedProfile.id));
      }
      setSelectedProfileId(selectedProfile.id);
      setToken("");
      setPassword("");
      setClearToken(false);
      setClearPassword(false);
      setStatus("直连配置已保存，正在测试 Gateway。");
      onSaved();
      await runTest();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function applyAgentConfig(update: RemoteProfileUpdate) {
    if (!selectedProfile) return;
    setAssistantApplying(true);
    setStatus("正在应用 Agent 配置...");
    try {
      const saved = await saveRemoteProfile(selectedProfile.id, {
        name: selectedProfile.name,
        remoteHost: selectedProfile.remoteHost,
        remoteSshPort: Number(selectedProfile.remoteSshPort),
        remoteUser: selectedProfile.remoteUser,
        remoteIdentityPath: selectedProfile.remoteIdentityPath,
        mainAgentServiceEnabled: selectedProfile.mainAgentServiceEnabled,
        localSshBridgeEnabled: selectedProfile.localSshBridgeEnabled,
        reverseBridgeRemoteHost: selectedProfile.reverseBridgeRemoteHost,
        reverseBridgeRemotePort: Number(selectedProfile.reverseBridgeRemotePort),
        gatewayTransport: selectedProfile.gatewayTransport,
        gatewayDirectHost: selectedProfile.gatewayDirectHost,
        gatewayDirectUrl: selectedProfile.gatewayDirectUrl,
        gatewayRemotePort: Number(selectedProfile.gatewayRemotePort),
        gatewayLocalPort: Number(selectedProfile.gatewayLocalPort),
        authMode: selectedProfile.authMode,
        remoteWorkspaceRoot: selectedProfile.remoteWorkspaceRoot,
        publicBaseUrl: selectedProfile.publicBaseUrl,
        ...update
      });
      setSettings(saved);
      if (saved.activeProfileId !== selectedProfile.id) {
        setSettings(await activateRemoteProfile(selectedProfile.id));
      }
      setSelectedProfileId(selectedProfile.id);
      setToken("");
      setPassword("");
      setClearToken(false);
      setClearPassword(false);
      setStatus("Agent 配置已应用，正在测试网络。");
      onSaved();
      await runTest();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setAssistantApplying(false);
    }
  }

  function handleCopyPairingCommand(command: string) {
    void copyText(command);
    setCopiedPairingCommand(true);
    setGuideStage("test-network");
  }

  if (!settings || !selectedProfile) {
    return <div className="settings-page muted">{status ?? "Loading settings..."}</div>;
  }

  return (
    <div className="settings-page">
      <section className="settings-panel profile-panel">
        <div className="settings-title">
          <div>
            <h2>远端服务</h2>
            <p>保存多个 OpenClaw Gateway 连接配置，并选择当前生效的远端。</p>
          </div>
          <Wifi size={18} />
        </div>
        <div className="profile-list">
          {settings.profiles.map((profile) => (
            <button
              type="button"
              className={`profile-item ${profile.id === selectedProfile.id ? "selected" : ""}`}
              key={profile.id}
              onClick={() => setSelectedProfileId(profile.id)}
            >
              <strong>{profile.name}</strong>
              <span>{profile.remoteHost}</span>
              <small>{profile.id === settings.activeProfileId ? "当前生效" : profile.gatewayTransport}</small>
            </button>
          ))}
        </div>
        <div className="profile-actions">
          <button type="button" className="secondary-button" onClick={() => createProfile(false)}>
            <Plus size={16} />
            新建
          </button>
          <button type="button" className="secondary-button" onClick={() => createProfile(true)}>
            <Copy size={16} />
            复制
          </button>
          <button type="button" className="secondary-button danger" onClick={removeProfile} disabled={settings.profiles.length <= 1}>
            <Trash2 size={16} />
            删除
          </button>
        </div>
      </section>

      <form className="settings-panel primary" onSubmit={submit}>
        <div className="settings-title">
          <div>
            <h2>网络连接</h2>
            <p>默认直连 Main Agent 的 OpenClaw Gateway；SSH 保留在高级配置中按需启用。</p>
          </div>
          <div className="settings-title-actions">
            <button type="button" className="secondary-button" onClick={() => setAdvancedOpen(true)}>
              <Settings2 size={16} />
              高级配置
            </button>
            <button type="button" className={`secondary-button ${guideStage === "test-network" && !gatewayConnected ? "guide-breathe" : ""}`} onClick={runTest} disabled={testing}>
              <Play size={16} />
              {testing ? "测试中" : "测试网络"}
            </button>
          </div>
        </div>

        <section className="settings-section">
          <div className="settings-section-heading">
            <h3>Main Agent Gateway</h3>
            <button
              type="button"
              className={`secondary-button compact agent-config-import-button ${guideStage === "import-agent" ? "guide-breathe" : ""}`}
              onClick={() => {
                setAssistantOpen(true);
                if (guideStage === "import-agent") setGuideStage("idle");
              }}
            >
              <FileInput size={16} />
              导入 Agent 配置
            </button>
          </div>
          <label>
            Profile name
            <input value={selectedProfile.name} onChange={(e) => updateSelectedProfile({ name: e.target.value })} />
          </label>
          <div className="settings-grid">
            <label>
              Remote host
              <input
                value={selectedProfile.remoteHost}
                placeholder="100.x.x.x 或 main-agent.ts.net"
                onChange={(e) => updateSelectedProfile({ remoteHost: e.target.value, gatewayDirectHost: e.target.value })}
              />
            </label>
            <label>
              Gateway port
              <input type="number" value={selectedProfile.gatewayRemotePort} onChange={(e) => updateSelectedProfile({ gatewayRemotePort: Number(e.target.value) })} />
            </label>
          </div>
          <label>
            Gateway URL / Tailscale Serve
            <input
              value={selectedProfile.gatewayDirectUrl}
              placeholder="https://main-agent.tailnet-name.ts.net"
              onChange={(e) => updateSelectedProfile({ gatewayDirectUrl: e.target.value })}
            />
            <small className="field-hint">如果 Main Agent 使用 `bind=loopback` + `tailscale.mode=serve`，这里填 Tailscale Serve 的 HTTPS 地址；会自动按 WSS 连接。</small>
          </label>
        </section>

        <section className="settings-section">
          <h3>Gateway 认证</h3>
          <label>
            Auth mode
            <select value={selectedProfile.authMode} onChange={(e) => updateSelectedProfile({ authMode: e.target.value as PublicSettings["authMode"] })}>
              <option value="token">token</option>
              <option value="password">password</option>
              <option value="none">none</option>
            </select>
          </label>
          <div className="settings-grid">
            <label>
              Gateway token {selectedProfile.hasAuthToken ? "(saved)" : ""}
              <input type="password" value={token} placeholder="leave blank to keep saved token" onChange={(e) => setToken(e.target.value)} />
            </label>
            <label>
              Gateway password {selectedProfile.hasAuthPassword ? "(saved)" : ""}
              <input type="password" value={password} placeholder="leave blank to keep saved password" onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <div className="settings-checks">
            {selectedProfile.hasAuthToken ? (
              <label className="check-row">
                <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} />
                Clear saved token
              </label>
            ) : null}
            {selectedProfile.hasAuthPassword ? (
              <label className="check-row">
                <input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} />
                Clear saved password
              </label>
            ) : null}
          </div>
        </section>

        <section className="settings-section">
          <h3>本机访问地址</h3>
          <label>
            Public base URL
            <input
              value={selectedProfile.publicBaseUrl}
              placeholder="http://100.x.x.x:38888"
              onChange={(e) => updateSelectedProfile({ publicBaseUrl: e.target.value })}
            />
          </label>
          <label>
            Remote workspace
            <input value={selectedProfile.remoteWorkspaceRoot} onChange={(e) => updateSelectedProfile({ remoteWorkspaceRoot: e.target.value })} />
          </label>
        </section>

        <div className="settings-actions">
          <button className="save-button">
            <Save size={16} />
            保存配置
          </button>
          <button type="button" className="secondary-button" onClick={quickDirectSetup}>
            <Wifi size={16} />
            保存并测试直连
          </button>
          {selectedProfile.id !== settings.activeProfileId ? (
            <button type="button" className="secondary-button" onClick={activateProfile}>
              设为当前
            </button>
          ) : null}
          {status ? <p className="settings-status">{status}</p> : null}
        </div>
      </form>

      <section className="settings-panel test-panel">
        <div className="settings-title">
          <div>
            <h2>网络测试</h2>
            <p>默认检查 Gateway 直连；高级 SSH 链路开启后才参与检测。</p>
          </div>
          <ShieldCheck size={18} />
        </div>
        {testResult ? (
          <div className="network-test-list">
            {testResult.steps.map((step) => (
              <article
                className={`network-test-step ${step.state} ${step.id === "gateway-health" && guideStage === "gateway-health" && gatewayNeedsPairing && !copiedPairingCommand ? "guide-breathe" : ""}`}
                key={step.id}
              >
                <strong>{step.label}</strong>
                <p>{step.message}</p>
                {networkStepApproveCommand(step.details) ? (
                  <div className="network-test-command">
                    <span>在 Main Agent 主机执行</span>
                    <code>{networkStepApproveCommand(step.details)}</code>
                    <button
                      type="button"
                      className={`secondary-button compact ${guideStage === "gateway-health" && !copiedPairingCommand ? "guide-breathe" : ""}`}
                      onClick={() => handleCopyPairingCommand(networkStepApproveCommand(step.details) ?? "")}
                    >
                      <Copy size={14} />
                      复制命令
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">点击“测试网络”后会显示逐项结果。</div>
        )}
        <details className="main-agent-config-help">
          <summary>Main Agent 需要怎么配置</summary>
          <p>detaches_agent 直连的是 Main Agent 的 OpenClaw Gateway，所以 Main Agent 必须让 Gateway 监听可被这台电脑访问的地址。</p>
          <p>OpenClaw 支持 `gateway.bind`、`gateway.customBindHost`、`gateway.port` 和 `gateway.auth`，不需要改源码。非 loopback 监听必须配置 token/password；Tailscale Serve/Funnel 则要求 Gateway 仍绑定 loopback。</p>
          <div className="config-example">
            <strong>支持：Tailscale Serve 保持 loopback</strong>
            <pre>{JSON.stringify({
              gateway: {
                bind: "loopback",
                port: mainAgentGatewayPort,
                tailscale: { mode: "serve" },
                auth: {
                  mode: mainAgentAuthMode,
                  [mainAgentAuthField]: mainAgentAuthPlaceholder
                }
              }
            }, null, 2)}</pre>
          </div>
          <div className="config-example">
            <strong>推荐：绑定 Tailnet 地址</strong>
            <pre>{tailnetBindDemo}</pre>
          </div>
          <div className="config-example">
            <strong>或者：指定当前 Gateway IP</strong>
            <pre>{customBindDemo}</pre>
          </div>
          <div className="config-example">
            <strong>detaches_agent 当前应对应为</strong>
            <pre>{detachesDemo}</pre>
          </div>
          <p>修改 Main Agent 的 OpenClaw 配置后，需要重启 Main Agent 上的 OpenClaw Gateway，再回到这里点击“测试网络”。</p>
        </details>
      </section>

      <AgentConfigAssistantDialog
        profile={selectedProfile}
        open={assistantOpen}
        applying={assistantApplying}
        onClose={() => setAssistantOpen(false)}
        onApply={applyAgentConfig}
      />
      {advancedOpen ? (
        <AdvancedSettingsDialog
          profile={selectedProfile}
          identityLooksInvalid={identityLooksInvalid}
          onClose={() => setAdvancedOpen(false)}
          onUpdate={updateSelectedProfile}
        />
      ) : null}
    </div>
  );
}

function AdvancedSettingsDialog({
  profile,
  identityLooksInvalid,
  onClose,
  onUpdate
}: {
  profile: RemoteProfile;
  identityLooksInvalid: boolean;
  onClose: () => void;
  onUpdate: (patch: Partial<RemoteProfileUpdate>) => void;
}) {
  const sshServiceEnabled = profile.mainAgentServiceEnabled || profile.gatewayTransport === "ssh";
  return (
    <div className="advanced-config-backdrop" role="presentation">
      <section className="advanced-config-dialog" role="dialog" aria-modal="true" aria-label="高级配置">
        <header className="advanced-config-header">
          <div>
            <strong>高级配置</strong>
            <small>SSH 是高级兼容能力，默认不参与 Gateway 直连主流程。</small>
          </div>
          <button type="button" className="icon-button small" title="关闭高级配置" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="advanced-config-body">
          <section className="advanced-config-section">
            <div>
              <h3>Main Agent 服务信息</h3>
              <p>当前支持 SSH；后续会扩展 scp 等协议。</p>
            </div>
            <label className="check-row advanced-toggle">
              <input
                type="checkbox"
                checked={sshServiceEnabled}
                onChange={(event) => onUpdate({
                  mainAgentServiceEnabled: event.target.checked,
                  gatewayTransport: event.target.checked ? profile.gatewayTransport : "direct"
                })}
              />
              启用 Main Agent 服务信息配置
            </label>
            <div className="settings-grid">
              <label>
                协议
                <select disabled={!sshServiceEnabled} value="ssh" onChange={() => undefined}>
                  <option value="ssh">SSH</option>
                </select>
              </label>
              <label>
                Gateway transport
                <select
                  disabled={!sshServiceEnabled}
                  value={profile.gatewayTransport}
                  onChange={(e) => onUpdate({
                    gatewayTransport: e.target.value as PublicSettings["gatewayTransport"],
                    mainAgentServiceEnabled: e.target.value === "ssh" ? true : profile.mainAgentServiceEnabled
                  })}
                >
                  <option value="direct">direct / Tailscale</option>
                  <option value="ssh">SSH tunnel</option>
                </select>
              </label>
            </div>
            <div className="settings-grid">
              <label>
                SSH host
                <input disabled={!sshServiceEnabled} value={profile.remoteHost} onChange={(e) => onUpdate({ remoteHost: e.target.value })} />
              </label>
              <label>
                SSH port
                <input disabled={!sshServiceEnabled} type="number" value={profile.remoteSshPort} onChange={(e) => onUpdate({ remoteSshPort: Number(e.target.value) })} />
              </label>
            </div>
            <div className="settings-grid">
              <label>
                SSH user
                <input disabled={!sshServiceEnabled} value={profile.remoteUser} onChange={(e) => onUpdate({ remoteUser: e.target.value })} />
              </label>
              <label>
                SSH identity / 私钥路径
                <input
                  disabled={!sshServiceEnabled}
                  value={profile.remoteIdentityPath}
                  placeholder="~/.ssh/detaches_agent_ed25519"
                  onChange={(e) => onUpdate({ remoteIdentityPath: e.target.value })}
                />
              </label>
            </div>
            {identityLooksInvalid && sshServiceEnabled ? <small className="field-warning">这里应填写私钥文件路径，不是 SSH 账号；账号请填在 SSH user。</small> : null}
          </section>

          <section className="advanced-config-section">
            <div>
              <h3>本机 SSH 回连</h3>
              <p>Main Agent 当前不依赖 SSH 控制本机 terminal；只有需要 reverse bridge 时才开启。</p>
            </div>
            <label className="check-row advanced-toggle">
              <input
                type="checkbox"
                checked={profile.localSshBridgeEnabled}
                onChange={(e) => onUpdate({ localSshBridgeEnabled: e.target.checked })}
              />
              连接本机 SSH / reverse bridge
            </label>
            {profile.localSshBridgeEnabled ? (
              <>
                <div className="settings-grid">
                  <label>
                    Reverse bridge host
                    <input value={profile.reverseBridgeRemoteHost} onChange={(e) => onUpdate({ reverseBridgeRemoteHost: e.target.value })} />
                  </label>
                  <label>
                    Reverse bridge port
                    <input type="number" value={profile.reverseBridgeRemotePort} onChange={(e) => onUpdate({ reverseBridgeRemotePort: Number(e.target.value) })} />
                  </label>
                </div>
                <label>
                  Local tunnel port
                  <input type="number" value={profile.gatewayLocalPort} onChange={(e) => onUpdate({ gatewayLocalPort: Number(e.target.value) })} />
                </label>
              </>
            ) : (
              <p className="advanced-disabled-note">已关闭。直连 Gateway 聊天、文件暂存和普通工具请求不会使用这条 SSH 链路。</p>
            )}
          </section>
        </div>
        <footer className="advanced-config-actions">
          <button type="button" className="primary-button" onClick={onClose}>完成</button>
        </footer>
      </section>
    </div>
  );
}

function networkStepApproveCommand(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const command = (details as { details?: { approveCommand?: unknown } }).details?.approveCommand;
  return typeof command === "string" && command.trim() ? command : null;
}

async function copyText(value: string) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
}
