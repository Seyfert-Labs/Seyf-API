import { defineConfig } from "vitest/config";

// Suite end-to-end: servidor real, HTTP real y proveedores externos reales.
// Separada de `npm test` porque depende de la red y tarda más.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    // Los proveedores externos (Horizon, Bitso, Friendbot) tienen latencia real.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Un servidor por archivo evita competir por puertos y por rate limits.
    fileParallelism: false,
  },
});
