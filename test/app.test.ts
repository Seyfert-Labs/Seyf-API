import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";

describe("SEYF API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadConfig({ NODE_ENV: "test" }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("responde el liveness check", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("expone /v1/vaults en el contrato OpenAPI", () => {
    const doc = app.swagger();
    expect(doc.paths).toHaveProperty("/v1/vaults");
  });

  it("GET /v1/vaults responde 501 con el shape de error estándar", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/vaults" });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({
      error: { code: "not_implemented" },
    });
  });
});
