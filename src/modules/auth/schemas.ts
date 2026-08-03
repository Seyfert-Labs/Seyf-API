import { z } from "zod";

export const CreateSessionRequestSchema = z.object({
  identityToken: z
    .string()
    .min(10)
    .describe("Access token del proveedor de identidad (Privy) del usuario ya autenticado"),
});

export const TokenPairSchema = z.object({
  accessToken: z.string().describe("JWT de la SEYF API; enviar como Authorization: Bearer"),
  expiresIn: z.number().int().describe("Vida del access token en segundos"),
  refreshToken: z
    .string()
    .describe("Token opaco de un solo uso para renovar la sesión; guardar en almacenamiento seguro"),
});

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(20),
});
