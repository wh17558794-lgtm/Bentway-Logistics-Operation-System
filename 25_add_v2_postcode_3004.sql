begin;

insert into public.delivery_suburb_rates (
  suburb,
  zone,
  postcode,
  state,
  unit_price,
  fuel_levy_rate,
  gst_rate,
  is_active
)
values (null, 'V2', '3004', 'VIC', 40, 0.20, 0.10, true)
on conflict (
  upper(btrim(state)),
  btrim(postcode)
)
where is_active = true
  and nullif(btrim(postcode), '') is not null
do update set
  zone = excluded.zone,
  unit_price = excluded.unit_price,
  fuel_levy_rate = excluded.fuel_levy_rate,
  gst_rate = excluded.gst_rate,
  effective_to = null,
  updated_at = now();

-- Re-run the existing pricing trigger only for open shipments in postcode 3004.
update public.shipments
set postcode = btrim(postcode),
    updated_at = now()
where current_status not in ('completed', 'cancelled')
  and btrim(postcode) = '3004';

commit;
