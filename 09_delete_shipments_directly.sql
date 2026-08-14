begin;

-- 删除操作现在会直接移除货物及其事件记录，不再要求先标记为作废。
-- 只有 profiles.role = 'admin' 的已登录用户可以调用此函数。
create or replace function public.delete_shipment_permanently(
  p_shipment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  deleted_tracking_number text;
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin']::text[]) then
    raise exception 'Only administrators can permanently delete shipments';
  end if;

  delete from public.shipment_events
  where shipment_id = p_shipment_id;

  delete from public.shipments
  where id = p_shipment_id
  returning tracking_number into deleted_tracking_number;

  if deleted_tracking_number is null then
    raise exception 'Shipment was not found';
  end if;
end;
$$;

-- SECURITY DEFINER 函数默认可能授予 PUBLIC 执行权，因此先全部撤销再最小化授权。
revoke all on function public.delete_shipment_permanently(uuid) from public;
revoke all on function public.delete_shipment_permanently(uuid) from anon;
grant execute on function public.delete_shipment_permanently(uuid) to authenticated;

commit;
