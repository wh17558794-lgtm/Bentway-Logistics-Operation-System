begin;

alter table public.shipments
  drop constraint if exists shipments_current_status_check;

alter table public.shipments
  add constraint shipments_current_status_check
  check (current_status in (
    'pending',
    'message_sent',
    'scheduled',
    'on_hold',
    'pending_warehouse_booking',
    'out_for_delivery',
    'completed',
    'exception',
    'cancelled'
  ));

alter table public.shipment_events
  drop constraint if exists shipment_events_event_type_check;

alter table public.shipment_events
  add constraint shipment_events_event_type_check
  check (event_type in (
    'inbound',
    'message_sent',
    'scheduled',
    'on_hold',
    'pending_warehouse_booking',
    'out_for_delivery',
    'delivered',
    'picked_up',
    'warehouse_delivery',
    'returned',
    'status_changed',
    'warehouse_location_changed',
    'details_updated',
    'note_added',
    'exception',
    'cancelled'
  ));

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

  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;

  if p_status not in ('pending', 'message_sent', 'scheduled', 'on_hold', 'pending_warehouse_booking', 'out_for_delivery') then
    raise exception 'Invalid dispatch status';
  end if;

  if p_status in ('scheduled', 'on_hold') and p_scheduled_for is null then
    raise exception 'A status date is required';
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

  if v_previous_status = 'exception' then
    raise exception 'Exception shipments must be resolved from Shipment Details';
  end if;

  update public.shipments
  set current_status = p_status,
      scheduled_for = case when p_status = 'scheduled' then p_scheduled_for else null end,
      on_hold_started_at = case when p_status = 'on_hold' then p_scheduled_for else null end,
      updated_at = now()
  where id = p_shipment_id
  returning * into v_result;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, metadata
  ) values (
    p_shipment_id,
    case when p_status = 'pending' then 'status_changed' else p_status end,
    v_previous_status,
    p_status,
    now(),
    auth.uid(),
    jsonb_strip_nulls(jsonb_build_object(
      'dispatch_status', p_status,
      'scheduled_for', case when p_status = 'scheduled' then p_scheduled_for else null end,
      'on_hold_started_at', case when p_status = 'on_hold' then p_scheduled_for else null end,
      'total_charge_override', case when p_status = 'pending_warehouse_booking' then v_result.total_charge_override else null end
    ))
  );

  return v_result;
end;
$$;

create or replace function public.set_shipment_status(
  p_shipment_id uuid,
  p_new_status text,
  p_notes text default null,
  p_scheduled_for timestamptz default null
)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_status text;
  v_event_type text;
  v_result public.shipments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;

  if p_new_status not in (
    'pending', 'message_sent', 'scheduled', 'on_hold', 'pending_warehouse_booking',
    'out_for_delivery', 'exception', 'cancelled'
  ) then
    raise exception 'Invalid shipment status';
  end if;

  if p_new_status in ('scheduled', 'on_hold') and p_scheduled_for is null then
    raise exception 'A status date is required';
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
    raise exception 'Closed shipment cannot be changed';
  end if;

  if v_previous_status <> 'exception' and p_new_status = 'exception' and nullif(btrim(p_notes), '') is null then
    raise exception 'An exception reason is required';
  end if;

  if v_previous_status = 'exception' and p_new_status <> 'exception' and nullif(btrim(p_notes), '') is null then
    raise exception 'An exception resolution reason is required';
  end if;

  v_event_type := case when p_new_status = 'pending' then 'status_changed' else p_new_status end;

  update public.shipments
  set current_status = p_new_status,
      scheduled_for = case
        when p_new_status = 'scheduled' then p_scheduled_for
        when p_new_status = 'exception' then scheduled_for
        else null
      end,
      on_hold_started_at = case
        when p_new_status = 'on_hold' then p_scheduled_for
        when p_new_status = 'exception' then on_hold_started_at
        else null
      end,
      exception_reason = case
        when v_previous_status <> 'exception' and p_new_status = 'exception' then btrim(p_notes)
        else exception_reason
      end,
      exception_resolution_reason = case
        when v_previous_status <> 'exception' and p_new_status = 'exception' then null
        when v_previous_status = 'exception' and p_new_status <> 'exception' then btrim(p_notes)
        else exception_resolution_reason
      end,
      updated_at = now()
  where id = p_shipment_id
  returning * into v_result;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
  ) values (
    p_shipment_id,
    v_event_type,
    v_previous_status,
    p_new_status,
    now(),
    auth.uid(),
    p_notes,
    jsonb_strip_nulls(jsonb_build_object(
      'scheduled_for', case when p_new_status = 'scheduled' then p_scheduled_for else null end,
      'on_hold_started_at', case when p_new_status = 'on_hold' then p_scheduled_for else null end,
      'total_charge_override', case when p_new_status = 'pending_warehouse_booking' then v_result.total_charge_override else null end,
      'exception_reason', case when p_new_status = 'exception' then v_result.exception_reason else null end,
      'exception_resolution_reason', case when v_previous_status = 'exception' and p_new_status <> 'exception' then v_result.exception_resolution_reason else null end
    ))
  );

  return v_result;
end;
$$;

create or replace function public.mark_shipment_sms_prepared(p_shipment_id uuid)
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

  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;

  select current_status
  into v_previous_status
  from public.shipments
  where id = p_shipment_id
  for update;

  if not found then
    raise exception 'Shipment not found';
  end if;

  if v_previous_status in ('completed', 'cancelled', 'exception') then
    raise exception 'SMS cannot be prepared for a closed or exception shipment';
  end if;

  update public.shipments
  set current_status = 'message_sent',
      scheduled_for = null,
      on_hold_started_at = null,
      source_data = coalesce(source_data, '{}'::jsonb) || jsonb_build_object(
        'sms_prepared_at', now(),
        'sms_prepared_by', auth.uid()
      ),
      updated_at = now()
  where id = p_shipment_id
  returning * into v_result;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, metadata
  ) values (
    p_shipment_id,
    'message_sent',
    v_previous_status,
    'message_sent',
    now(),
    auth.uid(),
    jsonb_build_object('sms_prepared_by_system', true)
  );

  return v_result;
end;
$$;

revoke all on function public.set_shipment_dispatch_status(uuid, text, timestamptz) from public, anon;
grant execute on function public.set_shipment_dispatch_status(uuid, text, timestamptz) to authenticated;

revoke all on function public.set_shipment_status(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.set_shipment_status(uuid, text, text, timestamptz) to authenticated;

revoke all on function public.mark_shipment_sms_prepared(uuid) from public, anon;
grant execute on function public.mark_shipment_sms_prepared(uuid) to authenticated;

commit;
