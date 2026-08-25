-- SQL 34 - Correct shipment totals, weekly storage fees, and container service fees
-- NOT YET EXECUTED IN PRODUCTION. Run once after SQL 33.

begin;

do $$
begin
  if to_regclass('public.storage_episodes') is not null then
    raise exception 'SQL 34 appears to be already applied; do not rerun a completed migration';
  end if;
end;
$$;

create table if not exists public.storage_episodes (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete restrict,
  started_at timestamptz not null,
  ended_at timestamptz,
  rate_per_m3 numeric(14, 3) not null check (rate_per_m3 > 0),
  volume_m3 numeric(14, 4) not null check (volume_m3 > 0),
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists storage_episodes_one_open_uidx
  on public.storage_episodes(shipment_id) where ended_at is null;
create index if not exists storage_episodes_shipment_started_idx
  on public.storage_episodes(shipment_id, started_at desc);

create table if not exists public.storage_fees (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete restrict,
  episode_id uuid not null references public.storage_episodes(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  amount numeric(14, 3) not null check (amount >= 0),
  billed_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end = period_start + 6),
  unique (episode_id, period_start)
);

create index if not exists storage_fees_shipment_period_idx
  on public.storage_fees(shipment_id, period_start);
create index if not exists storage_fees_unbilled_idx
  on public.storage_fees(shipment_id) where billed_at is null;

create table if not exists public.container_service_fees (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.import_batches(id) on delete restrict,
  container_number text not null check (btrim(container_number) <> ''),
  amount numeric(14, 3) check (amount is null or amount >= 0),
  gst_rate numeric(8, 6) not null default 0.10 check (gst_rate >= 0),
  billed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (import_batch_id, container_number)
);

create index if not exists container_service_fees_batch_idx
  on public.container_service_fees(import_batch_id);

create table if not exists public.crane_service_charges (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete restrict,
  amount_ex_gst numeric(14, 3) not null check (amount_ex_gst > 0),
  gst_rate numeric(8, 6) not null check (gst_rate >= 0),
  billed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists crane_service_charges_one_active_uidx
  on public.crane_service_charges(shipment_id)
  where billed_at is null and cancelled_at is null;

alter table public.shipments
  add column if not exists warehouse_booking_pricing boolean not null default false,
  add column if not exists delivery_billed_at timestamptz;

-- This is deliberately scoped metadata backfill. Existing completed totals are not recalculated.
update public.shipments
set warehouse_booking_pricing = true
where current_status = 'pending_warehouse_booking'
   or (current_status = 'completed' and outbound_method = 'warehouse_delivery');

alter table public.shipments drop constraint if exists shipments_crane_required_fee_check;
alter table public.shipments add constraint shipments_crane_required_fee_check
  check (not crane_required or crane_truck_fee > 0);

-- Keep the confirmed warehouse-booking pricing mode through DTW completion.
-- A retained inactive crane fee is historical data and is intentionally not zeroed.
create or replace function private.set_pending_warehouse_booking_charge()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.current_status = 'pending_warehouse_booking' then
    new.warehouse_booking_pricing := true;
    new.warehouse_booking_charge := coalesce(new.warehouse_booking_charge, 150.000);
    new.total_charge_override := null;
    new.crane_required := false;
  elsif tg_op = 'UPDATE' and old.current_status = 'pending_warehouse_booking' then
    new.warehouse_booking_pricing :=
      new.current_status = 'completed' and new.outbound_method = 'warehouse_delivery';
  end if;
  return new;
end;
$$;

drop trigger if exists set_pending_warehouse_booking_charge_trigger on public.shipments;
create trigger set_pending_warehouse_booking_charge_trigger
before insert or update of current_status, outbound_method, warehouse_booking_charge,
  total_charge_override, crane_required, crane_truck_fee
on public.shipments
for each row execute function private.set_pending_warehouse_booking_charge();

-- Crane belongs to Delivery until Delivery is billed. Later crane work is a
-- separate charge and cannot mutate the finalised Delivery snapshot.
create or replace function private.sync_supplementary_crane_charge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.delivery_billed_at is null then return new; end if;
  if new.crane_required then
    update public.crane_service_charges
    set amount_ex_gst = new.crane_truck_fee, gst_rate = new.gst_rate
    where shipment_id = new.id and billed_at is null and cancelled_at is null;
    if not found and not old.crane_required then
      insert into public.crane_service_charges (shipment_id, amount_ex_gst, gst_rate)
      values (new.id, new.crane_truck_fee, new.gst_rate);
    end if;
  else
    update public.crane_service_charges set cancelled_at = now()
    where shipment_id = new.id and billed_at is null and cancelled_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_supplementary_crane_charge_trigger on public.shipments;
create trigger sync_supplementary_crane_charge_trigger
after update of crane_required, crane_truck_fee, gst_rate on public.shipments
for each row when (
  old.crane_required is distinct from new.crane_required
  or old.crane_truck_fee is distinct from new.crane_truck_fee
  or old.gst_rate is distinct from new.gst_rate
)
execute function private.sync_supplementary_crane_charge();

create or replace function private.create_import_container_service_fee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.import_batch_id is not null and nullif(btrim(new.container_number), '') is not null then
    insert into public.container_service_fees (import_batch_id, container_number)
    values (new.import_batch_id, upper(btrim(new.container_number)))
    on conflict (import_batch_id, container_number) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists create_import_container_service_fee_trigger on public.shipments;
create trigger create_import_container_service_fee_trigger
after insert on public.shipments
for each row execute function private.create_import_container_service_fee();

-- Storage depends on child records, so total_charge can no longer be generated.
-- Preserve every existing value before changing the column contract.
alter table public.shipments add column if not exists legacy_total_charge_snapshot numeric(14, 3);
update public.shipments set legacy_total_charge_snapshot = total_charge
where legacy_total_charge_snapshot is null;
alter table public.shipments drop column total_charge;
alter table public.shipments add column total_charge numeric(14, 3);
update public.shipments set total_charge = legacy_total_charge_snapshot;

alter table public.shipments drop column fuel_levy;
alter table public.shipments add column fuel_levy numeric(14, 2)
generated always as (
  case when volume_m3 is null or unit_price is null then null
  else round(greatest(volume_m3, minimum_billable_volume) * unit_price * fuel_levy_rate, 2)
  end
) stored;

create or replace function private.recalculate_shipment_total(p_shipment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment public.shipments%rowtype;
  v_storage numeric(14, 3);
  v_delivery numeric(14, 6);
  v_fuel numeric(14, 6);
  v_service numeric(14, 3);
  v_total numeric(14, 3);
begin
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found then return; end if;

  select coalesce(sum(amount), 0) into v_storage
  from public.storage_fees
  where shipment_id = p_shipment_id and billed_at is null;

  if v_shipment.warehouse_booking_pricing then
    -- The confirmed $150/$200/custom booking amount is the final GST-inclusive
    -- booking core (no additional GST). Storage stays ex-GST and adds GST here.
    v_total := round(coalesce(v_shipment.warehouse_booking_charge, 150)
      + (v_storage * (1 + coalesce(v_shipment.gst_rate, 0))), 3);
  elsif v_shipment.total_charge_override is not null then
    -- Legacy/manual delivery overrides remain valid; newly accrued storage is still added tax-inclusive.
    v_total := round(v_shipment.total_charge_override + (v_storage * (1 + v_shipment.gst_rate)), 3);
  elsif v_shipment.volume_m3 is null or v_shipment.unit_price is null then
    v_total := null;
  else
    v_delivery := greatest(v_shipment.volume_m3, v_shipment.minimum_billable_volume) * v_shipment.unit_price;
    v_fuel := coalesce(v_shipment.fuel_levy_override, v_delivery * v_shipment.fuel_levy_rate);
    v_service := case when v_shipment.crane_required
      then coalesce(v_shipment.crane_truck_fee, 0)
      else coalesce(v_shipment.tail_lift_service_fee, 0)
    end;
    v_total := round((v_delivery + v_service + v_fuel + v_storage) * (1 + v_shipment.gst_rate), 3);
  end if;

  update public.shipments set total_charge = v_total where id = p_shipment_id;
end;
$$;

create or replace function private.recalculate_shipment_total_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.recalculate_shipment_total(old.shipment_id);
    return old;
  end if;
  if tg_table_name = 'shipments' then
    perform private.recalculate_shipment_total(new.id);
  else
    perform private.recalculate_shipment_total(new.shipment_id);
  end if;
  return new;
end;
$$;

drop trigger if exists recalculate_shipment_total_trigger on public.shipments;
create trigger recalculate_shipment_total_trigger
 after insert or update of current_status, warehouse_booking_pricing, volume_m3, unit_price, minimum_billable_volume,
  tail_lift_service_fee, crane_required, crane_truck_fee, fuel_levy_rate,
  fuel_levy_override, gst_rate, warehouse_booking_charge, total_charge_override
on public.shipments
for each row execute function private.recalculate_shipment_total_trigger();

drop trigger if exists recalculate_shipment_total_from_storage_trigger on public.storage_fees;
create trigger recalculate_shipment_total_from_storage_trigger
after insert or update of amount, billed_at or delete on public.storage_fees
for each row execute function private.recalculate_shipment_total_trigger();

create or replace function private.validate_on_hold_storage_rate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
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
  v_period_start date;
begin
  if new.current_status = 'on_hold'
     and (tg_op = 'INSERT' or old.current_status is distinct from 'on_hold') then
    v_started_at := coalesce(new.on_hold_started_at, now());
    v_period_start := (v_started_at at time zone 'Australia/Melbourne')::date;
    insert into public.storage_episodes (shipment_id, started_at, rate_per_m3, volume_m3)
    values (new.id, v_started_at, new.storage_rate, new.volume_m3)
    returning id into v_episode_id;

    insert into public.storage_fees (shipment_id, episode_id, period_start, period_end, amount)
    values (new.id, v_episode_id, v_period_start, v_period_start + 6,
      round(new.volume_m3 * new.storage_rate, 3));
  elsif tg_op = 'UPDATE' and old.current_status = 'on_hold' and new.current_status is distinct from 'on_hold' then
    update public.storage_episodes set ended_at = now()
    where shipment_id = new.id and ended_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_on_hold_storage_rate_trigger on public.shipments;
create trigger validate_on_hold_storage_rate_trigger
before insert or update of current_status on public.shipments
for each row execute function private.validate_on_hold_storage_rate();
drop trigger if exists sync_storage_episode_trigger on public.shipments;
create trigger sync_storage_episode_trigger
after insert or update of current_status on public.shipments
for each row execute function private.sync_storage_episode();

create or replace function private.generate_storage_fees()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_episode record;
  v_period_end date;
  v_created integer := 0;
begin
  for v_episode in
    select episode.id, episode.shipment_id, episode.rate_per_m3, episode.volume_m3
    from public.storage_episodes as episode
    join public.shipments as shipment on shipment.id = episode.shipment_id
    where episode.ended_at is null and shipment.current_status = 'on_hold'
  loop
    select max(period_end) into v_period_end
    from public.storage_fees where episode_id = v_episode.id;

    while now() >= ((v_period_end::timestamp + time '23:55') at time zone 'Australia/Melbourne') loop
      insert into public.storage_fees (shipment_id, episode_id, period_start, period_end, amount)
      values (v_episode.shipment_id, v_episode.id, v_period_end + 1, v_period_end + 7,
        round(v_episode.volume_m3 * v_episode.rate_per_m3, 3))
      on conflict (episode_id, period_start) do nothing;
      if found then v_created := v_created + 1; end if;
      v_period_end := v_period_end + 7;
    end loop;
  end loop;
  return v_created;
end;
$$;

-- Supabase Cron runs every five minutes; the function applies the exact 23:55 Melbourne threshold,
-- which remains correct across daylight-saving changes.
create extension if not exists pg_cron;
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'bentway-storage-periods') then
    perform cron.schedule(
      'bentway-storage-periods',
      '*/5 * * * *',
      'select private.generate_storage_fees();'
    );
  end if;
end;
$$;

-- Shipment Details writes data and status in one database transaction. Any
-- status/storage/billing trigger failure rolls the whole save back.
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
  v_status_date_changed boolean;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'You do not have permission to update shipments';
  end if;
  select * into v_before from public.shipments
  where id = p_shipment_id and cancelled_at is null for update;
  if not found then raise exception 'Shipment was not found'; end if;

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
    crane_truck_fee = case when p_payload ? 'crane_truck_fee' then (p_payload ->> 'crane_truck_fee')::numeric else crane_truck_fee end,
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
  if p_new_status is distinct from v_before.current_status or v_status_date_changed then
    select * into v_after from public.set_shipment_status(
      p_shipment_id, p_new_status, p_notes, p_scheduled_for
    );
  else
    select * into v_after from public.shipments where id = p_shipment_id;
  end if;
  return v_after;
end;
$$;

-- DTW is intentionally limited to the direct Pending Warehouse Booking path.
-- Other outbound methods retain the established completion behaviour.
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
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'Permission denied';
  end if;
  if p_outbound_method is null
     or p_outbound_method not in ('delivered', 'picked_up', 'warehouse_delivery', 'returned') then
    raise exception 'Invalid outbound method';
  end if;

  select current_status into v_previous_status
  from public.shipments
  where id = p_shipment_id and cancelled_at is null
  for update;
  if not found then raise exception 'Shipment not found'; end if;
  if v_previous_status in ('completed', 'cancelled') then raise exception 'Shipment is already closed'; end if;
  if v_previous_status = 'exception' then raise exception 'Exception shipments must be resolved from Shipment Details'; end if;
  if p_outbound_method = 'warehouse_delivery'
     and v_previous_status <> 'pending_warehouse_booking' then
    raise exception 'DTW completion requires Pending Warehouse Booking';
  end if;

  update public.shipments
  set current_status = 'completed', outbound_method = p_outbound_method, outbound_at = v_completed_at
  where id = p_shipment_id
  returning * into v_result;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, outbound_method,
    event_at, performed_by, notes
  ) values (
    p_shipment_id, p_outbound_method, v_previous_status, 'completed', p_outbound_method,
    v_completed_at, auth.uid(), p_notes
  );
  return v_result;
end;
$$;

-- Resume clears the completed operational episode and DTW pricing mode while
-- keeping the shipment and all event/billing history.
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
  if auth.uid() is null
     or not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'You do not have permission to resume shipments';
  end if;
  select outbound_method into v_outbound_method from public.shipments
  where id = p_shipment_id and current_status = 'completed' and cancelled_at is null for update;
  if not found then raise exception 'Completed shipment was not found'; end if;
  update public.shipments set
    current_status = 'pending', outbound_method = null, outbound_at = null,
    scheduled_for = null, on_hold_started_at = null,
    warehouse_booking_pricing = false,
    exception_condition_keys = '{}'::text[], updated_at = now()
  where id = p_shipment_id returning * into v_result;
  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, metadata
  ) values (
    p_shipment_id, 'status_changed', 'completed', 'pending', now(), auth.uid(),
    jsonb_build_object('action', 'resumed_completed_shipment', 'previous_outbound_method', v_outbound_method)
  );
  return v_result;
