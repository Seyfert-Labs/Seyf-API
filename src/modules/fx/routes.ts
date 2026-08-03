import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { ErrorResponseSchema } from "../../core/errors.js";
import { PricesQuerySchema, PricesResponseSchema } from "./schemas.js";
import { parseAssetsParam, type FxService } from "./service.js";

export interface FxRouteDeps {
  fx: FxService;
}

export function fxRoutes(deps: FxRouteDeps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/fx/prices",
      {
        schema: {
          tags: ["fx"],
          summary: "Precio en MXN de los activos soportados",
          description:
            "Agregado en el servidor con caché: el cliente no consulta proveedores de precios.",
          querystring: PricesQuerySchema,
          response: { 200: PricesResponseSchema, 400: ErrorResponseSchema },
        },
      },
      async (request) => ({
        prices: await deps.fx.getPrices(parseAssetsParam(request.query.assets)),
      }),
    );
  };
}
