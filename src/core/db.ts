import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";

// Cliente Supabase con SERVICE ROLE: omite RLS y por eso vive SOLO en este
// servidor — jamás en un cliente web/móvil (regla de PORTING.md).
// A diferencia de SEYF-P, aquí la ausencia de credenciales NO degrada en
// silencio: en producción la API no arranca (ver loadConfig) y los
// repositorios lanzan en lugar de hacer no-op.

export function createSupabaseClient(
  config: Pick<Config, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">,
): SupabaseClient | null {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
