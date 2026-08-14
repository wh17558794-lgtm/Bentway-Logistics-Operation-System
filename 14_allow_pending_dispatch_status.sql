begin;

-- Open shipments can be moved back to Pending. The existing authentication
-- and staff-role checks remain unchanged.
create or replace function public.set_shipment_dispatch_status(
  p_shipment_id uuid,
  p_status text,
  p_scheduled_for timestamptz default null
)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_status text;
  v_result public.shipments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not private.has_any_role(
    array['admin', 'operations', 'warehouse']::text[]
  ) then
    raise exception 'Permission denied';
  end if;

  if p_status not in ('pending', 'scheduled', 'out_for_delivery') then
    raise exception 'Invalid dispatch status';
  end if;

  if p_status = 'scheduled' and p_scheduled_for is null then
    raise exception 'A scheduled date is required';
  end if;

  select current_status
  into v_previous_status
  from public.shipments
  where id = p_shipment_id
  for update;

  if not found then
    raise exception 'Shipment not found';
  end if;

  if v_previous_status in ('completed', 'cancelled') then
    raise exception 'Shipment is already closed';
  end if;

  update public.shipments
  set current_status = p_status,
      scheduled_for = case
        when p_status = 'scheduled' then p_scheduled_for
        else null
      end,
      updated_at = now()
  where id = p_shipment_id
  returning * into v_result;

  insert into public.shipment_events (
    shipment_id,
    event_type,
    from_status,
    to_status,
    event_at,
    performed_by,
    metadata
  )
  values (
    p_shipment_id,
    case when p_status = 'pending' then 'status_changed' else p_status end,
    v_previous_status,
    p_status,
    now(),
    auth.uid(),
    jsonb_strip_nulls(jsonb_build_object(
      'dispatch_status', p_status,
      'scheduled_for', case when p_status = 'scheduled' then p_scheduled_for else null end
    ))
  );

  return v_result;
end;
$$;

revoke all on function public.set_shipment_dispatch_status(uuid, text, timestamptz) from public;
revoke all on function public.set_shipment_dispatch_status(uuid, text, timestamptz) from anon;
grant execute on function public.set_shipment_dispatch_status(uuid, text, timestamptz) to authenticated;

commit;
