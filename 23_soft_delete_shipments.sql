begin;

-- Hide shipments from the operating UI without deleting shipment or event rows.
create or replace function public.archive_shipment(
  p_shipment_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin']::text[]) then
    raise exception 'Only administrators can remove shipments from the system';
  end if;

  update public.shipments
  set cancelled_at = now(),
      cancelled_by = auth.uid(),
      cancellation_reason = 'Removed from operations system',
      updated_at = now()
  where id = p_shipment_id
    and cancelled_at is null
  returning current_status into v_status;

  if not found then
    raise exception 'Shipment was not found or is already removed';
  end if;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, metadata
  )
  values (
    p_shipment_id, 'details_updated', v_status, v_status, now(), auth.uid(),
    jsonb_build_object('action', 'removed_from_operations_system')
  );
end;
$$;

revoke all on function public.archive_shipment(uuid) from public;
revoke all on function public.archive_shipment(uuid) from anon;
revoke all on function public.archive_shipment(uuid) from authenticated;
grant execute on function public.archive_shipment(uuid) to authenticated;

-- Prevent the web system from physically deleting shipment data.
revoke all on function public.delete_shipment_permanently(uuid) from public;
revoke all on function public.delete_shipment_permanently(uuid) from anon;
revoke all on function public.delete_shipment_permanently(uuid) from authenticated;

comment on function public.archive_shipment(uuid) is
  'Hides a shipment from the operations UI while preserving its row, status, charges and event history.';

commit;
