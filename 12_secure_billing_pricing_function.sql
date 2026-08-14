begin;

-- The caller already has to be an admin or operations user, and RLS permits
-- those roles to read rates and update shipments. Use invoker rights so this
-- maintenance function does not bypass the normal table policies.
alter function public.refresh_open_shipment_pricing()
  security invoker;

revoke all on function public.refresh_open_shipment_pricing() from public;
revoke all on function public.refresh_open_shipment_pricing() from anon;
grant execute on function public.refresh_open_shipment_pricing() to authenticated;

commit;
