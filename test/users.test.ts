import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";
import type { IdentityVerifier } from "../src/modules/auth/identity.js";

const WALLET_1 = `G${"A".repeat(55)}`;
const WALLET_2 = `G${"B".repeat(55)}`;

class FakeVerifier implements IdentityVerifier {
  async verify(token: string) {
    if (token === "privy-user-1") return { subject: "did:privy:user-1" };
    if (token === "privy-user-2") return { subject: "did:privy:user-2" };
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

async function login(app: FastifyInstance, identityToken: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { identityToken } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { accessToken: string }).accessToken;
}

describe("perfil y vinculación de wallet", () => {
  it("GET /v1/me exige auth y devuelve wallet null antes de vincular", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);

    const token = await login(app, "privy-user-1");
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId: "did:privy:user-1", walletAddress: null });
  });

  it("vincula una wallet válida y la refleja en /v1/me; re-vincular la misma es idempotente", async () => {
    const app = await makeApp();
    const token = await login(app, "privy-user-1");
    const auth = { authorization: `Bearer ${token}` };

    const link = await app.inject({
      method: "POST",
      url: "/v1/me/wallet",
      headers: auth,
      payload: { publicKey: WALLET_1 },
    });
    expect(link.statusCode).toBe(200);
    expect(link.json().walletAddress).toBe(WALLET_1);

    const again = await app.inject({
      method: "POST",
      url: "/v1/me/wallet",
      headers: auth,
      payload: { publicKey: WALLET_1 },
    });
    expect(again.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth });
    expect(me.json().walletAddress).toBe(WALLET_1);
  });

  it("rechaza una public key con formato inválido", async () => {
    const app = await makeApp();
    const token = await login(app, "privy-user-1");
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/wallet",
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: "no-es-una-llave" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("409 si la cuenta ya tiene otra wallet vinculada", async () => {
    const app = await makeApp();
    const token = await login(app, "privy-user-1");
    const auth = { authorization: `Bearer ${token}` };

    await app.inject({ method: "POST", url: "/v1/me/wallet", headers: auth, payload: { publicKey: WALLET_1 } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/wallet",
      headers: auth,
      payload: { publicKey: WALLET_2 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("wallet_already_linked");
  });

  it("409 si la wallet pertenece a otra cuenta", async () => {
    const app = await makeApp();
    const token1 = await login(app, "privy-user-1");
    await app.inject({
      method: "POST",
      url: "/v1/me/wallet",
      headers: { authorization: `Bearer ${token1}` },
      payload: { publicKey: WALLET_1 },
    });

    const token2 = await login(app, "privy-user-2");
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/wallet",
      headers: { authorization: `Bearer ${token2}` },
      payload: { publicKey: WALLET_1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("wallet_taken");
  });
});
