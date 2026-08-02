import { buildApp } from "./app.js";
import { loadConfig } from "./core/config.js";

try {
  process.loadEnvFile();
} catch {
  // Sin .env — se usan defaults y variables del entorno.
}

const config = loadConfig();
const app = await buildApp(config);

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
