begin;

alter table public.shipments
  drop column total_charge;

alter table public.shipments
  add column total_charge numeric(14, 3)
  generated always as (
    case
      when current_status = 'pending_warehouse_booking' then
        round(coalesce(warehouse_booking_charge, 150.000), 3)
      when volume_m3 is null or unit_price is null then null
      else round(
        (
          (greatest(volume_m3, 1) * unit_price)
          + tail_lift_service_fee
          + coalesce(
              fuel_levy_override,
              greatest(volume_m3, 1) * unit_price * fuel_levy_rate
            )
        ) * (1 + gst_rate)
        + case when crane_required then crane_truck_fee else 0 end,
        3
      )
    end
  ) stored;

comment on column public.shipments.total_charge is
  'Calculated shipment charge. Standard pricing uses a minimum billable volume of 1 m3; Pending Warehouse Booking uses only its booking amount.';

commit;
