# Despliegue de la SEYF API

## Qué está listo

| Pieza | Estado |
|---|---|
| Imagen de contenedor ([Dockerfile](../Dockerfile)) | ✅ multi-stage, usuario sin privilegios, healthcheck |
| Publicación de imagen en GHCR ([release.yml](../.github/workflows/release.yml)) | ✅ en cada push a `main` |
| Smoke test post-despliegue (`npm run test:smoke`) | ✅ verificado contra el build de producción |
| Configuración de Railway ([railway.toml](../railway.toml)) | ✅ Dockerfile + healthcheck + una réplica |
| Migraciones de base de datos ([migrations/](../migrations)) | ⏳ pendientes de aplicar |
| Despliegue en sí | ⏳ requiere cuenta de Railway y credenciales |

La imagen queda en `ghcr.io/seyfert-labs/seyf-api:latest`. Cualquier plataforma que corra contenedores puede desplegarla.

## 1. Aplicar migraciones

Antes del primer despliegue, en el proyecto Supabase (SQL Editor):

```bash
migrations/001_vault_operations.sql
migrations/002_webhook_events.sql
```

Son tablas **nuevas**: no modifican el schema que usa la WebApp.

## 2. Variables de entorno

La API **se niega a arrancar en producción** sin las obligatorias — es deliberado, para que una mala configuración falle en el despliegue y no en silencio.

| Variable | Obligatoria en prod | Qué pasa si falta |
|---|---|---|
| `AUTH_JWT_SECRET` | ✅ | No arranca. Genera uno con `openssl rand -base64 48` |
| `SUPABASE_URL` | ✅ | No arranca |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | No arranca. **Nunca** en un cliente: omite RLS |
| `ETHERFUSE_WEBHOOK_SECRET` | ✅ en la práctica | El webhook responde 503 y el KYC nunca se actualiza |
| `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY` | ✅ en la práctica | No se puede iniciar sesión (503) |
| `DEFINDEX_API_KEY` | ✅ para operar | Lecturas degradan a APY de referencia; los depósitos fallan |
| `ETHERFUSE_API_KEY` | ✅ para KYC | No se puede enviar identidad ni documentos |
| `STELLAR_NETWORK` | recomendada | Default `testnet`. Cambiar a `mainnet` solo tras auditoría (Q8) |
| `PORT` | no | Default 8080 en la imagen |

Las opcionales (`HORIZON_URL`, `BITSO_BASE_URL`, `FX_PRICE_TTL_MS`, `DEFINDEX_VAULT_*`) están en [.env.example](../.env.example).

## 3. Plataforma: Railway (decidido 2026-08-02)

**Decisión**: staging en Railway. Motivo: SEYF no tiene infraestructura en AWS ni GCP, así que abrir una cuenta de nube completa solo para staging no desbloquea nada; el objetivo inmediato es una URL estable que desbloquee a la app móvil.

Alternativas evaluadas:

| | Railway (elegida) | AWS App Runner | AWS ECS Fargate | Cloud Run | Fly.io |
|---|---|---|---|---|---|
| Trabajo inicial | Bajo | Similar a Railway | Alto (ALB, VPC, IAM, task defs) | Alto (GCP, Artifact Registry, WIF) | Medio |
| Escala a cero | No | No | No | Sí | Sí |
| Coste staging | ~5 USD/mes | ~25–45 USD/mes | ~20 USD/mes solo el ALB | ~0 | Bajo |

**AWS Lambda quedó descartada** por algo más que coste: la API guarda hoy la idempotencia, los refresh tokens y la caché de precios en memoria del proceso. En un modelo serverless con muchas instancias efímeras, la garantía de idempotencia — la que evita ejecutar dos veces un depósito — dejaría de cumplirse.

**Esto no es una decisión irreversible.** El [Dockerfile](../Dockerfile) es neutral y la imagen queda en GHCR: mover el contenedor a AWS o GCP más adelante son horas, no una reescritura. Conviene reevaluarlo de cara a producción.

> ⚠️ **Una sola réplica.** [`railway.toml`](../railway.toml) fija `numReplicas = 1` a propósito, por los stores en memoria descritos arriba. Antes de subir ese número hay que respaldarlos en Postgres.

## 4. Desplegar y verificar

En Railway:

1. **New Project → Deploy from GitHub repo** y elegir `Seyf-API`. Detecta el [Dockerfile](../Dockerfile) y aplica [`railway.toml`](../railway.toml).
2. Cargar las variables del paso 2 en **Variables**. Railway inyecta `PORT` automáticamente: no hay que fijarlo.
3. El healthcheck de `/healthz` bloquea la promoción si la configuración es inválida, así que un secreto faltante se manifiesta como despliegue fallido, no como instancia rota atendiendo tráfico.
4. **Settings → Networking → Generate Domain** para obtener la URL pública.
5. Comprobar a mano que responde:

```bash
curl https://<url-de-staging>/healthz
```

6. Configurar la variable de repositorio `STAGING_URL` en GitHub (Settings → Variables) con esa URL. A partir de ahí, cada push a `main` corre el smoke test automáticamente.
7. Ejecutarlo en local cuando haga falta:

```bash
SEYF_API_BASE_URL=https://<url-de-staging> npm run test:smoke
```

El smoke verifica que la instancia está viva, que **toda** la superficie `/v1` exige autenticación, que el webhook rechaza payloads sin firma, y que la documentación interactiva **no** queda expuesta en producción.

## 5. Criterio de éxito del objetivo

Con staging en pie y `DEFINDEX_API_KEY` de testnet configurada, la suite E2E ejecuta el depósito completo contra la red:

```bash
npm run test:e2e
```

Ese es el criterio que se fijó al inicio: un depósito en testnet de punta a punta, construir → firmar → enviar → confirmar.
