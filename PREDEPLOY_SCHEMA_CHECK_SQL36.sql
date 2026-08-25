-- READ-ONLY SQL36 pre-deployment audit. Safe to run in production.
-- PASS requires every prerequisite=true and every blocker_count=0.

select 'SQL35 tables and RPCs' as check_name,
  to_regclass('public.billing_documents') is not null
  and to_regclass('public.billing_items') is not null
  and to_regclass('public.storage_episodes') is not null
  and to_regclass('public.storage_fees') is not null
  and to_regprocedure('public.finalise_draft_bill(uuid)') is not null
  and to_regprocedure('public.update_shipment_details(uuid,jsonb,text,text,timestamp with time zone)') is not null
  as prerequisite_ok;

select 'SQL36 not already applied' as check_name,
  not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='shipments' and column_name='pickup_rate_per_kg'
  ) as prerequisite_ok;

select 'Active Draft Warehouse Booking items using old GST semantics' as blocker,
  count(*) as blocker_count,
  coalesce(jsonb_agg(jsonb_build_object(
    'bill_id', item.bill_id, 'billing_item_id', item.id,
    'shipment_id', item.shipment_id, 'tracking_number', item.tracking_number
  )) filter (where item.id is not null), '[]'::jsonb) as details
from public.billing_items as item
join public.billing_documents as bill on bill.id=item.bill_id
where bill.status='draft' and item.charge_type='delivery' and item.description='Warehouse Booking';

select 'Invalid percentage Profile values for SQL36 <= 100% constraints' as blocker,
  count(*) as blocker_count,
  coalesce(jsonb_agg(jsonb_build_object(
    'customer_id', profile.customer_id,
    'fuel_rate', profile.default_fuel_levy_rate,
    'gst_rate', profile.default_gst_rate
  )) filter (where profile.customer_id is not null), '[]'::jsonb) as details
from public.customer_billing_profiles as profile
where profile.default_fuel_levy_rate not between 0 and 1
   or profile.default_gst_rate not between 0 and 1;

select 'On Hold shipments that SQL36 will repair because SQL34 missed the episode' as deployment_scope,
  count(*) as row_count,
  coalesce(jsonb_agg(jsonb_build_object(
    'shipment_id', shipment.id, 'tracking_number', shipment.tracking_number,
    'inbound_at', shipment.inbound_at, 'on_hold_started_at', shipment.on_hold_started_at,
    'volume_m3', shipment.volume_m3, 'storage_rate', shipment.storage_rate
  )) filter (where shipment.id is not null), '[]'::jsonb) as details
from public.shipments as shipment
where shipment.current_status='on_hold' and shipment.cancelled_at is null
  and not exists (
    select 1 from public.storage_episodes episode
    where episode.shipment_id=shipment.id and episode.ended_at is null
  );

select 'Missing On Hold episode rows whose Storage Rate will be repaired from Customer Profile' as deployment_scope,
  count(*) as row_count,
  coalesce(jsonb_agg(jsonb_build_object(
    'shipment_id', shipment.id, 'tracking_number', shipment.tracking_number,
    'old_storage_rate', shipment.storage_rate,
    'profile_storage_rate', profile.default_storage_rate
  )) filter (where shipment.id is not null), '[]'::jsonb) as details
from public.shipments as shipment
join public.customer_billing_profiles as profile on profile.customer_id=shipment.customer_id
where shipment.current_status='on_hold' and shipment.cancelled_at is null
  and (shipment.storage_rate is null or shipment.storage_rate <= 0)
  and profile.default_storage_rate > 0
  and not exists (
    select 1 from public.storage_episodes episode
    where episode.shipment_id=shipment.id and episode.ended_at is null
  );

select 'Unrepairable missing On Hold episodes' as blocker,
  count(*) as blocker_count,
  coalesce(jsonb_agg(shipment.tracking_number) filter (where shipment.id is not null), '[]'::jsonb) as tracking_numbers
