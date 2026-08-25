-- SQL 32 - Unified status transitions, completed resume, and per-condition exception fingerprints
-- NOT YET EXECUTED IN PRODUCTION. Run once after reviewing the production schema.

begin;

-- Fail before changing anything when the production database is not at the
-- documented SQL 31 baseline. Fingerprints use built-in pg_catalog.md5(text),
-- so no optional extension digest dependency is introduced.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shipments' and column_name = 'exception_condition_keys'
  ) then
    raise exception 'SQL 32 appears to be already applied; do not rerun a completed migration';
  end if;
  if to_regclass('public.shipments') is null
     or to_regclass('public.shipment_events') is null
     or to_regclass('public.delivery_suburb_rates') is null
     or to_regclass('private.delivery_postcode_suburbs') is null then
    raise exception 'SQL 32 preflight failed: SQL 31 shipment/event/rate tables are required';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shipments' and column_name = 'cancelled_at'
  ) then
    raise exception 'SQL 32 preflight failed: public.shipments.cancelled_at is required';
  end if;
  if to_regprocedure('private.has_any_role(text[])') is null
     or to_regprocedure('public.archive_shipment(uuid)') is null
     or to_regprocedure('public.complete_shipment(uuid,text,text)') is null
     or to_regprocedure('public.mark_shipment_sms_prepared(uuid)') is null then
    raise exception 'SQL 32 preflight failed: required SQL 23-31 RPCs are missing';
  end if;
  if to_regprocedure('pg_catalog.md5(text)') is null then
    raise exception 'Required PostgreSQL function pg_catalog.md5(text) is unavailable';
  end if;
end;
$$;

alter table public.shipments
  add column if not exists exception_condition_keys text[] not null default '{}'::text[],
  add column if not exists resolved_exception_condition_keys text[] not null default '{}'::text[];

comment on column public.shipments.exception_condition_keys is
  'Independent fingerprints for automatic exception conditions currently shown on the shipment.';
comment on column public.shipments.resolved_exception_condition_keys is
  'Acknowledged automatic condition fingerprints. Stable keys prevent unrelated conditions from re-triggering them.';

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
  if auth.uid() is null then raise exception 'Authentication required'; end if;
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

  select current_status into v_previous_status
  from public.shipments
  where id = p_shipment_id
  for update;

  if not found then raise exception 'Shipment not found'; end if;
  if v_previous_status in ('completed', 'cancelled') then
    raise exception 'Closed shipment cannot be changed; use the dedicated Resume action for completed shipments';
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
      resolved_exception_condition_keys = case
        when v_previous_status = 'exception' and p_new_status <> 'exception' then array(
          select distinct resolved.key
          from unnest(
            coalesce(resolved_exception_condition_keys, '{}'::text[])
            || coalesce(exception_condition_keys, '{}'::text[])
          ) as resolved(key)
          order by resolved.key
        )
        else resolved_exception_condition_keys
      end,
      exception_condition_keys = case
        when v_previous_status = 'exception' and p_new_status <> 'exception' then '{}'::text[]
        when v_previous_status <> 'exception' and p_new_status = 'exception' then '{}'::text[]
        else exception_condition_keys
      end,
      updated_at = now()
  where id = p_shipment_id
  returning * into v_result;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
  ) values (
    p_shipment_id, v_event_type, v_previous_status, p_new_status, now(), auth.uid(), p_notes,
    jsonb_strip_nulls(jsonb_build_object(
      'scheduled_for', case when p_new_status = 'scheduled' then p_scheduled_for else null end,
      'on_hold_started_at', case when p_new_status = 'on_hold' then p_scheduled_for else null end,
      'total_charge_override', case when p_new_status = 'pending_warehouse_booking' then v_result.total_charge_override else null end,
      'exception_reason', case when p_new_status = 'exception' then v_result.exception_reason else null end,
      'exception_resolution_reason', case when v_previous_status = 'exception' and p_new_status <> 'exception' then v_result.exception_resolution_reason else null end,
      'resolved_condition_keys', case when v_previous_status = 'exception' and p_new_status <> 'exception' then v_result.resolved_exception_condition_keys else null end
    ))
  );

  return v_result;
end;
$$;

-- Compatibility wrapper. New browser code calls set_shipment_status for every ordinary transition.
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
begin
  if p_status not in ('pending', 'message_sent', 'scheduled', 'on_hold', 'pending_warehouse_booking', 'out_for_delivery') then
    raise exception 'Invalid dispatch status';
  end if;
  return public.set_shipment_status(p_shipment_id, p_status, null, p_scheduled_for);
end;
$$;

