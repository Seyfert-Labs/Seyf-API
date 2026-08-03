import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AppError, ErrorResponseSchema } from "../../core/errors.js";
import type { IdentityVerifier } from "./identity.js";
import type { RefreshTokenStore } from "./refresh-store.js";
import { DEFAULT_SCOPES, type TokenService } from "./tokens.js";
import { CreateSessionRequestSchema, RefreshRequestSchema, TokenPairSchema } from "./schemas.js";

export interface AuthRouteDeps {
  verifier: IdentityVerifier;
  refreshStore: RefreshTokenStore;
  tokens: TokenService;
}

export function authRoutes(deps: AuthRouteDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/auth/session",
      {
        config: { public: true },
        schema: {
          tags: ["auth"],
          summary: "Canjea un token de identidad (Privy) por tokens de la SEYF API",
          security: [],
          body: CreateSessionRequestSchema,
          response: { 201: TokenPairSchema, 401: ErrorResponseSchema, 503: ErrorResponseSchema },
        },
      },
      async (request, reply) => {
        let subject: string;
        try {
          ({ subject } = await deps.verifier.verify(request.body.identityToken));
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw new AppError(
            "invalid_identity_token",
            "El token de identidad no es válido o expiró.",
            401,
          );
        }

        // TODO(#4): mapear subject → usuario interno (perfil + publicKey) en Supabase.
        const { token: refreshToken, sessionId } = await deps.refreshStore.issue(subject);
        const access = await deps.tokens.issue({ userId: subject, sessionId, scopes: DEFAULT_SCOPES });
        return reply
          .code(201)
          .send({ accessToken: access.token, expiresIn: access.expiresIn, refreshToken });
      },
    );

    app.post(
      "/auth/refresh",
      {
        config: { public: true },
        schema: {
          tags: ["auth"],
          summary: "Rota el refresh token y emite un nuevo par de tokens",
          security: [],
          body: RefreshRequestSchema,
          response: { 200: TokenPairSchema, 401: ErrorResponseSchema },
        },
      },
      async (request) => {
        const result = await deps.refreshStore.rotate(request.body.refreshToken);
        if (result === "invalid") {
          throw new AppError("invalid_refresh_token", "El refresh token no es válido o expiró.", 401);
        }
        if (result === "reused") {
          throw new AppError(
            "refresh_token_reused",
            "Se detectó reuso de un refresh token ya rotado; la sesión fue revocada por seguridad. Inicia sesión de nuevo.",
            401,
          );
        }
        const access = await deps.tokens.issue({
          userId: result.userId,
          sessionId: result.sessionId,
          scopes: DEFAULT_SCOPES,
        });
        return {
          accessToken: access.token,
          expiresIn: access.expiresIn,
          refreshToken: result.token,
        };
      },
    );

    app.post(
      "/auth/logout",
      {
        schema: {
          tags: ["auth"],
          summary: "Revoca la sesión actual (los refresh tokens dejan de servir)",
          response: { 204: z.null().describe("Sesión revocada") },
        },
      },
      async (request, reply) => {
        // El guard garantiza request.user en rutas no públicas.
        await deps.refreshStore.revokeSession(request.user!.sessionId);
        return reply.code(204).send(null);
      },
    );
  };
}
