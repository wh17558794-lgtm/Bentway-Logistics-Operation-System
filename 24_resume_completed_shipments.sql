begin;

create or replace function public.resume_completed_shipment(
  p_shipment_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbound_method text;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'You do not have permission to resume shipments';
  end if;

  select outbound_method
  into v_outbound_method
  from public.shipments
  where id = p_shipment_id
    and current_status = 'completed'
    and cancelled_at is null
  for update;

  if not found then
    raise exception 'Completed shipment was not found';
  end if;

  update public.shipments
  set current_status = 'pending',
      outbound_method = null,
      outbound_at = null,
      scheduled_for = null,
      on_hold_started_at = null,
      updated_at = now()
  where id = p_shipment_id;

  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, metadata
  ) values (
    p_shipment_id,
    'status_changed',
    'completed',
    'pending',
    now(),
    auth.uid(),
    jsonb_build_object('action', 'resumed_from_history', 'previous_outbound_method', v_outbound_method)
  );
end;
$$;

revoke all on function public.resume_completed_shipment(uuid) from public;
revoke all on function public.resume_completed_shipment(uuid) from anon;
revoke all on function public.resume_completed_shipment(uuid) from authenticated;
grant execute on function public.resume_completed_shipment(uuid) to authenticated;

comment on function public.resume_completed_shipment(uuid) is
  'Returns a completed shipment to Pending while preserving its shipment and event history.';

commit;
