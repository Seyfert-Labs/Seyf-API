# PORTING.md — Mapeo de SEYF-P → SEYF API

> Producto de la tarea #1. Referencia: clon de solo lectura de [SEYF-P](https://github.com/Seyfert-Labs/SEYF-P) (`git clone --depth 1`; el clon vive en el scratchpad de la sesión — re-clonar cuando haga falta, jamás editarlo).
> Los shapes exactos de request/response de cada ruta se extraen del código fuente al portar cada módulo (tareas #5–#9); este documento fija el inventario, el modelo de auth real y las reglas de porteo.

## 1. Hallazgos críticos de seguridad (determinan el porteo)

Estos hallazgos describen el estado actual de la WebApp. No se corrigen en SEYF-P (repo intocable): se corrigen **por diseño** en la SEYF API.

| # | Hallazgo | Evidencia | Regla para la SEYF API |
|---|---|---|---|
| H1 | **Ninguna ruta tiene autenticación de usuario.** No hay verificación Privy/JWT/Bearer en ningún route handler; lo único parecido a sesión es una cookie de onboarding de Etherfuse en las rutas KYC | grep de `privy\|auth\|bearer\|authorization` sobre `src/app/api/**`: cero verificaciones | **Toda ruta `/v1` exige JWT** (tarea #3). Sin excepciones |
| H2 | **La identidad es la public key que el cliente afirma.** `defindex/deposit` acepta `caller` arbitrario; `kyc/status` acepta `walletHint`; posiciones/balances de cualquier llave son consultables | `defindex/deposit/route.ts` (body `{caller}`), `kyc/status/route.ts` | La public key del usuario **se deriva de la sesión autenticada en el servidor**, nunca del body/query |
| H3 | **Rutas que mueven fondos del float del negocio, sin auth**: `juno/fund-wallet` envía MXNB a cualquier `address`/`amount` del request; similar `welcome-bonus`, `mock-deposit` | `juno/fund-wallet/route.ts` — "Juno emite/envía desde el float del negocio" | Endpoints que mueven fondos del negocio son **internos/admin con auth fuerte**, o no existen en la API pública |
| H4 | **Guards fail-open**: si Supabase falla, el rate limit permite (`catch → allowed:true`) y el lock de onramp permite (`catch → true`) | `lib/seyf/guards.ts` | Guards de dinero **fail-closed**; guards de lectura pueden fail-open documentado |
| H5 | Token de Pollar en `localStorage`; la firma va cliente→Pollar directo | `lib/pollar/session.ts` (`pollar:session`), `client-api.ts` | Móvil: token en Keychain/Keystore; firma proxeada vía API (decisión D6) |
| H6 | Shape de error inconsistente: `{error: string}` en unas rutas, `{error:{code,message_es,retryable}}` en otras | `defindex/*` vs `juno/respond.ts`/`guards.ts` | Un solo shape: `{error:{code,message}}` (ya en `src/core/errors.ts`) |

| H7 | **Toda la capa de datos hace no-op silencioso sin credenciales**: cada función de `lib/supabase/db.ts` retorna vacío/cero si Supabase no está configurado — p. ej. `getMonthlyUsage` devuelve `{deposit:0, withdraw:0}`, con lo que las validaciones de límites *pasan* sin DB; `setBonusClaimed` no persiste y el bono podría duplicarse | `lib/supabase/db.ts` (patrón `if (!sb) return`) | Repositorios **fail-closed**: sin DB lanzan (`db_unavailable`, 503); en producción la API no arranca sin `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` |

Positivo a conservar: `lib/juno/issue.ts` ya genera idempotency keys hacia Juno; el rate limiting Supabase-backed de `guards.ts` es un buen esqueleto (corrigiendo H4); los mensajes de error en español orientados a usuario de `defindex/*` son buen material para el catálogo de errores; `beginConversion` implementa reserva idempotente con manejo de carrera.

## 2. Inventario de rutas → módulos de la SEYF API

55 rutas en `src/app/api/**`. Mapeo a `src/modules/*`:

### `vaults` (tareas #5/#6) ← `/api/defindex/*` — 8 rutas
| Ruta SEYF-P | Rol | Destino /v1 |
|---|---|---|
| `defindex/strategies` | Catálogo de estrategias/APY | `GET /v1/vaults` ✅ |
| `defindex/vault-info` | Detalle de vault | `GET /v1/vaults/:id` ✅ |
| `defindex/balance`, `defindex/positions` | Saldo/posiciones on-chain del caller | `GET /v1/positions` ✅ |
| `defindex/deposit` | Construye XDR de depósito (SDK server-side) | `POST /v1/vaults/:id/deposits` ✅ |
| `defindex/withdraw` | Construye XDR de retiro | `POST /v1/vaults/:id/withdrawals` ✅ |
| `defindex/prepare` | Preparación de XDR (ver uso real al portar) | absorbido en deposits/withdrawals |
| `defindex/submit` | Submit del XDR firmado a la red | `POST /v1/operations/:id/confirm` ✅ |

Libs: `lib/defindex/{client,vaults,catalog,prepare-xdr,sign-and-submit,api-error}.ts`, `lib/chain.ts`.

**Decisiones tomadas al portar la lectura (tarea vaults #1)**, que corrigen comportamiento de la web:
- `positions` de SEYF-P traga *todos* los errores y devuelve `underlyingBalance: 0`, así que un rate limit de DeFindex muestra saldo cero en las tres bóvedas — viola el principio "saldo real on-chain". La API distingue por posición: `status: "ok"` (cero verificado) vs `status: "unavailable"` (el cliente debe conservar su último saldo). La ruta `balance` de la web ya hacía bien esta distinción con `unavailable: true`; se generalizó a todas las posiciones.
- Los montos salen como string decimal exacto + unidades enteras, no como `number` (`raw / 10 ** d` en coma flotante produce artefactos como `1e-7`).
- `apy` se expone siempre junto a `apySource: live | reference`, en vez de `apy: null` + `apyLoaded: false`: el cliente siempre tiene algo que mostrar y sabe su procedencia, sin lógica de fallback propia.
- ⚠️ **Por verificar en E2E (#7)**: si el `apy` del SDK viene en porcentaje (10.5) o fracción (0.105). El catálogo asume porcentaje, igual que SEYF-P. Un error aquí es un 100x en pantalla.

**Flujo de depósito**: cliente pide XDR → **cliente firma con su sesión Pollar** → cliente manda el firmado a submit. La SEYF API conserva ese reparto (ver hallazgo H8) y añade lo que faltaba: identidad del caller derivada de la sesión, gate de KYC, idempotencia, ledger persistente con máquina de estados y transición guardada contra doble envío.

| # | Hallazgo | Evidencia | Consecuencia |
|---|---|---|---|
| H8 | **La firma con Pollar es 100 % del lado del cliente**, con el SDK `@pollar/core` en el navegador y el access token del usuario en memoria; no existe ningún proxy server-side. Pollar además valida el origen (`ORIGIN_NOT_ALLOWED`), un concepto de navegador | `lib/pollar/client-api.ts` (`pollarSignXdr` recibe un `PollarClient`) | La decisión **D6 (proxy de firma) NO se implementó**: hacerlo requiere confirmar con Pollar que acepta llamadas server-side y con qué credenciales — es exactamente la pregunta Q4, aún abierta. El contrato actual (`confirm` recibe `signedXdr`) admite añadir el proxy después sin romper a los clientes |

### `identity` ✅ ← `/api/seyf/kyc/*` (4), `/api/webhooks/etherfuse` (1)

Portado a `GET/POST /v1/identity/kyc`, `POST /v1/identity/kyc/documents` y `POST /v1/webhooks/etherfuse`. Correcciones sobre la web:

| # | Hallazgo | Evidencia | Corrección |
|---|---|---|---|
| H9 | **El webhook acepta eventos sin firma si el secreto no está configurado** (solo lo impide `strictEtherfuseProductionConfig()`), así que un despliegue mal configurado deja que cualquiera fije el estado de KYC de cualquier wallet | `app/api/webhooks/etherfuse/route.ts` (`if (secret) {...} else if (strict...)`) | Fail-closed absoluto: sin `ETHERFUSE_WEBHOOK_SECRET` el endpoint responde 503; una firma inválida o ausente responde 401 |
| H10 | **No hay anti-replay**: la deduplicación por `last_event_id` es por (customer, wallet), así que un payload firmado capturado puede reenviarse y reaplicarse tras otros eventos | `lib/seyf/kyc-state-store.ts` | Tabla `webhook_events` con PK (provider, event_id): el reclamo del evento es atómico y un reenvío se descarta |

Se conserva de la web (buena lógica): la canonicalización JCS de la firma, la normalización de `compliant` → `proposed`, y el descarte de eventos desordenados por timestamp para que uno viejo no degrade un KYC aprobado.

### `identity` — pendiente
`kyc/agreements` (aceptación de términos) no se portó: en SEYF-P está entrelazado con la creación de cuenta bancaria del onramp (`bankAccountId`), que pertenece al módulo `banking` fuera de alcance (Q9). La sesión de onboarding, que en la web es una cookie keyed por publicKey, en la API se liga al usuario autenticado y persiste en `onboarding_sessions`.
Libs: `lib/etherfuse/*` (24 archivos — el módulo tercero más grande), `lib/seyf/kyc-*`, `lib/seyf/etherfuse-*`. Nota: `lib/etherfuse/__tests__/` ya tiene tests portables como referencia de comportamiento.

### `fx` (tarea #8) ← `/api/bitso/*` (3), `/api/convert`, `/api/prices/*` (2), `/api/sdex/*` (3)
Rates y conversión Bitso, precios MXN (cache server-side), y swap SDEX (`quote/build/send` — mismo patrón XDR que vaults). Libs: `lib/bitso/*`, `lib/sdex/*`, `lib/stellar/path-payment.ts`.

### `transactions` (tarea #9) ← `/api/db/conversions`, `/api/juno/transactions` + estado on-chain
Modelo de estados unificado: `building → signing → submitted → confirmed | failed`.

### `banking` (fuera del objetivo actual — pendiente Q9) ← `/api/juno/*` (13), `/api/db/{banks,clabe}`, `/api/seyf/etherfuse/{bank-account,deposit-info,onramp/*,order/*,quote/*,ramp-context,readiness}` (9)
El onramp SPEI (Juno + Etherfuse) está mucho más desarrollado de lo que el README sugería: CLABEs, registro de bancos, quotes/órdenes de onramp, welcome bonus, redeem/withdrawal. Es un módulo grande por sí mismo. **Decisión pendiente**: ¿entra en el MVP de la API o después? (afecta Q9).

### `profile` (absorber en `identity`/core) ← `/api/db/{profile,limits,bonus,vaults,banks}`
Lectura/escritura Supabase (`lib/supabase/{server,db}.ts`). Los límites (`db/limits`) alimentan las validaciones de mutaciones — se evalúan server-side siempre.

### Fuera de la API pública
- `/api/treasury/reconcile` — job interno, no endpoint de cliente.
- `/api/juno/{health,mock-deposit}`, `lib/seyf/etherfuse-dev-panel.ts`, `kyc-test-reset` — tooling de dev/testnet; no se portan a `/v1`.
- `/api/seyf/stellar-fund`, `stellar-trustline/cetes`, `/api/stellar/pay/build` — operaciones de wallet (funding, trustlines, pagos): se portan como parte del flujo de onboarding/vaults donde se usan, no como endpoints sueltos.

## 2b. Tablas Supabase → módulos de la SEYF API

Schema **compartido con la WebApp** (no modificarlo unilateralmente; cambios se coordinan con el equipo web). Fuente: `lib/supabase/db.ts`.

| Tabla | Contenido | Módulo API | Tarea |
|---|---|---|---|
| `profiles` | PK `wallet_address`, columna `privy_did` — el mapeo identidad→wallet | `users` (ProfilesRepository) | #4 ✅ |
| `vaults` | Metadata de bóvedas del usuario (nombre, meta, color, plan/estrategia, balance cacheado) | `vaults` | #5 |
| `monthly_limits` | Uso mensual depósito/retiro (validación server-side; ojo: `addMonthlyUsage` actual tiene carrera read-then-write) | `vaults` (mutaciones) | #6 |
| `transactions` | Ledger de movimientos | `transactions` | #9 |
| `conversions` | Ledger FX con reserva idempotente (`beginConversion`) | `fx` | #8 |
| `kyc_state`, `onboarding_sessions`, `kyc_agreements` | Estado KYC Etherfuse | `identity` | #7 |
| `deposit_clabes`, `bank_accounts`, `bonus_claims`, `advance_sessions`, `onramp_locks` | Rieles SPEI/banking | `banking` | fuera de alcance (Q9) |
| `rate_limit_buckets` | Rate limiting de la web | — (la API usa @fastify/rate-limit propio) | n/a |

## 3. Orden de porteo (confirma el plan de tareas)

1. **#2/#3 primero** — sin auth real (H1) y guards fail-closed (H4) no se porta ninguna mutación.
2. **#5 vaults lectura** — sin dependencias de dinero, valida DeFindex SDK + testnet.
3. **#6 vaults mutaciones** — flujo build→sign(Pollar proxy)→submit auditado.
4. **#7 identity/KYC** — reutilizar `webhook-verify` y los tests existentes de `lib/etherfuse/__tests__`.
5. **#8 fx / #9 transactions** — cierran el alcance del objetivo.
6. `banking` queda como tarea nueva cuando se decida Q9.
