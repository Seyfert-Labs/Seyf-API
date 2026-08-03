import { formatUnits } from "../../core/units.js";
import type { OperationsRepository, VaultOperation } from "../vaults/operations.js";
import type { Logger } from "../vaults/service.js";
import type { HorizonClient, OnchainOperation } from "./horizon.js";

// Historial unificado: el ledger de operaciones de la propia API más lo que
// existe on-chain.
//
// En SEYF-P los "pendientes" viven en localStorage y se reconcilian adivinando
// (mismo monto ±0.01 dentro de una ventana de tiempo). Aquí un movimiento en
// curso es un hecho del servidor con su identificador, así que no hace falta
// adivinar: se deduplica por hash de transacción.

export type TransactionStatus = "pending" | "confirmed" | "failed";

export interface Transaction {
  id: string;
  source: "vault" | "onchain";
  kind: string;
  direction: "in" | "out" | "self";
  asset: string;
  amount: string;
  status: TransactionStatus;
  txHash: string | null;
  vaultId: string | null;
  /** Presente solo si la operación falló. */
  failureReason: string | null;
  createdAt: string;
}

function statusOf(operation: VaultOperation): TransactionStatus {
  switch (operation.status) {
    case "confirmed":
      return "confirmed";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function fromVaultOperation(operation: VaultOperation): Transaction {
  return {
    id: operation.id,
    source: "vault",
    kind: operation.kind,
    // Un depósito saca fondos de la wallet hacia la bóveda; un retiro los devuelve.
    direction: operation.kind === "deposit" ? "out" : "in",
    asset: operation.assetSymbol,
    amount: formatUnits(BigInt(operation.amountRaw), operation.decimals),
    status: statusOf(operation),
    txHash: operation.txHash,
    vaultId: operation.vaultId,
    failureReason: operation.failureReason,
    createdAt: operation.createdAt,
  };
}

function fromOnchain(operation: OnchainOperation): Transaction {
  return {
    id: operation.id,
    source: "onchain",
    kind: operation.kind,
    direction: operation.direction,
    asset: operation.asset,
    amount: operation.amount,
    // Horizon se consulta con include_failed=false: lo que llega, se confirmó.
    status: "confirmed",
    txHash: operation.txHash,
    vaultId: null,
    failureReason: null,
    createdAt: operation.createdAt,
  };
}

export interface ListTransactionsParams {
  userId: string;
  walletAddress: string;
  limit: number;
  before?: string;
}

export interface TransactionsPage {
  transactions: Transaction[];
  /** Instante para pedir la siguiente página (`before`). null si no hay más. */
  nextBefore: string | null;
  /** false si el historial on-chain no pudo consultarse y la lista está incompleta. */
  onchainAvailable: boolean;
}

export class TransactionsService {
  constructor(
    private readonly operations: OperationsRepository,
    private readonly horizon: HorizonClient,
    private readonly logger: Logger,
  ) {}

  async list(params: ListTransactionsParams): Promise<TransactionsPage> {
    const vaultOps = await this.operations.listByUser(params.userId, {
      limit: params.limit,
      ...(params.before ? { before: params.before } : {}),
    });

    let onchain: OnchainOperation[] = [];
    let onchainAvailable = true;
    try {
      // Se pide de más para compensar lo que se descarte al deduplicar y filtrar.
      onchain = await this.horizon.listOperations(params.walletAddress, params.limit * 2);
    } catch (err) {
      onchainAvailable = false;
      this.logger.warn(
        { detail: err instanceof Error ? err.message : String(err) },
        "historial on-chain no disponible; se devuelve solo el ledger propio",
      );
    }

    // Las operaciones de bóveda ya confirmadas también aparecen en Horizon:
    // se conserva la versión propia, que sabe monto exacto, bóveda y estado.
    const knownHashes = new Set(
      vaultOps.map((operation) => operation.txHash).filter((hash): hash is string => Boolean(hash)),
    );

    const merged = [
      ...vaultOps.map(fromVaultOperation),
      ...onchain
        .filter((operation) => !knownHashes.has(operation.txHash))
        .filter((operation) => !params.before || operation.createdAt < params.before)
        .map(fromOnchain),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const page = merged.slice(0, params.limit);
    const nextBefore =
      merged.length > params.limit ? (page[page.length - 1]?.createdAt ?? null) : null;

    return { transactions: page, nextBefore, onchainAvailable };
  }

  /** Movimientos en curso: hechos del servidor, no una suposición del cliente. */
  async listPending(userId: string): Promise<Transaction[]> {
    const pending = await this.operations.listPendingByUser(userId);
    return pending.map(fromVaultOperation);
  }
}
