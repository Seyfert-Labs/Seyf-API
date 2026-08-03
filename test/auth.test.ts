import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";
import { AppError } from "../src/core/errors.js";
import { PrivyIdentityVerifier, type IdentityVerifier } from "../src/modules/auth/identity.js";
import { requireScope } from "../src/modules/auth/plugin.js";

class FakeVerifier implements IdentityVerifier {
  async verify(token: string) {
    if (token === "privy-token-valido") return { subject: "did:privy:user-1" };
    throw new Error("token inválido");
  }
}

const apps: FastifyInstance[] = [];

async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    identityVerifier: new FakeVerifier(),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function login(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/session",
    payload: { identityToken: "privy-token-valido" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { accessToken: string; expiresIn: number; refreshToken: string };
}

describe("sesión", () => {
  it("canjea un token de identidad válido por tokens propios", async () => {
    const app = await makeApp();
    const tokens = await login(app);
    expect(tokens.accessToken.split(".")).toHaveLength(3);
    expect(tokens.expiresIn).toBeLessThanOrEqual(900);
    expect(tokens.refreshToken.length).toBeGreaterThan(20);
  });

  it("rechaza un token de identidad inválido", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { identityToken: "token-falso-largo" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_identity_token");
  });
});

describe("guard de /v1", () => {
  it("sin token responde 401; con token válido la ruta responde", async () => {
    const app = await makeApp();

    const anon = await app.inject({ method: "GET", url: "/v1/vaults" });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe("unauthorized");

    const { accessToken } = await login(app);
    const authed = await app.inject({
      method: "GET",
      url: "/v1/vaults",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(authed.statusCode).toBe(200);
  });

  it("rechaza tokens malformados o firmados con otra llave", async () => {
    const app = await makeApp();
    for (const bad of ["Bearer basura", "Bearer a.b.c"]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/vaults",
        headers: { authorization: bad },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("el healthz sigue siendo público", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("refresh con rotación", () => {
  it("rota el token y detecta el reuso revocando la sesión completa", async () => {
    const app = await makeApp();
    const first = await login(app);

    const rotated = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json() as { refreshToken: string };
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Reuso del token ya rotado → detección + revocación de la sesión.
    const reuse = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe("refresh_token_reused");

    // El token "bueno" de la rotación también quedó revocado.
    const collateral = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: second.refreshToken },
    });
    expect(collateral.statusCode).toBe(401);
    expect(collateral.json().error.code).toBe("invalid_refresh_token");
  });

  it("logout revoca la sesión", async () => {
    const app = await makeApp();
    const tokens = await login(app);

    const out = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(out.statusCode).toBe(204);

    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe("PrivyIdentityVerifier", () => {
  it("verifica un token ES256 con issuer y audience correctos", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const verifier = new PrivyIdentityVerifier("app-seyf", await exportSPKI(publicKey));

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("did:privy:abc123")
      .setIssuer("privy.io")
      .setAudience("app-seyf")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifier.verify(token)).resolves.toEqual({ subject: "did:privy:abc123" });
  });

  it("rechaza un token para otra app (audience distinto)", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const verifier = new PrivyIdentityVerifier("app-seyf", await exportSPKI(publicKey));

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("did:privy:abc123")
      .setIssuer("privy.io")
      .setAudience("otra-app")
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

describe("requireScope", () => {
  it("permite con el scope presente y rechaza sin él", async () => {
    const check = requireScope("admin");
    const withScope = {
      user: { userId: "u1", sessionId: "s1", scopes: ["user", "admin"] },
    } as never;
    const withoutScope = { user: { userId: "u1", sessionId: "s1", scopes: ["user"] } } as never;

    await expect(check(withScope)).resolves.toBeUndefined();
    await expect(check(withoutScope)).rejects.toThrowError(AppError);
  });
});
