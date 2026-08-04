import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "../../src/modules/vaults/catalog.js";
import { loadConfig } from "../../src/core/config.js";
import { ApiClient, login, requires, startApi, type E2EContext } from "./helpers.js";

// Guardián anti-divergencia con la WebApp.
//
// Mientras SEYF-P siga sirviendo su propia lógica, ambos backends deben
// coincidir en los datos que comparten. El riesgo mayor son las DIRECCIONES DE
// BÓVEDA: si la web cambia la suya y la API no, los depósitos de móvil irían a
// una bóveda distinta que los de web — dinero en el lugar equivocado.
//
// Requiere SEYF_WEB_BASE_URL apuntando a un despliegue de SEYF-P.

const WEB_BASE = process.env.SEYF_WEB_BASE_URL?.replace(/\/$/, "");
const skip = requires.seyfWeb;

let ctx: E2EContext;
let client: ApiClient;

beforeAll(async () => {
  if (skip) return;
  ctx = await startApi();
  client = new ApiClient(ctx.baseUrl);
  await login(client, ctx);
});

afterAll(async () => {
  await ctx?.close();
});

interface WebStrategy {
  id: string;
  planId: string;
  vaultAddress: string;
  assetSymbol: string;
  decimals: number;
}

async function fetchWebStrategies(): Promise<WebStrategy[] | null> {
  try {
    const res = await fetch(`${WEB_BASE}/api/defindex/strategies`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { strategies?: WebStrategy[] };
    return body.strategies ?? null;
  } catch {
    return null;
  }
}

describe.skipIf(skip)("paridad con la WebApp", () => {
  it("las direcciones de bóveda coinciden entre la API y SEYF-P", async () => {
    const webStrategies = await fetchWebStrategies();
    if (!webStrategies) {
      throw new Error(`No se pudo leer ${WEB_BASE}/api/defindex/strategies`);
    }

    const apiVaults = await client.get<{
      vaults: Array<{ id: string; vaultAddress: string; planId: string; decimals: number }>;
    }>("/v1/vaults");
    expect(apiVaults.status).toBe(200);

    const webByPlan = new Map(webStrategies.map((s) => [s.planId, s]));

    for (const vault of apiVaults.body.vaults) {
      const web = webByPlan.get(vault.planId);
      expect(web, `la web no expone el plan "${vault.planId}"`).toBeDefined();

      // La aserción que evita mandar dinero a la bóveda equivocada.
      expect(
        vault.vaultAddress,
        `divergencia de vault para ${vault.planId}: la API usa ${vault.vaultAddress} y la web ${web!.vaultAddress}`,
      ).toBe(web!.vaultAddress);

      expect(vault.decimals).toBe(web!.decimals);
    }
  });

  it("el catálogo local declara los mismos activos y decimales que la web", async () => {
    const webStrategies = await fetchWebStrategies();
    if (!webStrategies) throw new Error("La web no respondió el catálogo de estrategias");

    const catalog = buildCatalog(loadConfig({ NODE_ENV: "test" }));
    for (const vault of catalog) {
      const web = webStrategies.find((s) => s.planId === vault.planId);
      expect(web, `plan "${vault.planId}" ausente en la web`).toBeDefined();
      expect(vault.assetSymbol).toBe(web!.assetSymbol);
      expect(vault.decimals).toBe(web!.decimals);
    }
  });
});

describe.skipIf(!skip)("paridad con la WebApp (omitida)", () => {
  it("informa por qué no se ejecutó", () => {
    console.warn(
      "[e2e] SEYF_WEB_BASE_URL ausente: no se comprobó la paridad con SEYF-P. " +
        "Configúrala con la URL del despliegue de la WebApp para activar el guardián anti-divergencia.",
    );
    expect(skip).toBe(true);
  });
});
