import { FormEvent, useEffect, useState } from "react";
import { Play, Save, ShieldCheck } from "lucide-react";
import type { NetworkTestResponse, PublicSettings, SettingsUpdate } from "@detaches/shared";
import { fetchSettings, saveSettings, testNetwork } from "../../lib/api.js";

interface Props {
  onSaved: () => void;
}

export function SettingsPanel({ onSaved }: Props) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<NetworkTestResponse | null>(null);

  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setStatus("Saving...");
    const update: SettingsUpdate = {
      remoteHost: settings.remoteHost,
      remoteSshPort: Number(settings.remoteSshPort),
      remoteUser: settings.remoteUser,
      remoteIdentityPath: settings.remoteIdentityPath,
      gatewayTransport: settings.gatewayTransport,
      gatewayDirectHost: settings.gatewayDirectHost,
      gatewayRemotePort: Number(settings.gatewayRemotePort),
      gatewayLocalPort: Number(settings.gatewayLocalPort),
      authMode: settings.authMode,
      remoteWorkspaceRoot: settings.remoteWorkspaceRoot
    };
    if (token.trim()) update.authToken = token.trim();
    if (password.trim()) update.authPassword = password.trim();
    if (clearToken) update.clearAuthToken = true;
    if (clearPassword) update.clearAuthPassword = true;
    try {
      const saved = await saveSettings(update);
      setSettings(saved);
      setToken("");
      setPassword("");
      setClearToken(false);
      setClearPassword(false);
      setStatus("Saved. Connection will use the new settings.");
      onSaved();
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

  if (!settings) {
    return <div className="settings-page muted">{status ?? "Loading settings..."}</div>;
  }

  return (
    <div className="settings-page">
      <form className="settings-panel primary" onSubmit={submit}>
        <div className="settings-title">
          <div>
            <h2>网络与 SSH</h2>
            <p>配置远端 OpenClaw Gateway 连接方式，保存后会重建隧道和 Gateway 连接。</p>
          </div>
          <button type="button" className="secondary-button" onClick={runTest} disabled={testing}>
            <Play size={16} />
            {testing ? "测试中" : "测试网络"}
          </button>
        </div>

        <section className="settings-section">
          <h3>远端地址</h3>
          <div className="settings-grid">
            <label>
              Remote host
              <input value={settings.remoteHost} onChange={(e) => setSettings({ ...settings, remoteHost: e.target.value })} />
            </label>
            <label>
              Gateway transport
              <select value={settings.gatewayTransport} onChange={(e) => setSettings({ ...settings, gatewayTransport: e.target.value as PublicSettings["gatewayTransport"] })}>
                <option value="ssh">SSH tunnel</option>
                <option value="direct">direct / Tailscale</option>
              </select>
            </label>
          </div>
          <div className="settings-grid">
            <label>
              Direct Gateway host
              <input value={settings.gatewayDirectHost} onChange={(e) => setSettings({ ...settings, gatewayDirectHost: e.target.value })} />
            </label>
            <label>
              Remote Gateway port
              <input type="number" value={settings.gatewayRemotePort} onChange={(e) => setSettings({ ...settings, gatewayRemotePort: Number(e.target.value) })} />
            </label>
          </div>
        </section>

        <section className="settings-section">
          <h3>SSH 隧道</h3>
          <div className="settings-grid">
            <label>
              SSH user
              <input value={settings.remoteUser} onChange={(e) => setSettings({ ...settings, remoteUser: e.target.value })} />
            </label>
            <label>
              SSH port
              <input type="number" value={settings.remoteSshPort} onChange={(e) => setSettings({ ...settings, remoteSshPort: Number(e.target.value) })} />
            </label>
          </div>
          <div className="settings-grid wide-left">
            <label>
              SSH identity
              <input value={settings.remoteIdentityPath} onChange={(e) => setSettings({ ...settings, remoteIdentityPath: e.target.value })} />
            </label>
            <label>
              Local tunnel port
              <input type="number" value={settings.gatewayLocalPort} onChange={(e) => setSettings({ ...settings, gatewayLocalPort: Number(e.target.value) })} />
            </label>
          </div>
        </section>

        <section className="settings-section">
          <h3>Gateway 认证</h3>
          <label>
            Auth mode
            <select value={settings.authMode} onChange={(e) => setSettings({ ...settings, authMode: e.target.value as PublicSettings["authMode"] })}>
              <option value="token">token</option>
              <option value="password">password</option>
              <option value="none">none</option>
            </select>
          </label>
          <div className="settings-grid">
            <label>
              Gateway token {settings.hasAuthToken ? "(saved)" : ""}
              <input type="password" value={token} placeholder="leave blank to keep saved token" onChange={(e) => setToken(e.target.value)} />
            </label>
            <label>
              Gateway password {settings.hasAuthPassword ? "(saved)" : ""}
              <input type="password" value={password} placeholder="leave blank to keep saved password" onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <div className="settings-checks">
            {settings.hasAuthToken ? (
              <label className="check-row">
                <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} />
                Clear saved token
              </label>
            ) : null}
            {settings.hasAuthPassword ? (
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
            <input value={settings.remoteWorkspaceRoot} onChange={(e) => setSettings({ ...settings, remoteWorkspaceRoot: e.target.value })} />
          </label>
        </section>

        <div className="settings-actions">
          <button className="save-button">
            <Save size={16} />
            Save settings
          </button>
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
