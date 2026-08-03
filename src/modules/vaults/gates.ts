import type { IdentityService } from "../identity/service.js";

// Control de cumplimiento antes de mover dinero. Fail-closed por diseño: si no
// se puede comprobar que la verificación está aprobada, la operación NO procede.

export interface KycGate {
  /** Lanza AppError 403 si el usuario no puede operar. */
  assertApproved(walletAddress: string): Promise<void>;
}

/** Delega en el módulo de identidad, que es el dueño del estado de KYC. */
export class IdentityKycGate implements KycGate {
  constructor(private readonly identity: IdentityService) {}

  async assertApproved(walletAddress: string): Promise<void> {
    await this.identity.assertCanOperate(walletAddress);
  }
}

/**
 * Gate para desarrollo sin Supabase. Permite operar y deja rastro en el log:
 * nunca debe alcanzar producción (loadConfig exige Supabase ahí).
 */
export class PermissiveKycGate implements KycGate {
  constructor(private readonly logger: { warn(obj: object, msg: string): void }) {}

  async assertApproved(walletAddress: string): Promise<void> {
    this.logger.warn(
      { walletAddress },
      "KYC no verificado: gate permisivo de desarrollo (sin Supabase configurado)",
    );
  }
}
