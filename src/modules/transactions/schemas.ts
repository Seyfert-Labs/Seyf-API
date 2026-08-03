import { z } from "zod";

export const TransactionSchema = z.object({
  id: z.string(),
  source: z
    .enum(["vault", "onchain"])
    .describe("'vault': operación iniciada en SEYF. 'onchain': movimiento observado en la red"),
  kind: z.string().describe("deposit | withdrawal | payment | path_payment | trustline | account_created"),
  direction: z.enum(["in", "out", "self"]),
  asset: z.string(),
  amount: z.string().describe("Monto decimal exacto"),
  status: z.enum(["pending", "confirmed", "failed"]),
  txHash: z.string().nullable(),
  vaultId: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
});

export const ListTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z
    .string()
    .datetime()
    .optional()
    .describe("Devuelve movimientos anteriores a este instante ISO (paginación)"),
});

export const TransactionsResponseSchema = z.object({
  transactions: z.array(TransactionSchema),
  nextBefore: z
    .string()
    .nullable()
    .describe("Valor para el parámetro `before` de la siguiente página. null si no hay más"),
  onchainAvailable: z
    .boolean()
    .describe("false si la red no pudo consultarse: la lista trae solo movimientos de SEYF"),
});

export const PendingTransactionsResponseSchema = z.object({
  transactions: z.array(TransactionSchema),
});
