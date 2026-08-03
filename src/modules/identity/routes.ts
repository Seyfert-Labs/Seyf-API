import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AppError, ErrorResponseSchema } from "../../core/errors.js";
import type { ProfilesRepository } from "../users/repo.js";
import {
  KycStatusResponseSchema,
  SubmitIdentityRequestSchema,
  UploadDocumentsRequestSchema,
  WebhookResponseSchema,
} from "./schemas.js";
import type { IdentityService } from "./service.js";

export interface IdentityRouteDeps {
  identity: IdentityService;
  profiles: ProfilesRepository;
}

export function identityRoutes(deps: IdentityRouteDeps): FastifyPluginAsyncZod {
  async function walletOf(request: FastifyRequest): Promise<string> {
    const profile = await deps.profiles.findByDid(request.user!.userId);
    if (!profile) {
      throw new AppError(
        "wallet_not_linked",
        "Vincula tu wallet (POST /v1/me/wallet) antes de verificar tu identidad.",
        409,
      );
    }
    return profile.walletAddress;
  }

  return async (app) => {
    app.get(
      "/identity/kyc",
      {
        schema: {
          tags: ["identity"],
          summary: "Estado de verificación de identidad del usuario",
          response: { 200: KycStatusResponseSchema, 409: ErrorResponseSchema },
        },
      },
      async (request) => deps.identity.getStatus(await walletOf(request)),
    );

    app.post(
      "/identity/kyc",
      {
        schema: {
          tags: ["identity"],
          summary: "Envía los datos de identidad para verificación",
          description:
            "Los datos personales se reenvían al proveedor de verificación; la SEYF API no los almacena.",
          body: SubmitIdentityRequestSchema,
          response: {
            200: KycStatusResponseSchema,
            400: ErrorResponseSchema,
            409: ErrorResponseSchema,
            502: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) =>
        deps.identity.submitIdentity(await walletOf(request), request.body),
    );

    app.post(
      "/identity/kyc/documents",
      {
        schema: {
          tags: ["identity"],
          summary: "Sube identificaciones o selfie para la verificación",
          body: UploadDocumentsRequestSchema,
          response: {
            200: KycStatusResponseSchema,
            400: ErrorResponseSchema,
            409: ErrorResponseSchema,
            502: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) =>
        deps.identity.uploadDocuments(
          await walletOf(request),
          request.body.documentType,
          request.body.images,
        ),
    );
  };
}

/**
 * Webhook de Etherfuse. Es público (lo llama un tercero) pero NO anónimo:
 * la autenticidad la da la firma HMAC, no un token de sesión.
 */
export function identityWebhookRoutes(deps: {
  identity: IdentityService;
}): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/webhooks/etherfuse",
      {
        config: { public: true },
        schema: {
          tags: ["identity"],
          summary: "Recibe eventos de verificación de Etherfuse",
          security: [],
          response: {
            200: WebhookResponseSchema,
            401: ErrorResponseSchema,
            503: ErrorResponseSchema,
          },
        },
      },
      async (request) => {
        const signature = request.headers["x-signature"];
        const result = await deps.identity.handleWebhook(
          request.body,
          typeof signature === "string" ? signature : null,
        );
        return { received: true as const, ...result };
      },
    );
  };
}
