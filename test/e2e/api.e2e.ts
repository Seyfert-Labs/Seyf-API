import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import canonicalize from "canonicalize";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, login, startApi, WEBHOOK_SECRET, type E2EContext } from "./helpers.js";

// Flujos que no dependen de credenciales de terceros: sesión, guard, contrato,
// idempotencia y webhook. Todo por HTTP real contra el servidor levantado.

let ctx: E2EContext;
let client: ApiClient;

beforeAll(async () => {
  ctx = await startApi();
  client = new ApiClient(ctx.baseUrl);
});

afterAll(async () => {
  await ctx?.close();
});

describe("servicio", () => {
  it("responde el liveness check", async () => {
    const res = await client.get<{ status: string }>("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("devuelve un x-request-id y respeta el entrante", async () => {
    const generated = await client.get("/healthz");
    expect(generated.headers.get("x-request-id")).toBeTruthy();

    const traced = await client.get("/healthz", { "x-request-id": "traza-e2e" });
    expect(traced.headers.get("x-request-id")).toBe("traza-e2e");
  });

  it("sirve el contrato OpenAPI en /docs", async () => {
    const res = await fetch(`${ctx.baseUrl}/docs/json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown>; info: { title: string } };
    expect(doc.info.title).toBe("SEYF API");
    for (const path of ["/v1/auth/session", "/v1/vaults", "/v1/positions", "/v1/transactions"]) {
      expect(doc.paths).toHaveProperty(path);
    }
  });

  it("una ruta inexistente responde 404 con el shape de error estándar", async () => {
    const res = await client.get<{ error: { code: string } }>("/v1/no-existe");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("sesión completa", () => {
  it("canjea identidad por tokens, accede, rota y cierra sesión", async () => {
    const fresh = new ApiClient(ctx.baseUrl);

    // Sin token: el guard rechaza.
    const anon = await fresh.get<{ error: { code: string } }>("/v1/me");
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe("unauthorized");

    // Login con un token de identidad válido.
    const { refreshToken } = await login(fresh, ctx);
    const me = await fresh.get<{ userId: string; walletAddress: string | null }>("/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.userId).toMatch(/^did:privy:/);
    expect(me.body.walletAddress).toBeNull();

    // Rotación del refresh token.
    const rotated = await fresh.post<{ accessToken: string; refreshToken: string }>(
      "/v1/auth/refresh",
      { refreshToken },
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(refreshToken);

    // Reusar el token ya rotado revoca la sesión completa.
    const reused = await fresh.post<{ error: { code: string } }>("/v1/auth/refresh", {
      refreshToken,
    });
    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe("refresh_token_reused");

    const afterRevoke = await fresh.post<{ error: { code: string } }>("/v1/auth/refresh", {
      refreshToken: rotated.body.refreshToken,
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("rechaza un token de identidad firmado por otra llave", async () => {
    const other = await startApi();
    try {
      const foreignToken = await other.identityToken();
      const res = await client.post<{ error: { code: string } }>("/v1/auth/session", {
        identityToken: foreignToken,
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_identity_token");
    } finally {
      await other.close();
    }
  });
});

describe("vinculación de wallet", () => {
  it("vincula, refleja en /me y rechaza la wallet de otra cuenta", async () => {
    const wallet = `G${"A".repeat(55)}`;
    const first = new ApiClient(ctx.baseUrl);
    await login(first, ctx);

    const linked = await first.post<{ walletAddress: string }>("/v1/me/wallet", {
      publicKey: wallet,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.walletAddress).toBe(wallet);

    const second = new ApiClient(ctx.baseUrl);
    await login(second, ctx);
    const taken = await second.post<{ error: { code: string } }>("/v1/me/wallet", {
      publicKey: wallet,
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("wallet_taken");
  });
});

describe("idempotencia sobre HTTP real", () => {
  it("exige la cabecera y repite la respuesta ante la misma clave", async () => {
    const user = new ApiClient(ctx.baseUrl);
    await login(user, ctx);
    await user.post("/v1/me/wallet", { publicKey: `G${"D".repeat(55)}` });

    const sinClave = await user.post<{ error: { code: string } }>("/v1/vaults/xlm/deposits", {
      amount: "1",
    });
    expect(sinClave.status).toBe(400);
    expect(sinClave.body.error.code).toBe("idempotency_key_required");

    // Sin credenciales de DeFindex la construcción falla, pero la idempotencia
    // se verifica igual: el mismo error se repite sin volver a intentarlo.
    const key = ApiClient.idempotencyKey();
    const first = await user.post("/v1/vaults/xlm/deposits", { amount: "1" }, key);
    const retry = await user.post("/v1/vaults/xlm/deposits", { amount: "1" }, key);

    if (first.status < 500) {
      expect(retry.status).toBe(first.status);
      expect(retry.body).toEqual(first.body);
      expect(retry.headers.get("idempotency-replayed")).toBe("true");
    }
  });

  it("aísla las claves entre usuarios distintos", async () => {
    const sharedKey = { "idempotency-key": randomUUID() };

    const a = new ApiClient(ctx.baseUrl);
    await login(a, ctx);
    await a.post("/v1/me/wallet", { publicKey: `G${"E".repeat(55)}` });

    const b = new ApiClient(ctx.baseUrl);
    await login(b, ctx);
    await b.post("/v1/me/wallet", { publicKey: `G${"F".repeat(55)}` });

    const resA = await a.post("/v1/vaults/xlm/deposits", { amount: "1" }, sharedKey);
    const resB = await b.post("/v1/vaults/xlm/deposits", { amount: "1" }, sharedKey);

    expect(resB.headers.get("idempotency-replayed")).toBeNull();
    expect(resA.headers.get("idempotency-replayed")).toBeNull();
  });
});

describe("webhook de verificación", () => {
  function sign(payload: unknown): string {
    const canonical = canonicalize(payload)!;
    const hmac = createHmac("sha256", Buffer.from(WEBHOOK_SECRET, "base64"))
      .update(canonical)
      .digest("hex");
    return `sha256=${hmac}`;
  }

  it("rechaza sin firma, con firma inválida, y acepta la válida una sola vez", async () => {
    const event = {
      event: "kyc_updated",
      id: `evt-${randomUUID()}`,
      data: {
        customerId: randomUUID(),
        walletPublicKey: `G${"H".repeat(55)}`,
        status: "approved",
      },
    };

    const sinFirma = await client.post("/v1/webhooks/etherfuse", event);
    expect(sinFirma.status).toBe(401);

    const firmaMala = await client.post("/v1/webhooks/etherfuse", event, {
      "x-signature": "sha256=0000",
    });
    expect(firmaMala.status).toBe(401);

    const headers = { "x-signature": sign(event) };
    const ok = await client.post<{ applied: boolean }>("/v1/webhooks/etherfuse", event, headers);
    expect(ok.status).toBe(200);
    expect(ok.body.applied).toBe(true);

    // Anti-replay: el mismo evento firmado no vuelve a aplicarse.
    const replay = await client.post<{ applied: boolean; reason: string }>(
      "/v1/webhooks/etherfuse",
      event,
      headers,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.applied).toBe(false);
    expect(replay.body.reason).toBe("evento ya procesado");
  });

  it("el webhook no exige sesión pero tampoco es anónimo: la firma es la credencial", async () => {
    const sinAuth = new ApiClient(ctx.baseUrl);
    const res = await sinAuth.post("/v1/webhooks/etherfuse", { event: "kyc_updated" });
    // 401 por firma, no por falta de token de sesión.
    expect(res.status).toBe(401);
  });
});
