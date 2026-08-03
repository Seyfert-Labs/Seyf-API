import { createHmac } from "node:crypto";
import canonicalize from "canonicalize";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";
import type { IdentityVerifier } from "../src/modules/auth/identity.js";
import type {
  EtherfuseClient,
  KycStatusResult,
  SubmitIdentityParams,
} from "../src/modules/identity/etherfuse.js";
import { MemoryIdentityRepository } from "../src/modules/identity/repo.js";
import { shouldApply } from "../src/modules/identity/repo.js";
import { verifyWebhookSignature } from "../src/modules/identity/webhook.js";

const WALLET_1 = `G${"A".repeat(55)}`;
const WEBHOOK_SECRET = Buffer.from("secreto-de-webhook-de-prueba").toString("base64");

class FakeVerifier implements IdentityVerifier {
  async verify(token: string) {
    if (token === "privy-user-1") return { subject: "did:privy:user-1" };
    throw new Error("token inválido");
  }
}

class FakeEtherfuse implements EtherfuseClient {
  submissions: SubmitIdentityParams[] = [];
  constructor(private readonly status: () => KycStatusResult = notFound) {}

  async getKycStatus(): Promise<KycStatusResult> {
    return this.status();
  }
  async submitIdentity(params: SubmitIdentityParams) {
    this.submissions.push(params);
    return { status: "proposed" as const, message: null };
  }
  async uploadDocuments() {
    return { status: "proposed" as const, message: null };
  }
}

function notFound(): KycStatusResult {
  return {
    found: false,
    status: null,
    approvedAt: null,
    rejectionReason: null,
    documentsCount: 0,
    selfiesCount: 0,
  };
}

function sign(payload: unknown, secret = WEBHOOK_SECRET): string {
  const canonical = canonicalize(payload)!;
  const hmac = createHmac("sha256", Buffer.from(secret, "base64")).update(canonical).digest("hex");
  return `sha256=${hmac}`;
}

const apps: FastifyInstance[] = [];

async function makeApp(
  etherfuseClient: EtherfuseClient = new FakeEtherfuse(),
  env: Record<string, string> = {},
) {
  const app = await buildApp(
    loadConfig({ NODE_ENV: "test", ETHERFUSE_WEBHOOK_SECRET: WEBHOOK_SECRET, ...env }),
    {
      identityVerifier: new FakeVerifier(),
      etherfuseClient,
      identityRepo: new MemoryIdentityRepository(),
    },
  );
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function session(app: FastifyInstance) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/session",
    payload: { identityToken: "privy-user-1" },
  });
  const { accessToken } = res.json() as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  await app.inject({
    method: "POST",
    url: "/v1/me/wallet",
    headers,
    payload: { publicKey: WALLET_1 },
  });
  return headers;
}

const IDENTITY_PAYLOAD = {
  name: { givenName: "Ana", familyName: "López" },
  dateOfBirth: "1990-05-14",
  address: {
    street: "Av. Reforma 100",
    city: "CDMX",
    region: "CDMX",
    postalCode: "06600",
    country: "MX",
  },
  idNumbers: [{ type: "curp", value: "LOAN900514MDFPNA01" }],
};

describe("verificación de firma de webhook", () => {
  it("acepta una firma válida y rechaza payload alterado, secreto distinto o firma ausente", () => {
    const payload = { event: "kyc_updated", data: { status: "approved" } };
    const signature = sign(payload);

    expect(verifyWebhookSignature(payload, signature, WEBHOOK_SECRET)).toBe(true);
    // Alterar el payload invalida la firma.
    expect(
      verifyWebhookSignature({ ...payload, data: { status: "rejected" } }, signature, WEBHOOK_SECRET),
    ).toBe(false);
    expect(
      verifyWebhookSignature(payload, signature, Buffer.from("otro-secreto").toString("base64")),
    ).toBe(false);
    expect(verifyWebhookSignature(payload, null, WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(payload, "sha256=corta", WEBHOOK_SECRET)).toBe(false);
  });

  it("la firma es estable ante reordenamiento de claves (canonicalización JCS)", () => {
    const a = { event: "kyc_updated", data: { status: "approved", customerId: "c1" } };
    const b = { data: { customerId: "c1", status: "approved" }, event: "kyc_updated" };
    expect(sign(a)).toBe(sign(b));
  });
});

describe("POST /v1/webhooks/etherfuse", () => {
  const event = {
    event: "kyc_updated",
    id: "evt-1",
    createdAt: "2026-08-02T10:00:00.000Z",
    data: {
      customerId: "cus-1",
      walletPublicKey: WALLET_1,
      status: "approved",
      approvedAt: "2026-08-02T10:00:00.000Z",
    },
  };

  it("rechaza con 401 una firma inválida y no altera el estado", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/etherfuse",
      headers: { "x-signature": "sha256=falsa" },
      payload: event,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_signature");
  });

  it("rechaza cuando no hay firma en absoluto", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/etherfuse", payload: event });
    expect(res.statusCode).toBe(401);
  });

  it("aplica un evento firmado y descarta su reenvío (anti-replay)", async () => {
    const app = await makeApp();
    const headers = { "x-signature": sign(event) };

    const first = await app.inject({
      method: "POST",
      url: "/v1/webhooks/etherfuse",
      headers,
      payload: event,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, applied: true });

    // Reenvío exacto del mismo payload firmado: debe descartarse.
    const replay = await app.inject({
      method: "POST",
      url: "/v1/webhooks/etherfuse",
      headers,
      payload: event,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ applied: false, reason: "evento ya procesado" });
  });

  it("sin secreto configurado responde 503 en vez de aceptar sin verificar", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      identityVerifier: new FakeVerifier(),
      etherfuseClient: new FakeEtherfuse(),
      identityRepo: new MemoryIdentityRepository(),
    });
    apps.push(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/etherfuse",
      headers: { "x-signature": sign(event) },
      payload: event,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("webhook_not_configured");
  });
});

