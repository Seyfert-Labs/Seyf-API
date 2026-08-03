# SEYF API

[![CI](https://github.com/Seyfert-Labs/Seyf-API/actions/workflows/ci.yml/badge.svg)](https://github.com/Seyfert-Labs/Seyf-API/actions/workflows/ci.yml)

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
├── core/               # config (env Zod), errores, idempotencia, db (Supabase), units (aritmética exacta)
└── modules/            # monolito modular — un directorio por dominio
    ├── auth/           # sesión: canje de identidad Privy → JWT propios, refresh con rotación, guard de /v1
    ├── users/          # perfil (/v1/me) y vinculación did:privy ↔ wallet Stellar (tabla profiles)
    ├── identity/       # KYC Etherfuse: estado, envío de identidad y documentos, webhook firmado
    │   ├── etherfuse.ts# puerto HTTP hacia el proveedor (timeout + reintentos)
    │   ├── webhook.ts  # verificación HMAC/JCS y extracción de eventos
    │   ├── repo.ts     # kyc_state, onboarding_sessions y anti-replay
    │   └── service.ts  # estado, envío y procesamiento de eventos
    └── vaults/         # bóvedas DeFindex: catálogo, cliente SDK, servicio y rutas
        ├── catalog.ts  # las 3 bóvedas (xlm/cetes/usdc), direcciones configurables por entorno
        ├── defindex.ts # puerto hacia el SDK + clasificación de errores transitorios
        ├── service.ts  # lectura: APY en vivo con fallback, posiciones on-chain
        ├── mutations.ts# depósito/retiro: gates, construcción de XDR, envío
        ├── operations.ts# ledger de operaciones con máquina de estados
        ├── gates.ts    # cumplimiento (KYC) fail-closed
        ├── schemas.ts  # contratos Zod
        └── routes.ts   # rutas /v1
```

**Flujo de una operación** (depósito o retiro):

1. `POST /v1/vaults/{id}/deposits` con `Idempotency-Key` → valida KYC y monto, construye el XDR, devuelve `{ id, unsignedXdr, status: "awaiting_signature" }`.
2. El **cliente** firma el XDR con la sesión Pollar del usuario (la API no proxea la firma; ver H8 en [PORTING.md](docs/PORTING.md)).
3. `POST /v1/operations/{id}/confirm` con `{ signedXdr }` → envía a la red → `confirmed` | `failed`.
4. Si el paso 3 responde `502 submit_uncertain`, **no reintentar**: consultar `GET /v1/operations/{id}`. La operación pudo haber llegado a la red.

## Migraciones

El SQL de `migrations/` se aplica al proyecto Supabase antes de desplegar. Son tablas **nuevas** propiedad de la API: no modifican el schema que usa la WebApp.

**Montos**: los saldos viajan como *string* decimal (`balance`) más unidades enteras (`balanceRaw`), nunca como `number`. La coma flotante introduce errores de redondeo en dinero; ver `src/core/units.ts`.

Módulos pendientes de portar (en orden): `vaults` (mutaciones) → `identity` (KYC/Etherfuse) → `fx` (Bitso/precios) → `transactions` → `banking` (Juno/SPEI) → `treasury` → `webhooks`.

## Arquitectura

La visión completa (decisiones D1–D7, seguridad, roadmap y preguntas abiertas) está en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Las decisiones puntuales se registran como ADRs en [docs/adr/](docs/adr/).
