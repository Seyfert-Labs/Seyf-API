import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";
import type { IdentityVerifier } from "../src/modules/auth/identity.js";
import { classifyOperation, type HorizonClient, type OnchainOperation } from "../src/modules/transactions/horizon.js";
import type {
  DefindexClient,
  SubmitResult,
  VaultBalance,
  VaultInfo,
} from "../src/modules/vaults/defindex.js";

const WALLET_1 = `G${"A".repeat(55)}`;
const OTHER = `G${"C".repeat(55)}`;

class FakeVerifier implements IdentityVerifier {
  async verify(token: string) {
    if (token === "privy-user-1") return { subject: "did:privy:user-1" };
    if (token === "privy-user-2") return { subject: "did:privy:user-2" };
    throw new Error("token inválido");
  }
}

class FakeDefindex implements DefindexClient {
  async getVaultInfo(): Promise<VaultInfo> {
    return { name: "V", symbol: "DFXV", apy: 5 };
  }
  async getVaultBalance(): Promise<VaultBalance> {
    return { dfTokens: 0n, underlyingRaw: 0n };
  }
  async buildDeposit(): Promise<string> {
    return "XDR_SIN_FIRMAR";
  }
  async buildWithdraw(): Promise<string> {
    return "XDR_SIN_FIRMAR";
  }
  async submitSigned(): Promise<SubmitResult> {
    return { txHash: "HASH_DEPOSITO", success: true, ledger: 7 };
  }
}

class FakeHorizon implements HorizonClient {
  constructor(private readonly behavior: () => OnchainOperation[] = () => []) {}
  async listOperations(): Promise<OnchainOperation[]> {
    return this.behavior();
  }
}

function onchainOp(overrides: Partial<OnchainOperation> = {}): OnchainOperation {
  return {
    id: randomUUID(),
    kind: "payment",
    direction: "in",
    from: OTHER,
    to: WALLET_1,
    asset: "XLM",
    amount: "25.5",
    txHash: `HASH_${randomUUID()}`,
    createdAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

const apps: FastifyInstance[] = [];

async function makeApp(horizonClient: HorizonClient = new FakeHorizon()) {
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    identityVerifier: new FakeVerifier(),
    defindexClient: new FakeDefindex(),
    horizonClient,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function session(app: FastifyInstance, token = "privy-user-1", wallet = WALLET_1) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/session",
    payload: { identityToken: token },
  });
  expect(res.statusCode).toBe(201);
  const { accessToken } = res.json() as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  await app.inject({ method: "POST", url: "/v1/me/wallet", headers, payload: { publicKey: wallet } });
  return headers;
}

