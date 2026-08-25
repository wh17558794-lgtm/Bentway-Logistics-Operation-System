-- SQL 36 - Pickup pricing, admin Billing Profiles, revised storage schedules, and permission hardening
-- EXECUTED IN PRODUCTION on 2026-08-26 after PREDEPLOY_SCHEMA_CHECK_SQL36.sql passed. Do not rerun.

begin;

do $$
begin
  if to_regclass('public.billing_documents') is null
     or to_regclass('public.billing_items') is null
     or to_regprocedure('public.finalise_draft_bill(uuid)') is null
     or to_regprocedure('public.update_shipment_details(uuid,jsonb,text,text,timestamp with time zone)') is null then
    raise exception 'SQL 35 prerequisites are missing; stop and reconcile the deployed schema';
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shipments'
      and column_name = 'pickup_rate_per_kg'
  ) then
    raise exception 'SQL 36 appears to be already applied; do not rerun a completed migration';
  end if;
  if exists (
    select 1
    from public.billing_items as item
    join public.billing_documents as bill on bill.id = item.bill_id
    where bill.status = 'draft'
      and item.charge_type = 'delivery'
      and item.description = 'Warehouse Booking'
  ) then
    raise exception 'Active Draft contains pre-SQL36 Warehouse Booking pricing. Discard and recreate that Draft before SQL36; no silent GST conversion is permitted.';
  end if;
end;
$$;

alter table public.customer_billing_profiles
  add column default_pickup_rate_per_kg numeric(14, 4) not null default 0.20,
  add column updated_by uuid;

alter table public.customer_billing_profiles
  add constraint customer_billing_profiles_pickup_rate_check
    check (default_pickup_rate_per_kg > 0),
  add constraint customer_billing_profiles_fuel_rate_upper_check
    check (default_fuel_levy_rate <= 1),
  add constraint customer_billing_profiles_gst_rate_upper_check
    check (default_gst_rate <= 1),
  add constraint customer_billing_profiles_updated_by_fkey
    foreign key (updated_by) references auth.users(id) on delete set null;

alter table public.shipments
  add column pickup_rate_per_kg numeric(14, 4);

update public.shipments as shipment
set pickup_rate_per_kg = profile.default_pickup_rate_per_kg
from public.customer_billing_profiles as profile
where profile.customer_id = shipment.customer_id
  and shipment.pickup_rate_per_kg is null;

update public.shipments set pickup_rate_per_kg = 0.20
where pickup_rate_per_kg is null;

alter table public.shipments
  alter column pickup_rate_per_kg set not null,
  alter column crane_truck_fee set default 850,
  add constraint shipments_pickup_rate_per_kg_check check (pickup_rate_per_kg > 0);

create or replace function private.create_customer_billing_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_billing_profiles (
    customer_id, legal_company_name, trading_name, default_pickup_rate_per_kg
  ) values (new.id, new.name, new.name, 0.20)
  on conflict (customer_id) do nothing;
  return new;
end;
$$;

create or replace function private.apply_customer_billing_defaults()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_profile public.customer_billing_profiles%rowtype;
begin
  if tg_op = 'UPDATE' and new.customer_id is not distinct from old.customer_id then return new; end if;

  select * into v_profile
  from public.customer_billing_profiles
  where customer_id = new.customer_id;
  if not found then raise exception 'Customer billing profile is not configured'; end if;

  if tg_op = 'INSERT' then
    -- Column defaults are already present by BEFORE INSERT. The profile must
    -- deliberately replace them so it remains the source of customer pricing.
    new.tail_lift_service_fee := v_profile.default_tail_lift_fee;
    new.fuel_levy_rate := v_profile.default_fuel_levy_rate;
    new.gst_rate := v_profile.default_gst_rate;
    new.warehouse_booking_charge := v_profile.default_warehouse_booking_fee;
    new.minimum_billable_volume := v_profile.minimum_billable_volume;
    new.storage_rate := v_profile.default_storage_rate;
  else
    if new.tail_lift_service_fee is not distinct from old.tail_lift_service_fee then new.tail_lift_service_fee := v_profile.default_tail_lift_fee; end if;
    if new.fuel_levy_rate is not distinct from old.fuel_levy_rate then new.fuel_levy_rate := v_profile.default_fuel_levy_rate; end if;
    if new.gst_rate is not distinct from old.gst_rate then new.gst_rate := v_profile.default_gst_rate; end if;
    if new.warehouse_booking_charge is not distinct from old.warehouse_booking_charge then new.warehouse_booking_charge := v_profile.default_warehouse_booking_fee; end if;
    if new.minimum_billable_volume is not distinct from old.minimum_billable_volume then new.minimum_billable_volume := v_profile.minimum_billable_volume; end if;
    if new.storage_rate is not distinct from old.storage_rate then new.storage_rate := v_profile.default_storage_rate; end if;
  end if;
  -- Pickup is always a customer snapshot on INSERT or a real customer switch.
  new.pickup_rate_per_kg := v_profile.default_pickup_rate_per_kg;
  return new;
end;
$$;

create or replace function public.update_customer_billing_profile(
  p_customer_id uuid,
  p_profile jsonb
)
returns public.customer_billing_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result public.customer_billing_profiles%rowtype;
  v_email_pattern constant text := '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
begin
  if auth.uid() is null or not private.has_any_role(array['admin']::text[]) then
    raise exception 'Admin permission is required to update Billing Profiles';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'Customer was not found';
  end if;
  if p_profile is null or jsonb_typeof(p_profile) is distinct from 'object' then
    raise exception 'Billing Profile payload must be an object';
  end if;
  if coalesce((p_profile ->> 'default_tail_lift_fee')::numeric, -1) < 0
     or coalesce((p_profile ->> 'default_storage_rate')::numeric, -1) < 0
     or coalesce((p_profile ->> 'default_warehouse_booking_fee')::numeric, -1) < 0 then
    raise exception 'Billing Profile amounts cannot be negative';
  end if;
  if coalesce((p_profile ->> 'default_pickup_rate_per_kg')::numeric, 0) <= 0 then
    raise exception 'Pickup rate per kg must be greater than zero';
  end if;
  if coalesce((p_profile ->> 'minimum_billable_volume')::numeric, 0) <= 0 then
    raise exception 'Minimum billable volume must be greater than zero';
  end if;
  if coalesce((p_profile ->> 'default_fuel_levy_rate')::numeric, -1) not between 0 and 1
     or coalesce((p_profile ->> 'default_gst_rate')::numeric, -1) not between 0 and 1 then
    raise exception 'Fuel Levy and GST rates must be decimal values from 0 to 1';
  end if;
  if coalesce(p_profile ->> 'billing_frequency', '') not in ('Weekly', 'On Demand') then
    raise exception 'Billing Frequency must be Weekly or On Demand';
  end if;
  if nullif(btrim(p_profile ->> 'billing_email'), '') is not null
     and btrim(p_profile ->> 'billing_email') !~* v_email_pattern then
    raise exception 'Billing Email is invalid';
  end if;
  if nullif(btrim(p_profile ->> 'cc_email'), '') is not null
     and btrim(p_profile ->> 'cc_email') !~* v_email_pattern then
    raise exception 'CC Email is invalid';
  end if;

  update public.customer_billing_profiles set
    legal_company_name = nullif(btrim(p_profile ->> 'legal_company_name'), ''),
    trading_name = nullif(btrim(p_profile ->> 'trading_name'), ''),
    abn = nullif(btrim(p_profile ->> 'abn'), ''),
    billing_address = nullif(btrim(p_profile ->> 'billing_address'), ''),
    billing_contact = nullif(btrim(p_profile ->> 'billing_contact'), ''),
    billing_email = nullif(btrim(p_profile ->> 'billing_email'), ''),
    cc_email = nullif(btrim(p_profile ->> 'cc_email'), ''),
    billing_phone = nullif(btrim(p_profile ->> 'billing_phone'), ''),
    billing_frequency = p_profile ->> 'billing_frequency',
    default_tail_lift_fee = (p_profile ->> 'default_tail_lift_fee')::numeric,
    default_fuel_levy_rate = (p_profile ->> 'default_fuel_levy_rate')::numeric,
    default_storage_rate = (p_profile ->> 'default_storage_rate')::numeric,
    default_gst_rate = (p_profile ->> 'default_gst_rate')::numeric,
    default_warehouse_booking_fee = (p_profile ->> 'default_warehouse_booking_fee')::numeric,
    minimum_billable_volume = (p_profile ->> 'minimum_billable_volume')::numeric,
    default_pickup_rate_per_kg = (p_profile ->> 'default_pickup_rate_per_kg')::numeric,
    updated_at = now(),
    updated_by = auth.uid()
  where customer_id = p_customer_id
  returning * into v_result;
  if not found then raise exception 'Customer Billing Profile was not found'; end if;
  return v_result;
