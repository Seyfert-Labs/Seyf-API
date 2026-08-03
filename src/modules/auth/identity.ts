import { importSPKI, jwtVerify } from "jose";
import { AppError } from "../../core/errors.js";

/**
 * Verificación del proveedor de identidad (Privy hoy). La SEYF API nunca
 * confía en el token de terceros directamente: lo verifica una vez y emite
 * sus propios JWT (ver routes.ts).
 */
export interface VerifiedIdentity {
  /** Identificador estable del usuario en el proveedor (p. ej. did:privy:...). */
  subject: string;
}

export interface IdentityVerifier {
  /** Devuelve la identidad verificada o lanza si el token no es válido. */
  verify(identityToken: string): Promise<VerifiedIdentity>;
}

/** Verifica access tokens de Privy (ES256, iss privy.io, aud = app id). */
export class PrivyIdentityVerifier implements IdentityVerifier {
  constructor(
    private readonly appId: string,
    private readonly verificationKeyPem: string,
  ) {}

  async verify(identityToken: string): Promise<VerifiedIdentity> {
    // La verification key del dashboard de Privy suele pegarse con \n escapados.
    const pem = this.verificationKeyPem.replace(/\\n/g, "\n");
    const key = await importSPKI(pem, "ES256");
    const { payload } = await jwtVerify(identityToken, key, {
      issuer: "privy.io",
      audience: this.appId,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("token de Privy sin subject");
    }
    return { subject: payload.sub };
  }
}

/** Permite arrancar la API sin credenciales de Privy (dev) sin fingir auth. */
export class UnconfiguredIdentityVerifier implements IdentityVerifier {
  async verify(): Promise<VerifiedIdentity> {
    throw new AppError(
      "auth_not_configured",
      "El proveedor de identidad no está configurado (PRIVY_APP_ID / PRIVY_VERIFICATION_KEY).",
      503,
    );
  }
}
