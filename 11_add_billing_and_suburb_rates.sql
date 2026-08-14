begin;

-- Suburb price master. Prices can be imported from the Melbourne delivery-rate
-- workbook later without mixing reusable rates into individual shipment rows.
create table if not exists public.delivery_suburb_rates (
  id uuid primary key default gen_random_uuid(),
  suburb text not null check (btrim(suburb) <> ''),
  state text not null default 'VIC' check (btrim(state) <> ''),
  postcode text,
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  base_charge numeric(12, 2) not null default 80 check (base_charge >= 0),
  fuel_levy_rate numeric(7, 6) not null default 0.20 check (fuel_levy_rate >= 0),
  gst_rate numeric(7, 6) not null default 0.10 check (gst_rate >= 0),
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create unique index if not exists delivery_suburb_rates_active_location_uidx
  on public.delivery_suburb_rates (
    lower(btrim(suburb)),
    upper(btrim(state)),
    coalesce(btrim(postcode), '')
  )
  where is_active = true;

create index if not exists delivery_suburb_rates_lookup_idx
  on public.delivery_suburb_rates (
    lower(btrim(suburb)),
    upper(btrim(state)),
    effective_from desc
  )
  where is_active = true;

-- Weight already exists in the original shipments table. Add the volume and
-- price snapshot fields that are needed for the billing view.
alter table public.shipments
  add column if not exists volume_m3 numeric(12, 4),
  add column if not exists delivery_rate_id uuid,
  add column if not exists unit_price numeric(12, 2),
  add column if not exists base_charge numeric(12, 2) not null default 80,
  add column if not exists fuel_levy_rate numeric(7, 6) not null default 0.20,
  add column if not exists gst_rate numeric(7, 6) not null default 0.10;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_weight_kg_nonnegative_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_weight_kg_nonnegative_check
      check (weight_kg is null or weight_kg >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_volume_m3_nonnegative_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_volume_m3_nonnegative_check
      check (volume_m3 is null or volume_m3 >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_unit_price_nonnegative_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_unit_price_nonnegative_check
      check (unit_price is null or unit_price >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_billing_settings_nonnegative_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_billing_settings_nonnegative_check
      check (base_charge >= 0 and fuel_levy_rate >= 0 and gst_rate >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_delivery_rate_id_fkey'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_delivery_rate_id_fkey
      foreign key (delivery_rate_id)
      references public.delivery_suburb_rates(id)
      on delete set null;
  end if;
end;
$$;

alter table public.shipments
  add column if not exists fuel_levy numeric(14, 2)
    generated always as (
      case
        when volume_m3 is null or unit_price is null then null
        else round(volume_m3 * unit_price * fuel_levy_rate, 2)
      end
    ) stored,
  add column if not exists total_charge numeric(14, 2)
    generated always as (
      case
        when volume_m3 is null or unit_price is null then null
        else round(
          (
            (volume_m3 * unit_price)
            + base_charge
            + (volume_m3 * unit_price * fuel_levy_rate)
          ) * (1 + gst_rate),
          2
        )
      end
    ) stored;

create index if not exists shipments_delivery_rate_id_idx
  on public.shipments(delivery_rate_id);

-- Copy the currently applicable rate into the shipment. This snapshot means a
-- later rate-table change does not rewrite historical shipment charges.
create or replace function public.assign_shipment_suburb_rate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate public.delivery_suburb_rates%rowtype;
begin
  select rate.*
  into v_rate
  from public.delivery_suburb_rates as rate
  where rate.is_active = true
    and lower(btrim(rate.suburb)) = lower(btrim(new.suburb))
    and upper(btrim(rate.state)) = upper(btrim(coalesce(new.state, 'VIC')))
    and (rate.postcode is null or btrim(rate.postcode) = btrim(coalesce(new.postcode, '')))
    and rate.effective_from <= current_date
    and (rate.effective_to is null or rate.effective_to >= current_date)
  order by
    case when rate.postcode is not null and btrim(rate.postcode) = btrim(coalesce(new.postcode, '')) then 0 else 1 end,
    rate.effective_from desc
  limit 1;

  if found then
    new.delivery_rate_id := v_rate.id;
    new.unit_price := v_rate.unit_price;
    new.base_charge := v_rate.base_charge;
    new.fuel_levy_rate := v_rate.fuel_levy_rate;
    new.gst_rate := v_rate.gst_rate;
  else
    new.delivery_rate_id := null;
    new.unit_price := null;
  end if;

  return new;
end;
$$;

drop trigger if exists assign_shipment_suburb_rate_trigger on public.shipments;
create trigger assign_shipment_suburb_rate_trigger
before insert or update of suburb, state, postcode
on public.shipments
for each row
execute function public.assign_shipment_suburb_rate();

-- Run this after a new rate workbook is imported to price any still-open
-- shipments using the new master data. Closed historical records are untouched.
create or replace function public.refresh_open_shipment_pricing()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_shipment record;
  v_rate public.delivery_suburb_rates%rowtype;
  v_updated integer := 0;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin', 'operations']::text[]) then
    raise exception 'Permission denied';
  end if;

  for v_shipment in
    select id, suburb, state, postcode
    from public.shipments
    where current_status not in ('completed', 'cancelled')
  loop
    select rate.*
    into v_rate
    from public.delivery_suburb_rates as rate
    where rate.is_active = true
      and lower(btrim(rate.suburb)) = lower(btrim(v_shipment.suburb))
      and upper(btrim(rate.state)) = upper(btrim(coalesce(v_shipment.state, 'VIC')))
      and (rate.postcode is null or btrim(rate.postcode) = btrim(coalesce(v_shipment.postcode, '')))
      and rate.effective_from <= current_date
      and (rate.effective_to is null or rate.effective_to >= current_date)
    order by
      case when rate.postcode is not null and btrim(rate.postcode) = btrim(coalesce(v_shipment.postcode, '')) then 0 else 1 end,
      rate.effective_from desc
    limit 1;

    if found then
      update public.shipments
      set delivery_rate_id = v_rate.id,
          unit_price = v_rate.unit_price,
          base_charge = v_rate.base_charge,
          fuel_levy_rate = v_rate.fuel_levy_rate,
          gst_rate = v_rate.gst_rate,
          updated_at = now()
      where id = v_shipment.id;
    else
      update public.shipments
      set delivery_rate_id = null,
          unit_price = null,
          updated_at = now()
      where id = v_shipment.id;
    end if;

    v_updated := v_updated + 1;
  end loop;

  return v_updated;
end;
$$;

create or replace function public.set_delivery_suburb_rate_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_delivery_suburb_rate_updated_at_trigger on public.delivery_suburb_rates;
create trigger set_delivery_suburb_rate_updated_at_trigger
before update on public.delivery_suburb_rates
for each row
execute function public.set_delivery_suburb_rate_updated_at();

alter table public.delivery_suburb_rates enable row level security;

drop policy if exists delivery_suburb_rates_read_policy on public.delivery_suburb_rates;
create policy delivery_suburb_rates_read_policy
on public.delivery_suburb_rates
for select
to authenticated
using (
  private.has_any_role(array['admin', 'operations', 'warehouse', 'driver', 'viewer']::text[])
);

drop policy if exists delivery_suburb_rates_insert_policy on public.delivery_suburb_rates;
create policy delivery_suburb_rates_insert_policy
on public.delivery_suburb_rates
for insert
to authenticated
with check (
  private.has_any_role(array['admin', 'operations']::text[])
);

drop policy if exists delivery_suburb_rates_update_policy on public.delivery_suburb_rates;
create policy delivery_suburb_rates_update_policy
on public.delivery_suburb_rates
for update
to authenticated
using (
  private.has_any_role(array['admin', 'operations']::text[])
)
with check (
  private.has_any_role(array['admin', 'operations']::text[])
);

drop policy if exists delivery_suburb_rates_delete_policy on public.delivery_suburb_rates;
create policy delivery_suburb_rates_delete_policy
on public.delivery_suburb_rates
for delete
to authenticated
using (
  private.has_any_role(array['admin']::text[])
);

grant select, insert, update, delete on table public.delivery_suburb_rates to authenticated;
grant select, insert, update on table public.shipments to authenticated;

revoke all on function public.refresh_open_shipment_pricing() from public;
revoke all on function public.refresh_open_shipment_pricing() from anon;
grant execute on function public.refresh_open_shipment_pricing() to authenticated;

revoke all on function public.assign_shipment_suburb_rate() from public;
revoke all on function public.set_delivery_suburb_rate_updated_at() from public;

comment on table public.delivery_suburb_rates is
  'Melbourne delivery unit prices keyed by suburb, with optional postcode-specific overrides.';
comment on column public.shipments.weight_kg is 'Actual shipment weight in kilograms.';
comment on column public.shipments.volume_m3 is 'Shipment volume in cubic metres.';
comment on column public.shipments.unit_price is 'Snapshot of the matched suburb delivery price in AUD per cubic metre.';
comment on column public.shipments.fuel_levy is 'Volume x unit price x fuel levy rate.';
comment on column public.shipments.total_charge is 'GST-inclusive total: (volume x unit price + base charge + fuel levy) x (1 + GST rate).';

commit;
