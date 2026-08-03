import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../core/errors.js";

// Perfiles: el puente identidad→wallet. La tabla `profiles` (compartida con la
// WebApp, PK wallet_address, columna privy_did) es la fuente del mapeo
// did:privy → publicKey Stellar. La SEYF API SIEMPRE deriva la wallet del
// usuario autenticado desde aquí — nunca del body de un request (regla H2).

export interface Profile {
  walletAddress: string;
  privyDid: string;
  email: string | null;
  fullName: string | null;
  phone: string | null;
  riskProfile: string | null;
}

export interface ProfilesRepository {
  findByDid(did: string): Promise<Profile | null>;
  /**
   * Vincula la wallet Pollar del usuario a su identidad. Idempotente para la
   * misma pareja did↔wallet; 409 si el did ya tiene otra wallet o la wallet
   * pertenece a otro did.
   *
   * TODO(#6): exigir prueba de posesión (challenge firmado vía Pollar) antes
   * de vincular — hoy la vinculación confía en el primer claim autenticado.
   */
  linkWallet(did: string, walletAddress: string, email?: string | null): Promise<Profile>;
}

const PROFILE_COLS = "wallet_address, privy_did, email, full_name, phone, risk_profile";

interface ProfileRow {
  wallet_address: string;
  privy_did: string | null;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  risk_profile: string | null;
}

function toProfile(row: ProfileRow, did: string): Profile {
  return {
    walletAddress: row.wallet_address,
    privyDid: row.privy_did ?? did,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    riskProfile: row.risk_profile,
  };
}

function dbError(context: string, cause: unknown): AppError {
  const err = new AppError(
    "db_unavailable",
    `No se pudo acceder a la base de datos (${context}).`,
    503,
  );
  err.cause = cause;
  return err;
}

export class SupabaseProfilesRepository implements ProfilesRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findByDid(did: string): Promise<Profile | null> {
    const { data, error } = await this.db
      .from("profiles")
      .select(PROFILE_COLS)
      .eq("privy_did", did)
      .limit(1)
      .maybeSingle();
    if (error) throw dbError("profiles.findByDid", error);
    return data ? toProfile(data as ProfileRow, did) : null;
  }

  async linkWallet(did: string, walletAddress: string, email?: string | null): Promise<Profile> {
    const existing = await this.findByDid(did);
    if (existing && existing.walletAddress !== walletAddress) {
      throw new AppError(
        "wallet_already_linked",
        "Esta cuenta ya tiene una wallet vinculada distinta.",
        409,
      );
    }

    const { data: byWallet, error: walletErr } = await this.db
      .from("profiles")
      .select(PROFILE_COLS)
      .eq("wallet_address", walletAddress)
      .maybeSingle();
    if (walletErr) throw dbError("profiles.byWallet", walletErr);
    const walletRow = byWallet as ProfileRow | null;
    if (walletRow?.privy_did && walletRow.privy_did !== did) {
      throw new AppError("wallet_taken", "Esta wallet ya pertenece a otra cuenta.", 409);
    }

    // TODO: carrera posible entre el select y el upsert; un índice único sobre
    // privy_did en la DB lo cerraría del todo (coordinar con el equipo web,
    // el schema es compartido).
    const patch: Record<string, unknown> = {
      wallet_address: walletAddress,
      privy_did: did,
      updated_at: new Date().toISOString(),
    };
    if (email !== undefined) patch.email = email;
    const { error: upsertErr } = await this.db
      .from("profiles")
      .upsert(patch, { onConflict: "wallet_address" });
    if (upsertErr) throw dbError("profiles.linkWallet", upsertErr);

    const linked = await this.findByDid(did);
    if (!linked) throw dbError("profiles.linkWallet.readback", null);
    return linked;
  }
}

/** Implementación en memoria para desarrollo y tests (misma semántica de conflictos). */
export class MemoryProfilesRepository implements ProfilesRepository {
  private readonly byWallet = new Map<string, Profile>();

  async findByDid(did: string): Promise<Profile | null> {
    for (const profile of this.byWallet.values()) {
      if (profile.privyDid === did) return profile;
    }
    return null;
  }

  async linkWallet(did: string, walletAddress: string, email?: string | null): Promise<Profile> {
    const existing = await this.findByDid(did);
    if (existing && existing.walletAddress !== walletAddress) {
      throw new AppError(
        "wallet_already_linked",
        "Esta cuenta ya tiene una wallet vinculada distinta.",
        409,
      );
    }
    const walletRow = this.byWallet.get(walletAddress);
    if (walletRow && walletRow.privyDid !== did) {
      throw new AppError("wallet_taken", "Esta wallet ya pertenece a otra cuenta.", 409);
    }
    const profile: Profile = {
      walletAddress,
      privyDid: did,
      email: email ?? existing?.email ?? null,
      fullName: existing?.fullName ?? null,
      phone: existing?.phone ?? null,
      riskProfile: existing?.riskProfile ?? null,
    };
    this.byWallet.set(walletAddress, profile);
    return profile;
  }
}
