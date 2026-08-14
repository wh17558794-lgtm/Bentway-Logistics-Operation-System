begin;

alter table public.shipments
  add column if not exists crane_required boolean not null default false,
  add column if not exists crane_truck_fee numeric(14, 2) not null default 0,
  add column if not exists fuel_levy_override numeric(14, 3),
  add column if not exists warehouse_booking_charge numeric(14, 3);

drop trigger if exists set_pending_warehouse_booking_charge_trigger on public.shipments;

alter table public.shipments
  alter column total_charge_override type numeric(14, 3);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_crane_truck_fee_nonnegative_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_crane_truck_fee_nonnegative_check
      check (crane_truck_fee >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_crane_required_fee_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_crane_required_fee_check
      check (
        (crane_required = false and crane_truck_fee = 0)
        or (crane_required = true and crane_truck_fee > 0)
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_fuel_levy_override_nonnegative_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_fuel_levy_override_nonnegative_check
      check (fuel_levy_override is null or fuel_levy_override >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_warehouse_booking_charge_nonnegative_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_warehouse_booking_charge_nonnegative_check
      check (warehouse_booking_charge is null or warehouse_booking_charge >= 0);
  end if;
end;
$$;

-- Move the former pending-booking override into its own automatic base amount.
-- This leaves total_charge_override available as a true final-total override.
update public.shipments
set warehouse_booking_charge = coalesce(total_charge_override, 150.000),
    total_charge_override = null
where current_status = 'pending_warehouse_booking';

-- Base charge is now the tail-lift service fee. Existing Oreo shipments use
-- $70; every other customer uses $80.
update public.shipments as shipment
set base_charge = case
  when lower(btrim(customer.name)) like 'oreo%' then 70.00
  else 80.00
end
from public.customers as customer
where customer.id = shipment.customer_id;

create or replace function private.set_default_tail_lift_service_fee()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_customer_name text;
begin
  if tg_op = 'UPDATE'
     and new.customer_id is not distinct from old.customer_id then
    return new;
  end if;

  -- If the customer and Tail Lift Service Fee are deliberately changed in
  -- the same edit, preserve the manually entered fee.
  if tg_op = 'UPDATE'
     and new.base_charge is distinct from old.base_charge then
    return new;
  end if;

  select name
  into v_customer_name
  from public.customers
  where id = new.customer_id;

  new.base_charge := case
    when lower(btrim(coalesce(v_customer_name, new.customer_name, ''))) like 'oreo%' then 70.00
    else 80.00
  end;

  return new;
end;
$$;

drop trigger if exists set_default_tail_lift_service_fee_trigger on public.shipments;
create trigger set_default_tail_lift_service_fee_trigger
before insert or update of customer_id
on public.shipments
for each row
execute function private.set_default_tail_lift_service_fee();

revoke all on function private.set_default_tail_lift_service_fee() from public;

-- Suburb pricing controls the unit price only. Tail-lift service is customer
-- dependent and must not be reset when an address is edited.
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
    new.fuel_levy_rate := v_rate.fuel_levy_rate;
    new.gst_rate := v_rate.gst_rate;
  else
    new.delivery_rate_id := null;
    new.unit_price := null;
  end if;

  return new;
end;
$$;

revoke all on function public.assign_shipment_suburb_rate() from public;
revoke all on function public.assign_shipment_suburb_rate() from anon;
revoke all on function public.assign_shipment_suburb_rate() from authenticated;

create or replace function private.set_pending_warehouse_booking_charge()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.current_status = 'pending_warehouse_booking'
     and new.warehouse_booking_charge is null then
    new.warehouse_booking_charge := 150.000;
  end if;

  return new;
end;
$$;

drop trigger if exists set_pending_warehouse_booking_charge_trigger on public.shipments;
create trigger set_pending_warehouse_booking_charge_trigger
before insert or update of current_status, warehouse_booking_charge
on public.shipments
for each row
execute function private.set_pending_warehouse_booking_charge();

revoke all on function private.set_pending_warehouse_booking_charge() from public;

alter table public.shipments
  drop column total_charge;

alter table public.shipments
  add column total_charge numeric(14, 3)
  generated always as (
    case
      when current_status = 'pending_warehouse_booking' then
        round(
          coalesce(warehouse_booking_charge, 150.000)
          + case when crane_required then crane_truck_fee else 0 end,
          3
        )
      when volume_m3 is null or unit_price is null then null
      else round(
        (
          (volume_m3 * unit_price)
          + base_charge
          + coalesce(
              fuel_levy_override,
              volume_m3 * unit_price * fuel_levy_rate
            )
        ) * (1 + gst_rate)
        + case when crane_required then crane_truck_fee else 0 end,
        3
      )
    end
  ) stored;

comment on column public.shipments.base_charge is
  'Tail Lift Service Fee in AUD. Defaults to 70 for Oreo Logistics and 80 for other customers.';
comment on column public.shipments.crane_required is
  'Whether a crane truck is required for this shipment.';
comment on column public.shipments.crane_truck_fee is
  'Crane Truck Fee in AUD. Added after the GST-inclusive standard shipment charge.';
comment on column public.shipments.fuel_levy_override is
  'Optional manually entered Fuel Levy. NULL uses volume x unit price x fuel levy rate.';
comment on column public.shipments.warehouse_booking_charge is
  'Base total for Pending Warehouse Booking shipments. Defaults to 150 AUD.';
comment on column public.shipments.total_charge is
  'Calculated charge including Tail Lift Service, effective Fuel Levy, GST and optional Crane Truck Fee.';
comment on column public.shipments.total_charge_override is
  'Optional manually entered final Total Charge. NULL uses the calculated total_charge value.';

grant select, insert, update on table public.shipments to authenticated;

commit;