create or replace function public.resume_completed_shipment(p_shipment_id uuid)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbound_method text;
  v_result public.shipments%rowtype;
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'You do not have permission to resume shipments';
  end if;

  select outbound_method into v_outbound_method
  from public.shipments
  where id = p_shipment_id and current_status = 'completed' and cancelled_at is null
  for update;

  if not found then raise exception 'Completed shipment was not found'; end if;

  update public.shipments
  set current_status = 'pending',
      outbound_method = null,
      outbound_at = null,
      scheduled_for = null,
      on_hold_started_at = null,
      exception_condition_keys = '{}'::text[],
      updated_at = now()
  where id = p_shipment_id
  returning * into v_result;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, metadata
  ) values (
    p_shipment_id, 'status_changed', 'completed', 'pending', now(), auth.uid(),
    jsonb_build_object('action', 'resumed_completed_shipment', 'previous_outbound_method', v_outbound_method)
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
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;

  with condition_rows as materialized (
    select shipment.id, shipment.current_status as previous_status,
      condition.condition_type,
      condition.reason,
      pg_catalog.md5(condition.condition_type || '|' || condition.fingerprint_source) as condition_key
    from public.shipments as shipment
    cross join lateral (
      select 'delivery_area'::text as condition_type,
        format(
          'Postcode/suburb pair is outside V1-V4 delivery areas: %s %s %s.',
          coalesce(nullif(btrim(shipment.suburb), ''), '/'),
          coalesce(nullif(upper(btrim(shipment.state)), ''), '/'),
          coalesce(nullif(btrim(shipment.postcode), ''), '/')
        ) as reason,
        concat_ws('|', upper(btrim(coalesce(shipment.state, 'VIC'))), btrim(coalesce(shipment.postcode, '')), upper(btrim(coalesce(shipment.suburb, '')))) as fingerprint_source
      where not exists (
        select 1
        from public.delivery_suburb_rates as rate
        where rate.is_active = true
          and upper(btrim(rate.zone)) in ('V1', 'V2', 'V3', 'V4')
          and upper(btrim(rate.state)) = upper(btrim(coalesce(shipment.state, 'VIC')))
          and nullif(btrim(shipment.postcode), '') is not null
          and btrim(rate.postcode) = btrim(shipment.postcode)
          and nullif(btrim(shipment.suburb), '') is not null
          and exists (
            select 1 from private.delivery_postcode_suburbs as mapping
            where mapping.state = upper(btrim(coalesce(shipment.state, 'VIC')))
              and mapping.postcode = btrim(shipment.postcode)
              and mapping.suburb = upper(btrim(shipment.suburb))
          )
          and rate.effective_from <= v_today
          and (rate.effective_to is null or rate.effective_to >= v_today)
      )
      union all
      select 'scheduled_overdue',
        format(
          'Scheduled On date %s has passed without changing to Out Of Delivery.',
          to_char(shipment.scheduled_for at time zone 'Australia/Melbourne', 'DD Mon YYYY')
        ),
        to_char(shipment.scheduled_for at time zone 'Australia/Melbourne', 'YYYY-MM-DD')
      where shipment.current_status = 'scheduled'
        and shipment.scheduled_for is not null
        and (shipment.scheduled_for at time zone 'Australia/Melbourne')::date < v_today
    ) as condition
    where shipment.cancelled_at is null
      and shipment.current_status not in ('completed', 'cancelled')
  ), active_key_sets as materialized (
    select id, array_agg(condition_key order by condition_type) as condition_keys
    from condition_rows
    group by id
  ), acknowledgements as materialized (
    select shipment.id, coalesce((
      select array_agg(resolved.key order by resolved.key)
      from unnest(coalesce(shipment.resolved_exception_condition_keys, '{}'::text[])) as resolved(key)
      where resolved.key = any(coalesce(active.condition_keys, '{}'::text[]))
    ), '{}'::text[]) as resolved_condition_keys
    from public.shipments as shipment
    left join active_key_sets as active on active.id = shipment.id
    where shipment.cancelled_at is null
      and shipment.current_status not in ('completed', 'cancelled')
  ), pruned as materialized (
    update public.shipments as shipment
    set resolved_exception_condition_keys = acknowledgements.resolved_condition_keys,
        updated_at = now()
    from acknowledgements
    where shipment.id = acknowledgements.id
      and shipment.resolved_exception_condition_keys is distinct from acknowledgements.resolved_condition_keys
    returning shipment.id
  ), unacknowledged as materialized (
    select condition.*
    from condition_rows as condition
    join acknowledgements on acknowledgements.id = condition.id
    cross join (select count(*) from pruned) as prune_barrier
    where condition.previous_status <> 'exception'
      and not (condition.condition_key = any(acknowledgements.resolved_condition_keys))
  ), candidates as materialized (
    select id, previous_status,
      string_agg(reason, E'\n' order by condition_type) as reason,
      array_agg(condition_key order by condition_type) as condition_keys,
      jsonb_object_agg(condition_type, condition_key) as condition_fingerprints
    from unacknowledged
    group by id, previous_status
  ), updated as (
    update public.shipments as shipment
    set current_status = 'exception',
        exception_reason = candidates.reason,
        exception_resolution_reason = null,
        exception_condition_keys = candidates.condition_keys,
        updated_at = now()
    from candidates
    where shipment.id = candidates.id
      and shipment.current_status = candidates.previous_status
    returning shipment.id, candidates.previous_status, candidates.reason,
      candidates.condition_keys, candidates.condition_fingerprints
  ), logged as (
    insert into public.shipment_events (
      shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
    )
    select updated.id, 'exception', updated.previous_status, 'exception', now(), auth.uid(), updated.reason,
      jsonb_build_object(
        'automatic', true,
        'exception_reason', updated.reason,
        'condition_keys', updated.condition_keys,
        'condition_fingerprints', updated.condition_fingerprints
      )
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
revoke all on function public.resume_completed_shipment(uuid) from public, anon;
grant execute on function public.resume_completed_shipment(uuid) to authenticated;
revoke all on function public.refresh_shipment_exceptions() from public, anon;
grant execute on function public.refresh_shipment_exceptions() to authenticated;

comment on function public.resume_completed_shipment(uuid) is
  'Returns a completed shipment to Pending, clears completion scheduling fields, and preserves shipment/event history.';

commit;
