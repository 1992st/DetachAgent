export type GatewayEventName = "tick" | "seqGap" | "health" | "chat" | "agent" | string;

export interface GatewayRequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

export interface GatewayResponseFrame<T = unknown> {
  type: "res";
  id: string;
  ok: boolean;
  payload?: T;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    retryable?: boolean;
  };
}

export interface GatewayEventFrame<T = unknown> {
  type: "event";
  event: GatewayEventName;
  payload?: T;
  seq?: number;
  stateVersion?: Record<string, unknown>;
}

export interface GatewayConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: Record<string, unknown>;
  role: "operator" | "node" | string;
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, unknown>;
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  };
  auth?: Record<string, unknown>;
  locale?: string;
  userAgent?: string;
}

export interface GatewayHello {
  type: "hello";
  protocol?: number;
  server?: Record<string, unknown>;
  features?: Record<string, unknown>;
  snapshot?: {
    presence?: unknown[];
    health?: unknown;
    uptimeMs?: number;
    configPath?: string;
    stateDir?: string;
    sessionDefaults?: Record<string, unknown>;
  };
  auth?: Record<string, unknown>;
  policy?: Record<string, unknown>;
}
