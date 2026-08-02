# ADR 001 — Reconversión del repo y stack de la SEYF API

- Estado: aceptada
- Fecha: 2026-08-02
- Contexto: decisiones Q1/Q2 de [ARQUITECTURA.md](../ARQUITECTURA.md)

## Decisión 1: este repo (ex `Seyf-Android`) se convierte en `seyf-api`

La extracción de la SEYF API es el camino crítico del proyecto móvil (Fase 1b): sin API no hay contrato, sin contrato no hay codegen de cliente ni pantallas contra mocks realistas. Se reutiliza este repositorio para arrancar ya; la app móvil (React Native + Expo, decisión Q1) tendrá su propio repositorio.

**Pendiente**: renombrar el repo en GitHub a `seyf-api` (Settings → Rename; GitHub redirige la URL vieja).

## Decisión 2: Fastify 5 + TypeScript strict + Zod, contrato generado

- **Fastify** sobre NestJS/Hono/Express: es lo más cercano en modelo mental a los route handlers de Next.js que el equipo ya escribe (funciones async con request/reply, plugins como módulos); NestJS impone decoradores y DI ceremonial sin retorno a este tamaño de equipo; Express carece de validación/serialización integradas y de tipado moderno; Hono es válido pero su ecosistema server-side (rate limit, swagger, plugins maduros) es menor.
- **Zod como fuente del contrato** (`fastify-type-provider-zod` + `@fastify/swagger`): cada ruta valida entrada/salida en runtime y esos mismos schemas generan `openapi/openapi.json`. El contrato no puede divergir del comportamiento porque *es* el comportamiento.
- **Artefacto commiteado**: `npm run openapi` regenera el JSON; CI debe fallar si el archivo commiteado no coincide con el generado (drift check).
- **Monolito modular**: `src/modules/{vaults,identity,fx,transactions,banking,treasury,webhooks}`; sin microservicios ni gateway (decisión D3).

## Consecuencias

- Los clientes (móvil primero, web después) generan su capa de red desde el contrato (orval en móvil).
- Los módulos se portan desde SEYF-P uno a uno, empezando por `vaults`; SEYF-P no se modifica.
- Las rutas stub responden `501 not_implemented` con el shape de error estándar — nunca datos fingidos.