async function deposit(app: FastifyInstance, headers: Record<string, string>, amount = "10") {
  const res = await app.inject({
    method: "POST",
    url: "/v1/vaults/xlm/deposits",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { amount },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function confirm(app: FastifyInstance, headers: Record<string, string>, id: string) {
  return app.inject({
    method: "POST",
    url: `/v1/operations/${id}/confirm`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { signedXdr: "XDR_FIRMADO" },
  });
}

describe("GET /v1/transactions", () => {
  it("exige autenticación", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/v1/transactions" })).statusCode).toBe(401);
  });

  it("exige wallet vinculada", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      payload: { identityToken: "privy-user-1" },
    });
    const { accessToken } = res.json() as { accessToken: string };
    const list = await app.inject({
      method: "GET",
      url: "/v1/transactions",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(list.statusCode).toBe(409);
    expect(list.json().error.code).toBe("wallet_not_linked");
  });

  it("une operaciones de SEYF con movimientos on-chain, ordenados por fecha", async () => {
    const app = await makeApp(new FakeHorizon(() => [onchainOp({ amount: "25.5" })]));
    const headers = await session(app);
    await deposit(app, headers, "10");

    const res = await app.inject({ method: "GET", url: "/v1/transactions", headers });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { transactions: Array<Record<string, unknown>>; onchainAvailable: boolean };
    expect(body.onchainAvailable).toBe(true);
    expect(body.transactions).toHaveLength(2);
    // El depósito recién creado es más reciente que la operación on-chain de julio.
    expect(body.transactions[0]).toMatchObject({ source: "vault", kind: "deposit", status: "pending" });
    expect(body.transactions[1]).toMatchObject({ source: "onchain", amount: "25.5", status: "confirmed" });
  });

  it("no duplica una operación de bóveda que ya aparece on-chain", async () => {
    // Horizon devuelve la MISMA transacción del depósito confirmado.
    const app = await makeApp(
      new FakeHorizon(() => [
        onchainOp({ txHash: "HASH_DEPOSITO", direction: "out", amount: "10" }),
      ]),
    );
    const headers = await session(app);
    const { id } = await deposit(app, headers, "10");
    expect((await confirm(app, headers, id)).statusCode).toBe(200);

    const { transactions } = (
      await app.inject({ method: "GET", url: "/v1/transactions", headers })
    ).json() as { transactions: Array<Record<string, unknown>> };

    expect(transactions).toHaveLength(1);
    // Se conserva la versión propia, que sabe bóveda y estado.
    expect(transactions[0]).toMatchObject({
      source: "vault",
      vaultId: "xlm",
      txHash: "HASH_DEPOSITO",
      status: "confirmed",
    });
  });

  it("si Horizon falla, devuelve el ledger propio y lo señala", async () => {
    const app = await makeApp(
      new FakeHorizon(() => {
        throw new Error("Horizon 503");
      }),
    );
    const headers = await session(app);
    await deposit(app, headers);

    const body = (
      await app.inject({ method: "GET", url: "/v1/transactions", headers })
    ).json() as { transactions: unknown[]; onchainAvailable: boolean };

    expect(body.onchainAvailable).toBe(false);
    expect(body.transactions).toHaveLength(1);
  });

  it("no expone movimientos de otro usuario", async () => {
    const app = await makeApp();
    const headers1 = await session(app, "privy-user-1", WALLET_1);
    await deposit(app, headers1);

    const headers2 = await session(app, "privy-user-2", `G${"B".repeat(55)}`);
    const { transactions } = (
      await app.inject({ method: "GET", url: "/v1/transactions", headers: headers2 })
    ).json() as { transactions: unknown[] };

    expect(transactions).toHaveLength(0);
  });

  it("pagina con limit y devuelve nextBefore cuando hay más", async () => {
    const app = await makeApp(
      new FakeHorizon(() => [
        onchainOp({ createdAt: "2026-07-03T00:00:00.000Z" }),
        onchainOp({ createdAt: "2026-07-02T00:00:00.000Z" }),
        onchainOp({ createdAt: "2026-07-01T00:00:00.000Z" }),
      ]),
    );
    const headers = await session(app);

    const first = (
      await app.inject({ method: "GET", url: "/v1/transactions?limit=2", headers })
    ).json() as { transactions: Array<{ createdAt: string }>; nextBefore: string | null };

    expect(first.transactions).toHaveLength(2);
    expect(first.nextBefore).toBe("2026-07-02T00:00:00.000Z");

    const second = (
      await app.inject({
        method: "GET",
        url: `/v1/transactions?limit=2&before=${encodeURIComponent(first.nextBefore!)}`,
        headers,
      })
    ).json() as { transactions: Array<{ createdAt: string }> };

    expect(second.transactions).toHaveLength(1);
    expect(second.transactions[0]?.createdAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("valida el límite máximo", async () => {
    const app = await makeApp();
    const headers = await session(app);
    const res = await app.inject({ method: "GET", url: "/v1/transactions?limit=500", headers });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/transactions/pending", () => {
  it("lista los movimientos en curso y los retira al confirmarse", async () => {
    const app = await makeApp();
    const headers = await session(app);
    const { id } = await deposit(app, headers, "10");

    const pending = (
      await app.inject({ method: "GET", url: "/v1/transactions/pending", headers })
    ).json() as { transactions: Array<Record<string, unknown>> };
    expect(pending.transactions).toHaveLength(1);
    expect(pending.transactions[0]).toMatchObject({
      id,
      kind: "deposit",
      status: "pending",
      amount: "10",
      direction: "out",
    });

    await confirm(app, headers, id);

    const after = (
      await app.inject({ method: "GET", url: "/v1/transactions/pending", headers })
    ).json() as { transactions: unknown[] };
    expect(after.transactions).toHaveLength(0);
  });
});

describe("clasificación de operaciones de Horizon", () => {
  it("clasifica un pago entrante y uno saliente", () => {
    const incoming = classifyOperation(
      {
        id: "1",
        type: "payment",
        from: OTHER,
        to: WALLET_1,
        asset_type: "native",
        amount: "10.0000000",
        transaction_hash: "H1",
        created_at: "2026-07-01T00:00:00Z",
      },
      WALLET_1,
    );
    expect(incoming).toMatchObject({ direction: "in", asset: "XLM", amount: "10.0000000" });

    const outgoing = classifyOperation(
      {
        id: "2",
        type: "payment",
        from: WALLET_1,
        to: OTHER,
        asset_type: "credit_alphanum4",
        asset_code: "usdc",
        amount: "5",
        transaction_hash: "H2",
        created_at: "2026-07-01T00:00:00Z",
      },
      WALLET_1,
    );
    expect(outgoing).toMatchObject({ direction: "out", asset: "USDC" });
  });

  it("clasifica trustlines y creación de cuenta", () => {
    expect(
      classifyOperation(
        { id: "3", type: "change_trust", asset_type: "credit_alphanum4", asset_code: "CETES" },
        WALLET_1,
      ),
    ).toMatchObject({ kind: "trustline", direction: "self", amount: "0" });

    expect(
      classifyOperation(
        { id: "4", type: "create_account", account: WALLET_1, funder: OTHER, starting_balance: "5" },
        WALLET_1,
      ),
    ).toMatchObject({ kind: "account_created", direction: "in", amount: "5" });
  });

  it("descarta tipos de operación que no interesan al historial", () => {
    expect(classifyOperation({ id: "5", type: "manage_sell_offer" }, WALLET_1)).toBeNull();
  });

  it("conserva el monto como string exacto de Horizon", () => {
    const op = classifyOperation(
      {
        id: "6",
        type: "payment",
        from: OTHER,
        to: WALLET_1,
        asset_type: "native",
        amount: "0.0000001",
        transaction_hash: "H6",
        created_at: "2026-07-01T00:00:00Z",
      },
      WALLET_1,
    );
    expect(op?.amount).toBe("0.0000001");
  });
});
