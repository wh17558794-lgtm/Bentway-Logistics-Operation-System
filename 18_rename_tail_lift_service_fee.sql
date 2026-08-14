begin;

alter table public.shipments
  rename column base_charge to tail_lift_service_fee;

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

  if tg_op = 'UPDATE'
     and new.tail_lift_service_fee is distinct from old.tail_lift_service_fee then
    return new;
  end if;

  select name
  into v_customer_name
  from public.customers
  where id = new.customer_id;

  new.tail_lift_service_fee := case
    when lower(btrim(coalesce(v_customer_name, new.customer_name, ''))) like 'oreo%' then 70.00
    else 80.00
  end;

  return new;
end;
$$;

revoke all on function private.set_default_tail_lift_service_fee() from public;

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

comment on column public.shipments.tail_lift_service_fee is
  'Tail Lift Service Fee in AUD. Defaults to 70 for Oreo Logistics and 80 for other customers.';

-- The old suburb-level base charge is no longer used. Tail-lift pricing is
-- customer-specific and is stored on each shipment instead.
alter table public.delivery_suburb_rates
  drop column if exists base_charge;

commit;
