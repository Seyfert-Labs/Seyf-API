import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";
import { AppError } from "../src/core/errors.js";
import type { IdentityVerifier } from "../src/modules/auth/identity.js";
import type {
  BuildParams,
  DefindexClient,
  SubmitResult,
  VaultBalance,
  VaultInfo,
} from "../src/modules/vaults/defindex.js";
import type { KycGate } from "../src/modules/vaults/gates.js";
import { MemoryOperationsRepository } from "../src/modules/vaults/operations.js";

const WALLET_1 = `G${"A".repeat(55)}`;
const WALLET_2 = `G${"B".repeat(55)}`;

class FakeVerifier implements IdentityVerifier {
  async verify(token: string) {
    if (token === "privy-user-1") return { subject: "did:privy:user-1" };
    if (token === "privy-user-2") return { subject: "did:privy:user-2" };
    throw new Error("token inválido");
  }
}

interface FakeOptions {
  submit?: (signedXdr: string) => Promise<SubmitResult>;
  build?: (params: BuildParams) => string;
}

class FakeDefindex implements DefindexClient {
  builds: Array<BuildParams & { kind: string }> = [];
  submits: string[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  async getVaultInfo(): Promise<VaultInfo> {
    return { name: "Vault", symbol: "DFXV", apy: 5 };
  }
  async getVaultBalance(): Promise<VaultBalance> {
    return { dfTokens: 0n, underlyingRaw: 0n };
  }
  async buildDeposit(params: BuildParams & { invest: boolean }): Promise<string> {
    this.builds.push({ ...params, kind: "deposit" });
    return this.options.build?.(params) ?? "XDR_SIN_FIRMAR";
  }
  async buildWithdraw(params: BuildParams): Promise<string> {
    this.builds.push({ ...params, kind: "withdrawal" });
    return this.options.build?.(params) ?? "XDR_SIN_FIRMAR";
  }
  async submitSigned(signedXdr: string): Promise<SubmitResult> {
    this.submits.push(signedXdr);
    return (
      this.options.submit?.(signedXdr) ??
      Promise.resolve({ txHash: "TX_HASH_OK", success: true, ledger: 42 })
    );
  }
}

class DenyingKycGate implements KycGate {
  async assertApproved(): Promise<void> {
    throw new AppError("kyc_required", "KYC pendiente.", 403);
  }
}

const apps: FastifyInstance[] = [];

async function makeApp(
  defindexClient: DefindexClient,
  extra: { kycGate?: KycGate; operationsRepo?: MemoryOperationsRepository } = {},
) {
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    identityVerifier: new FakeVerifier(),
    defindexClient,
    ...extra,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function session(app: FastifyInstance, identityToken: string, wallet: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/session",
    payload: { identityToken },
  });
  expect(res.statusCode).toBe(201);
  const { accessToken } = res.json() as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  await app.inject({ method: "POST", url: "/v1/me/wallet", headers, payload: { publicKey: wallet } });
  return headers;
}

function idem(headers: Record<string, string>) {
  return { ...headers, "idempotency-key": randomUUID() };
}

async function createDeposit(
  app: FastifyInstance,
  headers: Record<string, string>,
  amount = "100.5",
) {
  return app.inject({
    method: "POST",
    url: "/v1/vaults/xlm/deposits",
    headers: idem(headers),
    payload: { amount },
  });
}

