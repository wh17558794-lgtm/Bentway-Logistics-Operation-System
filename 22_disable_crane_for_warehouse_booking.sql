begin;

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
      new.crane_required := false;
      new.crane_truck_fee := 0;
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

  -- Warehouse-booking work never uses a crane service. Enforce this rule for
  -- every write path, including direct table updates and status RPC calls.
  if new.current_status = 'pending_warehouse_booking' then
    new.crane_required := false;
    new.crane_truck_fee := 0;
  end if;

  return new;
end;
$$;

drop trigger if exists set_pending_warehouse_booking_charge_trigger on public.shipments;
create trigger set_pending_warehouse_booking_charge_trigger
before insert or update of
  current_status,
  warehouse_booking_charge,
  total_charge_override,
  crane_required,
  crane_truck_fee
on public.shipments
for each row
execute function private.set_pending_warehouse_booking_charge();

revoke all on function private.set_pending_warehouse_booking_charge() from public;

-- Bring existing warehouse-booking rows into the same enforced state.
update public.shipments
set crane_required = false,
    crane_truck_fee = 0,
    updated_at = now()
where current_status = 'pending_warehouse_booking'
  and (crane_required = true or crane_truck_fee <> 0);

comment on column public.shipments.crane_required is
  'Whether a crane truck is required. Forced to false for Pending Warehouse Booking shipments.';
comment on column public.shipments.crane_truck_fee is
  'Crane Truck Fee in AUD. Forced to zero for Pending Warehouse Booking shipments.';

commit;
