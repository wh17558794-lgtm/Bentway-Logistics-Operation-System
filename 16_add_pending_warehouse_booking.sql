begin;

alter table public.shipments
  add column if not exists total_charge_override numeric(14, 2);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_total_charge_override_nonnegative_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_total_charge_override_nonnegative_check
      check (total_charge_override is null or total_charge_override >= 0);
  end if;
end;
$$;

comment on column public.shipments.total_charge_override is
  'Manual GST-inclusive total charge in AUD. Pending warehouse bookings default to 150.';

alter table public.shipments
  drop constraint if exists shipments_current_status_check;

alter table public.shipments
  add constraint shipments_current_status_check
  check (current_status in (
    'pending',
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

create or replace function private.set_pending_warehouse_booking_charge()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.current_status = 'pending_warehouse_booking'
     and new.total_charge_override is null then
    new.total_charge_override := 150.00;
  end if;

  return new;
end;
$$;

drop trigger if exists set_pending_warehouse_booking_charge_trigger on public.shipments;
create trigger set_pending_warehouse_booking_charge_trigger
before insert or update of current_status, total_charge_override
on public.shipments
for each row
execute function private.set_pending_warehouse_booking_charge();

revoke all on function private.set_pending_warehouse_booking_charge() from public;

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

  if p_status not in (
    'pending',
    'scheduled',
    'on_hold',
    'pending_warehouse_booking',
    'out_for_delivery'
  ) then
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

  update public.shipments
  set current_status = p_status,
      scheduled_for = case when p_status = 'scheduled' then p_scheduled_for else null end,
      on_hold_started_at = case when p_status = 'on_hold' then p_scheduled_for else null end,
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

  if not private.has_any_role(
    array['admin', 'operations', 'warehouse']::text[]
  ) then
    raise exception 'Permission denied';
  end if;

  if p_new_status not in (
    'pending',
    'scheduled',
    'on_hold',
    'pending_warehouse_booking',
    'out_for_delivery',
    'exception',
    'cancelled'
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

  v_event_type :=
    case p_new_status
      when 'pending' then 'status_changed'
      else p_new_status
    end;

  update public.shipments
  set current_status = p_new_status,
      scheduled_for = case when p_new_status = 'scheduled' then p_scheduled_for else null end,
      on_hold_started_at = case when p_new_status = 'on_hold' then p_scheduled_for else null end,
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
    notes,
    metadata
  )
  values (
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
      'total_charge_override', case when p_new_status = 'pending_warehouse_booking' then v_result.total_charge_override else null end
    ))
  );

  return v_result;
end;
$$;

revoke all on function public.set_shipment_dispatch_status(uuid, text, timestamptz) from public;
revoke all on function public.set_shipment_dispatch_status(uuid, text, timestamptz) from anon;
grant execute on function public.set_shipment_dispatch_status(uuid, text, timestamptz) to authenticated;

revoke all on function public.set_shipment_status(uuid, text, text, timestamptz) from public;
revoke all on function public.set_shipment_status(uuid, text, text, timestamptz) from anon;
grant execute on function public.set_shipment_status(uuid, text, text, timestamptz) to authenticated;

commit;
