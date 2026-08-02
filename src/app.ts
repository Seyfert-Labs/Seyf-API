import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "./core/config.js";
import { vaultsRoutes } from "./modules/vaults/routes.js";

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.NODE_ENV === "test"
        ? false
        : config.NODE_ENV === "development"
          ? { transport: { target: "pino-pretty" } }
          : true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "SEYF API",
        description:
          "Backend de producto para los clientes web y móvil de SEYF. " +
          "Contrato generado desde los schemas Zod — no editar a mano.",
        version: "0.1.0",
      },
      tags: [{ name: "vaults", description: "Bóvedas de rendimiento (DeFindex)" }],
    },
    transform: jsonSchemaTransform,
  });

  if (config.NODE_ENV !== "production") {
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  app.get(
    "/healthz",
    {
      schema: {
        summary: "Liveness check",
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  await app.register(vaultsRoutes, { prefix: "/v1" });

  return app;
}
