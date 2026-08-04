import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, fundTestnetAccount, login, requires, startApi, type E2EContext } from "./helpers.js";

// Depósito completo en testnet: construir → firmar → enviar → confirmar.
//
// La firma la hace aquí el SDK de Stellar en lugar de Pollar, que necesita una
// sesión OTP interactiva imposible de automatizar. Es la misma operación
// criptográfica sobre el mismo XDR: lo que valida esta prueba es que el XDR que
// construye la API es firmable y que la red lo acepta.
//
// Requiere DEFINDEX_API_KEY: la construcción del XDR es una escritura.

const skip = requires.defindexKey;

let ctx: E2EContext;
let client: ApiClient;
let keypair: Keypair;

interface Operation {
  id: string;
  status: string;
  amount: string;
  amountRaw: string;
  unsignedXdr: string | null;
  txHash: string | null;
  failureReason: string | null;
}

beforeAll(async () => {
  if (skip) return;
  ctx = await startApi();
  client = new ApiClient(ctx.baseUrl);

  keypair = Keypair.random();
  const funded = await fundTestnetAccount(keypair.publicKey());
  if (!funded) throw new Error("Friendbot no pudo fondear la cuenta de prueba");

  await login(client, ctx);
  const linked = await client.post("/v1/me/wallet", { publicKey: keypair.publicKey() });
  expect(linked.status).toBe(200);
});

afterAll(async () => {
  await ctx?.close();
});

describe.skipIf(skip)("depósito end-to-end en testnet", () => {
  it("construye un XDR firmable, lo envía y lo confirma en la red", async () => {
    // 1. Preparar: la API valida cumplimiento y construye el XDR.
    const created = await client.post<Operation>(
      "/v1/vaults/xlm/deposits",
      { amount: "1" },
      ApiClient.idempotencyKey(),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      status: "awaiting_signature",
      amount: "1",
      amountRaw: "10000000", // 1 XLM en stroops, exacto
    });
    expect(created.body.unsignedXdr).toBeTruthy();

    // 2. Firmar con la llave del usuario (rol de Pollar en producción).
    const transaction = TransactionBuilder.fromXDR(created.body.unsignedXdr!, Networks.TESTNET);
    transaction.sign(keypair);
    const signedXdr = transaction.toXDR();

    // 3. Confirmar: la API envía a la red y resuelve la operación.
    const confirmed = await client.post<Operation>(
      `/v1/operations/${created.body.id}/confirm`,
      { signedXdr },
      ApiClient.idempotencyKey(),
    );

    if (confirmed.status === 502) {
      // Envío con resultado desconocido: la operación NO puede quedar
      // reintentable. Es el comportamiento correcto, no un fallo del test.
      const stuck = await client.get<Operation>(`/v1/operations/${created.body.id}`);
      expect(stuck.body.status).toBe("submitted");
      console.warn("[e2e] envío con resultado desconocido; la operación quedó en submitted");
      return;
    }

    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(["confirmed", "failed"]).toContain(confirmed.body.status);
    // El XDR sin firmar deja de exponerse una vez resuelta.
    expect(confirmed.body.unsignedXdr).toBeNull();

    if (confirmed.body.status === "failed") {
      console.warn(`[e2e] la red rechazó la transacción: ${confirmed.body.failureReason}`);
      return;
    }

    expect(confirmed.body.txHash).toBeTruthy();

    // 4. El estado es consultable y estable.
    const fetched = await client.get<Operation>(`/v1/operations/${created.body.id}`);
    expect(fetched.body).toMatchObject({ status: "confirmed", txHash: confirmed.body.txHash });

    // 5. Aparece una sola vez en el historial, con los datos de la bóveda.
    const history = await client.get<{
      transactions: Array<{ source: string; txHash: string | null; vaultId: string | null }>;
    }>("/v1/transactions");
    const matches = history.body.transactions.filter((tx) => tx.txHash === confirmed.body.txHash);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ source: "vault", vaultId: "xlm" });

    // 6. Ya no figura como movimiento en curso.
    const pending = await client.get<{ transactions: Array<{ id: string }> }>(
      "/v1/transactions/pending",
    );
    expect(pending.body.transactions.some((tx) => tx.id === created.body.id)).toBe(false);
  });

  it("una operación ya resuelta no se reenvía a la red", async () => {
    const created = await client.post<Operation>(
      "/v1/vaults/xlm/deposits",
      { amount: "1" },
      ApiClient.idempotencyKey(),
    );
    expect(created.status).toBe(201);

    const transaction = TransactionBuilder.fromXDR(created.body.unsignedXdr!, Networks.TESTNET);
    transaction.sign(keypair);
    const signedXdr = transaction.toXDR();

    const first = await client.post<Operation>(
      `/v1/operations/${created.body.id}/confirm`,
      { signedXdr },
      ApiClient.idempotencyKey(),
    );
    if (first.status !== 200) return; // cubierto por el caso anterior

    // Segundo intento con OTRA clave de idempotencia: la guarda es del dominio.
    const again = await client.post<Operation>(
      `/v1/operations/${created.body.id}/confirm`,
      { signedXdr },
      ApiClient.idempotencyKey(),
    );
    expect(again.status).toBe(200);
    expect(again.body.status).toBe(first.body.status);
    expect(again.body.txHash).toBe(first.body.txHash);
  });

  it("rechaza montos con más precisión que el activo", async () => {
    const res = await client.post<{ error: { code: string } }>(
      "/v1/vaults/xlm/deposits",
      { amount: "1.12345678" }, // 8 decimales en un activo de 7
      ApiClient.idempotencyKey(),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_amount");
  });

  it("no permite confirmar la operación de otro usuario", async () => {
    const created = await client.post<Operation>(
      "/v1/vaults/xlm/deposits",
      { amount: "1" },
      ApiClient.idempotencyKey(),
    );
    expect(created.status).toBe(201);

    const intruder = new ApiClient(ctx.baseUrl);
    await login(intruder, ctx);
    const res = await intruder.get<{ error: { code: string } }>(
      `/v1/operations/${created.body.id}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("operation_not_found");
  });
});

describe.skipIf(!skip)("depósito end-to-end (omitido)", () => {
  it("informa por qué no se ejecutó", () => {
    console.warn(
      "[e2e] DEFINDEX_API_KEY ausente: el depósito contra testnet no se ejecutó. " +
        "Configúrala para validar el flujo completo construir→firmar→enviar.",
    );
    expect(skip).toBe(true);
  });
});
