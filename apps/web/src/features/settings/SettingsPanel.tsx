import { FormEvent, useEffect, useState } from "react";
import { Copy, KeyRound, Play, Plus, Save, ShieldCheck, Trash2, Wifi } from "lucide-react";
import type { NetworkTestResponse, PublicSettings, RemoteProfile, RemoteProfileUpdate } from "@detaches/shared";
import { activateRemoteProfile, bootstrapRemoteProfileSsh, createRemoteProfile, deleteRemoteProfile, fetchSettings, saveRemoteProfile, testNetwork } from "../../lib/api.js";

interface Props {
  onSaved: () => void;
}

export function SettingsPanel({ onSaved }: Props) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [bootstrappingSsh, setBootstrappingSsh] = useState(false);
  const [clearToken, setClearToken] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NetworkTestResponse | null>(null);

  useEffect(() => {
    fetchSettings()
      .then((value) => {
        setSettings(value);
        setSelectedProfileId(value.activeProfileId);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);

  const selectedProfile = settings?.profiles.find((profile) => profile.id === selectedProfileId) ?? settings ?? null;
  const selectedIdentityPath = selectedProfile?.remoteIdentityPath ?? "";
  const identityLooksInvalid = Boolean(selectedIdentityPath)
    && !selectedIdentityPath.startsWith("/")
    && !selectedIdentityPath.startsWith("~/");

  function updateSelectedProfile(patch: Partial<RemoteProfile>) {
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
      reverseBridgeRemoteHost: selectedProfile.reverseBridgeRemoteHost,
      reverseBridgeRemotePort: Number(selectedProfile.reverseBridgeRemotePort),
      gatewayTransport: selectedProfile.gatewayTransport,
      gatewayDirectHost: selectedProfile.gatewayDirectHost,
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
      setTestResult(await testNetwork());
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

  async function bootstrapSsh() {
    if (!selectedProfile) return;
    setBootstrappingSsh(true);
    setStatus("Initializing SSH key login...");
    try {
      const result = await bootstrapRemoteProfileSsh(selectedProfile.id, {
        password: sshPassword,
        identityPath: selectedProfile.remoteIdentityPath || undefined
      });
      setSettings(result.settings);
      setSelectedProfileId(selectedProfile.id);
      setSshPassword("");
      setStatus(`SSH key login ready: ${result.identityPath}`);
      if (selectedProfile.id === result.settings.activeProfileId) onSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBootstrappingSsh(false);
    }
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
            <h2>网络与 SSH</h2>
            <p>编辑当前选中的远端服务；只有设为生效后才会重建隧道和 Gateway 连接。</p>
          </div>
          <button type="button" className="secondary-button" onClick={runTest} disabled={testing}>
            <Play size={16} />
            {testing ? "测试中" : "测试网络"}
          </button>
        </div>

        <section className="settings-section">
          <h3>远端地址</h3>
          <label>
            Profile name
            <input value={selectedProfile.name} onChange={(e) => updateSelectedProfile({ name: e.target.value })} />
          </label>
          <div className="settings-grid">
            <label>
              Remote host
              <input value={selectedProfile.remoteHost} onChange={(e) => updateSelectedProfile({ remoteHost: e.target.value })} />
            </label>
            <label>
              Gateway transport
              <select value={selectedProfile.gatewayTransport} onChange={(e) => updateSelectedProfile({ gatewayTransport: e.target.value as PublicSettings["gatewayTransport"] })}>
                <option value="ssh">SSH tunnel</option>
                <option value="direct">direct / Tailscale</option>
              </select>
            </label>
          </div>
          <div className="settings-grid">
            <label>
              Direct Gateway host
              <input value={selectedProfile.gatewayDirectHost} onChange={(e) => updateSelectedProfile({ gatewayDirectHost: e.target.value })} />
            </label>
            <label>
              Remote Gateway port
              <input type="number" value={selectedProfile.gatewayRemotePort} onChange={(e) => updateSelectedProfile({ gatewayRemotePort: Number(e.target.value) })} />
            </label>
          </div>
        </section>

        <section className="settings-section">
          <h3>SSH 隧道</h3>
          <p>新账号先填写 SSH user 和 SSH password，然后点击“初始化免密”。SSH identity 是本机私钥路径，通常会自动生成。</p>
          <div className="settings-grid">
            <label>
              SSH user / 账号
              <input value={selectedProfile.remoteUser} onChange={(e) => updateSelectedProfile({ remoteUser: e.target.value })} />
            </label>
            <label>
              SSH port
              <input type="number" value={selectedProfile.remoteSshPort} onChange={(e) => updateSelectedProfile({ remoteSshPort: Number(e.target.value) })} />
            </label>
          </div>
          <div className="settings-grid wide-left">
            <label>
              SSH identity / 私钥路径
              <input
                value={selectedProfile.remoteIdentityPath}
                placeholder="/Users/zhangshutong/.ssh/detaches_agent_ed25519"
                onChange={(e) => updateSelectedProfile({ remoteIdentityPath: e.target.value })}
              />
              {identityLooksInvalid ? <small className="field-warning">这里应填写私钥文件路径，不是 SSH 账号；账号请填在 SSH user。</small> : null}
            </label>
            <label>
              Local tunnel port
              <input type="number" value={selectedProfile.gatewayLocalPort} onChange={(e) => updateSelectedProfile({ gatewayLocalPort: Number(e.target.value) })} />
            </label>
          </div>
          <div className="settings-grid wide-left">
            <label>
              SSH password / 登录密码
              <input
                type="password"
                value={sshPassword}
                placeholder="只用于初始化，不会保存"
                onChange={(e) => setSshPassword(e.target.value)}
              />
            </label>
            <div className="settings-field-button">
              <button type="button" className="secondary-button" onClick={bootstrapSsh} disabled={bootstrappingSsh || !sshPassword.trim()}>
                <KeyRound size={16} />
                {bootstrappingSsh ? "初始化中" : "用账号密码初始化免密"}
              </button>
            </div>
          </div>
          <div className="settings-grid">
            <label>
              Reverse bridge host
              <input value={selectedProfile.reverseBridgeRemoteHost} onChange={(e) => updateSelectedProfile({ reverseBridgeRemoteHost: e.target.value })} />
            </label>
            <label>
              Reverse bridge port
              <input type="number" value={selectedProfile.reverseBridgeRemotePort} onChange={(e) => updateSelectedProfile({ reverseBridgeRemotePort: Number(e.target.value) })} />
            </label>
          </div>
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
          <h3>文件工作区</h3>
          <label>
            Remote workspace
            <input value={selectedProfile.remoteWorkspaceRoot} onChange={(e) => updateSelectedProfile({ remoteWorkspaceRoot: e.target.value })} />
          </label>
          <label>
            Public base URL
            <input
              value={selectedProfile.publicBaseUrl}
              placeholder="http://100.x.x.x:38888"
              onChange={(e) => updateSelectedProfile({ publicBaseUrl: e.target.value })}
            />
          </label>
        </section>

        <div className="settings-actions">
          <button className="save-button">
            <Save size={16} />
            保存配置
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
            <p>检查 SSH 端口、隧道、本地 Gateway 端口和 Gateway health。</p>
          </div>
          <ShieldCheck size={18} />
        </div>
        {testResult ? (
          <div className="network-test-list">
            {testResult.steps.map((step) => (
              <article className={`network-test-step ${step.state}`} key={step.id}>
                <strong>{step.label}</strong>
                <p>{step.message}</p>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">点击“测试网络”后会显示逐项结果。</div>
        )}
      </section>
    </div>
  );
}
