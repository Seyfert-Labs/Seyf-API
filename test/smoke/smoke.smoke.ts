import { describe, expect, it } from "vitest";

// Smoke test post-despliegue: comprueba que la instancia desplegada está viva,
// bien configurada y sirviendo el contrato correcto.
//
// A diferencia de la suite E2E, aquí NO se levanta el servidor: se apunta a uno
// ya desplegado con SEYF_API_BASE_URL. Se limita a lecturas públicas y a
// verificar que lo protegido está protegido — no crea datos ni mueve dinero.

const BASE_URL = process.env.SEYF_API_BASE_URL?.replace(/\/$/, "");

if (!BASE_URL) {
  throw new Error(
    "SEYF_API_BASE_URL es obligatoria para el smoke test (URL de la instancia desplegada).",
  );
}

const TIMEOUT_MS = 15_000;

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, headers: res.headers, body };
}

describe("instancia desplegada", () => {
  it("responde el liveness check", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("responde por HTTPS en un despliegue real", () => {
    // Solo se exige TLS fuera de pruebas locales contra el contenedor.
    if (BASE_URL!.startsWith("http://127.0.0.1") || BASE_URL!.startsWith("http://localhost")) {
      return;
    }
    expect(BASE_URL!.startsWith("https://")).toBe(true);
  });

  it("devuelve un identificador de petición para correlacionar incidencias", async () => {
    const res = await call("/healthz");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("superficie protegida", () => {
  const protectedPaths = [
    "/v1/me",
    "/v1/vaults",
    "/v1/positions",
    "/v1/transactions",
    "/v1/fx/prices",
    "/v1/identity/kyc",
  ];

  it.each(protectedPaths)("%s exige autenticación", async (path) => {
    const res = await call(path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("las mutaciones de dinero también exigen autenticación", async () => {
    const res = await call("/v1/vaults/xlm/deposits", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "smoke-test-key-000" },
      body: JSON.stringify({ amount: "1" }),
    });
    expect(res.status).toBe(401);
  });

  it("el webhook rechaza payloads sin firma válida", async () => {
    const res = await call("/v1/webhooks/etherfuse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "kyc_updated", data: {} }),
    });
    // 401 = firma inválida (configurado). 503 = falta el secreto: mala config.
    expect(res.status, "el webhook no debe aceptar eventos sin firma").not.toBe(200);
    if (res.status === 503) {
      throw new Error("ETHERFUSE_WEBHOOK_SECRET no está configurado en el despliegue");
    }
    expect(res.status).toBe(401);
  });
});

describe("configuración del despliegue", () => {
  it("no expone la documentación interactiva en producción", async () => {
    const res = await call("/docs/json");
    // Swagger UI solo se registra fuera de producción.
    expect([404, 401]).toContain(res.status);
  });

  it("una ruta inexistente responde el shape de error estándar", async () => {
    const res = await call("/v1/ruta-que-no-existe");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "not_found" } });
  });
});
