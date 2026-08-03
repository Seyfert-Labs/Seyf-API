import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";
import type { IdentityVerifier } from "../src/modules/auth/identity.js";
import type { DefindexClient, VaultBalance, VaultInfo } from "../src/modules/vaults/defindex.js";

const WALLET_1 = `G${"A".repeat(55)}`;
const WALLET_2 = `G${"B".repeat(55)}`;

class FakeVerifier implements IdentityVerifier {
  async verify(token: string) {
    if (token === "privy-user-1") return { subject: "did:privy:user-1" };
    if (token === "privy-user-2") return { subject: "did:privy:user-2" };
    throw new Error("token inválido");
  }
}

/** Error con statusCode, como los que emite el SDK de DeFindex. */
function sdkError(message: string, statusCode?: number): Error {
  return Object.assign(new Error(message), statusCode ? { statusCode } : {});
}

/** Dirección de la bóveda XLM en el catálogo por defecto. */
const VAULT_XLM = "CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6";

// Las respuestas se declaran como thunks: devolver un valor o lanzar según el
// caso bajo prueba.
interface FakeBehavior {
  info?: () => VaultInfo;
  balance?: Record<string, () => VaultBalance>;
}

class FakeDefindex implements DefindexClient {
  constructor(private readonly behavior: FakeBehavior = {}) {}

  async getVaultInfo(): Promise<VaultInfo> {
    return this.behavior.info?.() ?? { name: "Vault", symbol: "DFXV", apy: 7.25 };
  }

  async getVaultBalance(vaultAddress: string): Promise<VaultBalance> {
    return this.behavior.balance?.[vaultAddress]?.() ?? { dfTokens: 0n, underlyingRaw: 0n };
  }

  // Las mutaciones se cubren en vault-mutations.test.ts; aquí no deben invocarse.
  async buildDeposit(): Promise<string> {
    throw new Error("no esperado en tests de lectura");
  }
  async buildWithdraw(): Promise<string> {
    throw new Error("no esperado en tests de lectura");
  }
  async submitSigned(): Promise<never> {
    throw new Error("no esperado en tests de lectura");
  }
}

const apps: FastifyInstance[] = [];

async function makeApp(defindexClient: DefindexClient = new FakeDefindex()) {
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    identityVerifier: new FakeVerifier(),
    defindexClient,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function authHeaders(app: FastifyInstance, identityToken = "privy-user-1") {
  const res = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { identityToken } });
  // Falla ruidosamente aquí: un login roto haría que todos los tests fallen
  // con 401 y el motivo real quedaría oculto.
  expect(res.statusCode).toBe(201);
  const { accessToken } = res.json() as { accessToken: string };
  return { authorization: `Bearer ${accessToken}` };
}

async function withWallet(app: FastifyInstance, identityToken = "privy-user-1", wallet = WALLET_1) {
  const headers = await authHeaders(app, identityToken);
  await app.inject({ method: "POST", url: "/v1/me/wallet", headers, payload: { publicKey: wallet } });
  return headers;
}

describe("GET /v1/vaults", () => {
  it("exige autenticación", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/v1/vaults" })).statusCode).toBe(401);
  });

  it("lista el catálogo con el APY en vivo de DeFindex", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/vaults",
      headers: await authHeaders(app),
    });

    expect(res.statusCode).toBe(200);
    const { vaults } = res.json() as { vaults: Array<Record<string, unknown>> };
    expect(vaults.map((v) => v.id)).toEqual(["xlm", "cetes", "usdc"]);
    expect(vaults[0]).toMatchObject({ apy: 7.25, apySource: "live", assetSymbol: "XLM", decimals: 7 });
  });

  it("cae al APY de referencia del catálogo si DeFindex falla, sin romper la lista", async () => {
    const app = await makeApp(
      new FakeDefindex({
        info: () => {
          throw sdkError("fetch failed");
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: "/v1/vaults",
      headers: await authHeaders(app),
    });

    expect(res.statusCode).toBe(200);
    const { vaults } = res.json() as { vaults: Array<Record<string, unknown>> };
    expect(vaults).toHaveLength(3);
    for (const vault of vaults) expect(vault.apySource).toBe("reference");
    expect(vaults.find((v) => v.id === "cetes")?.apy).toBe(10.5);
  });
});

describe("GET /v1/vaults/:id", () => {
  it("devuelve el detalle de una bóveda existente", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/vaults/cetes",
      headers: await authHeaders(app),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "cetes", planId: "conservador", assetSymbol: "CETES" });
  });

  it("404 con código claro si la bóveda no existe", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/vaults/inexistente",
      headers: await authHeaders(app),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("vault_not_found");
  });
});

describe("GET /v1/positions", () => {
  it("409 si el usuario no ha vinculado wallet", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/positions",
      headers: await authHeaders(app),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("wallet_not_linked");
  });

  it("devuelve saldos exactos como string decimal", async () => {
    const app = await makeApp(
      new FakeDefindex({
        balance: { [VAULT_XLM]: () => ({ dfTokens: 5_000_000n, underlyingRaw: 12_345_678n }) },
      }),
    );
    const headers = await withWallet(app);

    const res = await app.inject({ method: "GET", url: "/v1/positions", headers });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { walletAddress: string; positions: Array<Record<string, unknown>> };
    expect(body.walletAddress).toBe(WALLET_1);
    const xlm = body.positions.find((p) => p.vaultId === "xlm");
    expect(xlm).toMatchObject({
      balance: "1.2345678",
      balanceRaw: "12345678",
      dfTokens: "5000000",
      status: "ok",
    });
  });

  it("un fallo transitorio marca 'unavailable' en vez de afirmar saldo cero", async () => {
    const app = await makeApp(
      new FakeDefindex({
        balance: {
          [VAULT_XLM]: () => {
            throw sdkError("rate limit exceeded", 429);
          },
        },
      }),
    );
    const headers = await withWallet(app);

    const { positions } = (await app.inject({ method: "GET", url: "/v1/positions", headers })).json() as {
      positions: Array<Record<string, unknown>>;
    };

    const xlm = positions.find((p) => p.vaultId === "xlm");
    expect(xlm).toMatchObject({ status: "unavailable", balance: null, balanceRaw: null });

    // Las demás bóvedas sí responden: un fallo parcial no contamina el resto.
    const cetes = positions.find((p) => p.vaultId === "cetes");
    expect(cetes).toMatchObject({ status: "ok", balance: "0" });
  });

  it("una cuenta sin posición reporta saldo 0 real (status ok)", async () => {
    const app = await makeApp(
      new FakeDefindex({
        balance: {
          [VAULT_XLM]: () => {
            throw sdkError("no position found", 404);
          },
        },
      }),
    );
    const headers = await withWallet(app);

    const { positions } = (await app.inject({ method: "GET", url: "/v1/positions", headers })).json() as {
      positions: Array<Record<string, unknown>>;
    };
    expect(positions.find((p) => p.vaultId === "xlm")).toMatchObject({ status: "ok", balance: "0" });
  });

  it("regla H2: ignora un publicKey inyectado por query y usa el de la sesión", async () => {
    const app = await makeApp();
    await withWallet(app, "privy-user-1", WALLET_1);
    const headers2 = await withWallet(app, "privy-user-2", WALLET_2);

    // El usuario 2 intenta leer las posiciones del usuario 1.
    const res = await app.inject({
      method: "GET",
      url: `/v1/positions?publicKey=${WALLET_1}`,
      headers: headers2,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().walletAddress).toBe(WALLET_2);
  });
});
