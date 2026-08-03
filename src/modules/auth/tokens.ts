import { jwtVerify, SignJWT } from "jose";
import type { Config } from "../../core/config.js";

const ISSUER = "seyf-api";
const AUDIENCE = "seyf-clients";

/** Scopes por defecto de un usuario final. Granularidad fina cuando un módulo la exija. */
export const DEFAULT_SCOPES = ["user"];

export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
  scopes: string[];
}

export class TokenService {
  private readonly key: Uint8Array;
  private readonly ttlSec: number;

  constructor(config: Pick<Config, "AUTH_JWT_SECRET" | "ACCESS_TOKEN_TTL_SEC">) {
    this.key = new TextEncoder().encode(config.AUTH_JWT_SECRET);
    this.ttlSec = config.ACCESS_TOKEN_TTL_SEC;
  }

  async issue(user: AuthenticatedUser): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({ sid: user.sessionId, scopes: user.scopes })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSec}s`)
      .sign(this.key);
    return { token, expiresIn: this.ttlSec };
  }

  /** Lanza si el token es inválido o expiró. */
  async verify(token: string): Promise<AuthenticatedUser> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      throw new Error("claims incompletos");
    }
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((s): s is string => typeof s === "string")
      : [];
    return { userId: payload.sub, sessionId: payload.sid, scopes };
  }
}
