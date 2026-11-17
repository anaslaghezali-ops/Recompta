-- Consommation atomique des crédits (évite le dépassement en extractions parallèles).

create or replace function public.consume_vision_credit(
  p_cabinet_id bigint,
  p_count int default 1
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  quota int;
  new_used int;
  current_used int;
begin
  if p_cabinet_id is null then
    return json_build_object(
      'ok', false,
      'error', 'Cabinet requis pour consommer un crédit vision'
    );
  end if;

  if p_count is null or p_count < 1 then
    raise exception 'p_count doit être >= 1';
  end if;

  perform private.ensure_cabinet_vision_credits(p_cabinet_id);
  perform private.refresh_cabinet_credit_period(p_cabinet_id);

  quota := private.effective_vision_quota(p_cabinet_id);

  update public.cabinet_vision_credits
  set
    used_this_period = used_this_period + p_count,
    updated_at = timezone('utc', now())
  where cabinet_id = p_cabinet_id
    and used_this_period + p_count <= quota
  returning used_this_period into new_used;

  if found then
    return json_build_object(
      'ok', true,
      'quota', quota,
      'used', new_used,
      'remaining', greatest(quota - new_used, 0)
    );
  end if;

  select used_this_period into current_used
  from public.cabinet_vision_credits
  where cabinet_id = p_cabinet_id;

  return json_build_object(
    'ok', false,
    'quota', quota,
    'used', coalesce(current_used, 0),
    'remaining', greatest(quota - coalesce(current_used, 0), 0),
    'error', 'Quota crédits vision épuisé pour ce mois'
  );
end;
$$;

grant execute on function public.consume_vision_credit(bigint, int) to service_role;
