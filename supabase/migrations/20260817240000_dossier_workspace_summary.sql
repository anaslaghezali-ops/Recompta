-- Résumés numériques du workspace : le portefeuille ne télécharge plus lines/bank JSON.

alter table public.dossier_workspaces
  add column if not exists line_count integer generated always as (
    case
      when jsonb_typeof(lines) = 'array' then jsonb_array_length(lines)
      else 0
    end
  ) stored,
  add column if not exists bank_count integer generated always as (
    case
      when jsonb_typeof(bank_transactions) = 'array' then jsonb_array_length(bank_transactions)
      else 0
    end
  ) stored,
  add column if not exists anomaly_count integer not null default 0;

comment on column public.dossier_workspaces.line_count is
  'Nombre de lignes factures (jsonb_array_length). Généré, toujours à jour.';
comment on column public.dossier_workspaces.bank_count is
  'Nombre d''opérations bancaires. Généré, toujours à jour.';
comment on column public.dossier_workspaces.anomaly_count is
  'Lignes à corriger (field_confidence error/warn hors date_paie/IF, hors lignes validées).';

-- Même règle que docs/workspace-summary.js countAnomaliesFromStoredConfidence
create or replace function private.workspace_anomaly_count(p_lines jsonb)
returns integer
language sql
immutable
as $$
  select coalesce(count(*)::integer, 0)
  from jsonb_array_elements(
    case when jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) = 'array'
      then p_lines
      else '[]'::jsonb
    end
  ) as elem
  where not coalesce(elem->'user_verified_fields' ? '__line_review__', false)
    and exists (
      select 1
      from jsonb_each(coalesce(elem->'field_confidence', '{}'::jsonb)) as f(field, entry)
      where entry->>'level' = 'error'
         or (
           entry->>'level' = 'warn'
           and field not in ('date_paie', 'if')
         )
    );
$$;

revoke all on function private.workspace_anomaly_count(jsonb) from public, anon, authenticated;

create or replace function private.refresh_workspace_anomaly_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.anomaly_count := private.workspace_anomaly_count(new.lines);
  return new;
end;
$$;

drop trigger if exists dossier_workspaces_refresh_anomaly on public.dossier_workspaces;
create trigger dossier_workspaces_refresh_anomaly
  before insert or update of lines
  on public.dossier_workspaces
  for each row
  execute function private.refresh_workspace_anomaly_count();

update public.dossier_workspaces
set anomaly_count = private.workspace_anomaly_count(lines);
