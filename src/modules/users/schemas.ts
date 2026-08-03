import { z } from "zod";

export const StellarPublicKeySchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Debe ser una public key Stellar (G..., 56 caracteres)");

export const MeResponseSchema = z.object({
  userId: z.string().describe("Identificador de la identidad (did:privy:...)"),
  walletAddress: StellarPublicKeySchema.nullable().describe(
    "Wallet Stellar vinculada, o null si aún no se vincula",
  ),
  email: z.string().nullable(),
  fullName: z.string().nullable(),
});

export const LinkWalletRequestSchema = z.object({
  publicKey: StellarPublicKeySchema.describe("Public key de la wallet Pollar del usuario"),
});
