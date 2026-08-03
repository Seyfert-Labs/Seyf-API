import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";
import type { IdentityVerifier } from "../src/modules/auth/identity.js";
import { isPositiveDecimal, type BitsoClient, type Ticker } from "../src/modules/fx/bitso.js";
import { FxService } from "../src/modules/fx/service.js";

class FakeVerifier implements IdentityVerifier {
  async verify(token: string) {
    if (token === "privy-user-1") return { subject: "did:privy:user-1" };
    throw new Error("token inválido");
  }
}

class FakeBitso implements BitsoClient {
  calls: string[] = [];
  constructor(private readonly behavior: Record<string, () => Ticker | null> = {}) {}

  async getTicker(book: string): Promise<Ticker | null> {
    this.calls.push(book);
    const entry = this.behavior[book];
    return entry ? entry() : { last: "18.5" };
  }
}

const silentLogger = { warn() {} };

const apps: FastifyInstance[] = [];

async function makeApp(bitsoClient: BitsoClient) {
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    identityVerifier: new FakeVerifier(),
    bitsoClient,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function authHeaders(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/session",
    payload: { identityToken: "privy-user-1" },
  });
  expect(res.statusCode).toBe(201);
  const { accessToken } = res.json() as { accessToken: string };
  return { authorization: `Bearer ${accessToken}` };
}

