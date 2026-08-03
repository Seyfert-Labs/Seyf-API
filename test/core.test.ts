import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, registerErrorHandling } from "../src/core/errors.js";
import { idempotencyPlugin, MemoryIdempotencyStore } from "../src/core/idempotency.js";

const apps: FastifyInstance[] = [];

function makeApp(): FastifyInstance {
  const app = Fastify({
    logger: false,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("manejo de errores", () => {
  it("un AppError sale con su código y status", async () => {
    const app = makeApp();
    app.get("/app-error", async () => {
      throw new AppError("kyc_required", "Completa tu verificación KYC", 403);
    });
    const res = await app.inject({ method: "GET", url: "/app-error" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: "kyc_required", message: "Completa tu verificación KYC" });
  });

  it("un error desconocido responde 500 sin filtrar detalles internos", async () => {
    const app = makeApp();
    app.get("/boom", async () => {
      throw new Error("secreto interno de conexión");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");
    expect(res.body).not.toContain("secreto");
  });

  it("un body inválido responde 400 validation_error", async () => {
    const app = makeApp();
    app.post("/validated", { schema: { body: z.object({ amount: z.number() }) } }, async () => ({}));
    const res = await app.inject({
      method: "POST",
      url: "/validated",
      payload: { amount: "no-numero" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("una ruta inexistente responde 404 not_found", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/nada" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("propaga el x-request-id entrante en header y en el body de error", async () => {
    const app = makeApp();
    app.get("/boom", async () => {
      throw new Error("x");
    });
    const res = await app.inject({
      method: "GET",
      url: "/boom",
      headers: { "x-request-id": "traza-cliente-123" },
    });
    expect(res.headers["x-request-id"]).toBeUndefined(); // el header lo agrega buildApp, no el error handler
    expect(res.json().error.requestId).toBe("traza-cliente-123");
  });
});

describe("idempotencia", () => {
  async function makeIdempotentApp() {
    const app = makeApp();
    let executions = 0;
    let failNext = false;
    app.register(idempotencyPlugin, { store: new MemoryIdempotencyStore() });
    app.post("/pay", { config: { idempotency: true } }, async () => {
      executions += 1;
      if (failNext) {
        failNext = false;
        throw new Error("fallo transitorio");
      }
      return { execution: executions };
    });
    await app.ready();
    return {
      app,
      count: () => executions,
      failOnce: () => {
        failNext = true;
      },
    };
  }

  it("exige el header Idempotency-Key", async () => {
    const { app } = await makeIdempotentApp();
    const res = await app.inject({ method: "POST", url: "/pay" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_key_required");
  });

  it("repite la respuesta original ante la misma key, sin re-ejecutar", async () => {
    const { app, count } = await makeIdempotentApp();
    const key = randomUUID();
    const first = await app.inject({ method: "POST", url: "/pay", headers: { "idempotency-key": key } });
    const second = await app.inject({ method: "POST", url: "/pay", headers: { "idempotency-key": key } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(count()).toBe(1);

    const third = await app.inject({
      method: "POST",
      url: "/pay",
      headers: { "idempotency-key": randomUUID() },
    });
    expect(third.json()).toEqual({ execution: 2 });
  });

  it("rechaza con 409 un duplicado concurrente en vuelo", async () => {
    const app = makeApp();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    app.register(idempotencyPlugin, { store: new MemoryIdempotencyStore() });
    app.post("/slow", { config: { idempotency: true } }, async () => {
      signalStarted();
      await gate;
      return { done: true };
    });
    await app.ready();

    const key = randomUUID();
    // inject() despacha lazy: envolver en promesa real para que arranque ya.
    const firstPromise = Promise.resolve(
      app.inject({ method: "POST", url: "/slow", headers: { "idempotency-key": key } }),
    );
    await handlerStarted;
    const second = await app.inject({ method: "POST", url: "/slow", headers: { "idempotency-key": key } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("operation_in_flight");

    releaseGate();
    const first = await firstPromise;
    expect(first.statusCode).toBe(200);
  });

  it("libera la key tras un 5xx para permitir el reintento", async () => {
    const { app, count, failOnce } = await makeIdempotentApp();
    const key = randomUUID();
    failOnce();
    const failed = await app.inject({ method: "POST", url: "/pay", headers: { "idempotency-key": key } });
    expect(failed.statusCode).toBe(500);

    const retry = await app.inject({ method: "POST", url: "/pay", headers: { "idempotency-key": key } });
    expect(retry.statusCode).toBe(200);
    expect(count()).toBe(2);
  });

  it("fail-closed: si el store falla, la mutación no se ejecuta", async () => {
    const app = makeApp();
    let executions = 0;
    const brokenStore = {
      claim: async () => {
        throw new Error("db caída");
      },
      complete: async () => {},
      release: async () => {},
    };
    app.register(idempotencyPlugin, { store: brokenStore });
    app.post("/pay", { config: { idempotency: true } }, async () => {
      executions += 1;
      return { execution: executions };
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/pay",
      headers: { "idempotency-key": randomUUID() },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("idempotency_unavailable");
    expect(executions).toBe(0);
  });
});

describe("rate limit", () => {
  it("responde 429 con el shape de error estándar al exceder el límite", async () => {
    const app = makeApp();
    await app.register(rateLimit, { max: 2, timeWindow: 60_000 });
    app.get("/ping", async () => ({ pong: true }));
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/ping" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
  });
});
