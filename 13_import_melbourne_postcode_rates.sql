begin;

-- BentWay Melbourne delivery zones. The confirmed price unit is AUD per m³.
-- Postcode is the primary match; suburb-name rates remain available as a
-- fallback for future exceptions.
alter table public.delivery_suburb_rates
  add column if not exists zone text;

alter table public.delivery_suburb_rates
  alter column suburb drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'delivery_suburb_rates_location_check'
      and conrelid = 'public.delivery_suburb_rates'::regclass
  ) then
    alter table public.delivery_suburb_rates
      add constraint delivery_suburb_rates_location_check
      check (
        nullif(btrim(suburb), '') is not null
        or nullif(btrim(postcode), '') is not null
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'delivery_suburb_rates_zone_check'
      and conrelid = 'public.delivery_suburb_rates'::regclass
  ) then
    alter table public.delivery_suburb_rates
      add constraint delivery_suburb_rates_zone_check
      check (zone is null or zone in ('V1', 'V2', 'V3', 'V4'));
  end if;
end;
$$;

create unique index if not exists delivery_suburb_rates_active_postcode_uidx
  on public.delivery_suburb_rates (
    upper(btrim(state)),
    btrim(postcode)
  )
  where is_active = true
    and nullif(btrim(postcode), '') is not null;

create index if not exists delivery_suburb_rates_postcode_lookup_idx
  on public.delivery_suburb_rates (
    btrim(postcode),
    upper(btrim(state)),
    effective_from desc
  )
  where is_active = true
    and nullif(btrim(postcode), '') is not null;

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
      when nullif(btrim(rate.postcode), '') is not null
       and btrim(rate.postcode) = btrim(coalesce(new.postcode, ''))
      then 0
      else 1
    end,
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
        when nullif(btrim(rate.postcode), '') is not null
         and btrim(rate.postcode) = btrim(coalesce(v_shipment.postcode, ''))
        then 0
        else 1
      end,
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

