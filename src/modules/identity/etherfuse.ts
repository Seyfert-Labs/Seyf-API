import { AppError } from "../../core/errors.js";
import { normalizeKycStatus, type KycStatus } from "./webhook.js";

// Puerto hacia Etherfuse. La API key vive solo aquí (nunca en un cliente).

export interface KycStatusResult {
  found: boolean;
  status: KycStatus | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  documentsCount: number;
  selfiesCount: number;
}

export interface SubmitIdentityParams {
  customerId: string;
  walletAddress: string;
  identity: Record<string, unknown>;
}

export interface UploadDocumentsParams {
  customerId: string;
  walletAddress: string;
  documentType: "document" | "selfie";
  images: Array<{ label: string; image: string }>;
}

export interface EtherfuseClient {
  getKycStatus(customerId: string): Promise<KycStatusResult>;
  submitIdentity(params: SubmitIdentityParams): Promise<{ status: KycStatus | null; message: string | null }>;
  uploadDocuments(params: UploadDocumentsParams): Promise<{ status: KycStatus | null; message: string | null }>;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpEtherfuseClient implements EtherfuseClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /** Reintenta solo los status transitorios; las escrituras no se reintentan salvo que se pida. */
  private async request(
    path: string,
    init: RequestInit & { retryable?: boolean } = {},
  ): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
    const method = (init.method ?? "GET").toUpperCase();
    const canRetry = init.retryable ?? method === "GET";
    const attempts = canRetry ? MAX_RETRIES + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(200 * 2 ** (attempt - 1));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const headers = new Headers(init.headers);
        headers.set("Authorization", this.apiKey);
        headers.set("Accept", "application/json");

        const res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (RETRYABLE.has(res.status) && attempt < attempts - 1) continue;

        const text = await res.text();
        let json: Record<string, unknown> | null = null;
        try {
          json = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : null;
        } catch {
          json = null;
        }
        return { status: res.status, json, text };
      } catch (cause) {
        clearTimeout(timer);
        if (attempt >= attempts - 1) {
          throw new AppError(
            "identity_provider_unavailable",
            "No pudimos contactar al proveedor de verificación. Intenta de nuevo.",
            502,
          ).withCause(cause);
        }
      }
    }
    throw new AppError(
      "identity_provider_unavailable",
      "No pudimos contactar al proveedor de verificación. Intenta de nuevo.",
      502,
    );
  }

  private assertOk(status: number, text: string, context: string): void {
    if (status >= 200 && status < 300) return;
    throw new AppError(
      "identity_provider_error",
      `El proveedor de verificación rechazó la solicitud (${context}).`,
      status === 400 ? 400 : 502,
    ).withCause(text.slice(0, 400));
  }

  async getKycStatus(customerId: string): Promise<KycStatusResult> {
    const { status, json, text } = await this.request(
      `/ramp/customer/${encodeURIComponent(customerId)}/kyc`,
    );
    if (status === 404) {
      return {
        found: false,
        status: null,
        approvedAt: null,
        rejectionReason: null,
        documentsCount: 0,
        selfiesCount: 0,
      };
    }
    this.assertOk(status, text, "consulta de KYC");

    return {
      found: true,
      status: normalizeKycStatus(typeof json?.status === "string" ? json.status : null),
      approvedAt: json?.approvedAt == null ? null : String(json.approvedAt),
      rejectionReason:
        json?.currentRejectionReason == null ? null : String(json.currentRejectionReason),
      documentsCount: Array.isArray(json?.documents) ? json.documents.length : 0,
      selfiesCount: Array.isArray(json?.selfies) ? json.selfies.length : 0,
    };
  }

  async submitIdentity(params: SubmitIdentityParams) {
    const { status, json, text } = await this.request(
      `/ramp/customer/${encodeURIComponent(params.customerId)}/kyc`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pubkey: params.walletAddress,
          accountType: "personal",
          identity: { ...params.identity, accountType: "personal" },
        }),
      },
    );
    this.assertOk(status, text, "envío de identidad");
    return {
      status: normalizeKycStatus(typeof json?.status === "string" ? json.status : null),
      message: typeof json?.message === "string" ? json.message : null,
    };
  }

  async uploadDocuments(params: UploadDocumentsParams) {
    const { status, json, text } = await this.request(
      `/ramp/customer/${encodeURIComponent(params.customerId)}/kyc/documents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pubkey: params.walletAddress,
          documentType: params.documentType,
          images: params.images,
        }),
      },
    );
    this.assertOk(status, text, "carga de documentos");
    return {
      status: normalizeKycStatus(typeof json?.status === "string" ? json.status : null),
      message: typeof json?.message === "string" ? json.message : null,
    };
  }
}

/** Permite arrancar sin credenciales de Etherfuse sin fingir verificaciones. */
export class UnconfiguredEtherfuseClient implements EtherfuseClient {
  private fail(): never {
    throw new AppError(
      "identity_not_configured",
      "El proveedor de verificación no está configurado (ETHERFUSE_API_KEY).",
      503,
    );
  }
  async getKycStatus(): Promise<KycStatusResult> {
    this.fail();
  }
  async submitIdentity(): Promise<never> {
    this.fail();
  }
  async uploadDocuments(): Promise<never> {
    this.fail();
  }
}
