import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { horizonUrl, type Config } from "./core/config.js";
import { createSupabaseClient } from "./core/db.js";
import { registerErrorHandling } from "./core/errors.js";
import { idempotencyPlugin, MemoryIdempotencyStore } from "./core/idempotency.js";
import {
  PrivyIdentityVerifier,
  UnconfiguredIdentityVerifier,
  type IdentityVerifier,
} from "./modules/auth/identity.js";
import { authGuard } from "./modules/auth/plugin.js";
import { MemoryRefreshTokenStore, type RefreshTokenStore } from "./modules/auth/refresh-store.js";
import { authRoutes } from "./modules/auth/routes.js";
import { TokenService } from "./modules/auth/tokens.js";
import {
  MemoryProfilesRepository,
  SupabaseProfilesRepository,
  type ProfilesRepository,
} from "./modules/users/repo.js";
import { usersRoutes } from "./modules/users/routes.js";
import { HttpHorizonClient, type HorizonClient } from "./modules/transactions/horizon.js";
import { transactionsRoutes } from "./modules/transactions/routes.js";
import { TransactionsService } from "./modules/transactions/service.js";
import { HttpBitsoClient, type BitsoClient } from "./modules/fx/bitso.js";
import { fxRoutes } from "./modules/fx/routes.js";
import { FxService } from "./modules/fx/service.js";
import {
  HttpEtherfuseClient,
  UnconfiguredEtherfuseClient,
  type EtherfuseClient,
} from "./modules/identity/etherfuse.js";
import {
  MemoryIdentityRepository,
  MemoryReplayGuard,
  SupabaseIdentityRepository,
  SupabaseReplayGuard,
  type IdentityRepository,
} from "./modules/identity/repo.js";
import { identityRoutes, identityWebhookRoutes } from "./modules/identity/routes.js";
import { IdentityService } from "./modules/identity/service.js";
import { buildCatalog } from "./modules/vaults/catalog.js";
import { SdkDefindexClient, type DefindexClient } from "./modules/vaults/defindex.js";
import { IdentityKycGate, PermissiveKycGate, type KycGate } from "./modules/vaults/gates.js";
import { VaultMutationsService } from "./modules/vaults/mutations.js";
import {
  MemoryOperationsRepository,
  SupabaseOperationsRepository,
  type OperationsRepository,
} from "./modules/vaults/operations.js";
import { vaultsRoutes } from "./modules/vaults/routes.js";
import { VaultsService } from "./modules/vaults/service.js";

/** Dependencias inyectables (tests, o implementaciones Postgres futuras). */
export interface AppDeps {
  identityVerifier?: IdentityVerifier;
  refreshStore?: RefreshTokenStore;
  profilesRepo?: ProfilesRepository;
  defindexClient?: DefindexClient;
  operationsRepo?: OperationsRepository;
  kycGate?: KycGate;
  etherfuseClient?: EtherfuseClient;
  identityRepo?: IdentityRepository;
  bitsoClient?: BitsoClient;
  horizonClient?: HorizonClient;
}

