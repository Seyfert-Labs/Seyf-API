import { DefindexSDK, SupportedNetworks } from "@defindex/sdk";
import type { Config } from "../../core/config.js";

// Puerto hacia DeFindex. La API key (`sk_...`) vive SOLO aquí: es la razón
// original por la que existe un backend entre el cliente y DeFindex.
// La interfaz permite inyectar dobles en tests sin tocar la red.

export interface VaultInfo {
  name: string;
  symbol: string;
  /** APY reportado por DeFindex. Ver nota de unidades en `readApy`. */
  apy: number | null;
}

export interface VaultBalance {
  /** Shares del vault (dfTokens), en unidades crudas. */
  dfTokens: bigint;
  /** Saldo en el activo subyacente, en unidades crudas (10^decimals). */
  underlyingRaw: bigint;
}

export interface BuildParams {
  vaultAddress: string;
  caller: string;
  /** Monto en unidades crudas del activo subyacente. */
  amountRaw: bigint;
  slippageBps: number;
}

export interface SubmitResult {
  txHash: string | null;
  success: boolean;
  ledger: number | null;
}

export interface DefindexClient {
  getVaultInfo(vaultAddress: string): Promise<VaultInfo>;
  getVaultBalance(vaultAddress: string, publicKey: string): Promise<VaultBalance>;
  /** Construye el XDR sin firmar de un depósito. */
  buildDeposit(params: BuildParams & { invest: boolean }): Promise<string>;
  /** Construye el XDR sin firmar de un retiro. */
  buildWithdraw(params: BuildParams): Promise<string>;
  /** Envía a la red un XDR ya firmado. */
  submitSigned(signedXdr: string): Promise<SubmitResult>;
}

/** Texto de error del SDK (a veces son objetos JSON, no instancias de Error). */
export function defindexErrorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; error?: unknown };
    if (typeof o.message === "string") return o.message;
    if (typeof o.error === "string") return o.error;
  }
  return typeof e === "string" ? e : "";
}

/**
 * Distingue fallos transitorios (rate limit, 5xx, red) de respuestas legítimas.
 * Es la clasificación más importante del módulo: ante un fallo transitorio
 * NUNCA se puede afirmar "saldo 0" — eso borraría el saldo real del usuario en
 * pantalla. Portado de SEYF-P (lib/defindex/api-error.ts), que acierta en esto.
 */
export function isTransientError(e: unknown): boolean {
  const msg = defindexErrorText(e).toLowerCase();
  const status =
    e && typeof e === "object" && "statusCode" in e
      ? Number((e as { statusCode: unknown }).statusCode)
      : 0;
  return (
    status >= 500 ||
    status === 429 ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("rate limit") ||
    msg.includes("too many") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  );
}

/**
 * El SDK devuelve unidades crudas como `number`. Para los montos de SEYF
 * (7 decimales) los valores quedan holgadamente bajo MAX_SAFE_INTEGER, pero la
 * conversión se hace explícita y validada para no propagar NaN/Infinity como
 * si fueran saldos.
 */
function toRawUnits(value: unknown): bigint {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0n;
  if (!Number.isSafeInteger(Math.round(n))) {
    throw new Error(`Saldo fuera del rango seguro de precisión: ${n}`);
  }
  return BigInt(Math.round(n));
}

/** El APY llega como `number`; se normaliza a null si no es finito. */
function readApy(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class SdkDefindexClient implements DefindexClient {
  private readonly sdk: DefindexSDK;
  private readonly network: SupportedNetworks;

  constructor(config: Pick<Config, "DEFINDEX_API_KEY" | "DEFINDEX_BASE_URL" | "STELLAR_NETWORK">) {
    this.network =
      config.STELLAR_NETWORK === "mainnet" ? SupportedNetworks.MAINNET : SupportedNetworks.TESTNET;
    this.sdk = new DefindexSDK({
      ...(config.DEFINDEX_API_KEY ? { apiKey: config.DEFINDEX_API_KEY } : {}),
      baseUrl: config.DEFINDEX_BASE_URL,
      defaultNetwork: this.network,
    });
  }

  async getVaultInfo(vaultAddress: string): Promise<VaultInfo> {
    const info = await this.sdk.getVaultInfo(vaultAddress, this.network);
    return { name: info.name, symbol: info.symbol, apy: readApy(info.apy) };
  }

  async getVaultBalance(vaultAddress: string, publicKey: string): Promise<VaultBalance> {
    const balance = await this.sdk.getVaultBalance(vaultAddress, publicKey, this.network);
    return {
      dfTokens: toRawUnits(balance.dfTokens),
      underlyingRaw: toRawUnits(balance.underlyingBalance?.[0]),
    };
  }

  /** El SDK recibe montos como number; las unidades crudas caben con holgura en un entero seguro. */
  private amountForSdk(amountRaw: bigint): number {
    if (amountRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("El monto excede el rango que acepta el SDK de DeFindex");
    }
    return Number(amountRaw);
  }

  async buildDeposit(params: BuildParams & { invest: boolean }): Promise<string> {
    const res = await this.sdk.depositToVault(
      params.vaultAddress,
      {
        caller: params.caller,
        amounts: [this.amountForSdk(params.amountRaw)],
        invest: params.invest,
        slippageBps: params.slippageBps,
      },
      this.network,
    );
    if (!res.xdr) throw new Error("DeFindex no devolvió XDR de depósito");
    return res.xdr;
  }

  async buildWithdraw(params: BuildParams): Promise<string> {
    const res = await this.sdk.withdrawFromVault(
      params.vaultAddress,
      {
        caller: params.caller,
        amounts: [this.amountForSdk(params.amountRaw)],
        slippageBps: params.slippageBps,
      },
      this.network,
    );
    if (!res.xdr) throw new Error("DeFindex no devolvió XDR de retiro");
    return res.xdr;
  }

  async submitSigned(signedXdr: string): Promise<SubmitResult> {
    const res = await this.sdk.sendTransaction(signedXdr, this.network);
    const raw = res as unknown as { txHash?: unknown; success?: unknown; ledger?: unknown };
    return {
      txHash: typeof raw.txHash === "string" ? raw.txHash : null,
      success: raw.success === true,
      ledger: Number.isFinite(Number(raw.ledger)) ? Number(raw.ledger) : null,
    };
  }
}
