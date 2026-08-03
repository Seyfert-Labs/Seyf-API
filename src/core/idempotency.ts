import fp from "fastify-plugin";
import { errorBody } from "./errors.js";

// Idempotencia de mutaciones: una ruta marcada con `config: { idempotency: true }`
// exige el header Idempotency-Key. La primera ejecución se guarda; los reintentos
// con la misma key devuelven la respuesta original (header idempotency-replayed).
// Política fail-closed (regla H4 de PORTING.md): si el store falla, la mutación
// NO se ejecuta.

export interface IdempotencyRecord {
  status: number;
  contentType: string | undefined;
  body: string;
}

export type ClaimResult = "claimed" | "in_flight" | { replay: IdempotencyRecord };

export interface IdempotencyStore {
  /** Reclama la key: primera vez "claimed"; duplicado concurrente "in_flight"; terminada, la respuesta a repetir. */
  claim(key: string): Promise<ClaimResult>;
  complete(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void>;
  /** Libera una key reclamada cuya ejecución falló (5xx) para permitir el reintento. */
  release(key: string): Promise<void>;
}

type MemoryEntry =
  | { state: "in_flight" }
  | { state: "done"; record: IdempotencyRecord; expiresAt: number };

/** Store en memoria: suficiente para una instancia; sustituir por Postgres al escalar horizontalmente. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async claim(key: string): Promise<ClaimResult> {
    const entry = this.entries.get(key);
    if (entry) {
      if (entry.state === "in_flight") return "in_flight";
      if (entry.expiresAt > Date.now()) return { replay: entry.record };
      this.entries.delete(key);
    }
    this.entries.set(key, { state: "in_flight" });
    return "claimed";
  }

  async complete(key: string, record: IdempotencyRecord, ttlMs: number): Promise<void> {
    this.entries.set(key, { state: "done", record, expiresAt: Date.now() + ttlMs });
  }

  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

declare module "fastify" {
  interface FastifyContextConfig {
    idempotency?: boolean;
  }
  interface FastifyRequest {
    idempotencyKey?: string;
  }
}

const KEY_MIN = 8;
const KEY_MAX = 200;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyOptions {
  store: IdempotencyStore;
  ttlMs?: number;
}

export const idempotencyPlugin = fp<IdempotencyOptions>(
  async (app, opts) => {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

    app.decorateRequest("idempotencyKey", undefined);

    // preHandler (no onRequest): así un body inválido responde 400 sin reclamar la key.
    app.addHook("preHandler", async (request, reply) => {
      if (!request.routeOptions.config?.idempotency) return;

      const raw = request.headers["idempotency-key"];
      if (typeof raw !== "string" || raw.length < KEY_MIN || raw.length > KEY_MAX) {
        return reply
          .code(400)
          .send(
            errorBody(
              "idempotency_key_required",
              `Esta operación requiere el header Idempotency-Key (${KEY_MIN}–${KEY_MAX} caracteres; usa un UUID nuevo por operación).`,
              request.id,
            ),
          );
      }

      // La key se aísla por usuario: dos personas que elijan el mismo UUID no
      // pueden ver ni reusar la respuesta de la otra.
      const scope = request.user?.userId ?? "anonymous";
      const key = `${scope}:${request.method}:${request.routeOptions.url}:${raw}`;

      let result: ClaimResult;
      try {
        result = await opts.store.claim(key);
      } catch (err) {
        request.log.error(err, "idempotency store failure");
        return reply
          .code(503)
          .send(
            errorBody(
              "idempotency_unavailable",
              "No se pudo garantizar la idempotencia de la operación. Intenta de nuevo.",
              request.id,
            ),
          );
      }

      if (result === "in_flight") {
        return reply
          .code(409)
          .send(
            errorBody(
              "operation_in_flight",
              "Esta operación ya está en curso. Espera su resultado antes de reintentar.",
              request.id,
            ),
          );
      }

      if (result !== "claimed") {
        reply.header("idempotency-replayed", "true");
        const { replay } = result;
        return reply
          .code(replay.status)
          .type(replay.contentType ?? "application/json")
          .send(replay.body);
      }

      request.idempotencyKey = key;
    });

    app.addHook("onSend", async (request, reply, payload) => {
      const key = request.idempotencyKey;
      if (!key || reply.getHeader("idempotency-replayed")) return payload;

      try {
        if (reply.statusCode >= 500) {
          await opts.store.release(key);
        } else {
          await opts.store.complete(
            key,
            {
              status: reply.statusCode,
              contentType: reply.getHeader("content-type")?.toString(),
              body: typeof payload === "string" ? payload : String(payload ?? ""),
            },
            ttlMs,
          );
        }
      } catch (err) {
        request.log.error(err, "idempotency store failure al registrar el resultado");
      }
      return payload;
    });
  },
  { name: "idempotency" },
);
