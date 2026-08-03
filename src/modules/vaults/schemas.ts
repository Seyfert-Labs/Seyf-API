import { z } from "zod";

// Contrato del módulo de bóvedas.
//
// Los montos viajan como STRING decimal, no como number: los saldos son dinero
// y la coma flotante de JSON/JS introduce errores de redondeo. `balanceRaw`
// acompaña en unidades enteras para clientes que prefieran aritmética exacta.

export const VaultSchema = z.object({
  id: z.string().describe("Identificador estable de la bóveda (xlm | cetes | usdc)"),
  planId: z.string().describe("Plan de riesgo asociado (compatibilidad con la WebApp)"),
  name: z.string(),
  assetSymbol: z.string(),
  decimals: z.number().int().describe("Decimales del activo subyacente"),
  vaultAddress: z.string().describe("Dirección del vault DeFindex en Stellar"),
  apy: z
    .number()
    .describe("APY a mostrar, en porcentaje (10.5 = 10.5%). Ver apySource para su procedencia"),
  apySource: z
    .enum(["live", "reference"])
    .describe("'live': reportado por DeFindex. 'reference': valor de catálogo porque DeFindex no respondió"),
  risk: z.string(),
  horizon: z.string(),
  exposure: z.string(),
  description: z.string(),
  color: z.string(),
  emoji: z.string(),
});

export const ListVaultsResponseSchema = z.object({
  vaults: z.array(VaultSchema),
});

export const VaultIdParamsSchema = z.object({
  id: z.string().describe("Identificador de la bóveda"),
});

export const PositionSchema = z.object({
  vaultId: z.string(),
  planId: z.string(),
  name: z.string(),
  assetSymbol: z.string(),
  decimals: z.number().int(),
  vaultAddress: z.string(),
  balance: z
    .string()
    .nullable()
    .describe("Saldo en el activo subyacente, decimal exacto. null si status es 'unavailable'"),
  balanceRaw: z
    .string()
    .nullable()
    .describe("Mismo saldo en unidades enteras (10^decimals), para aritmética exacta"),
  dfTokens: z.string().nullable().describe("Shares del vault en unidades enteras"),
  status: z
    .enum(["ok", "unavailable"])
    .describe(
      "'ok': saldo verificado on-chain (incluido 0). 'unavailable': DeFindex no respondió — conserva el último saldo conocido, no muestres cero",
    ),
});

export const PositionsResponseSchema = z.object({
  walletAddress: z.string(),
  positions: z.array(PositionSchema),
});

// ─── Mutaciones ─────────────────────────────────────────────────────────────

export const CreateOperationRequestSchema = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "El monto debe ser un decimal positivo, p. ej. \"100.50\"")
    .describe("Monto en el activo de la bóveda, como string decimal"),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe("Tolerancia de slippage en puntos base (default 100 = 1%)"),
});

export const ConfirmOperationRequestSchema = z.object({
  signedXdr: z
    .string()
    .min(1)
    .describe("XDR firmado por la wallet del usuario (sesión Pollar del cliente)"),
});

export const OperationIdParamsSchema = z.object({
  id: z.string().describe("Identificador de la operación"),
});

export const OperationSchema = z.object({
  id: z.string(),
  vaultId: z.string(),
  kind: z.enum(["deposit", "withdrawal"]),
  amount: z.string().describe("Monto decimal exacto"),
  amountRaw: z.string().describe("Monto en unidades enteras"),
  assetSymbol: z.string(),
  decimals: z.number().int(),
  status: z
    .enum(["awaiting_signature", "submitted", "confirmed", "failed"])
    .describe(
      "awaiting_signature: falta firmar y confirmar. submitted: enviada, resultado desconocido — consulta, no reintentes. confirmed/failed: resuelta",
    ),
  unsignedXdr: z
    .string()
    .nullable()
    .describe("XDR a firmar. Solo presente mientras la operación espera firma"),
  txHash: z.string().nullable(),
  ledger: z.number().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
