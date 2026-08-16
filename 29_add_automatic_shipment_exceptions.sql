-- SQL 29 - Shipment exception reasons and automatic exception evaluation
-- Executed in production on 2026-08-16. Do not run again.

begin;

alter table public.shipments
  add column if not exists exception_reason text,
  add column if not exists exception_resolution_reason text;

comment on column public.shipments.exception_reason is
  'Most recent manual or automatic reason for placing the shipment in Exception status.';

comment on column public.shipments.exception_resolution_reason is
  'Most recent reason recorded when resolving an Exception status.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_exception_reason_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_exception_reason_check
      check (
        current_status <> 'exception'
        or nullif(btrim(exception_reason), '') is not null
      );
  end if;
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

  if v_previous_status <> 'exception'
     and p_new_status = 'exception'
     and nullif(btrim(p_notes), '') is null then
    raise exception 'An exception reason is required';
  end if;

  if v_previous_status = 'exception'
     and p_new_status <> 'exception'
     and nullif(btrim(p_notes), '') is null then
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
      'total_charge_override', case when p_new_status = 'pending_warehouse_booking' then v_result.total_charge_override else null end,
      'exception_reason', case when p_new_status = 'exception' then v_result.exception_reason else null end,
      'exception_resolution_reason', case when v_previous_status = 'exception' and p_new_status <> 'exception' then v_result.exception_resolution_reason else null end
    ))
  );

  return v_result;
end;
$$;

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

  if p_status not in ('pending', 'scheduled', 'on_hold', 'pending_warehouse_booking', 'out_for_delivery') then
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

create or replace function public.complete_shipment(
  p_shipment_id uuid,
  p_outbound_method text,
  p_notes text default null
)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_status text;
  v_completed_at timestamptz := now();
  v_result public.shipments%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;

  if p_outbound_method is null
     or p_outbound_method not in ('delivered', 'picked_up', 'warehouse_delivery', 'returned') then
    raise exception 'Invalid outbound method';
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
  set current_status = 'completed',
      outbound_method = p_outbound_method,
      outbound_at = v_completed_at
  where id = p_shipment_id
  returning * into v_result;

  insert into public.shipment_events (
    shipment_id,
    event_type,
    from_status,
    to_status,
    outbound_method,
    event_at,
    performed_by,
    notes
  )
  values (
    p_shipment_id,
    p_outbound_method,
    v_previous_status,
    'completed',
    p_outbound_method,
    v_completed_at,
    auth.uid(),
    p_notes
  );

  return v_result;
end;
$$;

create or replace function public.refresh_shipment_exceptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated_count integer;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;

  with candidates as materialized (
    select
      shipment.id,
      shipment.current_status as previous_status,
      concat_ws(E'\n',
        case when not exists (
          select 1
          from public.delivery_suburb_rates as rate
          where rate.is_active = true
            and upper(btrim(rate.zone)) in ('V1', 'V2', 'V3', 'V4')
            and upper(btrim(rate.state)) = upper(btrim(coalesce(shipment.state, 'VIC')))
            and (
              (
                nullif(btrim(shipment.postcode), '') is not null
                and nullif(btrim(rate.postcode), '') is not null
                and btrim(rate.postcode) = btrim(shipment.postcode)
              )
              or (
                nullif(btrim(rate.postcode), '') is null
                and nullif(btrim(shipment.suburb), '') is not null
                and lower(btrim(rate.suburb)) = lower(btrim(shipment.suburb))
              )
            )
            and rate.effective_from <= v_today
            and (rate.effective_to is null or rate.effective_to >= v_today)
        ) then format(
          'Outside V1-V4 delivery area: %s %s %s.',
          coalesce(nullif(btrim(shipment.suburb), ''), '/'),
          coalesce(nullif(upper(btrim(shipment.state)), ''), '/'),
          coalesce(nullif(btrim(shipment.postcode), ''), '/')
        ) end,
        case when shipment.current_status = 'scheduled'
          and shipment.scheduled_for is not null
          and (shipment.scheduled_for at time zone 'Australia/Melbourne')::date < v_today
        then format(
          'Scheduled On date %s has passed without changing to Out Of Delivery.',
          to_char(shipment.scheduled_for at time zone 'Australia/Melbourne', 'DD Mon YYYY')
        ) end
      ) as reason
    from public.shipments as shipment
    where shipment.cancelled_at is null
      and shipment.current_status not in ('completed', 'cancelled', 'exception')
  ),
  updated as (
    update public.shipments as shipment
    set current_status = 'exception',
        exception_reason = candidates.reason,
        exception_resolution_reason = null,
        updated_at = now()
    from candidates
    where shipment.id = candidates.id
      and shipment.current_status = candidates.previous_status
      and nullif(candidates.reason, '') is not null
    returning shipment.id, candidates.previous_status, candidates.reason
  ),
  logged as (
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
    select
      updated.id,
      'exception',
      updated.previous_status,
      'exception',
      now(),
      auth.uid(),
      updated.reason,
      jsonb_build_object('automatic', true, 'exception_reason', updated.reason)
    from updated
  )
  select count(*)::integer into v_updated_count from updated;

  return v_updated_count;
end;
$$;

revoke all on function public.set_shipment_status(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.set_shipment_status(uuid, text, text, timestamptz) to authenticated;

revoke all on function public.set_shipment_dispatch_status(uuid, text, timestamptz) from public, anon;
grant execute on function public.set_shipment_dispatch_status(uuid, text, timestamptz) to authenticated;

revoke all on function public.complete_shipment(uuid, text, text) from public, anon;
grant execute on function public.complete_shipment(uuid, text, text) to authenticated;

revoke all on function public.refresh_shipment_exceptions() from public, anon;
grant execute on function public.refresh_shipment_exceptions() to authenticated;

commit;
