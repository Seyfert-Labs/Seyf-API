import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ErrorResponseSchema } from "../../core/errors.js";
import type { Profile, ProfilesRepository } from "./repo.js";
import { LinkWalletRequestSchema, MeResponseSchema } from "./schemas.js";

export interface UsersRouteDeps {
  profiles: ProfilesRepository;
}

function toMeResponse(userId: string, profile: Profile | null) {
  return {
    userId,
    walletAddress: profile?.walletAddress ?? null,
    email: profile?.email ?? null,
    fullName: profile?.fullName ?? null,
  };
}

export function usersRoutes(deps: UsersRouteDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/me",
      {
        schema: {
          tags: ["users"],
          summary: "Perfil del usuario autenticado",
          response: { 200: MeResponseSchema },
        },
      },
      async (request) => {
        const profile = await deps.profiles.findByDid(request.user!.userId);
        return toMeResponse(request.user!.userId, profile);
      },
    );

    app.post(
      "/me/wallet",
      {
        schema: {
          tags: ["users"],
          summary: "Vincula la wallet Pollar del usuario a su identidad",
          body: LinkWalletRequestSchema,
          response: { 200: MeResponseSchema, 409: ErrorResponseSchema },
        },
      },
      async (request) => {
        const profile = await deps.profiles.linkWallet(
          request.user!.userId,
          request.body.publicKey,
        );
        return toMeResponse(request.user!.userId, profile);
      },
    );
  };
}
