import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../core/errors.js";
import type { KycStatus } from "./webhook.js";

// Estado de KYC y sesión de onboarding. Ambas tablas ya existen en el schema
// compartido con la WebApp (`kyc_state`, `onboarding_sessions`): se leen y
// escriben con la misma semántica para que web y móvil vean lo mismo.

export interface OnboardingSession {
  customerId: string;
  bankAccountId: string;
}

export interface KycSnapshot {
  customerId: string;
  walletAddress: string;
  status: KycStatus;
  approvedAt: string | null;
  rejectionReason: string | null;
  lastEventId: string | null;
  updatedAt: string;
}

export interface UpsertSnapshotParams {
  customerId: string;
  walletAddress: string;
  status: KycStatus;
  approvedAt?: string | null;
  rejectionReason?: string | null;
  eventId?: string | null;
  eventTimestamp?: string | null;
}

export interface IdentityRepository {
  findSession(walletAddress: string): Promise<OnboardingSession | null>;
  saveSession(walletAddress: string, session: OnboardingSession): Promise<void>;
  findSnapshot(customerId: string, walletAddress: string): Promise<KycSnapshot | null>;
  /** Devuelve false si el evento es duplicado o llega desordenado (estado más viejo). */
  upsertSnapshot(params: UpsertSnapshotParams): Promise<boolean>;
}

/**
 * Decide si un evento entrante debe sobrescribir el estado almacenado.
 * Portado de SEYF-P: los webhooks pueden llegar duplicados o fuera de orden y
 * un evento viejo no puede degradar un KYC ya aprobado.
 */
export function shouldApply(existing: KycSnapshot | null, params: UpsertSnapshotParams): boolean {
  if (!existing) return true;

  const eventId = params.eventId ?? null;
  if (eventId && existing.lastEventId === eventId) return false;

  if (!eventId) {
    const samePayload =
      existing.status === params.status &&
      existing.approvedAt === (params.approvedAt ?? null) &&
      existing.rejectionReason === (params.rejectionReason ?? null);
    if (samePayload) return false;
  }

  if (params.eventTimestamp) {
    const incoming = new Date(params.eventTimestamp).getTime();
    const current = new Date(existing.updatedAt).getTime();
    if (Number.isFinite(incoming) && Number.isFinite(current) && incoming < current) return false;
  }
  return true;
}

export class MemoryIdentityRepository implements IdentityRepository {
  private readonly sessions = new Map<string, OnboardingSession>();
  private readonly snapshots = new Map<string, KycSnapshot>();

  private key(customerId: string, walletAddress: string): string {
    return `${customerId}:${walletAddress}`;
  }

  async findSession(walletAddress: string): Promise<OnboardingSession | null> {
    return this.sessions.get(walletAddress) ?? null;
  }

  async saveSession(walletAddress: string, session: OnboardingSession): Promise<void> {
    this.sessions.set(walletAddress, session);
  }

  async findSnapshot(customerId: string, walletAddress: string): Promise<KycSnapshot | null> {
    return this.snapshots.get(this.key(customerId, walletAddress)) ?? null;
  }

  async upsertSnapshot(params: UpsertSnapshotParams): Promise<boolean> {
    const key = this.key(params.customerId, params.walletAddress);
    const existing = this.snapshots.get(key) ?? null;
    if (!shouldApply(existing, params)) return false;

    this.snapshots.set(key, {
      customerId: params.customerId,
      walletAddress: params.walletAddress,
      status: params.status,
      approvedAt: params.approvedAt ?? null,
      rejectionReason: params.rejectionReason ?? null,
      lastEventId: params.eventId ?? null,
      updatedAt: params.eventTimestamp ?? new Date().toISOString(),
    });
    return true;
  }
}

function dbError(context: string, cause: unknown): AppError {
  const err = new AppError(
    "db_unavailable",
    `No se pudo acceder a la base de datos (${context}).`,
    503,
  );
  err.cause = cause;
  return err;
}

interface KycStateRow {
  customer_id: string;
  wallet_public_key: string;
  status: string;
  approved_at: string | null;
  current_rejection_reason: string | null;
  last_event_id: string | null;
  updated_at: string;
}

const KYC_COLS =
  "customer_id, wallet_public_key, status, approved_at, current_rejection_reason, last_event_id, updated_at";

export class SupabaseIdentityRepository implements IdentityRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findSession(walletAddress: string): Promise<OnboardingSession | null> {
    const { data, error } = await this.db
      .from("onboarding_sessions")
      .select("customer_id, bank_account_id")
      .eq("wallet_public_key", walletAddress)
      .maybeSingle();
    if (error) throw dbError("onboarding_sessions.find", error);
    const row = data as { customer_id: string; bank_account_id: string } | null;
    return row ? { customerId: row.customer_id, bankAccountId: row.bank_account_id } : null;
  }

  async saveSession(walletAddress: string, session: OnboardingSession): Promise<void> {
    const { error } = await this.db.from("onboarding_sessions").upsert(
      {
        wallet_public_key: walletAddress,
        customer_id: session.customerId,
        bank_account_id: session.bankAccountId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "wallet_public_key" },
    );
    if (error) throw dbError("onboarding_sessions.save", error);
  }

  async findSnapshot(customerId: string, walletAddress: string): Promise<KycSnapshot | null> {
    const { data, error } = await this.db
      .from("kyc_state")
      .select(KYC_COLS)
      .eq("customer_id", customerId)
      .eq("wallet_public_key", walletAddress)
      .maybeSingle();
    if (error) throw dbError("kyc_state.find", error);
    if (!data) return null;
    const row = data as KycStateRow;
    return {
      customerId: row.customer_id,
      walletAddress: row.wallet_public_key,
      status: row.status as KycStatus,
      approvedAt: row.approved_at,
      rejectionReason: row.current_rejection_reason,
      lastEventId: row.last_event_id,
      updatedAt: row.updated_at,
    };
  }

  async upsertSnapshot(params: UpsertSnapshotParams): Promise<boolean> {
    const existing = await this.findSnapshot(params.customerId, params.walletAddress);
    if (!shouldApply(existing, params)) return false;

    const { error } = await this.db.from("kyc_state").upsert(
      {
        customer_id: params.customerId,
        wallet_public_key: params.walletAddress,
        status: params.status,
        approved_at: params.approvedAt ?? null,
        current_rejection_reason: params.rejectionReason ?? null,
        last_event_id: params.eventId ?? null,
        updated_at: params.eventTimestamp ?? new Date().toISOString(),
      },
      { onConflict: "customer_id,wallet_public_key" },
    );
    if (error) throw dbError("kyc_state.upsert", error);
    return true;
  }
}

// ─── Anti-replay de webhooks ────────────────────────────────────────────────

export interface WebhookReplayGuard {
  /** Reclama el evento. false si ya se había procesado (replay). */
  claim(eventId: string): Promise<boolean>;
}

export class MemoryReplayGuard implements WebhookReplayGuard {
  private readonly seen = new Set<string>();

  async claim(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
}

/** Requiere la tabla `webhook_events` (migrations/002_identity.sql). */
export class SupabaseReplayGuard implements WebhookReplayGuard {
  constructor(private readonly db: SupabaseClient) {}

  async claim(eventId: string): Promise<boolean> {
    // El primary key hace atómico el reclamo: un duplicado choca (código 23505).
    const { error } = await this.db
      .from("webhook_events")
      .insert({ provider: "etherfuse", event_id: eventId });
    if (!error) return true;
    if (error.code === "23505") return false;
    throw dbError("webhook_events.claim", error);
  }
}
