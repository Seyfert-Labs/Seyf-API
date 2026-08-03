import { AppError } from "../../core/errors.js";
import { parseUnits } from "../../core/units.js";
import type { VaultConfig } from "./catalog.js";
import { defindexErrorText, type DefindexClient } from "./defindex.js";
import type { KycGate } from "./gates.js";
import type {
  OperationKind,
  OperationsRepository,
  VaultOperation,
} from "./operations.js";
import type { Logger } from "./service.js";

export interface CreateOperationParams {
  userId: string;
  walletAddress: string;
  vaultId: string;
  kind: OperationKind;
  /** Monto decimal como string (p. ej. "100.50"). */
  amount: string;
  slippageBps?: number;
}

export interface MutationsConfig {
  /** Invertir en la estrategia en el mismo depósito (DEFINDEX_INVEST_ON_DEPOSIT). */
  investOnDeposit: boolean;
  defaultSlippageBps: number;
}

export class VaultMutationsService {
  constructor(
    private readonly catalog: VaultConfig[],
    private readonly defindex: DefindexClient,
    private readonly operations: OperationsRepository,
    private readonly kyc: KycGate,
    private readonly config: MutationsConfig,
    private readonly logger: Logger,
  ) {}

  private vault(vaultId: string): VaultConfig {
    const vault = this.catalog.find((v) => v.id === vaultId);
    if (!vault) throw new AppError("vault_not_found", `No existe la bóveda "${vaultId}".`, 404);
    return vault;
  }

  private amountRaw(amount: string, vault: VaultConfig): bigint {
    let raw: bigint;
    try {
      raw = parseUnits(amount, vault.decimals);
    } catch (err) {
      throw new AppError(
        "invalid_amount",
        err instanceof Error ? err.message : `Monto inválido: ${amount}`,
        400,
      );
    }
    if (raw <= 0n) throw new AppError("invalid_amount", "El monto debe ser mayor que cero.", 400);
    return raw;
  }

  async createOperation(params: CreateOperationParams): Promise<VaultOperation> {
    const vault = this.vault(params.vaultId);
    const amountRaw = this.amountRaw(params.amount, vault);

    // Cumplimiento antes de construir nada: si no puede operar, no se toca DeFindex.
    await this.kyc.assertApproved(params.walletAddress);

    const build = {
      vaultAddress: vault.vaultAddress,
      caller: params.walletAddress,
      amountRaw,
      slippageBps: params.slippageBps ?? this.config.defaultSlippageBps,
    };

    let unsignedXdr: string;
    try {
      unsignedXdr =
        params.kind === "deposit"
          ? await this.defindex.buildDeposit({ ...build, invest: this.config.investOnDeposit })
          : await this.defindex.buildWithdraw(build);
    } catch (err) {
      const detail = defindexErrorText(err);
      this.logger.warn({ vaultId: vault.id, kind: params.kind, detail }, "DeFindex no construyó el XDR");
      throw new AppError("build_failed", this.buildErrorMessage(detail, params.kind), 502);
    }

    return this.operations.create({
      userId: params.userId,
      walletAddress: params.walletAddress,
      vaultId: vault.id,
      vaultAddress: vault.vaultAddress,
      kind: params.kind,
      amountRaw: amountRaw.toString(),
      decimals: vault.decimals,
      assetSymbol: vault.assetSymbol,
      unsignedXdr,
    });
  }

  /** Mensajes accionables en español, en la línea de los que ya usa la WebApp. */
  private buildErrorMessage(detail: string, kind: OperationKind): string {
    const lower = detail.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("429")) {
      return "DeFindex alcanzó su límite de solicitudes. Espera unos segundos e intenta de nuevo.";
    }
    if (lower.includes("insufficient") || lower.includes("balance")) {
      return kind === "deposit"
        ? "Saldo insuficiente para el depósito."
        : "Saldo insuficiente en la bóveda para el retiro.";
    }
    if (lower.includes("trustline")) {
      return "Tu wallet no tiene la trustline del activo. Contacta a soporte.";
    }
    if (lower.includes("timeout") || lower.includes("econnrefused") || lower.includes("fetch failed")) {
      return "No pudimos contactar el servicio de bóvedas. Intenta de nuevo.";
    }
    return "No se pudo preparar la operación. Intenta con un monto diferente.";
  }

  /** Recupera una operación verificando pertenencia (404 si es de otro usuario, no 403: no se filtra existencia). */
  async getOwned(userId: string, operationId: string): Promise<VaultOperation> {
    const operation = await this.operations.findById(operationId);
    if (!operation || operation.userId !== userId) {
      throw new AppError("operation_not_found", "No existe la operación indicada.", 404);
    }
    return operation;
  }

  async confirm(userId: string, operationId: string, signedXdr: string): Promise<VaultOperation> {
    const operation = await this.getOwned(userId, operationId);

    // Ya resuelta: devolver el resultado en lugar de reenviar a la red.
    if (operation.status === "confirmed" || operation.status === "failed") return operation;

    if (!(await this.operations.claimForSubmit(operation.id))) {
      throw new AppError(
        "operation_in_flight",
        "Esta operación ya se está enviando a la red. Consulta su estado antes de reintentar.",
        409,
      );
    }

    try {
      const result = await this.defindex.submitSigned(signedXdr);
      if (result.success) {
        await this.operations.settle(operation.id, {
          status: "confirmed",
          txHash: result.txHash,
          ledger: result.ledger,
          failureReason: null,
        });
      } else {
        await this.operations.settle(operation.id, {
          status: "failed",
          txHash: result.txHash,
          ledger: result.ledger,
          failureReason: "La red no confirmó la transacción.",
        });
      }
      return this.getOwned(userId, operationId);
    } catch (err) {
      // No se sabe si la transacción llegó a la red: la operación queda en
      // "submitted" y NUNCA se libera para reintento — reenviar podría
      // duplicar un movimiento de dinero real. El cliente consulta el estado.
      const detail = defindexErrorText(err);
      this.logger.warn(
        { operationId: operation.id, detail },
        "envío con resultado desconocido; la operación queda en submitted",
      );
      throw new AppError(
        "submit_uncertain",
        "Enviamos tu operación pero no obtuvimos confirmación. Consulta su estado en unos segundos; no la reintentes.",
        502,
      );
    }
  }
}
