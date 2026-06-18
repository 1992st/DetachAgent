import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type {
  InteractionCreateInput,
  InteractionCreateResponse,
  InteractionRecord,
  InteractionRejectInput,
  InteractionResolveInput,
  InteractionResult,
  InteractionResultResponse,
  InteractionStatus
} from "@detaches/shared";

const INTERACTION_TTL_MS = 5 * 60 * 1000;

interface InteractionEvent {
  action: "created" | "updated" | "duplicate" | "resolved" | "rejected" | "expired";
  interaction: InteractionRecord;
}

interface SecretHandleRecord {
  secret: string;
  interactionId: string;
  createdAt: string;
}

export class InteractionBrokerService {
  private records = new Map<string, InteractionRecord>();
  private sourceIndex = new Map<string, string>();
  private secretHandles = new Map<string, SecretHandleRecord>();
  private revealSecrets = new Map<string, string>();
  readonly emitter = new EventEmitter();

  create(input: InteractionCreateInput): InteractionCreateResponse {
    const normalized = normalizeCreateInput(input);
    const duplicate = this.findDuplicate(normalized);
    if (duplicate) {
      this.emit("duplicate", duplicate);
      return { interaction: duplicate, duplicate: true };
    }
    const now = new Date().toISOString();
    const interaction: InteractionRecord = {
      ...normalized,
      source: normalized.source || "api",
      id: `interaction_${nanoid(12)}`,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + INTERACTION_TTL_MS).toISOString()
    };
    this.records.set(interaction.id, interaction);
    if (interaction.sourceEventId) this.sourceIndex.set(sourceKey(interaction.sessionKey, interaction.sourceEventId), interaction.id);
    this.emit("created", interaction);
    return { interaction };
  }

  resolve(id: string, input: InteractionResolveInput): InteractionResultResponse {
    const interaction = this.mustGet(id);
    this.ensurePending(interaction);
    const now = new Date().toISOString();
    const mode = input.mode || defaultResolveMode(interaction);
    const result: InteractionResult = {
      mode,
      value: input.value,
      actor: input.actor,
      decidedAt: now
    };
    if (interaction.kind === "credential.request") {
      const secret = typeof input.secret === "string" ? input.secret : "";
      if (!secret) throw new Error("Secret is required for credential.request.");
      if (mode === "local-handle") {
        const handle = `cred_${nanoid(16)}`;
        this.secretHandles.set(handle, { secret, interactionId: interaction.id, createdAt: now });
        result.credentialHandle = handle;
      } else if (mode === "reveal-once") {
        this.revealSecrets.set(interaction.id, secret);
      } else {
        throw new Error(`Unsupported credential return mode: ${mode}.`);
      }
    }
    const next: InteractionRecord = {
      ...interaction,
      status: "resolved",
      result,
      error: undefined,
      updatedAt: now
    };
    this.records.set(next.id, next);
    this.emit("resolved", next);
    return { interaction: next, result: this.publicResult(next, false) };
  }

  reject(id: string, input: InteractionRejectInput = {}): InteractionResultResponse {
    const interaction = this.mustGet(id);
    this.ensurePending(interaction);
    const now = new Date().toISOString();
    const next: InteractionRecord = {
      ...interaction,
      status: "rejected",
      error: input.error || "Interaction rejected by user.",
      result: input.actor
        ? { mode: "confirmed", actor: input.actor, decidedAt: now }
        : undefined,
      updatedAt: now
    };
    this.records.set(next.id, next);
    this.emit("rejected", next);
    return { interaction: next, result: next.result };
  }

  get(id: string, options: { consumeRevealSecret?: boolean } = {}): InteractionResultResponse {
    const interaction = this.mustGet(id);
    const expired = this.expireIfNeeded(interaction);
    return {
      interaction: expired,
      result: this.publicResult(expired, options.consumeRevealSecret === true)
    };
  }

  list(input: { sessionKey?: string; agentId?: string; status?: InteractionStatus; limit?: number } = {}): { interactions: InteractionRecord[] } {
    const limit = Math.max(1, Math.min(100, input.limit ?? 50));
    const interactions = Array.from(this.records.values())
      .map((record) => this.expireIfNeeded(record))
      .filter((record) => !input.sessionKey || record.sessionKey === input.sessionKey)
      .filter((record) => !input.agentId || record.agentId === input.agentId)
      .filter((record) => !input.status || record.status === input.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
    return { interactions };
  }

  secretForHandle(handle: string): string | null {
    return this.secretHandles.get(handle)?.secret || null;
  }

  private findDuplicate(input: InteractionCreateInput): InteractionRecord | null {
    if (!input.sourceEventId) return null;
    const existingId = this.sourceIndex.get(sourceKey(input.sessionKey, input.sourceEventId));
    return existingId ? this.records.get(existingId) || null : null;
  }

  private mustGet(id: string): InteractionRecord {
    const interaction = this.records.get(id);
    if (!interaction) throw new Error("Interaction not found.");
    return this.expireIfNeeded(interaction);
  }

  private ensurePending(interaction: InteractionRecord): void {
    if (interaction.status !== "pending") throw new Error(`Interaction is ${interaction.status}, not pending.`);
  }

  private expireIfNeeded(interaction: InteractionRecord): InteractionRecord {
    if (interaction.status !== "pending" || !interaction.expiresAt) return interaction;
    if (Date.parse(interaction.expiresAt) > Date.now()) return interaction;
    const next: InteractionRecord = {
      ...interaction,
      status: "expired",
      error: "Interaction expired.",
      updatedAt: new Date().toISOString()
    };
    this.records.set(next.id, next);
    this.emit("expired", next);
    return next;
  }

  private publicResult(interaction: InteractionRecord, consumeRevealSecret: boolean): InteractionResult | undefined {
    if (!interaction.result) return undefined;
    if (interaction.result.mode !== "reveal-once") return interaction.result;
    const secret = this.revealSecrets.get(interaction.id);
    if (!secret) return interaction.result;
    const result = { ...interaction.result, secret };
    if (consumeRevealSecret) this.revealSecrets.delete(interaction.id);
    return result;
  }

  private emit(action: InteractionEvent["action"], interaction: InteractionRecord): void {
    this.emitter.emit("interaction", { action, interaction } satisfies InteractionEvent);
  }
}

function normalizeCreateInput(input: InteractionCreateInput): InteractionCreateInput {
  const kind = input.kind;
  if (kind !== "credential.request" && kind !== "ui.confirm") throw new Error(`Unsupported interaction kind: ${kind}.`);
  const sessionKey = input.sessionKey.trim();
  if (!sessionKey) throw new Error("sessionKey is required.");
  const source = input.source || "api";
  const sourceEventId = input.sourceEventId?.trim();
  if (source === "gateway-event" && !sourceEventId) throw new Error("sourceEventId is required for gateway-event.");
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload : {};
  return {
    kind,
    sessionKey,
    agentId: input.agentId?.trim() || undefined,
    reason: input.reason?.trim() || undefined,
    source: source || "api",
    sourceEventId,
    sourceMessageId: input.sourceMessageId?.trim() || undefined,
    sourceRunId: input.sourceRunId?.trim() || undefined,
    payload
  };
}

function defaultResolveMode(interaction: InteractionRecord): NonNullable<InteractionResolveInput["mode"]> {
  return interaction.kind === "credential.request" ? "local-handle" : "confirmed";
}

function sourceKey(sessionKey: string, sourceEventId: string): string {
  return `${sessionKey}\0${sourceEventId}`;
}

export const interactionBrokerService = new InteractionBrokerService();
