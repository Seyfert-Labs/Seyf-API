import { createHmac, timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";

// Verificación de webhooks de Etherfuse: HMAC-SHA256 sobre el JSON
// canonicalizado (JCS, RFC 8785).
// @see https://docs.etherfuse.com/guides/verifying-webhooks

export function verifyWebhookSignature(
  payload: unknown,
  signatureHeader: string | null | undefined,
  secretBase64: string,
): boolean {
  if (!signatureHeader || !secretBase64) return false;

  const canonical = canonicalize(payload);
  if (canonical === undefined) return false;

  let key: Buffer;
  try {
    key = Buffer.from(secretBase64, "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const expected = `sha256=${createHmac("sha256", key).update(canonical).digest("hex")}`;
  // timingSafeEqual exige longitudes iguales; comparar antes evita la excepción
  // sin filtrar información por tiempo (la longitud del hash es pública).
  if (expected.length !== signatureHeader.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

export const KYC_STATUSES = [
  "not_started",
  "proposed",
  "approved",
  "approved_chain_deploying",
  "rejected",
] as const;

export type KycStatus = (typeof KYC_STATUSES)[number];

export function isKycStatus(value: string): value is KycStatus {
  return (KYC_STATUSES as readonly string[]).includes(value);
}

/** Etherfuse devuelve "compliant" tras submit programático: equivale a "proposed". */
export function normalizeKycStatus(value: string | null | undefined): KycStatus | null {
  if (!value) return null;
  if (isKycStatus(value)) return value;
  if (value === "compliant") return "proposed";
  return null;
}

export interface KycWebhookEvent {
  eventType: string | null;
  eventId: string | null;
  eventTimestamp: string | null;
  customerId: string | null;
  walletPublicKey: string | null;
  status: KycStatus | null;
  approvedAt: string | null;
  currentRejectionReason: string | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Etherfuse varía el envoltorio y el casing entre eventos; se aceptan las formas conocidas. */
export function extractKycEvent(payload: unknown): KycWebhookEvent {
  const root = asObject(payload) ?? {};
  const data = asObject(root.data) ?? asObject(root.payload) ?? root;
  return {
    eventType: pickString(root, ["event", "eventType", "type", "name"]),
    eventId: pickString(root, ["id", "eventId", "webhookId"]),
    eventTimestamp: pickString(root, ["createdAt", "timestamp", "occurredAt"]),
    customerId: pickString(data, ["customerId", "customer_id"]),
    walletPublicKey: pickString(data, [
      "walletPublicKey",
      "wallet_public_key",
      "pubkey",
      "publicKey",
    ]),
    status: normalizeKycStatus(pickString(data, ["status"])),
    approvedAt: pickString(data, ["approvedAt", "approved_at"]),
    currentRejectionReason: pickString(data, [
      "currentRejectionReason",
      "current_rejection_reason",
    ]),
  };
}

export function isKycEvent(event: KycWebhookEvent): boolean {
  return (
    event.eventType === "kyc_updated" ||
    Boolean(event.eventType && event.eventType.toLowerCase().includes("kyc"))
  );
}