from public.shipments as shipment
left join public.customer_billing_profiles as profile on profile.customer_id=shipment.customer_id
where shipment.current_status='on_hold' and shipment.cancelled_at is null
  and not exists (
    select 1 from public.storage_episodes episode
    where episode.shipment_id=shipment.id and episode.ended_at is null
  )
  and (
    shipment.volume_m3 is null or shipment.volume_m3 <= 0
    or coalesce(nullif(shipment.storage_rate, 0), profile.default_storage_rate) is null
    or coalesce(nullif(shipment.storage_rate, 0), profile.default_storage_rate) <= 0
    or (shipment.inbound_at at time zone 'Australia/Melbourne')::date
       > (now() at time zone 'Australia/Melbourne')::date
  );

select 'Outstanding rows whose current total SQL36 will recalculate' as deployment_scope,
  count(*) filter (where shipment.warehouse_booking_pricing) as warehouse_booking_rows,
  count(*) filter (where shipment.current_status='completed' and shipment.outbound_method='picked_up') as picked_up_rows,
  count(*) filter (where exists (
    select 1 from public.storage_fees fee where fee.shipment_id=shipment.id and fee.billed_at is null
  )) as rows_with_unbilled_storage
from public.shipments as shipment
where shipment.delivery_billed_at is null;

select 'Immutable billing/storage baselines (record before deployment)' as baseline,
  (select count(*) from public.billing_documents where status='finalised') as finalised_bills,
  (select count(*) from public.billing_items item join public.billing_documents bill on bill.id=item.bill_id where bill.status='finalised') as finalised_items,
  (select coalesce(sum(item.total_incl_gst),0) from public.billing_items item join public.billing_documents bill on bill.id=item.bill_id where bill.status='finalised') as finalised_total_incl_gst,
  (select count(*) from public.storage_fees where billed_at is not null) as billed_storage_rows,
  (select coalesce(sum(amount),0) from public.storage_fees where billed_at is not null) as billed_storage_amount;

select 'Cron contract' as check_name,
  count(*)=1
  and bool_and(active)
  and bool_and(schedule='*/5 * * * *')
  and bool_and(command='select private.generate_storage_fees();') as prerequisite_ok,
  jsonb_agg(jsonb_build_object('jobid',jobid,'active',active,'schedule',schedule,'command',command)) as details
from cron.job where jobname='bentway-storage-periods';

select n.nspname as function_schema, p.proname,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer,
  p.proconfig as function_config,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('public',p.oid,'EXECUTE') as public_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname,p.proname) in (
  ('public','complete_shipment'),('public','update_shipment_details'),
  ('public','finalise_draft_bill'),('public','save_draft_bill_changes'),
  ('public','rls_auto_enable'),('public','sync_shipment_customer'),
  ('private','generate_storage_fees'),('private','recalculate_shipment_total'),
  ('private','has_any_role')
)
order by n.nspname,p.proname;

select event_object_schema, event_object_table, trigger_name, action_timing,
  event_manipulation, action_statement
from information_schema.triggers
where event_object_schema='public'
  and event_object_table in ('shipments','storage_fees','billing_items','customer_billing_profiles')
order by event_object_table,trigger_name,event_manipulation;

select schemaname,tablename,policyname,roles,cmd,qual,with_check
from pg_policies
where schemaname='public'
  and tablename in ('shipments','customer_billing_profiles','storage_episodes','storage_fees','billing_documents','billing_items')
order by tablename,policyname;

select table_schema,table_name,grantee,privilege_type
from information_schema.role_table_grants
where table_schema in ('public','private')
  and table_name in ('shipments','customer_billing_profiles','storage_episodes','storage_fees','billing_documents','billing_items','delivery_postcode_suburbs')
  and grantee in ('anon','authenticated','PUBLIC')
order by table_schema,table_name,grantee,privilege_type;

select 'Private delivery mapping is not exposed despite no RLS' as check_name,
  not has_table_privilege('anon','private.delivery_postcode_suburbs','SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated','private.delivery_postcode_suburbs','SELECT,INSERT,UPDATE,DELETE')
  as prerequisite_ok,
  (select relrowsecurity from pg_class where oid='private.delivery_postcode_suburbs'::regclass) as rls_enabled;
