import { AppError } from "../../core/errors.js";
import type { Logger } from "../vaults/service.js";
import type { BitsoClient } from "./bitso.js";
import { findAsset, SUPPORTED_ASSETS, type PricedAsset } from "./catalog.js";

// Agregación de precios en el servidor con caché y TTL.
//
// En SEYF-P cada cliente consulta el ticker de Bitso directamente y sin caché
// (`Cache-Control: no-store`): con miles de usuarios eso multiplica la carga
// contra el proveedor y acaba en rate limit. Aquí una sola consulta por activo
// y ventana de TTL sirve a todos.

export type PriceStatus = "ok" | "stale" | "unavailable";

export interface Price {
  asset: string;
  /** Precio de una unidad del activo en MXN, decimal exacto. null si no hay. */
  mxn: string | null;
  status: PriceStatus;
  source: "fixed" | "bitso" | null;
  asOf: string | null;
}

interface CacheEntry {
  mxn: string;
  source: "fixed" | "bitso";
  fetchedAt: number;
}

export interface FxServiceConfig {
  /** Ventana de frescura de un precio en milisegundos. */
  ttlMs: number;
  /** Cuánto se puede seguir sirviendo un precio vencido si el proveedor falla. */
  staleMaxMs: number;
}

export class FxService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry | null>>();

  constructor(
    private readonly bitso: BitsoClient,
    private readonly config: FxServiceConfig,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async getPrices(assets: string[]): Promise<Price[]> {
    const requested = assets.length > 0 ? assets : SUPPORTED_ASSETS;
    return Promise.all(requested.map((asset) => this.getPrice(asset)));
  }

  private async getPrice(rawAsset: string): Promise<Price> {
    const asset = rawAsset.toUpperCase();
    const config = findAsset(asset);
    if (!config) {
      return { asset, mxn: null, status: "unavailable", source: null, asOf: null };
    }

    const cached = this.cache.get(asset);
    if (cached && this.now() - cached.fetchedAt < this.config.ttlMs) {
      return this.toPrice(asset, cached, "ok");
    }

    let fresh: CacheEntry | null;
    try {
      fresh = await this.fetchOnce(asset, config);
    } catch (err) {
      this.logger.warn(
        { asset, detail: err instanceof Error ? err.message : String(err) },
        "el proveedor de precios falló",
      );
      fresh = null;
    }

    if (fresh) return this.toPrice(asset, fresh, "ok");

    // Sin precio fresco: servir el último conocido marcado como stale, para que
    // el cliente pueda mostrarlo con su antigüedad en vez de quedarse en blanco.
    if (cached && this.now() - cached.fetchedAt < this.config.staleMaxMs) {
      return this.toPrice(asset, cached, "stale");
    }
    return { asset, mxn: null, status: "unavailable", source: null, asOf: null };
  }

  /** Colapsa consultas concurrentes del mismo activo en una sola llamada al proveedor. */
  private async fetchOnce(asset: string, config: PricedAsset): Promise<CacheEntry | null> {
    const pending = this.inFlight.get(asset);
    if (pending) return pending;

    const promise = this.resolve(config)
      .then((entry) => {
        if (entry) this.cache.set(asset, entry);
        return entry;
      })
      .finally(() => {
        this.inFlight.delete(asset);
      });

    this.inFlight.set(asset, promise);
    return promise;
  }

  private async resolve(config: PricedAsset): Promise<CacheEntry | null> {
    if (config.fixed) {
      return { mxn: config.fixed, source: "fixed", fetchedAt: this.now() };
    }

    let lastError: unknown = null;
    for (const book of config.books) {
      try {
        const ticker = await this.bitso.getTicker(book);
        if (ticker) return { mxn: ticker.last, source: "bitso", fetchedAt: this.now() };
      } catch (err) {
        // Un book caído no descarta los siguientes candidatos.
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  private toPrice(asset: string, entry: CacheEntry, status: PriceStatus): Price {
    return {
      asset,
      mxn: entry.mxn,
      status,
      source: entry.source,
      asOf: new Date(entry.fetchedAt).toISOString(),
    };
  }
}

/** Valida y normaliza la lista de activos pedida por query. */
export function parseAssetsParam(raw: string | undefined): string[] {
  if (!raw) return [];
  const assets = raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (assets.length > 20) {
    throw new AppError("too_many_assets", "Máximo 20 activos por consulta.", 400);
  }
  return assets;
}