describe("GET /v1/fx/prices", () => {
  it("exige autenticación", async () => {
    const app = await makeApp(new FakeBitso());
    expect((await app.inject({ method: "GET", url: "/v1/fx/prices" })).statusCode).toBe(401);
  });

  it("devuelve el precio del proveedor y el fijo del peso", async () => {
    const app = await makeApp(new FakeBitso({ xlm_mxn: () => ({ last: "3.4567" }) }));
    const res = await app.inject({
      method: "GET",
      url: "/v1/fx/prices?assets=XLM,MXN",
      headers: await authHeaders(app),
    });

    expect(res.statusCode).toBe(200);
    const { prices } = res.json() as { prices: Array<Record<string, unknown>> };
    expect(prices).toHaveLength(2);
    expect(prices[0]).toMatchObject({ asset: "XLM", mxn: "3.4567", status: "ok", source: "bitso" });
    expect(prices[1]).toMatchObject({ asset: "MXN", mxn: "1", status: "ok", source: "fixed" });
  });

  it("un activo desconocido sale como unavailable, sin romper la consulta", async () => {
    const app = await makeApp(new FakeBitso());
    const res = await app.inject({
      method: "GET",
      url: "/v1/fx/prices?assets=XLM,DOGECOIN",
      headers: await authHeaders(app),
    });
    const { prices } = res.json() as { prices: Array<Record<string, unknown>> };
    expect(prices[0]).toMatchObject({ asset: "XLM", status: "ok" });
    expect(prices[1]).toMatchObject({ asset: "DOGECOIN", status: "unavailable", mxn: null });
  });

  it("sin parámetro devuelve todos los activos soportados", async () => {
    const app = await makeApp(new FakeBitso());
    const res = await app.inject({
      method: "GET",
      url: "/v1/fx/prices",
      headers: await authHeaders(app),
    });
    const { prices } = res.json() as { prices: Array<{ asset: string }> };
    expect(prices.map((p) => p.asset)).toContain("USDC");
    expect(prices.length).toBeGreaterThan(5);
  });

  it("rechaza consultas con demasiados activos", async () => {
    const app = await makeApp(new FakeBitso());
    const assets = Array.from({ length: 21 }, (_, i) => `A${i}`).join(",");
    const res = await app.inject({
      method: "GET",
      url: `/v1/fx/prices?assets=${assets}`,
      headers: await authHeaders(app),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("too_many_assets");
  });
});

describe("resolución de precio", () => {
  it("prueba los books en orden hasta encontrar precio (USDC cae a USDT)", async () => {
    const bitso = new FakeBitso({
      usdc_mxn: () => null, // no existe en Bitso stage
      usdt_mxn: () => ({ last: "18.42" }),
    });
    const service = new FxService(bitso, { ttlMs: 1000, staleMaxMs: 10_000 }, silentLogger);

    const [price] = await service.getPrices(["USDC"]);
    expect(price).toMatchObject({ mxn: "18.42", status: "ok" });
    expect(bitso.calls).toEqual(["usdc_mxn", "usdt_mxn"]);
  });

  it("un book caído no descarta los siguientes candidatos", async () => {
    const bitso = new FakeBitso({
      usdc_mxn: () => {
        throw new Error("502 del proveedor");
      },
      usdt_mxn: () => ({ last: "18.42" }),
    });
    const service = new FxService(bitso, { ttlMs: 1000, staleMaxMs: 10_000 }, silentLogger);

    const [price] = await service.getPrices(["USDC"]);
    expect(price).toMatchObject({ mxn: "18.42", status: "ok" });
  });
});

describe("caché y degradación", () => {
  it("sirve de caché dentro del TTL sin volver a consultar al proveedor", async () => {
    const bitso = new FakeBitso({ xlm_mxn: () => ({ last: "3.5" }) });
    let now = 1_000_000;
    const service = new FxService(bitso, { ttlMs: 30_000, staleMaxMs: 600_000 }, silentLogger, () => now);

    await service.getPrices(["XLM"]);
    now += 10_000; // dentro del TTL
    const [second] = await service.getPrices(["XLM"]);

    expect(second).toMatchObject({ status: "ok", mxn: "3.5" });
    expect(bitso.calls).toEqual(["xlm_mxn"]);
  });

  it("vuelve a consultar cuando el TTL vence", async () => {
    let value = "3.5";
    const bitso = new FakeBitso({ xlm_mxn: () => ({ last: value }) });
    let now = 1_000_000;
    const service = new FxService(bitso, { ttlMs: 30_000, staleMaxMs: 600_000 }, silentLogger, () => now);

    await service.getPrices(["XLM"]);
    now += 31_000;
    value = "3.9";
    const [second] = await service.getPrices(["XLM"]);

    expect(second?.mxn).toBe("3.9");
    expect(bitso.calls).toHaveLength(2);
  });

  it("si el proveedor cae, sirve el último precio marcado como stale", async () => {
    let fail = false;
    const bitso = new FakeBitso({
      xlm_mxn: () => {
        if (fail) throw new Error("proveedor caído");
        return { last: "3.5" };
      },
    });
    let now = 1_000_000;
    const service = new FxService(bitso, { ttlMs: 30_000, staleMaxMs: 600_000 }, silentLogger, () => now);

    await service.getPrices(["XLM"]);
    fail = true;
    now += 31_000;

    const [degraded] = await service.getPrices(["XLM"]);
    expect(degraded).toMatchObject({ mxn: "3.5", status: "stale" });
    expect(degraded?.asOf).toBe(new Date(1_000_000).toISOString());
  });

  it("pasada la ventana de staleness deja de afirmar un precio viejo", async () => {
    let fail = false;
    const bitso = new FakeBitso({
      xlm_mxn: () => {
        if (fail) throw new Error("proveedor caído");
        return { last: "3.5" };
      },
    });
    let now = 1_000_000;
    const service = new FxService(bitso, { ttlMs: 30_000, staleMaxMs: 600_000 }, silentLogger, () => now);

    await service.getPrices(["XLM"]);
    fail = true;
    now += 700_000; // más allá de staleMaxMs

    const [expired] = await service.getPrices(["XLM"]);
    expect(expired).toMatchObject({ status: "unavailable", mxn: null });
  });

  it("colapsa consultas concurrentes del mismo activo en una sola llamada", async () => {
    const bitso = new FakeBitso({ xlm_mxn: () => ({ last: "3.5" }) });
    const service = new FxService(bitso, { ttlMs: 30_000, staleMaxMs: 600_000 }, silentLogger);

    await Promise.all([
      service.getPrices(["XLM"]),
      service.getPrices(["XLM"]),
      service.getPrices(["XLM"]),
    ]);
    expect(bitso.calls).toEqual(["xlm_mxn"]);
  });
});

describe("isPositiveDecimal", () => {
  it("acepta decimales positivos y rechaza el resto", () => {
    for (const good of ["1", "18.42", "0.0001"]) expect(isPositiveDecimal(good)).toBe(true);
    for (const bad of ["0", "0.00", "-1", "", "abc", "1e5", "NaN"]) {
      expect(isPositiveDecimal(bad)).toBe(false);
    }
  });
});
