import { randomUUID } from "node:crypto";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/core/config.js";

// Arranque real de la API para pruebas end-to-end.
//
// A diferencia de los tests de integración (que usan app.inject y dobles), aquí
// el servidor escucha en un puerto real, se le habla por HTTP con fetch y NO se
// inyecta ninguna dependencia: los clientes de DeFindex, Bitso, Horizon y
// Etherfuse son los de producción.
//
// La única pieza sustituida es el emisor de tokens de Privy, que es un servicio
// externo cuyo login no se puede automatizar: se genera un par ES256 propio y
// se configura como llave de verificación, de modo que el verificador real de
// la API (PrivyIdentityVerifier) se ejecuta sin cambios sobre tokens auténticos
// en forma y firma.

export const WEBHOOK_SECRET = Buffer.from(`e2e-${randomUUID()}`).toString("base64");

export interface E2EContext {
  baseUrl: string;
  /** Emite un token con la forma de uno de Privy, firmado con la llave de la prueba. */
  identityToken(subject?: string): Promise<string>;
  close(): Promise<void>;
}

export interface E2EOptions {
  env?: Record<string, string>;
}

export async function startApi(options: E2EOptions = {}): Promise<E2EContext> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const appId = "seyf-e2e";

  const config = loadConfig({
    NODE_ENV: "test",
    PRIVY_APP_ID: appId,
    PRIVY_VERIFICATION_KEY: await exportSPKI(publicKey),
    ETHERFUSE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    // Los límites de tasa por defecto estorban a una suite que hace ráfagas.
    RATE_LIMIT_MAX: "10000",
    ...options.env,
  });

  const app: FastifyInstance = await buildApp(config);
  await app.listen({ host: "127.0.0.1", port: 0 });

  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No se pudo determinar el puerto del servidor");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    identityToken: (subject = `did:privy:e2e-${randomUUID()}`) =>
      signIdentityToken(privateKey, appId, subject),
    close: () => app.close(),
  };
}

function signIdentityToken(key: CryptoKey, appId: string, subject: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(subject)
    .setIssuer("privy.io")
    .setAudience(appId)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/** Cliente HTTP mínimo contra la API levantada. */
export class ApiClient {
  private accessToken: string | null = null;

  constructor(private readonly baseUrl: string) {}

  setToken(token: string | null): void {
    this.accessToken = token;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.auth !== false && this.accessToken) {
      headers.authorization = `Bearer ${this.accessToken}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, headers: res.headers, body: body as T };
  }

  get<T = unknown>(path: string, headers?: Record<string, string>) {
    return this.request<T>("GET", path, headers ? { headers } : {});
  }

  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>("POST", path, {
      ...(body !== undefined ? { body } : {}),
      ...(headers ? { headers } : {}),
    });
  }

  /** Cabecera de idempotencia con una clave nueva. */
  static idempotencyKey(): Record<string, string> {
    return { "idempotency-key": randomUUID() };
  }
}

/** Inicia sesión y deja el cliente autenticado. */
export async function login(
  client: ApiClient,
  ctx: E2EContext,
  subject?: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const identityToken = await ctx.identityToken(subject);
  const res = await client.post<{ accessToken: string; refreshToken: string }>(
    "/v1/auth/session",
    { identityToken },
  );
  if (res.status !== 201) {
    throw new Error(`Login E2E falló (${res.status}): ${JSON.stringify(res.body)}`);
  }
  client.setToken(res.body.accessToken);
  return res.body;
}

// ─── Cuentas reales de Stellar testnet ──────────────────────────────────────

const FRIENDBOT = "https://friendbot.stellar.org";

/** Crea y fondea una cuenta real en testnet. Devuelve null si Friendbot no responde. */
export async function fundTestnetAccount(publicKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(publicKey)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Condiciones para saltar pruebas que dependen de credenciales ausentes. */
export const requires = {
  defindexKey: !process.env.DEFINDEX_API_KEY,
  etherfuseKey: !process.env.ETHERFUSE_API_KEY,
  supabase: !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY,
  seyfWeb: !process.env.SEYF_WEB_BASE_URL,
};