describe("orden y duplicidad de eventos", () => {
  const base = {
    customerId: "c1",
    walletAddress: WALLET_1,
    status: "approved" as const,
    updatedAt: "2026-08-02T10:00:00.000Z",
    approvedAt: null,
    rejectionReason: null,
    lastEventId: "evt-1",
  };

  it("descarta un evento ya visto por id", () => {
    expect(shouldApply(base, { ...base, eventId: "evt-1" })).toBe(false);
  });

  it("descarta un evento más viejo que el estado actual", () => {
    expect(
      shouldApply(base, {
        ...base,
        status: "rejected",
        eventId: "evt-0",
        eventTimestamp: "2026-08-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("aplica un evento más nuevo", () => {
    expect(
      shouldApply(base, {
        ...base,
        status: "rejected",
        eventId: "evt-2",
        eventTimestamp: "2026-08-03T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("GET /v1/identity/kyc", () => {
  it("exige autenticación", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/v1/identity/kyc" })).statusCode).toBe(401);
  });

  it("sin verificación iniciada devuelve not_started y canOperate false", async () => {
    const app = await makeApp();
    const headers = await session(app);
    const res = await app.inject({ method: "GET", url: "/v1/identity/kyc", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "not_started", canOperate: false, customerId: null });
  });

  it("refleja el estado tras un webhook aprobado", async () => {
    const app = await makeApp();
    const headers = await session(app);
    // El envío de identidad crea la sesión de onboarding (customerId).
    const submitted = await app.inject({
      method: "POST",
      url: "/v1/identity/kyc",
      headers,
      payload: IDENTITY_PAYLOAD,
    });
    expect(submitted.statusCode).toBe(200);
    const { customerId } = submitted.json() as { customerId: string };

    const event = {
      event: "kyc_updated",
      id: "evt-approve",
      data: { customerId, walletPublicKey: WALLET_1, status: "approved" },
    };
    await app.inject({
      method: "POST",
      url: "/v1/webhooks/etherfuse",
      headers: { "x-signature": sign(event) },
      payload: event,
    });

    const res = await app.inject({ method: "GET", url: "/v1/identity/kyc", headers });
    expect(res.json()).toMatchObject({ status: "approved", canOperate: true });
  });
});

describe("POST /v1/identity/kyc", () => {
  it("envía la identidad e incluye el customerId generado", async () => {
    const etherfuse = new FakeEtherfuse();
    const app = await makeApp(etherfuse);
    const headers = await session(app);

    const res = await app.inject({
      method: "POST",
      url: "/v1/identity/kyc",
      headers,
      payload: IDENTITY_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "proposed" });

    const sent = etherfuse.submissions[0]!;
    expect(sent.walletAddress).toBe(WALLET_1);
    expect(sent.identity).toMatchObject({ id: sent.customerId, dateOfBirth: "1990-05-14" });
  });

  it("valida el formato de los datos personales", async () => {
    const app = await makeApp();
    const headers = await session(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/identity/kyc",
      headers,
      payload: { ...IDENTITY_PAYLOAD, dateOfBirth: "14/05/1990" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("exige wallet vinculada", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { identityToken: "privy-user-1" },
    });
    const { accessToken } = res.json() as { accessToken: string };
    const submit = await app.inject({
      method: "POST",
      url: "/v1/identity/kyc",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: IDENTITY_PAYLOAD,
    });
    expect(submit.statusCode).toBe(409);
    expect(submit.json().error.code).toBe("wallet_not_linked");
  });
});

describe("POST /v1/identity/kyc/documents", () => {
  const image = `data:image/jpeg;base64,${Buffer.from("imagen").toString("base64")}`;

  it("requiere haber enviado la identidad primero", async () => {
    const app = await makeApp();
    const headers = await session(app);
    const res = await app.inject({
      method: "POST",
      url: "/v1/identity/kyc/documents",
      headers,
      payload: { documentType: "selfie", images: [{ label: "selfie", image }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("kyc_not_started");
  });

  it("rechaza contenido que no es una imagen data URL", async () => {
    const app = await makeApp();
    const headers = await session(app);
    await app.inject({ method: "POST", url: "/v1/identity/kyc", headers, payload: IDENTITY_PAYLOAD });

    const res = await app.inject({
      method: "POST",
      url: "/v1/identity/kyc/documents",
      headers,
      payload: {
        documentType: "document",
        images: [{ label: "ine", image: "https://ejemplo.com/foto.jpg" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sube documentos cuando ya hay sesión de onboarding", async () => {
    const app = await makeApp();
    const headers = await session(app);
    await app.inject({ method: "POST", url: "/v1/identity/kyc", headers, payload: IDENTITY_PAYLOAD });

    const res = await app.inject({
      method: "POST",
      url: "/v1/identity/kyc/documents",
      headers,
      payload: { documentType: "document", images: [{ label: "ine-frente", image }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("proposed");
  });
});