with confirmed_rates(zone, postcode, unit_price) as (
  values
    ('V1', '3003', 40),
    ('V1', '3008', 40),
    ('V1', '3011', 40),
    ('V1', '3012', 40),
    ('V1', '3013', 40),
    ('V1', '3015', 40),
    ('V1', '3016', 40),
    ('V1', '3018', 40),
    ('V1', '3019', 40),
    ('V1', '3020', 40),
    ('V1', '3021', 40),
    ('V1', '3022', 40),
    ('V1', '3025', 40),
    ('V1', '3026', 40),
    ('V1', '3032', 40),
    ('V1', '3033', 40),
    ('V1', '3042', 40),
    ('V1', '3051', 40),
    ('V1', '3052', 40),
    ('V1', '3053', 40),
    ('V1', '3054', 40),
    ('V1', '3065', 40),
    ('V1', '3207', 40),
    ('V2', '3000', 40),
    ('V2', '3002', 40),
    ('V2', '3006', 40),
    ('V2', '3023', 40),
    ('V2', '3027', 40),
    ('V2', '3028', 40),
    ('V2', '3029', 40),
    ('V2', '3031', 40),
    ('V2', '3034', 40),
    ('V2', '3036', 40),
    ('V2', '3037', 40),
    ('V2', '3038', 40),
    ('V2', '3039', 40),
    ('V2', '3040', 40),
    ('V2', '3041', 40),
    ('V2', '3043', 40),
    ('V2', '3044', 40),
    ('V2', '3045', 40),
    ('V2', '3046', 40),
    ('V2', '3047', 40),
    ('V2', '3048', 40),
    ('V2', '3049', 40),
    ('V2', '3055', 40),
    ('V2', '3056', 40),
    ('V2', '3057', 40),
    ('V2', '3058', 40),
    ('V2', '3059', 40),
    ('V2', '3060', 40),
    ('V2', '3061', 40),
    ('V2', '3062', 40),
    ('V2', '3063', 40),
    ('V2', '3066', 40),
    ('V2', '3067', 40),
    ('V2', '3068', 40),
    ('V2', '3070', 40),
    ('V2', '3071', 40),
    ('V2', '3072', 40),
    ('V2', '3074', 40),
    ('V2', '3075', 40),
    ('V2', '3078', 40),
    ('V2', '3079', 40),
    ('V2', '3081', 40),
    ('V2', '3101', 40),
    ('V2', '3102', 40),
    ('V2', '3103', 40),
    ('V2', '3104', 40),
    ('V2', '3105', 40),
    ('V2', '3107', 40),
    ('V2', '3108', 40),
    ('V2', '3121', 40),
    ('V2', '3122', 40),
    ('V2', '3123', 40),
    ('V2', '3124', 40),
    ('V2', '3125', 40),
    ('V2', '3126', 40),
    ('V2', '3129', 40),
    ('V2', '3141', 40),
    ('V2', '3142', 40),
    ('V2', '3143', 40),
    ('V2', '3144', 40),
    ('V2', '3145', 40),
    ('V2', '3146', 40),
    ('V2', '3147', 40),
    ('V2', '3161', 40),
    ('V2', '3162', 40),
    ('V2', '3181', 40),
    ('V2', '3182', 40),
    ('V2', '3183', 40),
    ('V2', '3184', 40),
    ('V2', '3185', 40),
    ('V2', '3186', 40),
    ('V2', '3187', 40),
    ('V2', '3188', 40),
    ('V2', '3205', 40),
    ('V2', '3206', 40),
    ('V2', '3335', 40),
    ('V2', '3336', 40),
    ('V2', '3427', 40),
    ('V2', '3428', 40),
    ('V3', '3024', 60),
    ('V3', '3030', 60),
    ('V3', '3064', 60),
    ('V3', '3073', 60),
    ('V3', '3076', 60),
    ('V3', '3082', 60),
    ('V3', '3083', 60),
    ('V3', '3084', 60),
    ('V3', '3085', 60),
    ('V3', '3087', 60),
    ('V3', '3088', 60),
    ('V3', '3089', 60),
    ('V3', '3090', 60),
    ('V3', '3091', 60),
    ('V3', '3093', 60),
    ('V3', '3094', 60),
    ('V3', '3095', 60),
    ('V3', '3096', 60),
    ('V3', '3097', 60),
    ('V3', '3106', 60),
    ('V3', '3109', 60),
    ('V3', '3111', 60),
    ('V3', '3113', 60),
    ('V3', '3114', 60),
    ('V3', '3115', 60),
    ('V3', '3127', 60),
    ('V3', '3128', 60),
    ('V3', '3130', 60),
    ('V3', '3131', 60),
    ('V3', '3132', 60),
    ('V3', '3133', 60),
    ('V3', '3134', 60),
    ('V3', '3135', 60),
    ('V3', '3136', 60),
    ('V3', '3137', 60),
    ('V3', '3138', 60),
    ('V3', '3148', 60),
    ('V3', '3149', 60),
    ('V3', '3150', 60),
    ('V3', '3151', 60),
    ('V3', '3152', 60),
    ('V3', '3153', 60),
    ('V3', '3154', 60),
    ('V3', '3155', 60),
    ('V3', '3156', 60),
    ('V3', '3158', 60),
    ('V3', '3163', 60),
    ('V3', '3165', 60),
    ('V3', '3166', 60),
    ('V3', '3167', 60),
    ('V3', '3168', 60),
    ('V3', '3169', 60),
    ('V3', '3170', 60),
    ('V3', '3171', 60),
    ('V3', '3172', 60),
    ('V3', '3173', 60),
    ('V3', '3174', 60),
    ('V3', '3175', 60),
    ('V3', '3177', 60),
    ('V3', '3178', 60),
    ('V3', '3179', 60),
    ('V3', '3180', 60),
    ('V3', '3189', 60),
    ('V3', '3190', 60),
    ('V3', '3191', 60),
    ('V3', '3192', 60),
    ('V3', '3193', 60),
    ('V3', '3194', 60),
    ('V3', '3195', 60),
    ('V3', '3202', 60),
    ('V3', '3204', 60),
    ('V3', '3337', 60),
    ('V3', '3338', 60),
    ('V3', '3429', 60),
    ('V3', '3750', 60),
    ('V3', '3752', 60),
    ('V3', '3754', 60),
    ('V3', '3765', 60),
    ('V3', '3785', 60),
    ('V3', '3802', 60),
    ('V3', '3803', 60),
    ('V3', '3804', 60),
    ('V3', '3805', 60),
    ('V3', '3806', 60),
    ('V3', '3975', 60),
    ('V3', '3976', 60),
    ('V4', '3160', 100),
    ('V4', '3196', 100),
    ('V4', '3197', 100),
    ('V4', '3198', 100),
    ('V4', '3199', 100),
    ('V4', '3200', 100),
    ('V4', '3201', 100),
    ('V4', '3756', 100),
    ('V4', '3807', 100),
    ('V4', '3808', 100),
    ('V4', '3809', 100),
    ('V4', '3810', 100),
    ('V4', '3910', 100),
    ('V4', '3911', 100),
    ('V4', '3921', 100),
    ('V4', '3930', 100),
    ('V4', '3977', 100),
    ('V4', '3978', 100)
)
insert into public.delivery_suburb_rates (
  suburb,
  zone,
  postcode,
  state,
  unit_price,
  base_charge,
  fuel_levy_rate,
  gst_rate,
  is_active
)
select
  null,
  confirmed_rates.zone,
  confirmed_rates.postcode,
  'VIC',
  confirmed_rates.unit_price,
  80,
  0.20,
  0.10,
  true
from confirmed_rates
on conflict do nothing;

-- Re-run the price trigger for all open shipments. This does not change their
-- postcode; it only attaches the newly imported price snapshot.
update public.shipments
set postcode = postcode,
    updated_at = now()
where current_status not in ('completed', 'cancelled')
  and nullif(btrim(postcode), '') is not null;

comment on column public.delivery_suburb_rates.zone is
  'BentWay Melbourne delivery zone (V1, V2, V3 or V4).';
comment on column public.delivery_suburb_rates.unit_price is
  'Delivery price in AUD per cubic metre.';

commit;

