export type ChatSessionMode = "device" | "main";

export interface ClientIdentity {
  deviceId: string;
  deviceIdShort: string;
  displayName: string;
  sessionNamespace: string;
}