end;
$$;

alter table public.storage_episodes
  add column start_date date,
  add column gst_rate numeric(8, 6);

update public.storage_episodes as episode
set start_date = (episode.started_at at time zone 'Australia/Melbourne')::date,
    gst_rate = shipment.gst_rate
from public.shipments as shipment
where shipment.id = episode.shipment_id
  and (episode.start_date is null or episode.gst_rate is null);

alter table public.storage_episodes
  alter column start_date set not null,
  alter column gst_rate set not null,
  add constraint storage_episodes_gst_rate_check check (gst_rate between 0 and 1);

alter table public.storage_fees
  drop constraint if exists storage_fees_episode_id_period_start_key;
create unique index storage_fees_one_current_unbilled_week_uidx
  on public.storage_fees(episode_id, period_start)
  where billed_at is null;

create table public.storage_schedule_revisions (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete restrict,
  episode_id uuid not null references public.storage_episodes(id) on delete restrict,
  previous_start_date date,
  revised_start_date date not null,
  billed_credit_count integer not null default 0 check (billed_credit_count >= 0),
  credit_required_count integer not null default 0 check (credit_required_count >= 0),
  billed_fee_ids jsonb not null default '[]'::jsonb,
  billed_actual_amount numeric(14, 3) not null default 0 check (billed_actual_amount >= 0),
  removed_draft_item_ids jsonb not null default '[]'::jsonb,
  previous_schedule jsonb not null default '{}'::jsonb,
  revised_schedule jsonb not null default '{}'::jsonb,
  reason text,
  source text not null default 'Shipment Details',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index storage_schedule_revisions_shipment_created_idx
  on public.storage_schedule_revisions(shipment_id, created_at desc);

alter table public.shipment_events drop constraint if exists shipment_events_event_type_check;
alter table public.shipment_events add constraint shipment_events_event_type_check check (event_type in (
  'inbound', 'message_sent', 'scheduled', 'on_hold', 'pending_warehouse_booking',
  'out_for_delivery', 'delivered', 'picked_up', 'warehouse_delivery', 'returned',
  'status_changed', 'warehouse_location_changed', 'details_updated', 'note_added',
  'exception', 'cancelled', 'billing_updated', 'storage_schedule_updated'
));

create or replace function private.storage_due_week_count(
  p_start_date date,
  p_ended_at timestamptz,
  p_as_of timestamptz default now()
)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_until timestamptz := coalesce(p_ended_at, p_as_of);
  v_count integer := 1;
begin
  if p_start_date is null then return 0; end if;
  while v_until >= (((p_start_date + (v_count * 7 - 1))::timestamp + time '23:55') at time zone 'Australia/Melbourne') loop
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function private.rebuild_storage_unbilled(
  p_episode_id uuid,
  p_as_of timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_episode public.storage_episodes%rowtype;
  v_due integer;
  v_billed integer;
  v_index integer;
  v_created integer := 0;
  v_start date;
begin
  select * into v_episode from public.storage_episodes where id = p_episode_id for update;
  if not found then raise exception 'Storage episode was not found'; end if;
  v_due := private.storage_due_week_count(v_episode.start_date, v_episode.ended_at, p_as_of);
  select count(*) into v_billed from public.storage_fees
  where episode_id = p_episode_id and billed_at is not null;
  if v_due <= v_billed then return 0; end if;

  for v_index in v_billed .. v_due - 1 loop
    v_start := v_episode.start_date + (v_index * 7);
    insert into public.storage_fees (shipment_id, episode_id, period_start, period_end, amount)
    values (
      v_episode.shipment_id, v_episode.id, v_start, v_start + 6,
      round(v_episode.volume_m3 * v_episode.rate_per_m3, 3)
    ) on conflict (episode_id, period_start) where billed_at is null do nothing;
    if found then v_created := v_created + 1; end if;
  end loop;
  return v_created;
end;
$$;

create or replace function private.storage_schedule_snapshot(
  p_episode_id uuid,
  p_as_of timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_episode public.storage_episodes%rowtype;
  v_due integer;
  v_billed integer;
  v_credit_required integer;
  v_index integer;
  v_start date;
  v_fee public.storage_fees%rowtype;
  v_weeks jsonb := '[]'::jsonb;
  v_history jsonb;
begin
  select * into v_episode from public.storage_episodes where id = p_episode_id;
  if not found then raise exception 'Storage episode was not found'; end if;
  v_due := private.storage_due_week_count(v_episode.start_date, v_episode.ended_at, p_as_of);
  select count(*) into v_billed from public.storage_fees
  where episode_id = p_episode_id and billed_at is not null;
  v_credit_required := greatest(v_billed - v_due, 0);

  for v_index in 0 .. v_due - 1 loop
    v_start := v_episode.start_date + (v_index * 7);
    if v_index < v_billed then
      select * into v_fee from public.storage_fees
      where episode_id = p_episode_id and billed_at is not null
      order by period_start, created_at offset v_index limit 1;
      v_weeks := v_weeks || jsonb_build_array(jsonb_build_object(
        'week_number', v_index + 1, 'period_start', v_start, 'period_end', v_start + 6,
        'amount_ex_gst', round(v_episode.volume_m3 * v_episode.rate_per_m3, 3),
        'gst_rate', v_episode.gst_rate, 'status', 'covered_by_billed_credit',
        'selectable', false, 'billed_fee_id', v_fee.id
      ));
    else
      select * into v_fee from public.storage_fees
      where episode_id = p_episode_id and billed_at is null and period_start = v_start
      order by created_at desc limit 1;
      v_weeks := v_weeks || jsonb_build_array(jsonb_build_object(
        'week_number', v_index + 1, 'period_start', v_start, 'period_end', v_start + 6,
        'amount_ex_gst', round(v_episode.volume_m3 * v_episode.rate_per_m3, 3),
        'gst_rate', v_episode.gst_rate,
        'status', case when v_fee.id is null then 'missing' else 'unbilled' end,
        'selectable', v_fee.id is not null, 'storage_fee_id', v_fee.id
      ));
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'storage_fee_id', fee.id, 'period_start', fee.period_start, 'period_end', fee.period_end,
    'amount_ex_gst', fee.amount, 'billed_at', fee.billed_at, 'bill_id', fee.bill_id,
    'status', 'billed_history', 'selectable', false
  ) order by fee.period_start, fee.created_at), '[]'::jsonb)
  into v_history
  from public.storage_fees as fee
  where fee.episode_id = p_episode_id and fee.billed_at is not null;

  return jsonb_build_object(
    'episode_id', v_episode.id, 'shipment_id', v_episode.shipment_id,
    'start_date', v_episode.start_date, 'ended_at', v_episode.ended_at,
    'volume_m3', v_episode.volume_m3, 'rate_per_m3', v_episode.rate_per_m3,
    'gst_rate', v_episode.gst_rate, 'weekly_amount_ex_gst', round(v_episode.volume_m3 * v_episode.rate_per_m3, 3),
    'due_week_count', v_due, 'billed_credit_count', least(v_billed, v_due),
    'credit_required_count', v_credit_required, 'weeks', v_weeks, 'billed_history', v_history
  );
end;
$$;

