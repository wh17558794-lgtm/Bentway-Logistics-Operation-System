begin;

alter table public.shipments
  drop column total_charge;

alter table public.shipments
  add column total_charge numeric(14, 3)
  generated always as (
    case
      -- Pending Warehouse Booking is a standalone booking price. Crane Truck
      -- Fee remains recorded on the shipment but does not affect this status.
      when current_status = 'pending_warehouse_booking' then
        round(coalesce(warehouse_booking_charge, 150.000), 3)
      when volume_m3 is null or unit_price is null then null
      else round(
        (
          (volume_m3 * unit_price)
          + tail_lift_service_fee
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

comment on column public.shipments.total_charge is
  'Calculated shipment charge. Pending Warehouse Booking uses only its booking amount (default 150 AUD); other statuses use standard pricing plus any Crane Truck Fee.';

commit;
