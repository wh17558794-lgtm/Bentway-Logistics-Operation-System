begin;

-- 独立客户资料表：客户名称只在这里维护一次。
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  customer_code text,
  contact_name text,
  phone text,
  email text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists customers_name_ci_uidx
  on public.customers ((lower(btrim(name))));

-- 每票货物通过 customer_id 连接到客户资料表。
alter table public.shipments
  add column if not exists customer_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shipments_customer_id_fkey'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_customer_id_fkey
      foreign key (customer_id)
      references public.customers(id)
      on delete restrict;
  end if;
end;
$$;

create index if not exists shipments_customer_id_idx
  on public.shipments(customer_id);

-- 把历史货物中已有的客户名称迁移到客户资料表，不会删除旧记录。
insert into public.customers (name)
select min(btrim(customer_name))
from public.shipments
where nullif(btrim(customer_name), '') is not null
group by lower(btrim(customer_name))
on conflict do nothing;

update public.shipments as shipment
set customer_id = customer.id
from public.customers as customer
where shipment.customer_id is null
  and nullif(btrim(shipment.customer_name), '') is not null
  and lower(btrim(shipment.customer_name)) = lower(btrim(customer.name));

-- 保存货物时，系统依据下拉选择自动保存客户名称快照。
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

  -- 编辑历史货物的其他资料时，允许继续保留其已经停用的原客户。
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

drop trigger if exists sync_shipment_customer_trigger on public.shipments;
create trigger sync_shipment_customer_trigger
before insert or update of customer_id on public.shipments
for each row
execute function public.sync_shipment_customer();

alter table public.customers enable row level security;

drop policy if exists customers_read_policy on public.customers;
create policy customers_read_policy
on public.customers
for select
to authenticated
using (
  is_active = true
  or private.has_any_role(array['admin', 'operations']::text[])
);

drop policy if exists customers_insert_policy on public.customers;
create policy customers_insert_policy
on public.customers
for insert
to authenticated
with check (
  private.has_any_role(array['admin', 'operations']::text[])
);

drop policy if exists customers_update_policy on public.customers;
create policy customers_update_policy
on public.customers
for update
to authenticated
using (
  private.has_any_role(array['admin', 'operations']::text[])
)
with check (
  private.has_any_role(array['admin', 'operations']::text[])
);

grant usage on schema public to authenticated;
grant select, insert, update on table public.customers to authenticated;
grant select, insert, update on table public.shipments to authenticated;

comment on table public.customers is 'Bentway customer master records';
comment on column public.shipments.customer_id is 'Selected customer master record';

commit;
