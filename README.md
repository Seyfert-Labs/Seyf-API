# SEYF API

Backend de producto de SEYF: la API versionada (`/v1`) que consumen los clientes **web** y **móvil**. Concentra toda la lógica de negocio y de blockchain (Stellar/Soroban vía DeFindex, firma vía Pollar, KYC vía Etherfuse, FX vía Bitso) para que los clientes sean 100 % agnósticos de blockchain.

> **Nota histórica**: este repositorio nació como `Seyf-Android`. Se reconvirtió a la SEYF API porque la extracción del backend es el camino crítico del proyecto móvil (ver decisión Q2 en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)). La app móvil (React Native + Expo) vivirá en su propio repositorio.

## Reglas del juego

1. **[SEYF-P](https://github.com/Seyfert-Labs/SEYF-P) (la WebApp) es la fuente de verdad del negocio y NO se modifica.** La lógica se **porta** desde `src/lib/*` y `src/app/api/*` de ese repo, módulo a módulo.
2. **El contrato manda**: [`openapi/openapi.json`](openapi/openapi.json) se genera desde los schemas Zod de las rutas (`npm run openapi`) y se commitea. Los clientes generan su código desde ese artefacto. Prohibido editarlo a mano.
3. **Ningún secreto sale del servidor**: API keys de DeFindex/Etherfuse/Bitso/Supabase viven solo aquí (`.env`, nunca commiteado).
4. Mientras la web siga usando sus rutas Next.js originales, los **tests de contrato** deben comparar respuestas de ambas implementaciones para evitar divergencia silenciosa.

## Quickstart

```bash
npm install
cp .env.example .env
npm run dev        # http://localhost:3001 — Swagger UI en /docs
```

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor en watch mode |
| `npm test` | Tests (Vitest) |
| `npm run typecheck` | TypeScript sin emitir |
| `npm run lint` | ESLint |
| `npm run openapi` | Regenera `openapi/openapi.json` |
| `npm run build` / `start` | Compila y corre producción |

## Estructura

```
src/
├── app.ts              # ensamblaje Fastify + OpenAPI
├── server.ts           # entrypoint
├── core/               # config (env validado con Zod), errores, próximamente auth/db
└── modules/            # monolito modular — un directorio por dominio
    └── vaults/         # bóvedas DeFindex (stub 501 — primer módulo a portar)
        ├── schemas.ts  # contratos Zod
        └── routes.ts   # rutas /v1
```

Módulos pendientes de portar (en orden): `vaults` → `identity` (KYC/Etherfuse) → `fx` (Bitso/precios) → `transactions` → `banking` (Juno/SPEI) → `treasury` → `webhooks`.

## Arquitectura

La visión completa (decisiones D1–D7, seguridad, roadmap y preguntas abiertas) está en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Las decisiones puntuales se registran como ADRs en [docs/adr/](docs/adr/).
