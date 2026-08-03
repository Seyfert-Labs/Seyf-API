import { randomUUID } from "node:crypto";
import { AppError } from "../../core/errors.js";
import type { Logger } from "../vaults/service.js";
import type { EtherfuseClient } from "./etherfuse.js";
import type { IdentityRepository, WebhookReplayGuard } from "./repo.js";
import {
  extractKycEvent,
  isKycEvent,
  verifyWebhookSignature,
  type KycStatus,
} from "./webhook.js";

export interface KycView {
  status: KycStatus;
  customerId: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  canOperate: boolean;
  updatedAt: string | null;
}

/** Estados que habilitan operar. En testnet el sandbox de Etherfuse no pasa de "proposed". */
export function approvedStatuses(network: "testnet" | "mainnet"): ReadonlySet<KycStatus> {
  return network === "testnet"
    ? new Set<KycStatus>(["approved", "approved_chain_deploying", "proposed"])
    : new Set<KycStatus>(["approved", "approved_chain_deploying"]);
}

export interface IdentityServiceConfig {
  network: "testnet" | "mainnet";
  webhookSecret: string | undefined;
}

export class IdentityService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly etherfuse: EtherfuseClient,
    private readonly replayGuard: WebhookReplayGuard,
    private readonly config: IdentityServiceConfig,
    private readonly logger: Logger,
  ) {}

  private canOperate(status: KycStatus): boolean {
    return approvedStatuses(this.config.network).has(status);
  }

  private view(
    status: KycStatus,
    customerId: string | null,
    approvedAt: string | null = null,
    rejectionReason: string | null = null,
    updatedAt: string | null = null,
  ): KycView {
    return {
      status,
      customerId,
      approvedAt,
      rejectionReason,
      canOperate: this.canOperate(status),
      updatedAt,
    };
  }

  /**
   * Estado del KYC. Refresca desde Etherfuse en best-effort: si el proveedor no
   * responde se devuelve el último estado conocido en lugar de fallar — pero
   * nunca se inventa una aprobación.
   */
  async getStatus(walletAddress: string): Promise<KycView> {
    const session = await this.repo.findSession(walletAddress);
    if (!session) return this.view("not_started", null);

    try {
      const live = await this.etherfuse.getKycStatus(session.customerId);
      if (live.found && live.status) {
        await this.repo.upsertSnapshot({
          customerId: session.customerId,
          walletAddress,
          status: live.status,
          approvedAt: live.approvedAt,
          rejectionReason: live.rejectionReason,
        });
      }
    } catch (err) {
      this.logger.warn(
        { walletAddress, detail: err instanceof Error ? err.message : String(err) },
        "no se pudo refrescar el KYC; se usa el último estado conocido",
      );
    }

    const stored = await this.repo.findSnapshot(session.customerId, walletAddress);
    if (!stored) return this.view("not_started", session.customerId);
    return this.view(
      stored.status,
      stored.customerId,
      stored.approvedAt,
      stored.rejectionReason,
      stored.updatedAt,
    );
  }

  /** Devuelve la sesión de onboarding, creándola en el primer envío. */
  private async ensureSession(walletAddress: string): Promise<string> {
    const existing = await this.repo.findSession(walletAddress);
    if (existing) return existing.customerId;

    // Los identificadores los genera el cliente de la API (mismo criterio que
    // la WebApp). bankAccountId queda reservado para el módulo de banking.
    const session = { customerId: randomUUID(), bankAccountId: randomUUID() };
    await this.repo.saveSession(walletAddress, session);
    return session.customerId;
  }

  async submitIdentity(
    walletAddress: string,
    identity: Record<string, unknown>,
  ): Promise<KycView> {
    const customerId = await this.ensureSession(walletAddress);
    const result = await this.etherfuse.submitIdentity({
      customerId,
      walletAddress,
      // Etherfuse espera el identificador del cliente dentro del bloque identity.
      identity: { ...identity, id: customerId },
    });

    if (result.status) {
      await this.repo.upsertSnapshot({ customerId, walletAddress, status: result.status });
    }
    return this.getStatusFromStore(customerId, walletAddress, result.status);
  }

  async uploadDocuments(
    walletAddress: string,
    documentType: "document" | "selfie",
    images: Array<{ label: string; image: string }>,
  ): Promise<KycView> {
    const session = await this.repo.findSession(walletAddress);
    if (!session) {
      throw new AppError(
        "kyc_not_started",
        "Envía primero tus datos de identidad antes de subir documentos.",
        409,
      );
    }
    const result = await this.etherfuse.uploadDocuments({
      customerId: session.customerId,
      walletAddress,
      documentType,
      images,
    });
    if (result.status) {
      await this.repo.upsertSnapshot({
        customerId: session.customerId,
        walletAddress,
        status: result.status,
      });
    }
    return this.getStatusFromStore(session.customerId, walletAddress, result.status);
  }

  private async getStatusFromStore(
    customerId: string,
    walletAddress: string,
    fallback: KycStatus | null,
  ): Promise<KycView> {
    const stored = await this.repo.findSnapshot(customerId, walletAddress);
    if (stored) {
      return this.view(
        stored.status,
        customerId,
        stored.approvedAt,
        stored.rejectionReason,
        stored.updatedAt,
      );
    }
    return this.view(fallback ?? "proposed", customerId);
  }

  /**
   * Procesa un webhook de Etherfuse. Lanza si la firma no valida: un payload no
   * autenticado nunca puede modificar el estado de cumplimiento.
   */
  async handleWebhook(
    payload: unknown,
    signatureHeader: string | null | undefined,
  ): Promise<{ applied: boolean; reason: string }> {
    if (!this.config.webhookSecret) {
      // Fail-closed: sin secreto no se puede autenticar el origen.
      throw new AppError(
        "webhook_not_configured",
        "El webhook no está configurado (ETHERFUSE_WEBHOOK_SECRET).",
        503,
      );
    }
    if (!verifyWebhookSignature(payload, signatureHeader, this.config.webhookSecret)) {
      throw new AppError("invalid_signature", "Firma de webhook inválida.", 401);
    }

    const event = extractKycEvent(payload);
    if (!isKycEvent(event)) return { applied: false, reason: "evento no relacionado con KYC" };

    // Anti-replay: un payload firmado capturado no puede reprocesarse.
    if (event.eventId && !(await this.replayGuard.claim(event.eventId))) {
      this.logger.warn({ eventId: event.eventId }, "webhook duplicado descartado (replay)");
      return { applied: false, reason: "evento ya procesado" };
    }

    if (!event.customerId || !event.walletPublicKey || !event.status) {
      return { applied: false, reason: "evento incompleto" };
    }

    const applied = await this.repo.upsertSnapshot({
      customerId: event.customerId,
      walletAddress: event.walletPublicKey,
      status: event.status,
      approvedAt: event.approvedAt,
      rejectionReason: event.currentRejectionReason,
      eventId: event.eventId,
      eventTimestamp: event.eventTimestamp,
    });
    return { applied, reason: applied ? "estado actualizado" : "evento obsoleto o duplicado" };
  }

  /** Gate de cumplimiento usado por las mutaciones de bóveda. */
  async assertCanOperate(walletAddress: string): Promise<void> {
    const view = await this.getStatus(walletAddress);
    if (view.canOperate) return;
    throw new AppError(
      "kyc_required",
      view.status === "not_started"
        ? "Completa tu verificación de identidad para poder operar."
        : `Tu verificación de identidad está en estado "${view.status}". Complétala para poder operar.`,
      403,
    );
  }
}
