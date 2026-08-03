import { AppError } from "../../core/errors.js";
import { formatUnits } from "../../core/units.js";
import type { VaultConfig } from "./catalog.js";
import { defindexErrorText, isTransientError, type DefindexClient } from "./defindex.js";

export interface Logger {
  warn(obj: object, msg: string): void;
}

export interface VaultSummary {
  id: string;
  planId: string;
  name: string;
  assetSymbol: string;
  decimals: number;
  vaultAddress: string;
  /** APY a mostrar (porcentaje). Ver `apySource` para saber si es en vivo. */
  apy: number;
  apySource: "live" | "reference";
  risk: string;
  horizon: string;
  exposure: string;
  description: string;
  color: string;
  emoji: string;
}

export interface Position {
  vaultId: string;
  planId: string;
  name: string;
  assetSymbol: string;
  decimals: number;
  vaultAddress: string;
  /** Saldo en el activo subyacente. `null` cuando `status` es "unavailable". */
  balance: string | null;
  balanceRaw: string | null;
  dfTokens: string | null;
  /**
   * "ok" → el saldo es un hecho verificado on-chain (incluido 0).
   * "unavailable" → DeFindex no respondió; el cliente debe conservar su último
   * saldo conocido en lugar de mostrar cero.
   */
  status: "ok" | "unavailable";
}

function toSummary(vault: VaultConfig, apy: number | null): VaultSummary {
  return {
    id: vault.id,
    planId: vault.planId,
    name: vault.name,
    assetSymbol: vault.assetSymbol,
    decimals: vault.decimals,
    vaultAddress: vault.vaultAddress,
    apy: apy ?? vault.apyReference,
    apySource: apy === null ? "reference" : "live",
    risk: vault.risk,
    horizon: vault.horizon,
    exposure: vault.exposure,
    description: vault.description,
    color: vault.color,
    emoji: vault.emoji,
  };
}

export class VaultsService {
  constructor(
    private readonly catalog: VaultConfig[],
    private readonly defindex: DefindexClient,
    private readonly logger: Logger,
  ) {}

  private find(id: string): VaultConfig {
    const vault = this.catalog.find((v) => v.id === id);
    if (!vault) throw new AppError("vault_not_found", `No existe la bóveda "${id}".`, 404);
    return vault;
  }

  /** APY en vivo, best-effort: si DeFindex falla se usa el de referencia del catálogo. */
  private async liveApy(vault: VaultConfig): Promise<number | null> {
    try {
      const info = await this.defindex.getVaultInfo(vault.vaultAddress);
      return info.apy;
    } catch (err) {
      this.logger.warn(
        { vaultId: vault.id, detail: defindexErrorText(err) },
        "APY en vivo no disponible; se usa el de referencia",
      );
      return null;
    }
  }

  async listVaults(): Promise<VaultSummary[]> {
    return Promise.all(
      this.catalog.map(async (vault) => toSummary(vault, await this.liveApy(vault))),
    );
  }

  async getVault(id: string): Promise<VaultSummary> {
    const vault = this.find(id);
    return toSummary(vault, await this.liveApy(vault));
  }

  async getPositions(publicKey: string): Promise<Position[]> {
    return Promise.all(this.catalog.map((vault) => this.position(vault, publicKey)));
  }

  private async position(vault: VaultConfig, publicKey: string): Promise<Position> {
    const base = {
      vaultId: vault.id,
      planId: vault.planId,
      name: vault.name,
      assetSymbol: vault.assetSymbol,
      decimals: vault.decimals,
      vaultAddress: vault.vaultAddress,
    };

    try {
      const balance = await this.defindex.getVaultBalance(vault.vaultAddress, publicKey);
      return {
        ...base,
        balance: formatUnits(balance.underlyingRaw, vault.decimals),
        balanceRaw: balance.underlyingRaw.toString(),
        dfTokens: balance.dfTokens.toString(),
        status: "ok",
      };
    } catch (err) {
      const detail = defindexErrorText(err);
      if (isTransientError(err)) {
        // Fallo transitorio: no se puede afirmar saldo 0 sin borrar el saldo
        // real del usuario en pantalla.
        this.logger.warn({ vaultId: vault.id, detail }, "saldo no disponible (fallo transitorio)");
        return { ...base, balance: null, balanceRaw: null, dfTokens: null, status: "unavailable" };
      }
      // Cuenta sin posición en esta bóveda: cero es el saldo real.
      this.logger.warn({ vaultId: vault.id, detail }, "sin posición en la bóveda; saldo 0");
      return { ...base, balance: "0", balanceRaw: "0", dfTokens: "0", status: "ok" };
    }
  }
}
