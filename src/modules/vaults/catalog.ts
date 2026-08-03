import type { Config } from "../../core/config.js";

// Catálogo de bóvedas DeFindex, portado de SEYF-P (src/lib/defindex/catalog.ts).
// Las direcciones deben ser VAULTS, no estrategias: la API de DeFindex rechaza
// direcciones de estrategia. Son configurables por entorno para apuntar a las
// vaults propias de SEYF cuando se creen en app.defindex.io; el fallback son
// las de paltalabs que envuelven las mismas estrategias Blend.

export type VaultId = "xlm" | "cetes" | "usdc";

/** planId del cuestionario de riesgo → bóveda. Se conserva por compatibilidad con la WebApp. */
export type PlanId = "conservador" | "moderado" | "balanceado";

export interface VaultConfig {
  id: VaultId;
  planId: PlanId;
  name: string;
  vaultAddress: string;
  strategyName: string;
  assetSymbol: string;
  assetIssuer: string;
  decimals: number;
  risk: "Bajo" | "Medio" | "Alto";
  horizon: string;
  exposure: string;
  description: string;
  color: string;
  emoji: string;
  /** APY de referencia que se muestra mientras DeFindex no responde el APY en vivo (porcentaje). */
  apyReference: number;
}

const DEFAULTS: Record<VaultId, string> = {
  xlm: "CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6",
  cetes: "CBIS5TEMTNNOTBE3WXPQUAGUEDYZZVIWAKTXEQCOUJ34OJJ3FJ5NLF2P",
  usdc: "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN",
};

type CatalogEnv = Pick<
  Config,
  "DEFINDEX_VAULT_XLM" | "DEFINDEX_VAULT_CETES" | "DEFINDEX_VAULT_USDC"
>;

export function buildCatalog(env: CatalogEnv): VaultConfig[] {
  // XLM primero: es el activo con el que el usuario puede depositar de inmediato
  // en testnet (Friendbot lo fondea), así que es el orden natural de la UI.
  return [
    {
      id: "xlm",
      planId: "balanceado",
      name: "XLM",
      vaultAddress: env.DEFINDEX_VAULT_XLM ?? DEFAULTS.xlm,
      strategyName: "XLM Blend Strategy",
      assetSymbol: "XLM",
      assetIssuer: "",
      decimals: 7,
      risk: "Medio",
      horizon: "7 a 15 años",
      exposure: "Activo nativo de Stellar (XLM)",
      description:
        "Exposición a XLM, el activo de la red Stellar. Más potencial de rendimiento con algo más de variación.",
      color: "var(--accent)",
      emoji: "📊",
      apyReference: 2.8,
    },
    {
      id: "cetes",
      planId: "conservador",
      name: "CETES",
      vaultAddress: env.DEFINDEX_VAULT_CETES ?? DEFAULTS.cetes,
      strategyName: "CETES Blend Strategy",
      assetSymbol: "CETES",
      assetIssuer: "GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4",
      decimals: 7,
      risk: "Bajo",
      horizon: "0 a 3 años",
      exposure: "Bonos del gobierno mexicano (CETES)",
      description:
        "Tu dinero rinde en CETES, deuda del gobierno mexicano en pesos. Riesgo bajo y rendimiento estable.",
      color: "#5BD6C0",
      emoji: "🛡️",
      apyReference: 10.5,
    },
    {
      id: "usdc",
      planId: "moderado",
      name: "USDC",
      vaultAddress: env.DEFINDEX_VAULT_USDC ?? DEFAULTS.usdc,
      strategyName: "USDC Blend Strategy",
      assetSymbol: "USDC",
      assetIssuer: "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56",
      decimals: 7,
      risk: "Bajo",
      horizon: "3 a 7 años",
      exposure: "Dólar digital estable (USDC)",
      description:
        "Ahorro en USDC, un dólar digital estable 1:1 con el dólar de EE. UU. Rendimiento en dólares.",
      color: "#7C9EFF",
      emoji: "🧭",
      apyReference: 4.5,
    },
  ];
}