function defaultIdentityVerifier(config: Config): IdentityVerifier {
  if (config.PRIVY_APP_ID && config.PRIVY_VERIFICATION_KEY) {
    return new PrivyIdentityVerifier(config.PRIVY_APP_ID, config.PRIVY_VERIFICATION_KEY);
  }
  return new UnconfiguredIdentityVerifier();
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.NODE_ENV === "test"
        ? false
        : config.NODE_ENV === "development"
          ? { transport: { target: "pino-pretty" } }
          : true,
    // Acepta un x-request-id entrante (traza cliente→API) o genera uno propio.
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  registerErrorHandling(app);

  // El 429 toma el shape estándar en el error handler central (errors.ts).
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
  });

  await app.register(idempotencyPlugin, { store: new MemoryIdempotencyStore() });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "SEYF API",
        description:
          "Backend de producto para los clientes web y móvil de SEYF. " +
          "Contrato generado desde los schemas Zod — no editar a mano.",
        version: "0.1.0",
      },
      tags: [
        { name: "auth", description: "Sesión y tokens de la SEYF API" },
        { name: "users", description: "Perfil y vinculación de wallet" },
        { name: "identity", description: "Verificación de identidad (KYC)" },
        { name: "fx", description: "Precios en MXN" },
        { name: "transactions", description: "Historial y movimientos en curso" },
        { name: "vaults", description: "Bóvedas de rendimiento (DeFindex)" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  if (config.NODE_ENV !== "production") {
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

  app.get(
    "/healthz",
    {
      schema: {
        summary: "Liveness check",
        security: [],
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  const tokenService = new TokenService(config);
  const identityVerifier = deps.identityVerifier ?? defaultIdentityVerifier(config);
  const refreshStore =
    deps.refreshStore ?? new MemoryRefreshTokenStore(config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const supabase = createSupabaseClient(config);
  const profilesRepo =
    deps.profilesRepo ??
    (supabase ? new SupabaseProfilesRepository(supabase) : new MemoryProfilesRepository());
  if (!supabase && !deps.profilesRepo && config.NODE_ENV === "development") {
    app.log.warn(
      "Supabase sin configurar: usando repositorios en memoria (los datos se pierden al reiniciar).",
    );
  }

  const fxService = new FxService(
    deps.bitsoClient ?? new HttpBitsoClient(config.BITSO_BASE_URL),
    { ttlMs: config.FX_PRICE_TTL_MS, staleMaxMs: config.FX_PRICE_STALE_MAX_MS },
    app.log,
  );

  const catalog = buildCatalog(config);
  const defindexClient = deps.defindexClient ?? new SdkDefindexClient(config);
  const vaultsService = new VaultsService(catalog, defindexClient, app.log);
  const operationsRepo =
    deps.operationsRepo ??
    (supabase ? new SupabaseOperationsRepository(supabase) : new MemoryOperationsRepository());
  const identityRepo =
    deps.identityRepo ??
    (supabase ? new SupabaseIdentityRepository(supabase) : new MemoryIdentityRepository());
  const etherfuseClient =
    deps.etherfuseClient ??
    (config.ETHERFUSE_API_KEY
      ? new HttpEtherfuseClient(config.ETHERFUSE_BASE_URL, config.ETHERFUSE_API_KEY)
      : new UnconfiguredEtherfuseClient());
  const identityService = new IdentityService(
    identityRepo,
    etherfuseClient,
    supabase ? new SupabaseReplayGuard(supabase) : new MemoryReplayGuard(),
    { network: config.STELLAR_NETWORK, webhookSecret: config.ETHERFUSE_WEBHOOK_SECRET },
    app.log,
  );
  // Sin Supabase (dev) el estado de KYC no persiste: se usa el gate permisivo
  // en lugar de bloquear todo el flujo local.
  const kycGate =
    deps.kycGate ??
    (supabase ? new IdentityKycGate(identityService) : new PermissiveKycGate(app.log));
  const transactionsService = new TransactionsService(
    operationsRepo,
    deps.horizonClient ?? new HttpHorizonClient(horizonUrl(config)),
    app.log,
  );
  const mutationsService = new VaultMutationsService(
    catalog,
    defindexClient,
    operationsRepo,
    kycGate,
    {
      investOnDeposit: config.DEFINDEX_INVEST_ON_DEPOSIT,
      defaultSlippageBps: config.DEFINDEX_SLIPPAGE_BPS,
    },
    app.log,
  );

  // Scope /v1: el authGuard aplica a todo lo registrado aquí dentro.
  await app.register(
    async (v1) => {
      await v1.register(authGuard, { tokens: tokenService });
      await v1.register(authRoutes({ verifier: identityVerifier, refreshStore, tokens: tokenService }));
      await v1.register(usersRoutes({ profiles: profilesRepo }));
      await v1.register(identityRoutes({ identity: identityService, profiles: profilesRepo }));
      await v1.register(identityWebhookRoutes({ identity: identityService }));
      await v1.register(fxRoutes({ fx: fxService }));
      await v1.register(
        transactionsRoutes({ transactions: transactionsService, profiles: profilesRepo }),
      );
      await v1.register(
        vaultsRoutes({
          vaults: vaultsService,
          mutations: mutationsService,
          profiles: profilesRepo,
        }),
      );
    },
    { prefix: "/v1" },
  );

  return app;
}
