import { AppError } from "../../core/errors.js";

// Puerto hacia Bitso para precios. Los tickers son endpoints PÚBLICOS: este
// módulo no necesita credenciales. Las llaves firmadas de Bitso solo hacen
// falta para órdenes y saldos (módulo de conversión, fuera de alcance).

export interface Ticker {
  /** Último precio como string: Bitso ya lo entrega así y convertirlo a number perdería exactitud. */
  last: string;
}

export interface BitsoClient {
  /** Devuelve null si el book no existe o no tiene precio válido. */
  getTicker(book: string): Promise<Ticker | null>;
}

const TIMEOUT_MS = 8_000;

export class HttpBitsoClient implements BitsoClient {
  constructor(private readonly baseUrl: string) {}

  async getTicker(book: string): Promise<Ticker | null> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/api/v3/ticker?book=${encodeURIComponent(book)}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
    } catch (cause) {
      throw new AppError(
        "prices_provider_unavailable",
        "No pudimos contactar al proveedor de precios.",
        502,
      ).withCause(cause);
    }

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new AppError(
        "prices_provider_unavailable",
        `El proveedor de precios respondió ${res.status}.`,
        502,
      );
    }

    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      payload?: { last?: unknown };
    } | null;
    if (!body || body.success === false) return null;

    const last = body.payload?.last;
    if (typeof last !== "string" || !isPositiveDecimal(last)) return null;
    return { last };
  }
}

/** Valida que el precio sea un decimal positivo sin recurrir a coma flotante. */
export function isPositiveDecimal(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return false;
  return /[1-9]/.test(value);
}
