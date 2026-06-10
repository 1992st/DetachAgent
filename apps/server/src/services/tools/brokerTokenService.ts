import { nanoid } from "nanoid";

const tokens = new Map<string, string>();

export const brokerTokenService = {
  tokenForSession(sessionKey: string): string {
    const normalized = sessionKey.trim();
    if (!normalized) return "";
    const existing = tokens.get(normalized);
    if (existing) return existing;
    const token = nanoid(32);
    tokens.set(normalized, token);
    return token;
  },

  verify(sessionKey: string, token: string): boolean {
    const normalized = sessionKey.trim();
    if (!normalized || !token.trim()) return false;
    return tokens.get(normalized) === token.trim();
  }
};
