-- Sécurise consume_vision_credit + limite d'analyse côté API.

-- Anon/authenticated ne doivent PAS pouvoir consommer (SECURITY DEFINER).
revoke all on function public.consume_vision_credit(bigint, int) from public;
revoke all on function public.consume_vision_credit(bigint, int) from anon;
revoke all on function public.consume_vision_credit(bigint, int) from authenticated;
grant execute on function public.consume_vision_credit(bigint, int) to service_role;

-- Lecture quota pour un cabinet (service_role / backend).
create or replace function public.get_cabinet_vision_credits(p_cabinet_id bigint)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  row public.cabinet_vision_credits%rowtype;
  quota int;
begin
  if p_cabinet_id is null then
    return json_build_object('cabinet_id', null, 'quota', 0, 'used', 0, 'remaining', 0);
  end if;

  perform private.ensure_cabinet_vision_credits(p_cabinet_id);

  select * into row
  from public.cabinet_vision_credits
  where cabinet_id = p_cabinet_id;

  quota := private.effective_vision_quota(p_cabinet_id);

  return json_build_object(
    'cabinet_id', p_cabinet_id,
    'quota', quota,
    'used', row.used_this_period,
    'remaining', greatest(quota - row.used_this_period, 0),
    'period_start', row.period_start,
    'monthly_quota_override', row.monthly_quota_override
  );
end;
$$;

revoke all on function public.get_cabinet_vision_credits(bigint) from public;
revoke all on function public.get_cabinet_vision_credits(bigint) from anon;
revoke all on function public.get_cabinet_vision_credits(bigint) from authenticated;
grant execute on function public.get_cabinet_vision_credits(bigint) to service_role;
