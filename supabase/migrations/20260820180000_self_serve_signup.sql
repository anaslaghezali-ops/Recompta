-- Inscription self-serve Freemium : cabinets créés par l'utilisateur (Edge Function signup-cabinet).

alter table public.cabinets
  add column if not exists signup_source text not null default 'admin'
    check (signup_source in ('admin', 'self_serve'));

comment on column public.cabinets.signup_source is
  'admin = super-admin / admin-create-cabinet ; self_serve = inscription publique signup-cabinet.';