create or replace function public.get_storage_schedule(p_shipment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_episode record;
  v_episodes jsonb := '[]'::jsonb;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin','operations','warehouse','viewer']::text[]) then
    raise exception 'Permission denied';
  end if;
  for v_episode in
    select id from public.storage_episodes where shipment_id = p_shipment_id order by start_date, created_at
  loop
    v_episodes := v_episodes || jsonb_build_array(private.storage_schedule_snapshot(v_episode.id));
  end loop;
  return jsonb_build_object('shipment_id', p_shipment_id, 'episodes', v_episodes);
end;
$$;

create or replace function public.preview_storage_schedule_change(
  p_shipment_id uuid,
  p_new_start_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment public.shipments%rowtype;
  v_episode public.storage_episodes%rowtype;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
  v_inbound_date date;
  v_end_date date;
  v_due integer;
  v_billed integer := 0;
  v_billed_amount numeric(14, 3) := 0;
  v_billed_ids jsonb := '[]'::jsonb;
  v_removed_ids jsonb := '[]'::jsonb;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin','operations','warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;
  select * into v_shipment from public.shipments where id = p_shipment_id and cancelled_at is null;
  if not found then raise exception 'Shipment was not found'; end if;
  v_inbound_date := (v_shipment.inbound_at at time zone 'Australia/Melbourne')::date;
  if p_new_start_date < v_inbound_date then
    raise exception 'Storage Start Date cannot be earlier than Inbound Time (%).', to_char(v_inbound_date, 'DD Mon YYYY');
  end if;
  if p_new_start_date > v_today then
    raise exception 'Storage Start Date cannot be after today in Melbourne';
  end if;

  select * into v_episode from public.storage_episodes
  where shipment_id = p_shipment_id and ended_at is null
  order by created_at desc limit 1;
  if not found then
    select * into v_episode from public.storage_episodes
    where shipment_id = p_shipment_id order by created_at desc limit 1;
  end if;
  if found then
    v_end_date := case when v_episode.ended_at is null then null else (v_episode.ended_at at time zone 'Australia/Melbourne')::date end;
    if v_end_date is not null and p_new_start_date > v_end_date then
      raise exception 'Storage Start Date cannot be after the Storage episode end date';
    end if;
    select count(*), coalesce(sum(amount), 0), coalesce(jsonb_agg(id order by period_start), '[]'::jsonb)
      into v_billed, v_billed_amount, v_billed_ids
    from public.storage_fees where episode_id = v_episode.id and billed_at is not null;
    select coalesce(jsonb_agg(item.id order by item.created_at), '[]'::jsonb)
      into v_removed_ids
    from public.billing_items as item
    join public.billing_documents as bill on bill.id = item.bill_id and bill.status = 'draft'
    join public.storage_fees as fee on fee.id = item.source_id and item.charge_type = 'storage'
    where fee.episode_id = v_episode.id and fee.billed_at is null;
    v_due := private.storage_due_week_count(p_new_start_date, v_episode.ended_at, now());
  else
    if v_shipment.volume_m3 is null or v_shipment.volume_m3 <= 0 then
      raise exception 'Shipment volume is required before starting Storage';
    end if;
    if v_shipment.storage_rate is null or v_shipment.storage_rate <= 0 then
      raise exception 'Storage rate is not configured for this customer';
    end if;
    v_due := private.storage_due_week_count(p_new_start_date, null, now());
  end if;

  return jsonb_build_object(
    'shipment_id', p_shipment_id, 'episode_id', v_episode.id,
    'old_start_date', v_episode.start_date, 'new_start_date', p_new_start_date,
    'due_week_count', v_due, 'billed_credit_count', least(v_billed, v_due),
    'unbilled_week_count', greatest(v_due - v_billed, 0),
    'credit_required_count', greatest(v_billed - v_due, 0),
    'billed_fee_ids', v_billed_ids, 'billed_actual_amount', v_billed_amount,
    'removed_draft_item_ids', v_removed_ids,
    'weekly_amount_ex_gst', round(coalesce(v_episode.volume_m3, v_shipment.volume_m3) * coalesce(v_episode.rate_per_m3, v_shipment.storage_rate), 3)
  );
end;
$$;

create or replace function private.apply_storage_schedule_change_internal(
  p_shipment_id uuid,
  p_new_start_date date,
  p_reason text,
  p_source text,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment public.shipments%rowtype;
  v_episode public.storage_episodes%rowtype;
  v_preview jsonb;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb;
  v_removed_ids jsonb := '[]'::jsonb;
  v_revision_id uuid;
begin
  select * into v_shipment from public.shipments where id = p_shipment_id and cancelled_at is null for update;
  if not found then raise exception 'Shipment was not found'; end if;
  if v_shipment.current_status <> 'on_hold' then raise exception 'Storage schedule can only be changed while Shipment is On Hold'; end if;
  v_preview := public.preview_storage_schedule_change(p_shipment_id, p_new_start_date);

  select * into v_episode from public.storage_episodes
  where shipment_id = p_shipment_id and ended_at is null for update;
  if not found then
    insert into public.storage_episodes (
      shipment_id, started_at, start_date, rate_per_m3, volume_m3, gst_rate
    ) values (
      p_shipment_id,
      ((p_new_start_date::timestamp + time '12:00') at time zone 'Australia/Melbourne'),
      p_new_start_date, v_shipment.storage_rate, v_shipment.volume_m3, v_shipment.gst_rate
    ) returning * into v_episode;
  else
    v_before := private.storage_schedule_snapshot(v_episode.id);
    select coalesce(jsonb_agg(item.id order by item.created_at), '[]'::jsonb)
      into v_removed_ids
    from public.billing_items as item
    join public.billing_documents as bill on bill.id = item.bill_id and bill.status = 'draft'
    join public.storage_fees as fee on fee.id = item.source_id and item.charge_type = 'storage'
    where fee.episode_id = v_episode.id and fee.billed_at is null;
    delete from public.billing_items as item
    using public.billing_documents as bill, public.storage_fees as fee
    where item.bill_id = bill.id and bill.status = 'draft'
      and item.charge_type = 'storage' and item.source_id = fee.id
      and fee.episode_id = v_episode.id and fee.billed_at is null;
    delete from public.storage_fees where episode_id = v_episode.id and billed_at is null;
    update public.storage_episodes set
      start_date = p_new_start_date,
      started_at = ((p_new_start_date::timestamp + time '12:00') at time zone 'Australia/Melbourne')
    where id = v_episode.id returning * into v_episode;
  end if;

  update public.shipments set
    on_hold_started_at = ((p_new_start_date::timestamp + time '12:00') at time zone 'Australia/Melbourne')
  where id = p_shipment_id;
  perform private.rebuild_storage_unbilled(v_episode.id, now());
  v_after := private.storage_schedule_snapshot(v_episode.id);

  insert into public.storage_schedule_revisions (
    shipment_id, episode_id, previous_start_date, revised_start_date,
    billed_credit_count, credit_required_count, billed_fee_ids, billed_actual_amount,
    removed_draft_item_ids, previous_schedule, revised_schedule, reason, source, created_by
  ) values (
    p_shipment_id, v_episode.id, (v_preview ->> 'old_start_date')::date, p_new_start_date,
    (v_preview ->> 'billed_credit_count')::integer,
    (v_preview ->> 'credit_required_count')::integer,
    coalesce(v_preview -> 'billed_fee_ids', '[]'::jsonb),
    coalesce((v_preview ->> 'billed_actual_amount')::numeric, 0),
    v_removed_ids, v_before, v_after, nullif(btrim(p_reason), ''), coalesce(nullif(p_source, ''), 'Shipment Details'), p_actor
  ) returning id into v_revision_id;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
  ) values (
    p_shipment_id, 'storage_schedule_updated', v_shipment.current_status, v_shipment.current_status,
    now(), p_actor, 'Storage Schedule Updated', jsonb_build_object(
      'source', coalesce(nullif(p_source, ''), 'Shipment Details'), 'revision_id', v_revision_id,
      'old_start_date', v_preview -> 'old_start_date', 'new_start_date', p_new_start_date,
      'billed_credit_count', v_preview -> 'billed_credit_count',
      'credit_required_count', v_preview -> 'credit_required_count',
      'billed_fee_ids', v_preview -> 'billed_fee_ids',
      'billed_actual_amount', v_preview -> 'billed_actual_amount',
      'removed_draft_item_ids', v_removed_ids, 'reason', nullif(btrim(p_reason), '')
    )
  );
  perform private.recalculate_shipment_total(p_shipment_id);
  return v_after || jsonb_build_object('revision_id', v_revision_id, 'removed_draft_item_ids', v_removed_ids);
end;
$$;

create or replace function public.apply_storage_schedule_change(
  p_shipment_id uuid,
  p_new_start_date date,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.has_any_role(array['admin']::text[]) then
    raise exception 'Admin permission is required to revise Storage Start Date';
  end if;
  return private.apply_storage_schedule_change_internal(
    p_shipment_id, p_new_start_date, p_reason, 'Shipment Details', auth.uid()
  );
end;
$$;

create or replace function private.validate_on_hold_storage_rate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_start_date date;
  v_inbound_date date;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
begin
  if new.current_status = 'on_hold'
     and (tg_op = 'INSERT' or old.current_status is distinct from 'on_hold') then
    if new.storage_rate is null then
      select default_storage_rate into new.storage_rate
      from public.customer_billing_profiles where customer_id = new.customer_id;
    end if;
    if new.storage_rate is null or new.storage_rate <= 0 then
      raise exception 'Storage rate is not configured for this customer';
    end if;
    if new.volume_m3 is null or new.volume_m3 <= 0 then
      raise exception 'Shipment volume is required before entering On Hold';
    end if;
    v_start_date := (coalesce(new.on_hold_started_at, now()) at time zone 'Australia/Melbourne')::date;
    v_inbound_date := (new.inbound_at at time zone 'Australia/Melbourne')::date;
    if v_start_date < v_inbound_date then
      raise exception 'Storage Start Date cannot be earlier than Inbound Time (%)', to_char(v_inbound_date, 'DD Mon YYYY');
    end if;
    if v_start_date > v_today then
      raise exception 'Storage Start Date cannot be after today in Melbourne';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.sync_storage_episode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_episode_id uuid;
  v_started_at timestamptz;
  v_start_date date;
begin
  if new.current_status = 'on_hold'
     and (tg_op = 'INSERT' or old.current_status is distinct from 'on_hold') then
    v_started_at := coalesce(new.on_hold_started_at, now());
    v_start_date := (v_started_at at time zone 'Australia/Melbourne')::date;
    insert into public.storage_episodes (
      shipment_id, started_at, start_date, rate_per_m3, volume_m3, gst_rate
    ) values (
      new.id, v_started_at, v_start_date, new.storage_rate, new.volume_m3, new.gst_rate
    ) returning id into v_episode_id;
    perform private.rebuild_storage_unbilled(v_episode_id, now());
  elsif tg_op = 'UPDATE' and old.current_status = 'on_hold' and new.current_status is distinct from 'on_hold' then
    select id into v_episode_id from public.storage_episodes
    where shipment_id = new.id and ended_at is null for update;
    if v_episode_id is not null then
      perform private.rebuild_storage_unbilled(v_episode_id, now());
      update public.storage_episodes set ended_at = now() where id = v_episode_id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.generate_storage_fees()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_episode public.storage_episodes%rowtype;
  v_due integer;
  v_existing integer;
  v_start date;
  v_created integer := 0;
begin
  for v_episode in
    select episode.* from public.storage_episodes as episode
    join public.shipments as shipment on shipment.id = episode.shipment_id
    where episode.ended_at is null and shipment.current_status = 'on_hold'
    order by episode.created_at
  loop
    v_due := private.storage_due_week_count(v_episode.start_date, null, now());
    select count(*) into v_existing from public.storage_fees where episode_id = v_episode.id;
    if v_existing < v_due then
      v_start := v_episode.start_date + (v_existing * 7);
      insert into public.storage_fees (shipment_id, episode_id, period_start, period_end, amount)
      values (v_episode.shipment_id, v_episode.id, v_start, v_start + 6,
        round(v_episode.volume_m3 * v_episode.rate_per_m3, 3))
      on conflict (episode_id, period_start) where billed_at is null do nothing;
      if found then v_created := v_created + 1; end if;
    end if;
  end loop;
  return v_created;
end;
$$;

create or replace function private.recalculate_shipment_total(p_shipment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment public.shipments%rowtype;
  v_storage_ex numeric(14, 3);
  v_storage_incl numeric(14, 3);
  v_delivery numeric(14, 6);
  v_fuel numeric(14, 6);
  v_service numeric(14, 3);
  v_core_ex numeric(14, 3);
  v_total numeric(14, 3);
begin
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found then return; end if;

  select coalesce(sum(fee.amount), 0),
         coalesce(sum(fee.amount * (1 + episode.gst_rate)), 0)
    into v_storage_ex, v_storage_incl
  from public.storage_fees as fee
  join public.storage_episodes as episode on episode.id = fee.episode_id
  where fee.shipment_id = p_shipment_id and fee.billed_at is null;

  if v_shipment.warehouse_booking_pricing then
    v_core_ex := coalesce(v_shipment.warehouse_booking_charge, 150);
    v_total := round(v_core_ex * (1 + v_shipment.gst_rate) + v_storage_incl, 3);
  elsif v_shipment.current_status = 'completed' and v_shipment.outbound_method = 'picked_up' then
    if v_shipment.weight_kg is null or v_shipment.weight_kg <= 0
       or v_shipment.pickup_rate_per_kg is null or v_shipment.pickup_rate_per_kg <= 0 then
      v_total := null;
    else
      v_core_ex := round(v_shipment.weight_kg * v_shipment.pickup_rate_per_kg, 3);
      v_total := round(v_core_ex * (1 + v_shipment.gst_rate) + v_storage_incl, 3);
    end if;
  elsif v_shipment.total_charge_override is not null then
    -- Existing manual overrides remain GST-inclusive delivery cores.
    v_total := round(v_shipment.total_charge_override + v_storage_incl, 3);
  elsif v_shipment.volume_m3 is null or v_shipment.unit_price is null then
    v_total := null;
  else
    v_delivery := greatest(v_shipment.volume_m3, v_shipment.minimum_billable_volume) * v_shipment.unit_price;
    v_fuel := coalesce(v_shipment.fuel_levy_override, v_delivery * v_shipment.fuel_levy_rate);
    v_service := case when v_shipment.crane_required
      then coalesce(v_shipment.crane_truck_fee, 0)
      else coalesce(v_shipment.tail_lift_service_fee, 0)
    end;
    v_core_ex := v_delivery + v_service + v_fuel;
    v_total := round(v_core_ex * (1 + v_shipment.gst_rate) + v_storage_incl, 3);
  end if;

  update public.shipments set total_charge = v_total where id = p_shipment_id;
end;
$$;

drop trigger if exists recalculate_shipment_total_trigger on public.shipments;
create trigger recalculate_shipment_total_trigger
after insert or update of current_status, outbound_method, warehouse_booking_pricing, volume_m3, weight_kg,
  pickup_rate_per_kg, unit_price, minimum_billable_volume, tail_lift_service_fee,
  crane_required, crane_truck_fee, fuel_levy_rate, fuel_levy_override, gst_rate,
  warehouse_booking_charge, total_charge_override
on public.shipments
for each row execute function private.recalculate_shipment_total_trigger();

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
  v_previous public.shipments%rowtype;
  v_completed_at timestamptz := now();
  v_result public.shipments%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;
  if p_outbound_method is null
     or p_outbound_method not in ('delivered', 'picked_up', 'warehouse_delivery', 'returned') then
    raise exception 'Invalid outbound method';
  end if;

  select * into v_previous from public.shipments
  where id = p_shipment_id and cancelled_at is null for update;
  if not found then raise exception 'Shipment not found'; end if;
  if v_previous.current_status in ('completed', 'cancelled') then raise exception 'Shipment is already closed'; end if;
  if v_previous.current_status = 'exception' then raise exception 'Exception shipments must be resolved from Shipment Details'; end if;
  if p_outbound_method = 'warehouse_delivery'
     and v_previous.current_status <> 'pending_warehouse_booking' then
    raise exception 'DTW completion requires Pending Warehouse Booking';
  end if;
  if p_outbound_method = 'picked_up' and (v_previous.weight_kg is null or v_previous.weight_kg <= 0) then
    raise exception 'Weight must be greater than zero before completing Shipment as Picked Up';
  end if;
  if p_outbound_method = 'picked_up'
     and (v_previous.pickup_rate_per_kg is null or v_previous.pickup_rate_per_kg <= 0) then
    raise exception 'Pickup rate per kg must be greater than zero before completing Shipment as Picked Up';
  end if;

  update public.shipments
  set current_status = 'completed', outbound_method = p_outbound_method, outbound_at = v_completed_at
  where id = p_shipment_id returning * into v_result;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, outbound_method,
    event_at, performed_by, notes
  ) values (
    p_shipment_id, p_outbound_method, v_previous.current_status, 'completed', p_outbound_method,
    v_completed_at, auth.uid(), p_notes
  );
  return v_result;
end;
$$;

create or replace function public.update_shipment_details(
  p_shipment_id uuid,
  p_payload jsonb,
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
  v_before public.shipments%rowtype;
  v_after public.shipments%rowtype;
  v_episode public.storage_episodes%rowtype;
  v_status_date_changed boolean;
  v_requested_storage_start date;
  v_final_inbound_date date;
  v_old_values jsonb;
  v_new_values jsonb;
  v_changed_fields jsonb := '[]'::jsonb;
  v_changed_old jsonb := '{}'::jsonb;
  v_changed_new jsonb := '{}'::jsonb;
  v_key text;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'You do not have permission to update shipments';
  end if;
  select * into v_before from public.shipments
  where id = p_shipment_id and cancelled_at is null for update;
  if not found then raise exception 'Shipment was not found'; end if;

  select * into v_episode from public.storage_episodes
  where shipment_id = p_shipment_id and ended_at is null for update;
  v_requested_storage_start := case
    when p_new_status = 'on_hold' and p_scheduled_for is not null
      then (p_scheduled_for at time zone 'Australia/Melbourne')::date
    else v_episode.start_date
  end;
  v_final_inbound_date := (
    case when p_payload ? 'inbound_at' then (p_payload ->> 'inbound_at')::timestamptz else v_before.inbound_at end
    at time zone 'Australia/Melbourne'
  )::date;
  if v_episode.id is not null and v_final_inbound_date > v_requested_storage_start then
    raise exception 'Inbound Time cannot be after Storage Start Date (%). Revise both dates in the same save.',
      to_char(v_requested_storage_start, 'DD Mon YYYY');
  end if;

  update public.shipments set
    tracking_number = case when p_payload ? 'tracking_number' then p_payload ->> 'tracking_number' else tracking_number end,
    customer_id = case when p_payload ? 'customer_id' then (p_payload ->> 'customer_id')::uuid else customer_id end,
    customer_reference = case when p_payload ? 'customer_reference' then nullif(p_payload ->> 'customer_reference', '') else customer_reference end,
    container_number = case when p_payload ? 'container_number' then nullif(p_payload ->> 'container_number', '') else container_number end,
    quantity = case when p_payload ? 'quantity' then (p_payload ->> 'quantity')::integer else quantity end,
    total_quantity = case when p_payload ? 'total_quantity' then (p_payload ->> 'total_quantity')::integer else total_quantity end,
    weight_kg = case when p_payload ? 'weight_kg' then nullif(p_payload ->> 'weight_kg', '')::numeric else weight_kg end,
    volume_m3 = case when p_payload ? 'volume_m3' then nullif(p_payload ->> 'volume_m3', '')::numeric else volume_m3 end,
    tail_lift_service_fee = case when p_payload ? 'tail_lift_service_fee' then (p_payload ->> 'tail_lift_service_fee')::numeric else tail_lift_service_fee end,
    crane_required = case when p_payload ? 'crane_required' then (p_payload ->> 'crane_required')::boolean else crane_required end,
    crane_truck_fee = case
      when coalesce(case when p_payload ? 'crane_required' then (p_payload ->> 'crane_required')::boolean else crane_required end, false)
        and coalesce(case when p_payload ? 'crane_truck_fee' then nullif(p_payload ->> 'crane_truck_fee', '')::numeric else crane_truck_fee end, 0) <= 0
        then 850
      when p_payload ? 'crane_truck_fee' then nullif(p_payload ->> 'crane_truck_fee', '')::numeric
      else crane_truck_fee
    end,
    fuel_levy_override = case when p_payload ? 'fuel_levy_override' then nullif(p_payload ->> 'fuel_levy_override', '')::numeric else fuel_levy_override end,
    total_charge_override = case when p_payload ? 'total_charge_override' then nullif(p_payload ->> 'total_charge_override', '')::numeric else total_charge_override end,
    warehouse_booking_charge = case when p_payload ? 'warehouse_booking_charge' then (p_payload ->> 'warehouse_booking_charge')::numeric else warehouse_booking_charge end,
    recipient_name = case when p_payload ? 'recipient_name' then nullif(p_payload ->> 'recipient_name', '') else recipient_name end,
    delivery_address = case when p_payload ? 'delivery_address' then p_payload ->> 'delivery_address' else delivery_address end,
    suburb = case when p_payload ? 'suburb' then nullif(p_payload ->> 'suburb', '') else suburb end,
    state = case when p_payload ? 'state' then nullif(p_payload ->> 'state', '') else state end,
    postcode = case when p_payload ? 'postcode' then nullif(p_payload ->> 'postcode', '') else postcode end,
    warehouse_location = case when p_payload ? 'warehouse_location' then nullif(p_payload ->> 'warehouse_location', '') else warehouse_location end,
    delivery_instructions = case when p_payload ? 'delivery_instructions' then nullif(p_payload ->> 'delivery_instructions', '') else delivery_instructions end,
    notes = case when p_payload ? 'notes' then nullif(p_payload ->> 'notes', '') else notes end,
    source_data = case when p_payload ? 'source_data' then p_payload -> 'source_data' else source_data end,
    inbound_at = case when p_payload ? 'inbound_at' then (p_payload ->> 'inbound_at')::timestamptz else inbound_at end,
    exception_reason = case when p_payload ? 'exception_reason' then nullif(p_payload ->> 'exception_reason', '') else exception_reason end,
    exception_resolution_reason = case when p_payload ? 'exception_resolution_reason' then nullif(p_payload ->> 'exception_resolution_reason', '') else exception_resolution_reason end,
    updated_at = now()
  where id = p_shipment_id;

  v_status_date_changed := p_new_status in ('scheduled', 'on_hold') and (
    case when p_new_status = 'scheduled' then v_before.scheduled_for else v_before.on_hold_started_at end
  ) is distinct from p_scheduled_for;
  if v_before.current_status = 'on_hold' and p_new_status = 'on_hold' and v_status_date_changed then
    if not private.has_any_role(array['admin']::text[]) then
      raise exception 'Admin permission is required to revise Storage Start Date';
    end if;
    perform private.apply_storage_schedule_change_internal(
      p_shipment_id, v_requested_storage_start, p_notes, 'Shipment Details', auth.uid()
    );
    select * into v_after from public.shipments where id = p_shipment_id;
  elsif p_new_status is distinct from v_before.current_status or v_status_date_changed then
    select * into v_after from public.set_shipment_status(
      p_shipment_id, p_new_status, p_notes, p_scheduled_for
    );
  else
    select * into v_after from public.shipments where id = p_shipment_id;
  end if;

  v_old_values := jsonb_build_object(
    'tracking_number', v_before.tracking_number, 'customer_id', v_before.customer_id,
    'customer_reference', v_before.customer_reference, 'container_number', v_before.container_number,
    'quantity', v_before.quantity, 'total_quantity', v_before.total_quantity,
    'weight_kg', v_before.weight_kg, 'volume_m3', v_before.volume_m3,
    'recipient_name', v_before.recipient_name,
    'phone', coalesce(v_before.source_data ->> 'phone', v_before.source_data ->> 'recipient_phone'),
    'delivery_address', v_before.delivery_address, 'suburb', v_before.suburb,
    'state', v_before.state, 'postcode', v_before.postcode, 'inbound_at', v_before.inbound_at,
    'warehouse_location', v_before.warehouse_location,
    'delivery_instructions', v_before.delivery_instructions, 'notes', v_before.notes,
    'tail_lift_service_fee', v_before.tail_lift_service_fee,
    'crane_required', v_before.crane_required, 'crane_truck_fee', v_before.crane_truck_fee,
    'fuel_levy_override', v_before.fuel_levy_override,
    'warehouse_booking_charge', v_before.warehouse_booking_charge,
    'exception_reason', v_before.exception_reason,
    'exception_resolution_reason', v_before.exception_resolution_reason
  );
  v_new_values := jsonb_build_object(
    'tracking_number', v_after.tracking_number, 'customer_id', v_after.customer_id,
    'customer_reference', v_after.customer_reference, 'container_number', v_after.container_number,
    'quantity', v_after.quantity, 'total_quantity', v_after.total_quantity,
    'weight_kg', v_after.weight_kg, 'volume_m3', v_after.volume_m3,
    'recipient_name', v_after.recipient_name,
    'phone', coalesce(v_after.source_data ->> 'phone', v_after.source_data ->> 'recipient_phone'),
    'delivery_address', v_after.delivery_address, 'suburb', v_after.suburb,
    'state', v_after.state, 'postcode', v_after.postcode, 'inbound_at', v_after.inbound_at,
    'warehouse_location', v_after.warehouse_location,
    'delivery_instructions', v_after.delivery_instructions, 'notes', v_after.notes,
    'tail_lift_service_fee', v_after.tail_lift_service_fee,
    'crane_required', v_after.crane_required, 'crane_truck_fee', v_after.crane_truck_fee,
    'fuel_levy_override', v_after.fuel_levy_override,
    'warehouse_booking_charge', v_after.warehouse_booking_charge,
    'exception_reason', v_after.exception_reason,
    'exception_resolution_reason', v_after.exception_resolution_reason
  );
  for v_key in select jsonb_object_keys(v_old_values) loop
    if v_old_values -> v_key is distinct from v_new_values -> v_key then
      v_changed_fields := v_changed_fields || jsonb_build_array(v_key);
      v_changed_old := v_changed_old || jsonb_build_object(v_key, v_old_values -> v_key);
      v_changed_new := v_changed_new || jsonb_build_object(v_key, v_new_values -> v_key);
    end if;
  end loop;
  if jsonb_array_length(v_changed_fields) > 0 then
    insert into public.shipment_events (
      shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
    ) values (
      p_shipment_id, 'details_updated', v_before.current_status, v_after.current_status,
      now(), auth.uid(), 'Shipment details updated', jsonb_build_object(
        'source', 'Shipment Details', 'changed_fields', v_changed_fields,
        'old_values', v_changed_old, 'new_values', v_changed_new
      )
    );
  end if;
  return v_after;
end;
$$;

-- Repair only the explicit SQL34 defect: current On Hold shipments with no open episode.
-- This never touches billed storage rows or finalised Billing Items.
update public.shipments as shipment
set storage_rate = profile.default_storage_rate
from public.customer_billing_profiles as profile
where profile.customer_id = shipment.customer_id
  and shipment.current_status = 'on_hold'
  and shipment.cancelled_at is null
  and (shipment.storage_rate is null or shipment.storage_rate <= 0)
  and profile.default_storage_rate > 0
  and not exists (
    select 1 from public.storage_episodes as episode
    where episode.shipment_id = shipment.id and episode.ended_at is null
  );

do $$
declare
  v_shipment public.shipments%rowtype;
  v_start_date date;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
  v_episode_id uuid;
  v_schedule jsonb;
begin
  for v_shipment in
    select shipment.* from public.shipments as shipment
    where shipment.current_status = 'on_hold' and shipment.cancelled_at is null
      and not exists (
        select 1 from public.storage_episodes as episode
        where episode.shipment_id = shipment.id and episode.ended_at is null
      )
    for update
  loop
    if v_shipment.volume_m3 is null or v_shipment.volume_m3 <= 0
       or v_shipment.storage_rate is null or v_shipment.storage_rate <= 0 then
      raise exception 'Cannot repair missing Storage episode for shipment %: Volume and Storage Rate must be positive', v_shipment.tracking_number;
    end if;
    v_start_date := greatest(
      (v_shipment.inbound_at at time zone 'Australia/Melbourne')::date,
      coalesce((v_shipment.on_hold_started_at at time zone 'Australia/Melbourne')::date, v_today)
    );
    if v_start_date > v_today then
      raise exception 'Cannot repair missing Storage episode for shipment %: start date is after Melbourne today', v_shipment.tracking_number;
    end if;
    insert into public.storage_episodes (
      shipment_id, started_at, start_date, rate_per_m3, volume_m3, gst_rate
    ) values (
      v_shipment.id,
      ((v_start_date::timestamp + time '12:00') at time zone 'Australia/Melbourne'),
      v_start_date, v_shipment.storage_rate, v_shipment.volume_m3, v_shipment.gst_rate
    ) returning id into v_episode_id;
    perform private.rebuild_storage_unbilled(v_episode_id, now());
    v_schedule := private.storage_schedule_snapshot(v_episode_id);
    insert into public.storage_schedule_revisions (
      shipment_id, episode_id, revised_start_date, revised_schedule, reason, source
    ) values (
      v_shipment.id, v_episode_id, v_start_date, v_schedule,
      'Repaired current On Hold shipment missing its SQL34 Storage episode', 'SQL36 migration repair'
    );
    insert into public.shipment_events (
      shipment_id, event_type, from_status, to_status, event_at, notes, metadata
    ) values (
      v_shipment.id, 'storage_schedule_updated', 'on_hold', 'on_hold', now(),
      'Storage Schedule Updated', jsonb_build_object(
        'source', 'SQL36 migration repair', 'new_start_date', v_start_date,
        'reason', 'Missing open Storage episode repaired'
      )
    );
  end loop;
end;
$$;

-- Recalculate only outstanding rows affected by SQL36 semantics. Finalised Delivery snapshots stay immutable.
select private.recalculate_shipment_total(shipment.id)
from public.shipments as shipment
where shipment.delivery_billed_at is null
  and (
    shipment.warehouse_booking_pricing
    or (shipment.current_status = 'completed' and shipment.outbound_method = 'picked_up')
    or exists (select 1 from public.storage_fees fee where fee.shipment_id = shipment.id and fee.billed_at is null)
  );

create or replace function private.add_draft_bill_items(p_bill_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill public.billing_documents%rowtype;
  v_item jsonb;
  v_type text;
  v_source_id uuid;
  v_customer_id uuid;
  v_shipment public.shipments%rowtype;
  v_storage public.storage_fees%rowtype;
  v_container public.container_service_fees%rowtype;
  v_crane public.crane_service_charges%rowtype;
  v_delivery numeric(14, 3);
  v_service numeric(14, 3);
  v_fuel numeric(14, 3);
  v_amount numeric(14, 3);
  v_gst numeric(8, 6);
  v_gst_amount numeric(14, 3);
  v_total numeric(14, 3);
  v_description text;
  v_components jsonb;
  v_snapshot jsonb;
begin
  select * into v_bill from public.billing_documents where id = p_bill_id for update;
  if not found or v_bill.status <> 'draft' then raise exception 'Draft Bill was not found'; end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Charges must be an array'; end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_type := v_item ->> 'type';
    v_source_id := (v_item ->> 'id')::uuid;
    v_snapshot := '{}'::jsonb;

    if v_type = 'delivery' then
      select * into v_shipment from public.shipments where id = v_source_id for update;
      if not found then raise exception 'Shipment delivery charge not found'; end if;
      if v_shipment.delivery_billed_at is not null then raise exception 'Delivery charge for % is already billed', v_shipment.tracking_number; end if;
      v_customer_id := v_shipment.customer_id;
      v_gst := v_shipment.gst_rate;
      if v_shipment.current_status = 'completed' and v_shipment.outbound_method = 'picked_up' then
        if v_shipment.weight_kg is null or v_shipment.weight_kg <= 0 then
          raise exception 'Weight must be greater than zero before billing Pickup Service for %', v_shipment.tracking_number;
        end if;
        if v_shipment.pickup_rate_per_kg is null or v_shipment.pickup_rate_per_kg <= 0 then
          raise exception 'Pickup rate per kg must be greater than zero before billing Pickup Service for %', v_shipment.tracking_number;
        end if;
        v_amount := round(v_shipment.weight_kg * v_shipment.pickup_rate_per_kg, 3);
        v_description := 'Pickup Service';
        v_components := jsonb_build_array(jsonb_build_object(
          'description', 'Pickup Service', 'quantity', v_shipment.weight_kg,
          'rate', v_shipment.pickup_rate_per_kg, 'rate_kind', 'currency', 'amount_ex_gst', v_amount,
          'unit', 'kg'
        ));
      elsif v_shipment.warehouse_booking_pricing then
        v_amount := coalesce(v_shipment.warehouse_booking_charge, 150);
        v_description := 'Warehouse Booking';
        v_components := jsonb_build_array(jsonb_build_object(
          'description', 'Warehouse Booking', 'quantity', 1, 'rate', v_amount,
          'rate_kind', 'currency', 'amount_ex_gst', v_amount
        ));
      elsif v_shipment.total_charge_override is not null then
        v_amount := round(v_shipment.total_charge_override / (1 + v_gst), 3);
        v_description := 'Delivery Total';
        v_components := jsonb_build_array(jsonb_build_object(
          'description', 'Delivery Total', 'quantity', 1, 'rate', v_amount,
          'rate_kind', 'currency', 'amount_ex_gst', v_amount
        ));
      else
        if v_shipment.volume_m3 is null or v_shipment.unit_price is null then
          raise exception 'Delivery charge for % is not priced', v_shipment.tracking_number;
        end if;
        v_delivery := round(greatest(v_shipment.volume_m3, v_shipment.minimum_billable_volume) * v_shipment.unit_price, 3);
        v_service := case when v_shipment.crane_required then v_shipment.crane_truck_fee else v_shipment.tail_lift_service_fee end;
        v_fuel := round(coalesce(v_shipment.fuel_levy_override, v_delivery * v_shipment.fuel_levy_rate), 3);
        v_amount := v_delivery + v_service + v_fuel;
        v_description := 'Delivery Total';
        v_components := jsonb_build_array(
          jsonb_build_object('description', 'Last Mile Delivery', 'quantity', greatest(v_shipment.volume_m3, v_shipment.minimum_billable_volume), 'rate', v_shipment.unit_price, 'rate_kind', 'currency', 'amount_ex_gst', v_delivery),
          jsonb_build_object('description', case when v_shipment.crane_required then 'Crane Truck Service' else 'Tail Lift Service' end, 'quantity', 1, 'rate', v_service, 'rate_kind', 'currency', 'amount_ex_gst', v_service),
          jsonb_build_object(
            'description', 'Fuel Levy', 'quantity', 1,
            'rate', case when v_shipment.fuel_levy_override is null then v_shipment.fuel_levy_rate else null end,
            'rate_kind', case when v_shipment.fuel_levy_override is null then 'percentage' else 'manual' end,
            'manual_amount', v_shipment.fuel_levy_override, 'base_amount_ex_gst', v_delivery,
            'amount_ex_gst', v_fuel
          )
        );
      end if;
      v_gst_amount := round(v_amount * v_gst, 3);
      v_total := v_amount + v_gst_amount;
      v_snapshot := private.billing_snapshot(
        v_components, v_amount, v_gst,
        jsonb_build_object('shipment', to_jsonb(v_shipment), 'pricing_mode', v_description)
      );
      insert into public.billing_items (
        bill_id, charge_type, source_id, shipment_id, import_batch_id, tracking_number,
        customer_reference, container_number, description, quantity, rate,
        amount_ex_gst, gst_rate, gst_amount, total_incl_gst, snapshot
      ) values (
        p_bill_id, v_type, v_source_id, v_shipment.id, v_shipment.import_batch_id, v_shipment.tracking_number,
        v_shipment.customer_reference, v_shipment.container_number, v_description, 1, v_amount,
        v_amount, v_gst, v_gst_amount, v_total, v_snapshot
      ) on conflict (bill_id, charge_type, source_id) do nothing;
    elsif v_type = 'storage' then
      select * into v_storage from public.storage_fees where id = v_source_id for update;
      if not found or v_storage.billed_at is not null then raise exception 'Storage fee is already billed or missing'; end if;
      select * into v_shipment from public.shipments where id = v_storage.shipment_id;
      select gst_rate into v_gst from public.storage_episodes where id = v_storage.episode_id;
      v_customer_id := v_shipment.customer_id;
      v_amount := v_storage.amount;
      v_gst_amount := round(v_amount * v_gst, 3);
      v_total := v_amount + v_gst_amount;
      v_description := format('Storage %s - %s', to_char(v_storage.period_start, 'DD Mon YYYY'), to_char(v_storage.period_end, 'DD Mon YYYY'));
      insert into public.billing_items (
        bill_id, charge_type, source_id, shipment_id, import_batch_id, tracking_number,
        customer_reference, container_number, description, quantity, rate,
        amount_ex_gst, gst_rate, gst_amount, total_incl_gst, snapshot
      ) values (
        p_bill_id, v_type, v_source_id, v_shipment.id, v_shipment.import_batch_id, v_shipment.tracking_number,
        v_shipment.customer_reference, v_shipment.container_number, v_description, 1, v_amount,
        v_amount, v_gst, v_gst_amount, v_total,
        private.billing_snapshot(
          jsonb_build_array(jsonb_build_object('description', v_description, 'quantity', 1, 'rate', v_amount, 'rate_kind', 'currency', 'amount_ex_gst', v_amount)),
          v_amount, v_gst, jsonb_build_object('storage_fee', to_jsonb(v_storage), 'shipment', to_jsonb(v_shipment))
        )
      ) on conflict (bill_id, charge_type, source_id) do nothing;
    elsif v_type = 'container' then
      select * into v_container from public.container_service_fees where id = v_source_id for update;
      if not found or v_container.billed_at is not null then raise exception 'Container service fee is already billed or missing'; end if;
      if v_container.amount is null then raise exception 'Container service fee amount is not configured for %', v_container.container_number; end if;
      select customer_id into v_customer_id from public.import_batches where id = v_container.import_batch_id;
      v_amount := v_container.amount;
      v_gst := v_container.gst_rate;
      v_gst_amount := round(v_amount * v_gst, 3);
      v_total := v_amount + v_gst_amount;
      insert into public.billing_items (
        bill_id, charge_type, source_id, import_batch_id, container_number, description,
        quantity, rate, amount_ex_gst, gst_rate, gst_amount, total_incl_gst, snapshot
      ) values (
        p_bill_id, v_type, v_source_id, v_container.import_batch_id, v_container.container_number,
        'Container Service Fee', 1, v_amount, v_amount, v_gst, v_gst_amount, v_total,
        private.billing_snapshot(
          jsonb_build_array(jsonb_build_object('description', 'Container Service Fee', 'quantity', 1, 'rate', v_amount, 'rate_kind', 'currency', 'amount_ex_gst', v_amount)),
          v_amount, v_gst, jsonb_build_object('container_fee', to_jsonb(v_container))
        )
      ) on conflict (bill_id, charge_type, source_id) do nothing;
    elsif v_type = 'crane' then
      select * into v_crane from public.crane_service_charges where id = v_source_id for update;
      if not found or v_crane.billed_at is not null or v_crane.cancelled_at is not null then raise exception 'Crane Truck Service is already billed, cancelled or missing'; end if;
      select * into v_shipment from public.shipments where id = v_crane.shipment_id;
      v_customer_id := v_shipment.customer_id;
      v_amount := v_crane.amount_ex_gst;
      v_gst := v_crane.gst_rate;
      v_gst_amount := round(v_amount * v_gst, 3);
      v_total := v_amount + v_gst_amount;
      insert into public.billing_items (
        bill_id, charge_type, source_id, shipment_id, import_batch_id, tracking_number,
        customer_reference, container_number, description, quantity, rate,
        amount_ex_gst, gst_rate, gst_amount, total_incl_gst, snapshot
      ) values (
        p_bill_id, v_type, v_source_id, v_shipment.id, v_shipment.import_batch_id, v_shipment.tracking_number,
        v_shipment.customer_reference, v_shipment.container_number, 'Crane Truck Service', 1, v_amount,
        v_amount, v_gst, v_gst_amount, v_total,
        private.billing_snapshot(
          jsonb_build_array(jsonb_build_object('description', 'Crane Truck Service', 'quantity', 1, 'rate', v_amount, 'rate_kind', 'currency', 'amount_ex_gst', v_amount)),
          v_amount, v_gst, jsonb_build_object('crane_charge', to_jsonb(v_crane), 'shipment', to_jsonb(v_shipment))
        )
      ) on conflict (bill_id, charge_type, source_id) do nothing;
    else
      raise exception 'Unsupported charge type: %', coalesce(v_type, 'null');
    end if;

    if v_bill.customer_id is null then
      update public.billing_documents set customer_id = v_customer_id where id = p_bill_id;
      v_bill.customer_id := v_customer_id;
    elsif v_bill.customer_id is distinct from v_customer_id then
      raise exception 'All Draft Bill charges must belong to one customer';
    end if;
  end loop;
end;
$$;

-- Preserve the proven SQL35 editor for every existing charge and wrap only the new Pickup component.
alter function public.save_draft_bill_changes(uuid, jsonb) rename to save_draft_bill_changes_sql35;
revoke all on function public.save_draft_bill_changes_sql35(uuid, jsonb) from public, anon, authenticated;

create or replace function public.save_draft_bill_changes(p_bill_id uuid, p_changes jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb;
  v_remove_ids jsonb;
  v_change jsonb;
  v_other_changes jsonb := '[]'::jsonb;
  v_pickup_changes jsonb := '[]'::jsonb;
  v_item public.billing_items%rowtype;
  v_components jsonb;
  v_component jsonb;
  v_quantity numeric(14, 3);
  v_rate numeric(14, 6);
  v_gst numeric(8, 6);
  v_amount numeric(14, 3);
  v_gst_amount numeric(14, 3);
  v_before jsonb;
  v_audit jsonb := '{}'::jsonb;
  v_shipment_key text;
  v_audit_changes jsonb;
begin
  if auth.uid() is null or not private.has_any_role(array['admin','operations']::text[]) then
    raise exception 'Permission denied';
  end if;
  if jsonb_typeof(p_changes) = 'object' then
    v_changes := coalesce(p_changes -> 'changes', '[]'::jsonb);
    v_remove_ids := coalesce(p_changes -> 'remove_item_ids', '[]'::jsonb);
  elsif jsonb_typeof(p_changes) = 'array' then
    v_changes := p_changes;
    v_remove_ids := '[]'::jsonb;
  else
    raise exception 'Draft changes must be an array or editor payload';
  end if;

  for v_change in select value from jsonb_array_elements(v_changes) loop
    select * into v_item from public.billing_items
    where id = (v_change ->> 'item_id')::uuid and bill_id = p_bill_id;
    if not found then raise exception 'Draft charge was not found'; end if;
    if v_item.charge_type = 'delivery' and v_item.description = 'Pickup Service' then
      v_pickup_changes := v_pickup_changes || jsonb_build_array(v_change);
    else
      v_other_changes := v_other_changes || jsonb_build_array(v_change);
    end if;
  end loop;

  if jsonb_array_length(v_other_changes) > 0 or jsonb_array_length(v_remove_ids) > 0 then
    perform public.save_draft_bill_changes_sql35(
      p_bill_id, jsonb_build_object('changes', v_other_changes, 'remove_item_ids', v_remove_ids)
    );
  end if;

  for v_change in select value from jsonb_array_elements(v_pickup_changes) loop
    select item.* into v_item from public.billing_items as item
    join public.billing_documents as bill on bill.id = item.bill_id
    where item.id = (v_change ->> 'item_id')::uuid and item.bill_id = p_bill_id
      and bill.status = 'draft' for update of item;
    if not found or v_item.description <> 'Pickup Service' then raise exception 'Draft Pickup Service was not found'; end if;
    v_components := coalesce(v_change -> 'actual_components', v_item.snapshot -> 'actual_components');
    if jsonb_typeof(v_components) is distinct from 'array' or jsonb_array_length(v_components) <> 1
       or v_components -> 0 ->> 'description' <> 'Pickup Service' then
      raise exception 'Pickup Service requires exactly one Pickup Service component';
    end if;
    v_component := v_components -> 0;
    v_quantity := coalesce((v_component ->> 'quantity')::numeric, 0);
    v_rate := coalesce((v_component ->> 'rate')::numeric, 0);
    v_gst := coalesce((v_change ->> 'gst_rate')::numeric, v_item.gst_rate);
    if v_quantity <= 0 then raise exception 'Pickup Service weight must be greater than zero'; end if;
    if v_rate <= 0 then raise exception 'Pickup Service rate per kg must be greater than zero'; end if;
    if v_gst not between 0 and 1 then raise exception 'GST rate must be a decimal value from 0 to 1'; end if;
    v_amount := round(v_quantity * v_rate, 3);
    v_gst_amount := round(v_amount * v_gst, 3);
    v_before := v_item.snapshot -> 'actual';
    v_components := jsonb_build_array(v_component || jsonb_build_object(
      'quantity', v_quantity, 'rate', v_rate, 'rate_kind', 'currency',
      'amount_ex_gst', v_amount, 'unit', 'kg'
    ));
    update public.billing_items set
      quantity = 1, rate = v_amount, amount_ex_gst = v_amount,
      gst_rate = v_gst, gst_amount = v_gst_amount, total_incl_gst = v_amount + v_gst_amount,
      snapshot = snapshot || jsonb_build_object(
        'actual_components', v_components, 'components', v_components,
        'actual', jsonb_build_object('amount_ex_gst', v_amount, 'gst_rate', v_gst, 'gst_amount', v_gst_amount, 'total_incl_gst', v_amount + v_gst_amount),
        'adjustment_ex_gst', v_amount - coalesce((snapshot -> 'expected' ->> 'amount_ex_gst')::numeric, amount_ex_gst),
        'draft_edited_at', now(), 'draft_edited_by', auth.uid()
      )
    where id = v_item.id;
    if v_item.shipment_id is not null then
      v_shipment_key := v_item.shipment_id::text;
      v_audit := jsonb_set(v_audit, array[v_shipment_key],
        coalesce(v_audit -> v_shipment_key, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
          'charge_type', 'delivery', 'description', 'Pickup Service',
          'expected', v_item.snapshot -> 'expected', 'before_actual', v_before,
          'after_actual', jsonb_build_object('amount_ex_gst', v_amount, 'gst_rate', v_gst, 'gst_amount', v_gst_amount, 'total_incl_gst', v_amount + v_gst_amount),
          'after_actual_components', v_components
        )), true);
    end if;
  end loop;

  for v_shipment_key, v_audit_changes in select key, value from jsonb_each(v_audit) loop
    insert into public.shipment_events (
      shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
    ) select shipment.id, 'billing_updated', shipment.current_status, shipment.current_status,
      now(), auth.uid(), 'Invoice adjusted from Draft Bill', jsonb_build_object(
        'source', 'Draft Bill', 'bill_id', p_bill_id, 'changes', v_audit_changes
      ) from public.shipments as shipment where shipment.id = v_shipment_key::uuid;
  end loop;
  if jsonb_array_length(v_pickup_changes) > 0 then
    update public.billing_documents set updated_at = now(), updated_by = auth.uid() where id = p_bill_id;
  end if;
end;
$$;

alter table public.storage_schedule_revisions enable row level security;
drop policy if exists storage_schedule_revisions_read_policy on public.storage_schedule_revisions;
create policy storage_schedule_revisions_read_policy
on public.storage_schedule_revisions for select to authenticated
using (private.has_any_role(array['admin','operations','warehouse','viewer']::text[]));

drop policy if exists customer_billing_profiles_manage_policy on public.customer_billing_profiles;
drop policy if exists shipments_update_policy on public.shipments;
drop policy if exists import_batches_insert_policy on public.import_batches;

revoke all on table public.shipments from anon;
revoke all on table public.shipments from authenticated;
grant select, insert on table public.shipments to authenticated;

revoke all on table public.import_batches from anon;
revoke all on table public.import_batches from authenticated;
grant select on table public.import_batches to authenticated;

revoke all on table public.customer_billing_profiles from anon;
revoke all on table public.customer_billing_profiles from authenticated;
grant select on table public.customer_billing_profiles to authenticated;

revoke all on table public.storage_episodes, public.storage_fees,
  public.storage_schedule_revisions, public.container_service_fees,
  public.crane_service_charges, public.billing_documents, public.billing_items
from anon, authenticated;
grant select on table public.storage_episodes, public.storage_fees,
  public.storage_schedule_revisions, public.container_service_fees,
  public.crane_service_charges, public.billing_documents, public.billing_items
to authenticated;

revoke all on function public.rls_auto_enable() from public, anon, authenticated;
revoke all on function public.sync_shipment_customer() from public, anon, authenticated;

revoke all on function private.create_customer_billing_profile() from public, anon, authenticated;
revoke all on function private.apply_customer_billing_defaults() from public, anon, authenticated;
revoke all on function private.storage_due_week_count(date, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.rebuild_storage_unbilled(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.storage_schedule_snapshot(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.apply_storage_schedule_change_internal(uuid, date, text, text, uuid) from public, anon, authenticated;
revoke all on function private.validate_on_hold_storage_rate() from public, anon, authenticated;
revoke all on function private.sync_storage_episode() from public, anon, authenticated;
revoke all on function private.generate_storage_fees() from public, anon, authenticated;
revoke all on function private.recalculate_shipment_total(uuid) from public, anon, authenticated;
revoke all on function private.add_draft_bill_items(uuid, jsonb) from public, anon, authenticated;

revoke all on function public.update_customer_billing_profile(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.update_customer_billing_profile(uuid, jsonb) to authenticated;
revoke all on function public.get_storage_schedule(uuid) from public, anon, authenticated;
grant execute on function public.get_storage_schedule(uuid) to authenticated;
revoke all on function public.preview_storage_schedule_change(uuid, date) from public, anon, authenticated;
grant execute on function public.preview_storage_schedule_change(uuid, date) to authenticated;
revoke all on function public.apply_storage_schedule_change(uuid, date, text) from public, anon, authenticated;
grant execute on function public.apply_storage_schedule_change(uuid, date, text) to authenticated;
revoke all on function public.complete_shipment(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_shipment(uuid, text, text) to authenticated;
revoke all on function public.update_shipment_details(uuid, jsonb, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.update_shipment_details(uuid, jsonb, text, text, timestamptz) to authenticated;
revoke all on function public.save_draft_bill_changes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_draft_bill_changes(uuid, jsonb) to authenticated;

comment on column public.customer_billing_profiles.default_pickup_rate_per_kg is
  'AUD per kg copied to each new Shipment or real customer switch; later Profile edits do not rewrite Shipment snapshots.';
comment on column public.shipments.pickup_rate_per_kg is
  'Customer Pickup rate snapshot. Picked Up ex-GST charge is weight_kg multiplied by this value.';
comment on column public.shipments.warehouse_booking_charge is
  'SQL36 onward: Warehouse Booking core amount is ex GST. Unbilled Storage remains a separate ex-GST source.';
comment on table public.storage_schedule_revisions is
  'Admin audit of Storage Start Date revisions. Finalised fees/items are immutable; billed fees become earliest-week credits within the same episode.';
comment on function private.generate_storage_fees() is
  'Called by bentway-storage-periods every five minutes. Generates at most the next due week after Melbourne 23:55; never revises history.';

commit;