end;
$$;

-- Do not silently rewrite historical Completed/Cancelled amounts during deployment.
select private.recalculate_shipment_total(id)
from public.shipments
where current_status not in ('completed', 'cancelled');

alter table public.storage_episodes enable row level security;
alter table public.storage_fees enable row level security;
alter table public.container_service_fees enable row level security;
alter table public.crane_service_charges enable row level security;

drop policy if exists storage_episodes_read_policy on public.storage_episodes;
create policy storage_episodes_read_policy on public.storage_episodes for select to authenticated
using (private.has_any_role(array['admin', 'operations', 'warehouse', 'viewer']::text[]));
drop policy if exists storage_fees_read_policy on public.storage_fees;
create policy storage_fees_read_policy on public.storage_fees for select to authenticated
using (private.has_any_role(array['admin', 'operations', 'warehouse', 'viewer']::text[]));
drop policy if exists container_service_fees_read_policy on public.container_service_fees;
create policy container_service_fees_read_policy on public.container_service_fees for select to authenticated
using (private.has_any_role(array['admin', 'operations', 'warehouse', 'viewer']::text[]));
drop policy if exists container_service_fees_insert_policy on public.container_service_fees;
create policy container_service_fees_insert_policy on public.container_service_fees for insert to authenticated
  with check (private.has_any_role(array['admin', 'operations', 'warehouse']::text[]));
