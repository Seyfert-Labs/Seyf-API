import { createHash, randomBytes, randomUUID } from "node:crypto";

// Refresh tokens opacos con rotación: cada refresh invalida el anterior.
// Si un token ya rotado vuelve a usarse (robo o replay), se revoca la sesión
// completa — el atacante y el usuario legítimo pierden acceso y se fuerza
// re-login. Los tokens se guardan hasheados: una fuga del store no sirve.

export type RotateResult =
  | "invalid"
  | "reused"
  | { token: string; sessionId: string; userId: string };

export interface RefreshTokenStore {
  issue(userId: string): Promise<{ token: string; sessionId: string }>;
  rotate(token: string): Promise<RotateResult>;
  revokeSession(sessionId: string): Promise<void>;
}

interface RefreshRecord {
  sessionId: string;
  userId: string;
  expiresAt: number;
  used: boolean;
}

/** Store en memoria: sustituir por Postgres (tarea #4) para sobrevivir reinicios y escalar. */
export class MemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly tokens = new Map<string, RefreshRecord>();
  private readonly revokedSessions = new Set<string>();

  constructor(private readonly ttlMs: number = 30 * 24 * 60 * 60 * 1000) {}

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private mint(sessionId: string, userId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(this.hash(token), {
      sessionId,
      userId,
      expiresAt: Date.now() + this.ttlMs,
      used: false,
    });
    return token;
  }

  async issue(userId: string): Promise<{ token: string; sessionId: string }> {
    const sessionId = randomUUID();
    return { token: this.mint(sessionId, userId), sessionId };
  }

  async rotate(token: string): Promise<RotateResult> {
    const record = this.tokens.get(this.hash(token));
    if (!record || record.expiresAt < Date.now() || this.revokedSessions.has(record.sessionId)) {
      return "invalid";
    }
    if (record.used) {
      await this.revokeSession(record.sessionId);
      return "reused";
    }
    record.used = true;
    return {
      token: this.mint(record.sessionId, record.userId),
      sessionId: record.sessionId,
      userId: record.userId,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.revokedSessions.add(sessionId);
  }
}
