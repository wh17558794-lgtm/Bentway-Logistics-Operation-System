-- Read-only SQL31 production preflight for pending migrations SQL32-SQL35.
-- Safe to run before deployment: no DDL/DML is performed.

do $$
declare
  v_missing text[] := '{}'::text[];
  v_column text;
begin
  foreach v_column in array array[
    'id', 'customer_id', 'current_status', 'cancelled_at', 'scheduled_for',
    'on_hold_started_at', 'outbound_method', 'outbound_at', 'volume_m3',
    'unit_price', 'tail_lift_service_fee', 'crane_required', 'crane_truck_fee',
    'fuel_levy_rate', 'fuel_levy_override', 'gst_rate',
    'warehouse_booking_charge', 'total_charge_override', 'total_charge'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'shipments' and column_name = v_column
    ) then v_missing := array_append(v_missing, 'public.shipments.' || v_column); end if;
  end loop;

  if to_regclass('public.shipment_events') is null then v_missing := array_append(v_missing, 'public.shipment_events'); end if;
  if to_regclass('public.customers') is null then v_missing := array_append(v_missing, 'public.customers'); end if;
  if to_regclass('public.delivery_suburb_rates') is null then v_missing := array_append(v_missing, 'public.delivery_suburb_rates'); end if;
  if to_regclass('private.delivery_postcode_suburbs') is null then v_missing := array_append(v_missing, 'private.delivery_postcode_suburbs'); end if;
  if to_regprocedure('private.has_any_role(text[])') is null then v_missing := array_append(v_missing, 'private.has_any_role(text[])'); end if;
  if to_regprocedure('public.archive_shipment(uuid)') is null then v_missing := array_append(v_missing, 'public.archive_shipment(uuid)'); end if;
  if to_regprocedure('public.complete_shipment(uuid,text,text)') is null then v_missing := array_append(v_missing, 'public.complete_shipment(uuid,text,text)'); end if;
  if to_regprocedure('public.mark_shipment_sms_prepared(uuid)') is null then v_missing := array_append(v_missing, 'public.mark_shipment_sms_prepared(uuid)'); end if;
  if to_regprocedure('pg_catalog.md5(text)') is null then v_missing := array_append(v_missing, 'pg_catalog.md5(text)'); end if;

  if cardinality(v_missing) > 0 then
    raise exception 'SQL31 preflight failed. Missing: %', array_to_string(v_missing, ', ');
  end if;
end;
$$;

select
  current_database() as database_name,
  current_user as checked_by,
  now() as checked_at,
  'SQL31 baseline is compatible with pending SQL32-SQL35 preflight' as result;