drop policy if exists crane_service_charges_read_policy on public.crane_service_charges;
create policy crane_service_charges_read_policy on public.crane_service_charges for select to authenticated
using (private.has_any_role(array['admin', 'operations', 'warehouse', 'viewer']::text[]));

grant select on public.storage_episodes, public.storage_fees, public.container_service_fees, public.crane_service_charges to authenticated;
grant insert on public.container_service_fees to authenticated;
revoke all on function public.update_shipment_details(uuid, jsonb, text, text, timestamptz) from public, anon;
grant execute on function public.update_shipment_details(uuid, jsonb, text, text, timestamptz) to authenticated;
revoke all on function public.resume_completed_shipment(uuid) from public, anon;
grant execute on function public.resume_completed_shipment(uuid) to authenticated;
revoke all on function private.recalculate_shipment_total(uuid) from public;
revoke all on function private.recalculate_shipment_total_trigger() from public;
revoke all on function private.validate_on_hold_storage_rate() from public;
revoke all on function private.sync_storage_episode() from public;
revoke all on function private.generate_storage_fees() from public;
revoke all on function private.create_import_container_service_fee() from public;
revoke all on function private.set_pending_warehouse_booking_charge() from public;
revoke all on function private.sync_supplementary_crane_charge() from public;

comment on table public.storage_fees is 'One tax-exclusive charge per full seven-day storage period; billed rows are retained permanently.';
comment on table public.container_service_fees is 'At most one fee per import batch and container. Amount remains null until the customer rule is defined.';
comment on table public.crane_service_charges is 'Crane Truck Service added after Delivery Total was finalised; it has its own billing lifecycle.';
comment on column public.shipments.total_charge is 'Database-maintained final shipment charge including only unbilled storage fees.';
comment on column public.shipments.legacy_total_charge_snapshot is 'Immutable deployment snapshot of the SQL31-era generated total. Historical completed totals are not recalculated by SQL34.';

commit;
