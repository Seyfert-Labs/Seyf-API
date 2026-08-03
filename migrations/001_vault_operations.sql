-- SEYF API — ledger de operaciones de bóveda.
--
-- Tabla NUEVA, propiedad de la SEYF API: no modifica ninguna tabla existente
-- del schema compartido con la WebApp, así que aplicarla no afecta a SEYF-P.
--
-- Aplicar en el proyecto Supabase antes de desplegar el módulo de mutaciones.

create table if not exists public.vault_operations (
  id            uuid primary key default gen_random_uuid(),
  user_id       text        not null,
  wallet_address text       not null,
  vault_id      text        not null,
  vault_address text        not null,
  kind          text        not null check (kind in ('deposit', 'withdrawal')),
  -- Unidades enteras del activo (10^decimals). numeric(78,0) evita el límite de
  -- bigint y el redondeo de la coma flotante en montos de dinero.
  amount_raw    numeric(78, 0) not null check (amount_raw > 0),
  decimals      smallint    not null,
  asset_symbol  text        not null,
  status        text        not null default 'awaiting_signature'
                  check (status in ('awaiting_signature', 'submitted', 'confirmed', 'failed')),
  unsigned_xdr  text        not null,
  tx_hash       text,
  ledger        bigint,
  failure_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Listado de operaciones por usuario (historial, tarea #5).
create index if not exists vault_operations_user_created_idx
  on public.vault_operations (user_id, created_at desc);

-- Búsqueda de operaciones enviadas cuyo resultado quedó desconocido y hay que
-- reconciliar contra la red.
create index if not exists vault_operations_pending_idx
  on public.vault_operations (status)
  where status = 'submitted';

-- Solo el service role de la API accede a esta tabla; ningún cliente la toca.
alter table public.vault_operations enable row level security;
