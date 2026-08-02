import { z } from "zod";

// Forma única de error para todos los endpoints de la API.
// Los clientes (web y móvil) solo necesitan entender este shape.
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}
