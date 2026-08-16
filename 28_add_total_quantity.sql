begin;

alter table public.shipments
  add column if not exists total_quantity integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_total_quantity_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_total_quantity_check
      check (total_quantity is null or total_quantity >= quantity);
  end if;
end;
$$;

comment on column public.shipments.quantity is
  'Actual item quantity received at the warehouse for this shipment.';

comment on column public.shipments.total_quantity is
  'Expected total item quantity for this shipment. NULL is treated as equal to quantity by the application.';

commit;
