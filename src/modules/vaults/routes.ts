import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AppError, ErrorResponseSchema } from "../../core/errors.js";
import { formatUnits } from "../../core/units.js";
import type { ProfilesRepository } from "../users/repo.js";
import type { VaultMutationsService } from "./mutations.js";
import type { OperationKind, VaultOperation } from "./operations.js";
import {
  ConfirmOperationRequestSchema,
  CreateOperationRequestSchema,
  ListVaultsResponseSchema,
  OperationIdParamsSchema,
  OperationSchema,
  PositionsResponseSchema,
  VaultIdParamsSchema,
  VaultSchema,
} from "./schemas.js";
import type { VaultsService } from "./service.js";

export interface VaultsRouteDeps {
  vaults: VaultsService;
  mutations: VaultMutationsService;
  profiles: ProfilesRepository;
}

function toOperationResponse(operation: VaultOperation) {
  return {
    id: operation.id,
    vaultId: operation.vaultId,
    kind: operation.kind,
    amount: formatUnits(BigInt(operation.amountRaw), operation.decimals),
    amountRaw: operation.amountRaw,
    assetSymbol: operation.assetSymbol,
    decimals: operation.decimals,
    status: operation.status,
    // El XDR solo sirve mientras falta firmar; después es ruido.
    unsignedXdr: operation.status === "awaiting_signature" ? operation.unsignedXdr : null,
    txHash: operation.txHash,
    ledger: operation.ledger,
    failureReason: operation.failureReason,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

export function vaultsRoutes(deps: VaultsRouteDeps): FastifyPluginAsyncZod {
  /** Regla H2: la wallet sale siempre de la sesión, nunca del request. */
  async function walletOf(request: FastifyRequest): Promise<string> {
    const profile = await deps.profiles.findByDid(request.user!.userId);
    if (!profile) {
      throw new AppError(
        "wallet_not_linked",
        "Vincula tu wallet (POST /v1/me/wallet) antes de operar.",
        409,
      );
    }
    return profile.walletAddress;
  }

  return async (app) => {
    app.get(
      "/vaults",
      {
        schema: {
          tags: ["vaults"],
          summary: "Lista las bóvedas disponibles con su APY",
          response: { 200: ListVaultsResponseSchema },
        },
      },
      async () => ({ vaults: await deps.vaults.listVaults() }),
    );

    app.get(
      "/vaults/:id",
      {
        schema: {
          tags: ["vaults"],
          summary: "Detalle de una bóveda",
          params: VaultIdParamsSchema,
          response: { 200: VaultSchema, 404: ErrorResponseSchema },
        },
      },
      async (request) => deps.vaults.getVault(request.params.id),
    );

    app.get(
      "/positions",
      {
        schema: {
          tags: ["vaults"],
          summary: "Posiciones on-chain del usuario en todas las bóvedas",
          description:
            "La wallet se deriva del usuario autenticado, nunca de parámetros del request.",
          response: { 200: PositionsResponseSchema, 409: ErrorResponseSchema },
        },
      },
      async (request) => {
        const walletAddress = await walletOf(request);
        return {
          walletAddress,
          positions: await deps.vaults.getPositions(walletAddress),
        };
      },
    );

    // ─── Mutaciones ─────────────────────────────────────────────────────────

    const createOperation = (kind: OperationKind) => ({
      config: { idempotency: true },
      schema: {
        tags: ["vaults"],
        summary:
          kind === "deposit" ? "Prepara un depósito en la bóveda" : "Prepara un retiro de la bóveda",
        description:
          "Valida cumplimiento y construye el XDR sin firmar. El cliente lo firma con su wallet " +
          "y lo envía a POST /v1/operations/{id}/confirm. Requiere header Idempotency-Key.",
        params: VaultIdParamsSchema,
        body: CreateOperationRequestSchema,
        response: {
          201: OperationSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          502: ErrorResponseSchema,
        },
      },
    });

    for (const kind of ["deposit", "withdrawal"] as const) {
      app.post(
        kind === "deposit" ? "/vaults/:id/deposits" : "/vaults/:id/withdrawals",
        createOperation(kind),
        async (request, reply) => {
          const operation = await deps.mutations.createOperation({
            userId: request.user!.userId,
            walletAddress: await walletOf(request),
            vaultId: request.params.id,
            kind,
            amount: request.body.amount,
            ...(request.body.slippageBps !== undefined
              ? { slippageBps: request.body.slippageBps }
              : {}),
          });
          return reply.code(201).send(toOperationResponse(operation));
        },
      );
    }

    app.post(
      "/operations/:id/confirm",
      {
        config: { idempotency: true },
        schema: {
          tags: ["vaults"],
          summary: "Envía a la red la operación ya firmada",
          description:
            "Requiere header Idempotency-Key. Si responde 502 submit_uncertain, consulta el estado " +
            "con GET /v1/operations/{id} en lugar de reintentar: la operación pudo haber llegado a la red.",
          params: OperationIdParamsSchema,
          body: ConfirmOperationRequestSchema,
          response: {
            200: OperationSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            502: ErrorResponseSchema,
          },
        },
      },
      async (request) =>
        toOperationResponse(
          await deps.mutations.confirm(
            request.user!.userId,
            request.params.id,
            request.body.signedXdr,
          ),
        ),
    );

    app.get(
      "/operations/:id",
      {
        schema: {
          tags: ["vaults"],
          summary: "Estado de una operación",
          params: OperationIdParamsSchema,
          response: { 200: OperationSchema, 404: ErrorResponseSchema },
        },
      },
      async (request) =>
        toOperationResponse(await deps.mutations.getOwned(request.user!.userId, request.params.id)),
    );
  };
}
