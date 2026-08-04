import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, fundTestnetAccount, login, startApi, type E2EContext } from "./helpers.js";

// Integración real con proveedores públicos: Horizon testnet, Friendbot y los
// tickers de Bitso. No hacen falta credenciales.
//
// Las aserciones duras cubren lo que debe cumplirse siempre (forma del
// contrato, precio fijo del peso, aislamiento por usuario). Lo que depende de
// la disponibilidad de un tercero se comprueba de forma resiliente: la API
// debe degradar con `status`/`onchainAvailable`, nunca romperse.

let ctx: E2EContext;
let client: ApiClient;
let wallet: string;
let funded = false;

beforeAll(async () => {
  ctx = await startApi();
  client = new ApiClient(ctx.baseUrl);

  wallet = Keypair.random().publicKey();
  funded = await fundTestnetAccount(wallet);
  if (!funded) {
    console.warn("[e2e] Friendbot no respondió: las pruebas de historial on-chain se relajan");
  }

  await login(client, ctx);
  const linked = await client.post("/v1/me/wallet", { publicKey: wallet });
  expect(linked.status).toBe(200);
});

afterAll(async () => {
  await ctx?.close();
});

interface Transaction {
  id: string;
  source: string;
  kind: string;
  direction: string;
  asset: string;
  amount: string;
  status: string;
  txHash: string | null;
}

describe("historial contra Horizon testnet", () => {
  it("refleja la creación de la cuenta hecha por Friendbot", async () => {
    const res = await client.get<{ transactions: Transaction[]; onchainAvailable: boolean }>(
      "/v1/transactions",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);

    if (!funded || !res.body.onchainAvailable) {
      console.warn("[e2e] historial on-chain no disponible; solo se valida la forma del contrato");
      return;
    }

    const creation = res.body.transactions.find((tx) => tx.kind === "account_created");
    expect(creation, "Friendbot debió dejar una operación create_account").toBeDefined();
    expect(creation).toMatchObject({ source: "onchain", direction: "in", asset: "XLM" });
    // El monto llega como string exacto de Horizon, no como número redondeado.
    expect(creation!.amount).toMatch(/^\d+(\.\d+)?$/);
    expect(creation!.txHash).toBeTruthy();
  });

  it("una wallet sin actividad devuelve historial vacío, no un error", async () => {
    const virgin = new ApiClient(ctx.baseUrl);
    await login(virgin, ctx);
    await virgin.post("/v1/me/wallet", { publicKey: Keypair.random().publicKey() });

    const res = await virgin.get<{ transactions: Transaction[] }>("/v1/transactions");
    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
  });

  it("no filtra movimientos entre usuarios", async () => {
    const other = new ApiClient(ctx.baseUrl);
    await login(other, ctx);
    await other.post("/v1/me/wallet", { publicKey: Keypair.random().publicKey() });

    const res = await other.get<{ transactions: Transaction[] }>("/v1/transactions");
    expect(res.status).toBe(200);
    expect(res.body.transactions.every((tx) => tx.source !== "vault")).toBe(true);
  });

  it("los movimientos en curso están vacíos si no hay operaciones", async () => {
    const res = await client.get<{ transactions: Transaction[] }>("/v1/transactions/pending");
    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
  });
});

describe("posiciones contra DeFindex", () => {
  it("devuelve una posición por bóveda, con estado explícito", async () => {
    const res = await client.get<{
      walletAddress: string;
      positions: Array<{ vaultId: string; status: string; balance: string | null }>;
    }>("/v1/positions");

    expect(res.status).toBe(200);
    expect(res.body.walletAddress).toBe(wallet);
    expect(res.body.positions.map((p) => p.vaultId).sort()).toEqual(["cetes", "usdc", "xlm"]);

    for (const position of res.body.positions) {
      // La regla que importa: o el saldo es un hecho, o se declara no disponible.
      // Nunca un cero inventado por un fallo del proveedor.
      expect(["ok", "unavailable"]).toContain(position.status);
      if (position.status === "ok") {
        expect(position.balance).toMatch(/^\d+(\.\d+)?$/);
      } else {
        expect(position.balance).toBeNull();
      }
    }
  });

  it("lista las bóvedas con APY y su procedencia", async () => {
    const res = await client.get<{
      vaults: Array<{ id: string; apy: number; apySource: string; decimals: number }>;
    }>("/v1/vaults");

    expect(res.status).toBe(200);
    expect(res.body.vaults).toHaveLength(3);
    for (const vault of res.body.vaults) {
      expect(["live", "reference"]).toContain(vault.apySource);
      expect(vault.apy).toBeGreaterThan(0);
      expect(vault.decimals).toBe(7);
    }
  });
});

describe("precios contra Bitso", () => {
  it("el peso vale 1 siempre y los demás activos declaran su estado", async () => {
    const res = await client.get<{
      prices: Array<{ asset: string; mxn: string | null; status: string; source: string | null }>;
    }>("/v1/fx/prices?assets=MXN,XLM,USDC");

    expect(res.status).toBe(200);
    const byAsset = new Map(res.body.prices.map((p) => [p.asset, p]));

    // Precio fijo: no depende de ningún proveedor.
    expect(byAsset.get("MXN")).toMatchObject({ mxn: "1", status: "ok", source: "fixed" });

    for (const asset of ["XLM", "USDC"]) {
      const price = byAsset.get(asset)!;
      expect(["ok", "stale", "unavailable"]).toContain(price.status);
      if (price.status === "unavailable") {
        expect(price.mxn).toBeNull();
      } else {
        // Precio exacto como string, sin notación científica ni redondeo.
        expect(price.mxn).toMatch(/^\d+(\.\d+)?$/);
      }
    }
  });

  it("sirve de caché: una segunda consulta responde el mismo precio", async () => {
    const first = await client.get<{ prices: Array<{ asset: string; asOf: string | null }> }>(
      "/v1/fx/prices?assets=XLM",
    );
    const second = await client.get<{ prices: Array<{ asset: string; asOf: string | null }> }>(
      "/v1/fx/prices?assets=XLM",
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Dentro del TTL el `asOf` no cambia: no se volvió a consultar al proveedor.
    expect(second.body.prices[0]?.asOf).toBe(first.body.prices[0]?.asOf);
  });
});
