import { z } from "zod";

/** Secreto de desarrollo: la API se niega a arrancar en producción con este valor. */
export const DEV_AUTH_SECRET = "dev-only-secret-do-not-use-in-production!!";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3001),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  AUTH_JWT_SECRET: z.string().min(32).default(DEV_AUTH_SECRET),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().max(900).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  PRIVY_APP_ID: z.string().optional(),
  PRIVY_VERIFICATION_KEY: z.string().optional(),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  DEFINDEX_API_KEY: z.string().optional(),
  DEFINDEX_BASE_URL: z.string().default("https://api.defindex.io"),
  DEFINDEX_VAULT_XLM: z.string().optional(),
  DEFINDEX_VAULT_CETES: z.string().optional(),
  DEFINDEX_VAULT_USDC: z.string().optional(),
  DEFINDEX_INVEST_ON_DEPOSIT: z
    .stringbool()
    .default(false)
    .describe("Invertir en la estrategia dentro del mismo depósito"),
  DEFINDEX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),

  HORIZON_URL: z.string().optional().describe("Sin valor se deriva de STELLAR_NETWORK"),

  BITSO_BASE_URL: z.string().default("https://stage.bitso.com"),
  FX_PRICE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  FX_PRICE_STALE_MAX_MS: z.coerce.number().int().positive().default(600_000),

  ETHERFUSE_API_KEY: z.string().optional(),
  ETHERFUSE_BASE_URL: z.string().default("https://devnet.blockchain.etherfuse.com"),
  ETHERFUSE_WEBHOOK_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Configuración inválida:\n${parsed.error.message}`);
  }
  if (parsed.data.NODE_ENV === "production") {
    if (parsed.data.AUTH_JWT_SECRET === DEV_AUTH_SECRET) {
      throw new Error("AUTH_JWT_SECRET debe configurarse con un secreto real en producción.");
    }
    if (!parsed.data.SUPABASE_URL || !parsed.data.SUPABASE_SERVICE_ROLE_KEY) {
      // Fail-closed: sin DB los repositorios degradarían a memoria y se
      // perderían perfiles/sesiones en cada deploy.
      throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son obligatorios en producción.");
    }
  }
  return parsed.data;
}

export function horizonUrl(config: Config): string {
  if (config.HORIZON_URL) return config.HORIZON_URL;
  return config.STELLAR_NETWORK === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}
