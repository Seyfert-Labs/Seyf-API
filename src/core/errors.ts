import { z } from "zod";
import type { FastifyError, FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";

// Forma única de error para todos los endpoints de la API.
// Los clientes (web y móvil) solo necesitan entender este shape.
// requestId permite correlacionar un reporte de soporte con los logs.
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function errorBody(code: string, message: string, requestId?: string): ErrorResponse {
  return { error: { code, message, ...(requestId ? { requestId } : {}) } };
}

/** Error de negocio: se lanza desde cualquier handler y sale con su código y status. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }

  /** Adjunta la causa original para el log, sin exponerla al cliente. */
  withCause(cause: unknown): this {
    this.cause = cause;
    return this;
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(errorBody(error.code, error.message, request.id));
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation
        .map((v) => v.message)
        .filter(Boolean)
        .join("; ");
      return reply
        .code(400)
        .send(errorBody("validation_error", `Solicitud inválida: ${issues}`, request.id));
    }

    if (isResponseSerializationError(error)) {
      request.log.error(error, "la respuesta no cumple su propio schema");
      return reply.code(500).send(errorBody("internal_error", "Error interno", request.id));
    }

    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;

    if (statusCode === 429) {
      return reply
        .code(429)
        .send(
          errorBody("rate_limited", "Demasiadas solicitudes. Intenta de nuevo más tarde.", request.id),
        );
    }

    if (statusCode >= 500) {
      // Nunca filtrar detalles internos al cliente.
      request.log.error(error);
      return reply
        .code(statusCode)
        .send(errorBody("internal_error", "Error interno del servidor", request.id));
    }

    // 4xx generados por Fastify/plugins (p. ej. JSON malformado).
    return reply.code(statusCode).send(errorBody("bad_request", error.message, request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .send(errorBody("not_found", `${request.method} ${request.url} no existe`, request.id));
  });
}
