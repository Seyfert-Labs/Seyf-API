import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { AppError, ErrorResponseSchema } from "../../core/errors.js";
import type { ProfilesRepository } from "../users/repo.js";
import {
  ListTransactionsQuerySchema,
  PendingTransactionsResponseSchema,
  TransactionsResponseSchema,
} from "./schemas.js";
import type { TransactionsService } from "./service.js";

export interface TransactionsRouteDeps {
  transactions: TransactionsService;
  profiles: ProfilesRepository;
}

export function transactionsRoutes(deps: TransactionsRouteDeps): FastifyPluginAsyncZod {
  async function walletOf(request: FastifyRequest): Promise<string> {
    const profile = await deps.profiles.findByDid(request.user!.userId);
    if (!profile) {
      throw new AppError(
        "wallet_not_linked",
        "Vincula tu wallet (POST /v1/me/wallet) para ver tus movimientos.",
        409,
      );
    }
    return profile.walletAddress;
  }

  return async (app) => {
    app.get(
      "/transactions",
      {
        schema: {
          tags: ["transactions"],
          summary: "Historial de movimientos del usuario",
          description:
            "Une las operaciones iniciadas en SEYF con lo observado on-chain, sin duplicar: " +
            "si una operación de bóveda ya está confirmada en la red, se reporta una sola vez.",
          querystring: ListTransactionsQuerySchema,
          response: { 200: TransactionsResponseSchema, 409: ErrorResponseSchema },
        },
      },
      async (request) =>
        deps.transactions.list({
          userId: request.user!.userId,
          walletAddress: await walletOf(request),
          limit: request.query.limit,
          ...(request.query.before ? { before: request.query.before } : {}),
        }),
    );

    app.get(
      "/transactions/pending",
      {
        schema: {
          tags: ["transactions"],
          summary: "Movimientos en curso",
          description:
            "Operaciones que aún esperan firma o confirmación de la red. A diferencia de un " +
            "registro optimista en el cliente, cada una tiene identificador y estado consultable.",
          response: { 200: PendingTransactionsResponseSchema, 409: ErrorResponseSchema },
        },
      },
      async (request) => ({
        transactions: await deps.transactions.listPending(request.user!.userId),
      }),
    );
  };
}
