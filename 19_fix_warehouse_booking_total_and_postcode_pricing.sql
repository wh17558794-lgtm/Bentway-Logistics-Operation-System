begin;

-- Old builds stored the Pending Warehouse Booking default in the final-total
-- override. Clean only rows that can be identified as that legacy behaviour.
update public.shipments as shipment
set warehouse_booking_charge = coalesce(shipment.warehouse_booking_charge, 150.000),
    total_charge_override = null,
    updated_at = now()
where shipment.current_status <> 'pending_warehouse_booking'
  and shipment.warehouse_booking_charge is null
  and shipment.total_charge_override = 150.000
  and exists (
    select 1
    from public.shipment_events as event
    where event.shipment_id = shipment.id
      and event.to_status = 'pending_warehouse_booking'
      and jsonb_typeof(event.metadata -> 'total_charge_override') = 'number'
      and (event.metadata ->> 'total_charge_override')::numeric = 150.000
  );

-- The Melbourne rate table is postcode-led. Prefer an exact postcode match;
-- only fall back to suburb text when a rate has no postcode.
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
    and upper(btrim(rate.state)) = upper(btrim(coalesce(new.state, 'VIC')))
    and (
      (
        nullif(btrim(new.postcode), '') is not null
        and nullif(btrim(rate.postcode), '') is not null
        and btrim(rate.postcode) = btrim(new.postcode)
      )
      or
      (
        nullif(btrim(rate.postcode), '') is null
        and nullif(btrim(new.suburb), '') is not null
        and lower(btrim(rate.suburb)) = lower(btrim(new.suburb))
      )
    )
    and rate.effective_from <= current_date
    and (rate.effective_to is null or rate.effective_to >= current_date)
  order by
    case
      when nullif(btrim(new.postcode), '') is not null
       and nullif(btrim(rate.postcode), '') is not null
       and btrim(rate.postcode) = btrim(new.postcode)
      then 0
      else 1
    end,
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
      and upper(btrim(rate.state)) = upper(btrim(coalesce(v_shipment.state, 'VIC')))
      and (
        (
          nullif(btrim(v_shipment.postcode), '') is not null
          and nullif(btrim(rate.postcode), '') is not null
          and btrim(rate.postcode) = btrim(v_shipment.postcode)
        )
        or
        (
          nullif(btrim(rate.postcode), '') is null
          and nullif(btrim(v_shipment.suburb), '') is not null
          and lower(btrim(rate.suburb)) = lower(btrim(v_shipment.suburb))
        )
      )
      and rate.effective_from <= current_date
      and (rate.effective_to is null or rate.effective_to >= current_date)
    order by
      case
        when nullif(btrim(v_shipment.postcode), '') is not null
         and nullif(btrim(rate.postcode), '') is not null
         and btrim(rate.postcode) = btrim(v_shipment.postcode)
        then 0
        else 1
      end,
      rate.effective_from desc
    limit 1;

    if found then
      update public.shipments
      set delivery_rate_id = v_rate.id,
          unit_price = v_rate.unit_price,
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

revoke all on function public.refresh_open_shipment_pricing() from public;
revoke all on function public.refresh_open_shipment_pricing() from anon;
grant execute on function public.refresh_open_shipment_pricing() to authenticated;

-- The $150 booking amount applies only while the shipment is in the booking
-- status. Crossing either boundary clears any final-total override so a value
-- from the previous pricing mode cannot leak into the next one.
create or replace function private.set_pending_warehouse_booking_charge()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.current_status = 'pending_warehouse_booking' then
      new.warehouse_booking_charge := coalesce(new.warehouse_booking_charge, 150.000);
      new.total_charge_override := null;
    end if;
    return new;
  end if;

  if new.current_status = 'pending_warehouse_booking'
     and old.current_status is distinct from 'pending_warehouse_booking' then
    new.warehouse_booking_charge := coalesce(new.warehouse_booking_charge, 150.000);
    new.total_charge_override := null;
  elsif old.current_status = 'pending_warehouse_booking'
        and new.current_status is distinct from 'pending_warehouse_booking' then
    new.total_charge_override := null;
  elsif new.current_status = 'pending_warehouse_booking'
        and new.warehouse_booking_charge is null then
    new.warehouse_booking_charge := 150.000;
  end if;

  return new;
end;
$$;

drop trigger if exists set_pending_warehouse_booking_charge_trigger on public.shipments;
create trigger set_pending_warehouse_booking_charge_trigger
before insert or update of current_status, warehouse_booking_charge, total_charge_override
on public.shipments
for each row
execute function private.set_pending_warehouse_booking_charge();

revoke all on function private.set_pending_warehouse_booking_charge() from public;

-- Reprice existing open shipments with the corrected postcode-first rule.
with matched_rates as (
  select
    shipment.id as shipment_id,
    rate.id as rate_id,
    rate.unit_price,
    rate.fuel_levy_rate,
    rate.gst_rate
  from public.shipments as shipment
  left join lateral (
    select candidate.*
    from public.delivery_suburb_rates as candidate
    where candidate.is_active = true
      and upper(btrim(candidate.state)) = upper(btrim(coalesce(shipment.state, 'VIC')))
      and (
        (
          nullif(btrim(shipment.postcode), '') is not null
          and nullif(btrim(candidate.postcode), '') is not null
          and btrim(candidate.postcode) = btrim(shipment.postcode)
        )
        or
        (
          nullif(btrim(candidate.postcode), '') is null
          and nullif(btrim(shipment.suburb), '') is not null
          and lower(btrim(candidate.suburb)) = lower(btrim(shipment.suburb))
        )
      )
      and candidate.effective_from <= current_date
      and (candidate.effective_to is null or candidate.effective_to >= current_date)
    order by
      case
        when nullif(btrim(shipment.postcode), '') is not null
         and nullif(btrim(candidate.postcode), '') is not null
         and btrim(candidate.postcode) = btrim(shipment.postcode)
        then 0
        else 1
      end,
      candidate.effective_from desc
    limit 1
  ) as rate on true
  where shipment.current_status not in ('completed', 'cancelled')
)
update public.shipments as shipment
set delivery_rate_id = matched_rates.rate_id,
    unit_price = matched_rates.unit_price,
    fuel_levy_rate = coalesce(matched_rates.fuel_levy_rate, shipment.fuel_levy_rate),
    gst_rate = coalesce(matched_rates.gst_rate, shipment.gst_rate),
    updated_at = now()
from matched_rates
where shipment.id = matched_rates.shipment_id
  and (
    shipment.delivery_rate_id is distinct from matched_rates.rate_id
    or shipment.unit_price is distinct from matched_rates.unit_price
    or shipment.fuel_levy_rate is distinct from coalesce(matched_rates.fuel_levy_rate, shipment.fuel_levy_rate)
    or shipment.gst_rate is distinct from coalesce(matched_rates.gst_rate, shipment.gst_rate)
  );

comment on column public.shipments.warehouse_booking_charge is
  'Pending Warehouse Booking base amount in AUD. Defaults to 150 and is used only while that status is active.';
comment on column public.shipments.total_charge_override is
  'Optional manually entered final Total Charge for the current pricing mode. Cleared when entering or leaving Pending Warehouse Booking.';

commit;
