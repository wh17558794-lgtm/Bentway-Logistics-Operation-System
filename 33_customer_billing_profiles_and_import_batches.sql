-- SQL 33 - Customer billing profiles and stable import batches
-- NOT YET EXECUTED IN PRODUCTION. Run once after SQL 32.

begin;

do $$
begin
  if to_regclass('public.customer_billing_profiles') is not null then
    raise exception 'SQL 33 appears to be already applied; do not rerun a completed migration';
  end if;
end;
$$;

create table if not exists public.customer_billing_profiles (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  legal_company_name text,
  trading_name text,
  abn text,
  billing_address text,
  billing_contact text,
  billing_email text,
  cc_email text,
  billing_phone text,
  billing_frequency text not null default 'On Demand'
    check (billing_frequency in ('Weekly', 'On Demand')),
  default_tail_lift_fee numeric(14, 3) not null default 80 check (default_tail_lift_fee >= 0),
  default_fuel_levy_rate numeric(8, 6) not null default 0.20 check (default_fuel_levy_rate >= 0),
  default_storage_rate numeric(14, 3) not null default 20 check (default_storage_rate >= 0),
  default_gst_rate numeric(8, 6) not null default 0.10 check (default_gst_rate >= 0),
  default_warehouse_booking_fee numeric(14, 3) not null default 150 check (default_warehouse_booking_fee >= 0),
  minimum_billable_volume numeric(14, 4) not null default 1 check (minimum_billable_volume > 0),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One-time conversion of the legacy name rule into data. Runtime pricing below never checks a customer name.
insert into public.customer_billing_profiles (
  customer_id, legal_company_name, trading_name, default_tail_lift_fee
)
select customer.id, customer.name, customer.name,
  case
    when lower(btrim(customer.name)) like 'oreo%' then 70
    when lower(btrim(customer.name)) like 'winmav%' then 80
    else 80
  end
from public.customers as customer
on conflict (customer_id) do nothing;

create or replace function private.create_customer_billing_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.customer_billing_profiles (customer_id, legal_company_name, trading_name)
  values (new.id, new.name, new.name)
  on conflict (customer_id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_customer_billing_profile_trigger on public.customers;
create trigger create_customer_billing_profile_trigger
after insert on public.customers
for each row execute function private.create_customer_billing_profile();

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  imported_at timestamptz not null default now(),
  imported_by uuid references auth.users(id) on delete set null,
  source_file_name text not null,
  source_file_size bigint check (source_file_size is null or source_file_size >= 0),
  source_file_type text,
  source_file_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.shipments
  add column if not exists import_batch_id uuid,
  add column if not exists container_number text,
  add column if not exists minimum_billable_volume numeric(14, 4) not null default 1,
  add column if not exists storage_rate numeric(14, 3);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_import_batch_id_fkey'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments add constraint shipments_import_batch_id_fkey
      foreign key (import_batch_id) references public.import_batches(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_minimum_billable_volume_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments add constraint shipments_minimum_billable_volume_check
      check (minimum_billable_volume > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_storage_rate_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments add constraint shipments_storage_rate_check
      check (storage_rate is null or storage_rate >= 0);
  end if;
end;
$$;

create index if not exists shipments_import_batch_id_idx on public.shipments(import_batch_id);
create index if not exists shipments_container_number_idx on public.shipments(container_number);
create index if not exists import_batches_customer_imported_idx on public.import_batches(customer_id, imported_at desc);

-- Minimal metadata backfill only; shipment status, pricing and history are untouched.
update public.shipments
set container_number = nullif(btrim(source_data ->> 'container_number'), '')
where container_number is null
  and nullif(btrim(source_data ->> 'container_number'), '') is not null;

alter table public.shipments alter column tail_lift_service_fee drop default;
alter table public.shipments alter column fuel_levy_rate drop default;
alter table public.shipments alter column gst_rate drop default;
alter table public.shipments alter column warehouse_booking_charge drop default;
alter table public.shipments alter column minimum_billable_volume drop default;
alter table public.shipments alter column storage_rate drop default;

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
    new.tail_lift_service_fee := coalesce(new.tail_lift_service_fee, v_profile.default_tail_lift_fee);
    new.fuel_levy_rate := coalesce(new.fuel_levy_rate, v_profile.default_fuel_levy_rate);
    new.gst_rate := coalesce(new.gst_rate, v_profile.default_gst_rate);
    new.warehouse_booking_charge := coalesce(new.warehouse_booking_charge, v_profile.default_warehouse_booking_fee);
    new.minimum_billable_volume := coalesce(new.minimum_billable_volume, v_profile.minimum_billable_volume);
    new.storage_rate := coalesce(new.storage_rate, v_profile.default_storage_rate);
  else
    if new.tail_lift_service_fee is not distinct from old.tail_lift_service_fee then new.tail_lift_service_fee := v_profile.default_tail_lift_fee; end if;
    if new.fuel_levy_rate is not distinct from old.fuel_levy_rate then new.fuel_levy_rate := v_profile.default_fuel_levy_rate; end if;
    if new.gst_rate is not distinct from old.gst_rate then new.gst_rate := v_profile.default_gst_rate; end if;
    if new.warehouse_booking_charge is not distinct from old.warehouse_booking_charge then new.warehouse_booking_charge := v_profile.default_warehouse_booking_fee; end if;
    if new.minimum_billable_volume is not distinct from old.minimum_billable_volume then new.minimum_billable_volume := v_profile.minimum_billable_volume; end if;
    if new.storage_rate is not distinct from old.storage_rate then new.storage_rate := v_profile.default_storage_rate; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists set_default_tail_lift_service_fee_trigger on public.shipments;
drop function if exists private.set_default_tail_lift_service_fee();
drop trigger if exists apply_customer_billing_defaults_trigger on public.shipments;
create trigger apply_customer_billing_defaults_trigger
before insert or update of customer_id on public.shipments
for each row execute function private.apply_customer_billing_defaults();

-- Address matching owns only the address-derived rate. Customer billing
-- profile values and intentional shipment overrides must survive an address edit.
create or replace function public.assign_shipment_suburb_rate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate public.delivery_suburb_rates%rowtype;
begin
  select rate.* into v_rate
  from public.delivery_suburb_rates as rate
  where rate.is_active = true
    and upper(btrim(rate.zone)) in ('V1', 'V2', 'V3', 'V4')
    and upper(btrim(rate.state)) = upper(btrim(coalesce(new.state, 'VIC')))
    and nullif(btrim(new.postcode), '') is not null
    and btrim(rate.postcode) = btrim(new.postcode)
    and nullif(btrim(new.suburb), '') is not null
    and exists (
      select 1 from private.delivery_postcode_suburbs as mapping
      where mapping.state = upper(btrim(coalesce(new.state, 'VIC')))
        and mapping.postcode = btrim(new.postcode)
        and mapping.suburb = upper(btrim(new.suburb))
    )
    and rate.effective_from <= (now() at time zone 'Australia/Melbourne')::date
    and (rate.effective_to is null or rate.effective_to >= (now() at time zone 'Australia/Melbourne')::date)
  order by rate.effective_from desc
  limit 1;

  if found then
    new.delivery_rate_id := v_rate.id;
    new.unit_price := v_rate.unit_price;
  else
    new.delivery_rate_id := null;
    new.unit_price := null;
  end if;
  return new;
end;
$$;

create or replace function public.refresh_open_shipment_pricing()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin', 'operations']::text[]) then
    raise exception 'Permission denied';
  end if;

  with matched as (
    select shipment.id, rate.id as delivery_rate_id, rate.unit_price,
      row_number() over (partition by shipment.id order by rate.effective_from desc) as priority
    from public.shipments as shipment
    join public.delivery_suburb_rates as rate
      on rate.is_active = true
     and upper(btrim(rate.zone)) in ('V1', 'V2', 'V3', 'V4')
     and upper(btrim(rate.state)) = upper(btrim(coalesce(shipment.state, 'VIC')))
     and btrim(rate.postcode) = btrim(shipment.postcode)
     and exists (
       select 1 from private.delivery_postcode_suburbs as mapping
       where mapping.state = upper(btrim(coalesce(shipment.state, 'VIC')))
         and mapping.postcode = btrim(shipment.postcode)
         and mapping.suburb = upper(btrim(shipment.suburb))
     )
     and rate.effective_from <= (now() at time zone 'Australia/Melbourne')::date
     and (rate.effective_to is null or rate.effective_to >= (now() at time zone 'Australia/Melbourne')::date)
    where shipment.cancelled_at is null
      and shipment.current_status not in ('completed', 'cancelled')
  ), refreshed as (
    update public.shipments as shipment
    set delivery_rate_id = matched.delivery_rate_id,
        unit_price = matched.unit_price,
        updated_at = now()
    from matched
    where matched.id = shipment.id and matched.priority = 1
    returning shipment.id
  ), cleared as (
    update public.shipments as shipment
    set delivery_rate_id = null, unit_price = null, updated_at = now()
    where shipment.cancelled_at is null
      and shipment.current_status not in ('completed', 'cancelled')
      and not exists (select 1 from matched where matched.id = shipment.id)
    returning shipment.id
  )
  select (select count(*) from refreshed) + (select count(*) from cleared)
  into v_updated;
  return v_updated;
end;
$$;

revoke all on function public.assign_shipment_suburb_rate() from public, anon, authenticated;
revoke all on function public.refresh_open_shipment_pricing() from public, anon;
grant execute on function public.refresh_open_shipment_pricing() to authenticated;

-- One RPC owns the batch row and every shipment insert. Any invalid row rolls the
-- whole request back, so a confirmed import can never leave a partial batch.
create or replace function public.import_shipment_batch(p_batch jsonb, p_shipments jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_id uuid;
  v_customer_id uuid;
  v_item jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then raise exception 'Permission denied'; end if;
  if p_batch is null or nullif(p_batch ->> 'customer_id', '') is null then raise exception 'Import customer is required'; end if;
  if p_shipments is null or jsonb_typeof(p_shipments) is distinct from 'array' or jsonb_array_length(p_shipments) = 0 then
    raise exception 'Import must contain at least one shipment';
  end if;

  v_customer_id := (p_batch ->> 'customer_id')::uuid;
  insert into public.import_batches (
    customer_id, imported_by, source_file_name, source_file_size, source_file_type, source_file_metadata
  ) values (
    v_customer_id,
    auth.uid(),
    nullif(btrim(p_batch ->> 'source_file_name'), ''),
    nullif(p_batch ->> 'source_file_size', '')::bigint,
    nullif(p_batch ->> 'source_file_type', ''),
    coalesce(p_batch -> 'source_file_metadata', '{}'::jsonb)
  ) returning id into v_batch_id;

  for v_item in select value from jsonb_array_elements(p_shipments) loop
    if nullif(v_item ->> 'tracking_number', '') is null or nullif(v_item ->> 'delivery_address', '') is null then
      raise exception 'Every imported shipment requires a tracking number and delivery address';
    end if;
    if nullif(v_item ->> 'customer_id', '') is distinct from v_customer_id::text then
      raise exception 'Every imported shipment must belong to the batch customer';
    end if;

    insert into public.shipments (
      tracking_number, customer_reference, container_number, customer_id, customer_name,
      quantity, total_quantity, weight_kg, volume_m3, current_status, created_by,
      recipient_name, delivery_address, suburb, state, postcode, warehouse_location,
      delivery_instructions, notes, inbound_at, import_batch_id, source_data
    ) values (
      btrim(v_item ->> 'tracking_number'), nullif(v_item ->> 'customer_reference', ''), nullif(v_item ->> 'container_number', ''),
      v_customer_id, coalesce(v_item ->> 'customer_name', ''),
      coalesce(nullif(v_item ->> 'quantity', '')::integer, 1),
      coalesce(nullif(v_item ->> 'total_quantity', '')::integer, coalesce(nullif(v_item ->> 'quantity', '')::integer, 1)),
      nullif(v_item ->> 'weight_kg', '')::numeric, nullif(v_item ->> 'volume_m3', '')::numeric,
      'pending', auth.uid(), nullif(v_item ->> 'recipient_name', ''), btrim(v_item ->> 'delivery_address'),
      nullif(v_item ->> 'suburb', ''), nullif(v_item ->> 'state', ''), nullif(v_item ->> 'postcode', ''),
      nullif(v_item ->> 'warehouse_location', ''), nullif(v_item ->> 'delivery_instructions', ''), nullif(v_item ->> 'notes', ''),
      coalesce(nullif(v_item ->> 'inbound_at', '')::timestamptz, now()), v_batch_id,
      coalesce(v_item -> 'source_data', '{}'::jsonb)
    );
  end loop;

  return v_batch_id;
end;
$$;

alter table public.customer_billing_profiles enable row level security;
alter table public.import_batches enable row level security;

drop policy if exists customer_billing_profiles_read_policy on public.customer_billing_profiles;
create policy customer_billing_profiles_read_policy on public.customer_billing_profiles
for select to authenticated using (private.has_any_role(array['admin', 'operations', 'warehouse', 'viewer']::text[]));
drop policy if exists customer_billing_profiles_manage_policy on public.customer_billing_profiles;
create policy customer_billing_profiles_manage_policy on public.customer_billing_profiles
for all to authenticated using (private.has_any_role(array['admin', 'operations']::text[]))
with check (private.has_any_role(array['admin', 'operations']::text[]));

drop policy if exists import_batches_read_policy on public.import_batches;
create policy import_batches_read_policy on public.import_batches
for select to authenticated using (private.has_any_role(array['admin', 'operations', 'warehouse', 'viewer']::text[]));
drop policy if exists import_batches_insert_policy on public.import_batches;
create policy import_batches_insert_policy on public.import_batches
for insert to authenticated with check (
  imported_by = auth.uid() and private.has_any_role(array['admin', 'operations', 'warehouse']::text[])
);

grant select, insert, update on public.customer_billing_profiles to authenticated;
grant select, insert on public.import_batches to authenticated;
revoke all on function public.import_shipment_batch(jsonb, jsonb) from public, anon;
grant execute on function public.import_shipment_batch(jsonb, jsonb) to authenticated;
revoke all on function private.apply_customer_billing_defaults() from public;
revoke all on function private.create_customer_billing_profile() from public;

comment on table public.customer_billing_profiles is 'Customer-specific billing defaults; operational code must not branch on customer names.';
comment on table public.import_batches is 'Stable batch record created atomically with every shipment in one confirmed Excel or CSV import.';
comment on column public.shipments.import_batch_id is 'Null for historical/manual shipments; set for spreadsheet imports created after SQL 33.';

commit;
