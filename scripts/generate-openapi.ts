// Regenera openapi/openapi.json desde los schemas Zod de las rutas.
// Ejecutar con `npm run openapi` y commitear el resultado: el artefacto
// versionado es el contrato que consumen los codegen de los clientes.
import { mkdir, writeFile } from "node:fs/promises";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/core/config.js";

const app = await buildApp(loadConfig({ NODE_ENV: "test" }));
await app.ready();

const doc = app.swagger();
await mkdir("openapi", { recursive: true });
await writeFile("openapi/openapi.json", `${JSON.stringify(doc, null, 2)}\n`);
await app.close();

console.log("openapi/openapi.json regenerado");
