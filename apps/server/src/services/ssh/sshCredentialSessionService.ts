import { EventEmitter } from "node:events";
import type { RuntimeSettings } from "../../config/settingsStore.js";
import type { SshCredentialSessionSnapshot, SshCredentialTarget } from "@detaches/shared";

const PASSWORD_TIMEOUT_MS = 5 * 60 * 1000;

interface CredentialState {
  target?: SshCredentialTarget;
  password?: string;
  passwordResolver?: (password: string) => void;
  passwordRejecter?: (error: Error) => void;
  passwordTimeout?: NodeJS.Timeout;
  dismissedTargetKey?: string;
  requestedAt?: string;
  updatedAt: string;
  message?: string;
  error?: string;
}

export class SshCredentialSessionService {
  private state: CredentialState = { updatedAt: new Date().toISOString() };
  readonly emitter = new EventEmitter();

  targetFromConfig(config: Pick<RuntimeSettings, "remoteHost" | "remoteSshPort" | "remoteUser">): SshCredentialTarget | null {
    const host = config.remoteHost.trim();
    const user = config.remoteUser.trim();
    const port = Number(config.remoteSshPort);
    if (!host || !user || !Number.isFinite(port) || port <= 0) return null;
    return {
      host,
      user,
      port: Math.max(1, Math.min(65535, Math.floor(port))),
      key: `${user}@${host}:${Math.max(1, Math.min(65535, Math.floor(port)))}`
    };
  }

  getPassword(target: SshCredentialTarget): string | null {
    if (this.state.target?.key !== target.key) return null;
    return this.state.password || null;
  }

  status(): SshCredentialSessionSnapshot {
    return snapshot(this.state, this.currentState());
  }

  async requestPassword(target: SshCredentialTarget, options: { message?: string; force?: boolean } = {}): Promise<string> {
    this.ensureTarget(target);
    if (!options.force && this.state.password) return this.state.password;
    if (!options.force && this.state.dismissedTargetKey === target.key) {
      throw new Error("SSH password prompt was dismissed. Retry the connection test to ask again.");
    }
    if (this.state.passwordResolver) {
      return new Promise((resolve, reject) => {
        const previousResolver = this.state.passwordResolver;
        const previousRejecter = this.state.passwordRejecter;
        this.state.passwordResolver = (password) => {
          previousResolver?.(password);
          resolve(password);
        };
        this.state.passwordRejecter = (error) => {
          previousRejecter?.(error);
          reject(error);
        };
      });
    }
    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      target,
      requestedAt: now,
      updatedAt: now,
      dismissedTargetKey: undefined,
      message: options.message || "SSH password required for tunnel.",
      error: undefined
    };
    this.emit();
    return new Promise((resolve, reject) => {
      this.state.passwordResolver = resolve;
      this.state.passwordRejecter = reject;
      this.state.passwordTimeout = setTimeout(() => {
        const error = new Error("SSH password input timed out after 5 minutes.");
        this.finishWait(error);
      }, PASSWORD_TIMEOUT_MS);
      this.emit();
    });
  }

  providePassword(password: string): SshCredentialSessionSnapshot {
    const trimmedPassword = password;
    if (!trimmedPassword) throw new Error("Password is required.");
    if (!this.state.target || !this.state.passwordResolver) throw new Error("SSH tunnel is not waiting for a password.");
    const resolver = this.state.passwordResolver;
    this.clearWait();
    this.state.password = trimmedPassword;
    this.state.dismissedTargetKey = undefined;
    this.state.error = undefined;
    this.state.message = "SSH password received for this app session.";
    this.touch();
    resolver(trimmedPassword);
    this.emit();
    return this.status();
  }

  dismiss(): SshCredentialSessionSnapshot {
    if (this.state.target) this.state.dismissedTargetKey = this.state.target.key;
    this.finishWait(new Error("SSH password prompt dismissed."), { keepDismissed: true });
    return this.status();
  }

  markReady(target: SshCredentialTarget, message = "SSH tunnel password is available for this app session."): void {
    this.ensureTarget(target);
    this.state.message = message;
    this.state.error = undefined;
    this.touch();
    this.emit();
  }

  markFailed(target: SshCredentialTarget, error: string, options: { clearPassword?: boolean } = {}): void {
    this.ensureTarget(target);
    if (options.clearPassword) this.state.password = undefined;
    this.state.error = error;
    this.state.message = "SSH password authentication failed.";
    this.touch();
    this.emit();
  }

  clear(target?: SshCredentialTarget): void {
    if (target && this.state.target?.key !== target.key) return;
    this.finishWait(new Error("SSH credential session was cleared."));
    this.state = { updatedAt: new Date().toISOString() };
    this.emit();
  }

  private ensureTarget(target: SshCredentialTarget): void {
    if (this.state.target?.key === target.key) return;
    this.finishWait(new Error("SSH target changed."));
    this.state = {
      target,
      updatedAt: new Date().toISOString()
    };
  }

  private finishWait(error: Error, options: { keepDismissed?: boolean } = {}): void {
    const rejecter = this.state.passwordRejecter;
    this.clearWait();
    if (!options.keepDismissed) this.state.dismissedTargetKey = undefined;
    if (rejecter) rejecter(error);
    this.state.error = error.message;
    this.state.message = error.message;
    this.touch();
    this.emit();
  }

  private clearWait(): void {
    if (this.state.passwordTimeout) clearTimeout(this.state.passwordTimeout);
    this.state.passwordTimeout = undefined;
    this.state.passwordResolver = undefined;
    this.state.passwordRejecter = undefined;
    this.state.requestedAt = undefined;
  }

  private currentState(): SshCredentialSessionSnapshot["state"] {
    if (this.state.passwordResolver) return "waiting-password";
    if (this.state.password) return "ready";
    if (this.state.dismissedTargetKey && this.state.target?.key === this.state.dismissedTargetKey) return "dismissed";
    if (this.state.error) return "failed";
    return "idle";
  }

  private touch(): void {
    this.state.updatedAt = new Date().toISOString();
  }

  private emit(): void {
    this.emitter.emit("credential", this.status());
  }
}

function snapshot(state: CredentialState, status: SshCredentialSessionSnapshot["state"]): SshCredentialSessionSnapshot {
  return {
    state: status,
    target: state.target,
    requestedAt: state.requestedAt,
    updatedAt: state.updatedAt,
    message: state.message,
    error: state.error,
    hasPassword: Boolean(state.password)
  };
}

export const sshCredentialSessionService = new SshCredentialSessionService();
