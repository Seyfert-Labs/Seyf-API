import { defineConfig } from "vitest/config";

// Smoke test contra una instancia ya desplegada (SEYF_API_BASE_URL).
// No levanta servidores ni crea datos: solo comprueba que el despliegue está
// vivo, bien configurado y con su superficie protegida.
export default defineConfig({
  test: {
    include: ["test/smoke/**/*.smoke.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
