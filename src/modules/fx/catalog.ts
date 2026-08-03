// Activos con precio en MXN y los books de Bitso que los resuelven.
//
// El orden importa: se prueba book por book hasta encontrar precio. Los
// stablecoins de dólar caen a USDT/USD porque en Bitso stage no existe
// `usdc_mxn` (mismo criterio que la WebApp).

export interface PricedAsset {
  asset: string;
  /** Books candidatos, en orden de preferencia. Vacío = precio fijo. */
  books: string[];
  /** Precio fijo en MXN, para el peso y su equivalente digital. */
  fixed?: string;
}

export const PRICED_ASSETS: PricedAsset[] = [
  { asset: "MXN", books: [], fixed: "1" },
  { asset: "MXNB", books: [], fixed: "1" },
  { asset: "XLM", books: ["xlm_mxn"] },
  { asset: "USDC", books: ["usdc_mxn", "usdt_mxn", "usd_mxn"] },
  { asset: "USDT", books: ["usdt_mxn", "usd_mxn"] },
  { asset: "USD", books: ["usd_mxn", "usdt_mxn"] },
  { asset: "DAI", books: ["dai_mxn"] },
  { asset: "EUR", books: ["eur_mxn"] },
  { asset: "BRL", books: ["brl_mxn"] },
];

export const SUPPORTED_ASSETS = PRICED_ASSETS.map((a) => a.asset);

export function findAsset(asset: string): PricedAsset | undefined {
  return PRICED_ASSETS.find((a) => a.asset === asset.toUpperCase());
}
