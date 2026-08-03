import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../core/errors.js";

// Ledger de operaciones de bóveda. Es la memoria del flujo
// construir → firmar (cliente) → enviar, y la fuente de la auditoría.
//
// La transición a "submitted" es un compare-and-set: dos confirmaciones
// concurrentes con idempotency keys distintas no pueden enviar la misma
// operación dos veces a la red.

export type OperationKind = "deposit" | "withdrawal";

export type OperationStatus =
  | "awaiting_signature"
  | "submitted"
  | "confirmed"
  | "failed";

export interface VaultOperation {
  id: string;
  userId: string;
  walletAddress: string;
  vaultId: string;
  vaultAddress: string;
  kind: OperationKind;
  /** Monto en unidades crudas, como string para no perder precisión. */
  amountRaw: string;
  decimals: number;
  assetSymbol: string;
  status: OperationStatus;
  unsignedXdr: string;
  txHash: string | null;
  ledger: number | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewVaultOperation = Omit<
  VaultOperation,
  "id" | "status" | "txHash" | "ledger" | "failureReason" | "createdAt" | "updatedAt"
>;

export interface OperationResult {
  status: Extract<OperationStatus, "confirmed" | "failed">;
  txHash: string | null;
  ledger: number | null;
  failureReason: string | null;
}

export interface ListOptions {
  limit: number;
  /** Solo operaciones creadas antes de este instante ISO (paginación). */
  before?: string;
}

export interface OperationsRepository {
  create(op: NewVaultOperation): Promise<VaultOperation>;
  findById(id: string): Promise<VaultOperation | null>;
  listByUser(userId: string, options: ListOptions): Promise<VaultOperation[]>;
  /** Operaciones que aún no se resuelven (esperando firma o enviadas). */
  listPendingByUser(userId: string): Promise<VaultOperation[]>;
  /**
   * Marca la operación como enviada solo si sigue esperando firma.
   * Devuelve false si otra ejecución ya la tomó (evita doble envío).
   */
  claimForSubmit(id: string): Promise<boolean>;
  settle(id: string, result: OperationResult): Promise<void>;
  /** Devuelve la operación a "awaiting_signature" si el envío nunca llegó a la red. */
  releaseClaim(id: string): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryOperationsRepository implements OperationsRepository {
  private readonly rows = new Map<string, VaultOperation>();

  async create(op: NewVaultOperation): Promise<VaultOperation> {
    const timestamp = nowIso();
    const row: VaultOperation = {
      ...op,
      id: randomUUID(),
      status: "awaiting_signature",
      txHash: null,
      ledger: null,
      failureReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findById(id: string): Promise<VaultOperation | null> {
    return this.rows.get(id) ?? null;
  }

  async listByUser(userId: string, options: ListOptions): Promise<VaultOperation[]> {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .filter((row) => !options.before || row.createdAt < options.before)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }

  async listPendingByUser(userId: string): Promise<VaultOperation[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.userId === userId &&
          (row.status === "awaiting_signature" || row.status === "submitted"),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async claimForSubmit(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "awaiting_signature") return false;
    this.rows.set(id, { ...row, status: "submitted", updatedAt: nowIso() });
    return true;
  }

  async settle(id: string, result: OperationResult): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, { ...row, ...result, updatedAt: nowIso() });
  }

  async releaseClaim(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.status !== "submitted") return;
    this.rows.set(id, { ...row, status: "awaiting_signature", updatedAt: nowIso() });
  }
}

interface OperationRow {
  id: string;
  user_id: string;
  wallet_address: string;
  vault_id: string;
  vault_address: string;
  kind: OperationKind;
  amount_raw: string;
  decimals: number;
  asset_symbol: string;
  status: OperationStatus;
  unsigned_xdr: string;
  tx_hash: string | null;
  ledger: number | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: OperationRow): VaultOperation {
  return {
    id: row.id,
    userId: row.user_id,
    walletAddress: row.wallet_address,
    vaultId: row.vault_id,
    vaultAddress: row.vault_address,
    kind: row.kind,
    amountRaw: row.amount_raw,
    decimals: row.decimals,
    assetSymbol: row.asset_symbol,
    status: row.status,
    unsignedXdr: row.unsigned_xdr,
    txHash: row.tx_hash,
    ledger: row.ledger,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

/** Requiere la tabla `vault_operations` (ver migrations/001_vault_operations.sql). */
export class SupabaseOperationsRepository implements OperationsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async create(op: NewVaultOperation): Promise<VaultOperation> {
    const { data, error } = await this.db
      .from("vault_operations")
      .insert({
        user_id: op.userId,
        wallet_address: op.walletAddress,
        vault_id: op.vaultId,
        vault_address: op.vaultAddress,
        kind: op.kind,
        amount_raw: op.amountRaw,
        decimals: op.decimals,
        asset_symbol: op.assetSymbol,
        status: "awaiting_signature",
        unsigned_xdr: op.unsignedXdr,
      })
      .select()
      .single();
    if (error || !data) throw dbError("vault_operations.create", error);
    return toDomain(data as OperationRow);
  }

  async findById(id: string): Promise<VaultOperation | null> {
    const { data, error } = await this.db
      .from("vault_operations")
      .select()
      .eq("id", id)
      .maybeSingle();
    if (error) throw dbError("vault_operations.findById", error);
    return data ? toDomain(data as OperationRow) : null;
  }

  async listByUser(userId: string, options: ListOptions): Promise<VaultOperation[]> {
    let query = this.db
      .from("vault_operations")
      .select()
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(options.limit);
    if (options.before) query = query.lt("created_at", options.before);

    const { data, error } = await query;
    if (error) throw dbError("vault_operations.listByUser", error);
    return (data ?? []).map((row) => toDomain(row as OperationRow));
  }

  async listPendingByUser(userId: string): Promise<VaultOperation[]> {
    const { data, error } = await this.db
      .from("vault_operations")
      .select()
      .eq("user_id", userId)
      .in("status", ["awaiting_signature", "submitted"])
      .order("created_at", { ascending: false });
    if (error) throw dbError("vault_operations.listPendingByUser", error);
    return (data ?? []).map((row) => toDomain(row as OperationRow));
  }

  async claimForSubmit(id: string): Promise<boolean> {
    // Compare-and-set atómico: solo gana quien encuentra la fila esperando firma.
    const { data, error } = await this.db
      .from("vault_operations")
      .update({ status: "submitted", updated_at: nowIso() })
      .eq("id", id)
      .eq("status", "awaiting_signature")
      .select("id");
    if (error) throw dbError("vault_operations.claimForSubmit", error);
    return (data?.length ?? 0) > 0;
  }

  async settle(id: string, result: OperationResult): Promise<void> {
    const { error } = await this.db
      .from("vault_operations")
      .update({
        status: result.status,
        tx_hash: result.txHash,
        ledger: result.ledger,
        failure_reason: result.failureReason,
        updated_at: nowIso(),
      })
      .eq("id", id);
    if (error) throw dbError("vault_operations.settle", error);
  }

  async releaseClaim(id: string): Promise<void> {
    const { error } = await this.db
      .from("vault_operations")
      .update({ status: "awaiting_signature", updated_at: nowIso() })
      .eq("id", id)
      .eq("status", "submitted");
    if (error) throw dbError("vault_operations.releaseClaim", error);
  }
}
