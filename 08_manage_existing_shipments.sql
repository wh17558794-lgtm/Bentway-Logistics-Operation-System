begin;

-- 作废信息保存在货物本身；作废不会删除任何历史数据。
alter table public.shipments
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid,
  add column if not exists cancellation_reason text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_cancelled_by_fkey'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_cancelled_by_fkey
      foreign key (cancelled_by)
      references auth.users(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists shipments_cancelled_at_idx
  on public.shipments(cancelled_at desc)
  where current_status = 'cancelled';

-- 编辑历史货物时允许保留已经停用的原客户；更换客户时仍只能选择有效客户。
create or replace function public.sync_shipment_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_customer_name text;
begin
  if new.customer_id is null then
    raise exception 'Customer selection is required';
  end if;

  if tg_op = 'UPDATE' and new.customer_id is not distinct from old.customer_id then
    new.customer_name := old.customer_name;
    return new;
  end if;

  select name
  into selected_customer_name
  from public.customers
  where id = new.customer_id
    and is_active = true;

  if selected_customer_name is null then
    raise exception 'Selected customer does not exist or is inactive';
  end if;

  new.customer_name := selected_customer_name;
  return new;
end;
$$;

-- 运营、仓库和管理员可以作废尚未完成的货物。
create or replace function public.cancel_shipment(
  p_shipment_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'You do not have permission to cancel shipments';
  end if;

  update public.shipments
  set current_status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = auth.uid(),
      cancellation_reason = nullif(btrim(p_reason), ''),
      updated_at = now()
  where id = p_shipment_id
    and current_status not in ('completed', 'cancelled');

  if not found then
    raise exception 'Shipment was not found or cannot be cancelled';
  end if;
end;
$$;

-- 作废货物可以恢复到待处理状态。
create or replace function public.restore_shipment(
  p_shipment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin', 'operations', 'warehouse']::text[]) then
    raise exception 'You do not have permission to restore shipments';
  end if;

  update public.shipments
  set current_status = 'pending',
      cancelled_at = null,
      cancelled_by = null,
      cancellation_reason = null,
      updated_at = now()
  where id = p_shipment_id
    and current_status = 'cancelled';

  if not found then
    raise exception 'Cancelled shipment was not found';
  end if;
end;
$$;

-- 永久删除只允许管理员执行，并同时清除该票货物的事件记录。
create or replace function public.delete_shipment_permanently(
  p_shipment_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if auth.uid() is null
     or not private.has_any_role(array['admin']::text[]) then
    raise exception 'Only administrators can permanently delete shipments';
  end if;

  if not exists (
    select 1 from public.shipments
    where id = p_shipment_id
      and current_status = 'cancelled'
  ) then
    raise exception 'Only cancelled shipments can be permanently deleted';
  end if;

  delete from public.shipment_events
  where shipment_id = p_shipment_id;

  delete from public.shipments
  where id = p_shipment_id
    and current_status = 'cancelled';
end;
$$;

revoke all on function public.cancel_shipment(uuid, text) from public;
revoke all on function public.restore_shipment(uuid) from public;
revoke all on function public.delete_shipment_permanently(uuid) from public;

grant execute on function public.cancel_shipment(uuid, text) to authenticated;
grant execute on function public.restore_shipment(uuid) to authenticated;
grant execute on function public.delete_shipment_permanently(uuid) to authenticated;

grant select, insert, update on table public.shipments to authenticated;

commit;
