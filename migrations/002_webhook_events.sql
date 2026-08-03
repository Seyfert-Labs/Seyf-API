-- SEYF API — anti-replay de webhooks.
--
-- Tabla NUEVA, propiedad de la SEYF API. Un payload firmado que se capture y
-- se reenvíe no puede reprocesarse: el primary key hace atómico el reclamo del
-- evento (un duplicado choca con 23505 y se descarta).

create table if not exists public.webhook_events (
  provider     text        not null,
  event_id     text        not null,
  received_at  timestamptz not null default now(),
  primary key (provider, event_id)
);

-- Los eventos viejos ya no pueden reproducirse con utilidad; permite purgar.
create index if not exists webhook_events_received_idx
  on public.webhook_events (received_at);

alter table public.webhook_events enable row level security;
