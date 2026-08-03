import { AppError } from "../../core/errors.js";

// Puerto hacia Horizon (API pública de Stellar).
//
// En SEYF-P esta consulta la hace el navegador directamente contra Horizon. En
// móvil eso violaría el principio de cliente agnóstico de blockchain (D1): la
// app no debe conocer Horizon, redes ni formatos de operación. La API traduce.

export type OperationKind =
  | "payment"
  | "path_payment"
  | "trustline"
  | "account_created"
  | "other";

export interface OnchainOperation {
  id: string;
  kind: OperationKind;
  direction: "in" | "out" | "self";
  from: string;
  to: string;
  asset: string;
  /** Monto como string: Horizon lo entrega exacto y convertirlo perdería precisión. */
  amount: string;
  txHash: string;
  createdAt: string;
}

export interface HorizonClient {
  listOperations(publicKey: string, limit: number): Promise<OnchainOperation[]>;
}

function normalizeAsset(assetType: unknown, assetCode: unknown): string {
  if (assetType === "native") return "XLM";
  return typeof assetCode === "string" ? assetCode.toUpperCase() : "desconocido";
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Clasificación portada de `useStellarTxns` (SEYF-P). */
export function classifyOperation(
  op: Record<string, unknown>,
  userAddress: string,
): OnchainOperation | null {
  const type = str(op.type);
  const base = {
    id: str(op.id),
    txHash: str(op.transaction_hash),
    createdAt: str(op.created_at),
  };

  if (type === "payment" || type.startsWith("path_payment")) {
    const from = str(op.from);
    const to = str(op.to);
    let direction: OnchainOperation["direction"] = "self";
    if (from === userAddress && to === userAddress) direction = "self";
    else if (to === userAddress) direction = "in";
    else if (from === userAddress) direction = "out";

    return {
      ...base,
      kind: type === "payment" ? "payment" : "path_payment",
      direction,
      from,
      to,
      asset: normalizeAsset(op.asset_type, op.asset_code),
      amount: str(op.amount, "0"),
    };
  }

  if (type === "change_trust") {
    return {
      ...base,
      kind: "trustline",
      direction: "self",
      from: userAddress,
      to: str(op.trustor, userAddress),
      asset: normalizeAsset(op.asset_type, op.asset_code),
      amount: "0",
    };
  }

  if (type === "create_account") {
    const account = str(op.account);
    return {
      ...base,
      kind: "account_created",
      direction: account === userAddress ? "in" : "out",
      from: str(op.funder),
      to: account,
      asset: "XLM",
      amount: str(op.starting_balance, "0"),
    };
  }

  return null;
}

const TIMEOUT_MS = 8_000;

export class HttpHorizonClient implements HorizonClient {
  constructor(private readonly baseUrl: string) {}

  async listOperations(publicKey: string, limit: number): Promise<OnchainOperation[]> {
    const url =
      `${this.baseUrl}/accounts/${encodeURIComponent(publicKey)}/operations` +
      `?order=desc&limit=${limit}&include_failed=false`;

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (cause) {
      throw new AppError(
        "onchain_unavailable",
        "No pudimos consultar el historial on-chain.",
        502,
      ).withCause(cause);
    }

    // Cuenta aún no creada en la red: no hay historial, pero tampoco es un error.
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new AppError("onchain_unavailable", `Horizon respondió ${res.status}.`, 502);
    }

    const body = (await res.json().catch(() => null)) as {
      _embedded?: { records?: Record<string, unknown>[] };
    } | null;

    const records = body?._embedded?.records ?? [];
    return records
      .map((record) => classifyOperation(record, publicKey))
      .filter((op): op is OnchainOperation => op !== null);
  }
}
