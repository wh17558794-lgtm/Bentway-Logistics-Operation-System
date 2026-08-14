begin;

-- Migration 19 originally compared the JSON value as text. Historic events
-- store the same number with decimal places, so normalise it as numeric before
-- identifying the legacy Pending Warehouse Booking override.
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

commit;
