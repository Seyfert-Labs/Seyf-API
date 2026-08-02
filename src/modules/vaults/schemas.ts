import { z } from "zod";

// Contrato de vaults. Los shapes deben mantenerse conceptualmente compatibles
// con lo que hoy devuelven los hooks de SEYF-P (useVaults, useStellarVaults,
// useDefindexStrategies) — validar contra respuestas reales al portar.

export const VaultSchema = z.object({
  id: z.string(),
  name: z.string(),
  asset: z.enum(["CETES", "USDC", "XLM"]),
  apy: z.number().describe("APY vigente, fracción decimal (0.105 = 10.5%)"),
  tvl: z.string().describe("TVL en unidades del asset, string decimal"),
  status: z.enum(["active", "paused"]),
});

export type Vault = z.infer<typeof VaultSchema>;

export const ListVaultsResponseSchema = z.object({
  vaults: z.array(VaultSchema),
});