describe("preparar operación", () => {
  it("construye el XDR y deja la operación esperando firma", async () => {
    const defindex = new FakeDefindex();
    const app = await makeApp(defindex);
    const headers = await session(app, "privy-user-1", WALLET_1);

    const res = await createDeposit(app, headers, "100.5");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      vaultId: "xlm",
      kind: "deposit",
      amount: "100.5",
      amountRaw: "1005000000", // 100.5 × 10^7, exacto
      status: "awaiting_signature",
      unsignedXdr: "XDR_SIN_FIRMAR",
      txHash: null,
    });
    // El caller que se firma es la wallet de la sesión, no un dato del cliente.
    expect(defindex.builds[0]).toMatchObject({ caller: WALLET_1, amountRaw: 1_005_000_000n });
  });

  it("exige Idempotency-Key", async () => {
    const app = await makeApp(new FakeDefindex());
    const headers = await session(app, "privy-user-1", WALLET_1);

    const res = await app.inject({
      method: "POST",
      url: "/v1/vaults/xlm/deposits",
      headers,
      payload: { amount: "10" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_key_required");
  });

  it("un reintento con la misma key no construye una segunda operación", async () => {
    const defindex = new FakeDefindex();
    const app = await makeApp(defindex);
    const headers = await session(app, "privy-user-1", WALLET_1);
    const withKey = idem(headers);

    const first = await app.inject({
      method: "POST",
      url: "/v1/vaults/xlm/deposits",
      headers: withKey,
      payload: { amount: "10" },
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/vaults/xlm/deposits",
      headers: withKey,
      payload: { amount: "10" },
    });

    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    expect(retry.headers["idempotency-replayed"]).toBe("true");
    expect(defindex.builds).toHaveLength(1);
  });

  it("bloquea sin KYC aprobado y ni siquiera contacta a DeFindex", async () => {
    const defindex = new FakeDefindex();
    const app = await makeApp(defindex, { kycGate: new DenyingKycGate() });
    const headers = await session(app, "privy-user-1", WALLET_1);

    const res = await createDeposit(app, headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("kyc_required");
    expect(defindex.builds).toHaveLength(0);
  });

  it("exige wallet vinculada", async () => {
    const app = await makeApp(new FakeDefindex());
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { identityToken: "privy-user-1" },
    });
    const { accessToken } = res.json() as { accessToken: string };

    const deposit = await app.inject({
      method: "POST",
      url: "/v1/vaults/xlm/deposits",
      headers: idem({ authorization: `Bearer ${accessToken}` }),
      payload: { amount: "10" },
    });
    expect(deposit.statusCode).toBe(409);
    expect(deposit.json().error.code).toBe("wallet_not_linked");
  });

  it("rechaza montos inválidos o con precisión imposible para el activo", async () => {
    const app = await makeApp(new FakeDefindex());
    const headers = await session(app, "privy-user-1", WALLET_1);

    const zero = await createDeposit(app, headers, "0");
    expect(zero.statusCode).toBe(400);
    expect(zero.json().error.code).toBe("invalid_amount");

    // 8 decimales en un activo de 7: redondear en silencio sería perder dinero.
    const tooPrecise = await createDeposit(app, headers, "1.12345678");
    expect(tooPrecise.statusCode).toBe(400);
    expect(tooPrecise.json().error.code).toBe("invalid_amount");

    const negative = await createDeposit(app, headers, "-5");
    expect(negative.statusCode).toBe(400);
    expect(negative.json().error.code).toBe("validation_error");
  });

  it("404 si la bóveda no existe", async () => {
    const app = await makeApp(new FakeDefindex());
    const headers = await session(app, "privy-user-1", WALLET_1);
    const res = await app.inject({
      method: "POST",
      url: "/v1/vaults/inexistente/deposits",
      headers: idem(headers),
      payload: { amount: "10" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("vault_not_found");
  });

  it("prepara retiros por la misma vía", async () => {
    const defindex = new FakeDefindex();
    const app = await makeApp(defindex);
    const headers = await session(app, "privy-user-1", WALLET_1);

    const res = await app.inject({
      method: "POST",
      url: "/v1/vaults/cetes/withdrawals",
      headers: idem(headers),
      payload: { amount: "50" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: "withdrawal", vaultId: "cetes", amount: "50" });
    expect(defindex.builds[0]?.kind).toBe("withdrawal");
  });
});

describe("confirmar operación", () => {
  it("envía el XDR firmado y confirma la operación", async () => {
    const defindex = new FakeDefindex();
    const app = await makeApp(defindex);
    const headers = await session(app, "privy-user-1", WALLET_1);
    const { id } = (await createDeposit(app, headers)).json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/v1/operations/${id}/confirm`,
      headers: idem(headers),
      payload: { signedXdr: "XDR_FIRMADO" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "confirmed",
      txHash: "TX_HASH_OK",
      ledger: 42,
      unsignedXdr: null, // ya no hace falta exponerlo
    });
    expect(defindex.submits).toEqual(["XDR_FIRMADO"]);
  });

  it("una operación ya resuelta no se reenvía a la red", async () => {
    const defindex = new FakeDefindex();
    const app = await makeApp(defindex);
    const headers = await session(app, "privy-user-1", WALLET_1);
    const { id } = (await createDeposit(app, headers)).json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/v1/operations/${id}/confirm`,
      headers: idem(headers),
      payload: { signedXdr: "XDR_FIRMADO" },
    });
    // Segundo intento con OTRA idempotency key: la guarda es del dominio.
    const again = await app.inject({
      method: "POST",
      url: `/v1/operations/${id}/confirm`,
      headers: idem(headers),
      payload: { signedXdr: "XDR_FIRMADO" },
    });

    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("confirmed");
    expect(defindex.submits).toHaveLength(1);
  });

  it("un envío concurrente recibe 409 en lugar de duplicar la transacción", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });

    const defindex = new FakeDefindex({
      submit: async () => {
        started();
        await gate;
        return { txHash: "TX_HASH_OK", success: true, ledger: 1 };
      },
    });
    const app = await makeApp(defindex);
    const headers = await session(app, "privy-user-1", WALLET_1);
    const { id } = (await createDeposit(app, headers)).json() as { id: string };

    const firstPromise = Promise.resolve(
      app.inject({
        method: "POST",
        url: `/v1/operations/${id}/confirm`,
        headers: idem(headers),
        payload: { signedXdr: "XDR_FIRMADO" },
      }),
    );
    await inFlight;

    const second = await app.inject({
      method: "POST",
      url: `/v1/operations/${id}/confirm`,
      headers: idem(headers),
      payload: { signedXdr: "XDR_FIRMADO" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("operation_in_flight");

    releaseGate();
    expect((await firstPromise).statusCode).toBe(200);
    expect(defindex.submits).toHaveLength(1);
  });

  it("si la red rechaza la transacción, la operación queda 'failed'", async () => {
    const app = await makeApp(
      new FakeDefindex({
        submit: async () => ({ txHash: "TX_HASH_KO", success: false, ledger: null }),
      }),
    );
    const headers = await session(app, "privy-user-1", WALLET_1);
    const { id } = (await createDeposit(app, headers)).json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/v1/operations/${id}/confirm`,
      headers: idem(headers),
      payload: { signedXdr: "XDR_FIRMADO" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed", txHash: "TX_HASH_KO" });
  });

  it("ante un envío de resultado desconocido no libera la operación para reintento", async () => {
    const defindex = new FakeDefindex({
      submit: async () => {
        throw new Error("socket hang up");
      },
    });
    const app = await makeApp(defindex);
    const headers = await session(app, "privy-user-1", WALLET_1);
    const { id } = (await createDeposit(app, headers)).json() as { id: string };

    const res = await app.inject({
      method: "POST",
      url: `/v1/operations/${id}/confirm`,
      headers: idem(headers),
      payload: { signedXdr: "XDR_FIRMADO" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("submit_uncertain");

    // Queda "submitted": reenviar podría duplicar un movimiento de dinero.
    const status = await app.inject({ method: "GET", url: `/v1/operations/${id}`, headers });
    expect(status.json().status).toBe("submitted");

    const retry = await app.inject({
      method: "POST",
      url: `/v1/operations/${id}/confirm`,
      headers: idem(headers),
      payload: { signedXdr: "XDR_FIRMADO" },
    });
    expect(retry.statusCode).toBe(409);
    expect(defindex.submits).toHaveLength(1);
  });

  it("una operación de otro usuario no existe (404, sin filtrar su existencia)", async () => {
    const app = await makeApp(new FakeDefindex());
    const headers1 = await session(app, "privy-user-1", WALLET_1);
    const headers2 = await session(app, "privy-user-2", WALLET_2);
    const { id } = (await createDeposit(app, headers1)).json() as { id: string };

    const read = await app.inject({ method: "GET", url: `/v1/operations/${id}`, headers: headers2 });
    expect(read.statusCode).toBe(404);

    const confirm = await app.inject({
      method: "POST",
      url: `/v1/operations/${id}/confirm`,
      headers: idem(headers2),
      payload: { signedXdr: "XDR_FIRMADO" },
    });
    expect(confirm.statusCode).toBe(404);
    expect(confirm.json().error.code).toBe("operation_not_found");
  });
});

describe("aislamiento de idempotencia entre usuarios", () => {
  it("la misma Idempotency-Key de otro usuario no devuelve su respuesta", async () => {
    const app = await makeApp(new FakeDefindex());
    const headers1 = await session(app, "privy-user-1", WALLET_1);
    const headers2 = await session(app, "privy-user-2", WALLET_2);
    const sharedKey = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: "/v1/vaults/xlm/deposits",
      headers: { ...headers1, "idempotency-key": sharedKey },
      payload: { amount: "10" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/vaults/xlm/deposits",
      headers: { ...headers2, "idempotency-key": sharedKey },
      payload: { amount: "10" },
    });

    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotency-replayed"]).toBeUndefined();
    expect(second.json().id).not.toBe(first.json().id);
  });
});
