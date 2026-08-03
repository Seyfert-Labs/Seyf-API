import { z } from "zod";
import { SUPPORTED_ASSETS } from "./catalog.js";

export const PriceSchema = z.object({
  asset: z.string(),
  mxn: z
    .string()
    .nullable()
    .describe("Precio de una unidad del activo en MXN, decimal exacto. null si status es 'unavailable'"),
  status: z
    .enum(["ok", "stale", "unavailable"])
    .describe(
      "'ok': precio vigente. 'stale': el proveedor falló y este es el último conocido — muéstralo con su antigüedad (asOf). 'unavailable': sin precio",
    ),
  source: z.enum(["fixed", "bitso"]).nullable(),
  asOf: z.string().nullable().describe("Momento en que se obtuvo el precio"),
});

export const PricesQuerySchema = z.object({
  assets: z
    .string()
    .optional()
    .describe(
      `Lista separada por comas. Sin valor devuelve todos los soportados: ${SUPPORTED_ASSETS.join(", ")}`,
    ),
});

export const PricesResponseSchema = z.object({
  prices: z.array(PriceSchema),
});
