import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { AppError, errorBody } from "../../core/errors.js";
import type { AuthenticatedUser, TokenService } from "./tokens.js";

// Guard de autenticación del scope /v1: TODA ruta exige Bearer token salvo
// que se declare explícitamente pública (config: { public: true }). Es el
// inverso deliberado del patrón de SEYF-P (regla H1 de PORTING.md): el
// default es negar, no permitir.

declare module "fastify" {
  interface FastifyContextConfig {
    public?: boolean;
  }
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export interface AuthGuardOptions {
  tokens: TokenService;
}

export const authGuard = fp<AuthGuardOptions>(
  async (app, opts) => {
    app.addHook("onRequest", async (request, reply) => {
      if (request.routeOptions.config?.public) return;

      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return reply
          .code(401)
          .send(
            errorBody(
              "unauthorized",
              "Se requiere autenticación (header Authorization: Bearer <token>).",
              request.id,
            ),
          );
      }

      try {
        request.user = await opts.tokens.verify(header.slice("Bearer ".length));
      } catch {
        return reply
          .code(401)
          .send(errorBody("unauthorized", "Access token inválido o expirado.", request.id));
      }
    });
  },
  { name: "auth-guard" },
);

/** preHandler para rutas que exigen un scope específico además de autenticación. */
export function requireScope(scope: string) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.user?.scopes.includes(scope)) {
      throw new AppError("insufficient_scope", `Se requiere el scope "${scope}".`, 403);
    }
  };
}
