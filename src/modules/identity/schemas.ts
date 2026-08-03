import { z } from "zod";
import { KYC_STATUSES } from "./webhook.js";

// Contrato del módulo de identidad.
//
// PII: el cuerpo de `POST /v1/identity/kyc` lleva datos personales (nombre,
// fecha de nacimiento, domicilio, identificaciones). No debe registrarse en
// logs ni almacenarse en la API: se reenvía a Etherfuse, que es el custodio.

export const KycStatusResponseSchema = z.object({
  status: z.enum(KYC_STATUSES),
  customerId: z.string().nullable().describe("Identificador del cliente en el proveedor"),
  approvedAt: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  canOperate: z
    .boolean()
    .describe("Si el usuario puede depositar/retirar con este estado de verificación"),
  updatedAt: z.string().nullable(),
});

export const SubmitIdentityRequestSchema = z.object({
  name: z.object({
    givenName: z.string().min(1).max(100),
    familyName: z.string().min(1).max(100),
    motherMaidenName: z.string().max(100).optional(),
  }),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato esperado AAAA-MM-DD")
    .describe("Fecha de nacimiento en formato ISO (AAAA-MM-DD)"),
  email: z.string().email().optional(),
  phoneNumber: z.string().max(30).optional(),
  occupation: z.string().max(100).optional(),
  address: z.object({
    street: z.string().min(1).max(200),
    city: z.string().min(1).max(100),
    region: z.string().min(1).max(100),
    postalCode: z.string().min(1).max(20),
    country: z.string().min(2).max(3).describe("Código de país ISO (p. ej. MX)"),
  }),
  idNumbers: z
    .array(
      z.object({
        type: z.string().min(1).max(50),
        idType: z.string().max(50).optional(),
        value: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(5),
});

/** ~1.4 MB de base64 ≈ 1 MB de imagen. Cota defensiva contra cargas abusivas. */
export const MAX_IMAGE_CHARS = 1_400_000;
export const MAX_IMAGES = 4;

export const UploadDocumentsRequestSchema = z.object({
  documentType: z.enum(["document", "selfie"]),
  images: z
    .array(
      z.object({
        label: z.string().min(1).max(50),
        image: z
          .string()
          .max(MAX_IMAGE_CHARS, "La imagen excede el tamaño permitido")
          .regex(/^data:image\/(jpeg|jpg|png|webp);base64,/, "Se espera un data URL de imagen"),
      }),
    )
    .min(1)
    .max(MAX_IMAGES),
});

export const WebhookResponseSchema = z.object({
  received: z.literal(true),
  applied: z.boolean(),
  reason: z.string(),
});
