import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ErrorResponseSchema, errorBody } from "../../core/errors.js";
import { ListVaultsResponseSchema } from "./schemas.js";

// TODO(port): implementar portando la lógica de SEYF-P (src/lib/defindex,
// src/app/api/defindex/*). Mientras tanto responde 501 para que el contrato
// exista y los clientes puedan generarse, sin fingir datos.
export const vaultsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/vaults",
    {
      schema: {
        tags: ["vaults"],
        summary: "Lista las bóvedas disponibles con APY y estado",
        response: {
          200: ListVaultsResponseSchema,
          501: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      return reply
        .code(501)
        .send(errorBody("not_implemented", "Pendiente de portar desde SEYF-P"));
    },
  );
};
