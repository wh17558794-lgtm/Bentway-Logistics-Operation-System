-- SQL 35 - One Draft Bill editor and atomic finalisation
-- NOT YET EXECUTED IN PRODUCTION. Run once after SQL 34.

begin;

do $$
begin
  if to_regclass('public.billing_documents') is not null then
    raise exception 'SQL 35 appears to be already applied; do not rerun a completed migration';
  end if;
end;
$$;

create table if not exists public.billing_documents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'finalised', 'discarded')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  finalised_by uuid references auth.users(id) on delete restrict,
  finalised_at timestamptz,
  discarded_by uuid references auth.users(id) on delete restrict,
  discarded_at timestamptz
);

-- ponytail: the confirmed product rule is one global unfinished Draft.
create unique index if not exists billing_documents_one_draft_uidx
  on public.billing_documents ((true)) where status = 'draft';

create table if not exists public.billing_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.billing_documents(id) on delete restrict,
  charge_type text not null check (charge_type in ('delivery', 'storage', 'container', 'crane')),
  source_id uuid not null,
  shipment_id uuid references public.shipments(id) on delete restrict,
  import_batch_id uuid references public.import_batches(id) on delete restrict,
  tracking_number text,
  customer_reference text,
  container_number text,
  description text not null,
  quantity numeric(14, 3) not null default 1 check (quantity > 0),
  rate numeric(14, 3) not null check (rate >= 0),
  amount_ex_gst numeric(14, 3) not null check (amount_ex_gst >= 0),
  gst_rate numeric(8, 6) not null check (gst_rate >= 0),
  gst_amount numeric(14, 3) not null check (gst_amount >= 0),
  total_incl_gst numeric(14, 3) not null check (total_incl_gst >= 0),
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (bill_id, charge_type, source_id)
);

alter table public.shipments add column if not exists delivery_bill_id uuid;
alter table public.storage_fees add column if not exists bill_id uuid;
alter table public.container_service_fees add column if not exists bill_id uuid;
alter table public.crane_service_charges add column if not exists bill_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shipments_delivery_bill_id_fkey' and conrelid = 'public.shipments'::regclass) then
    alter table public.shipments add constraint shipments_delivery_bill_id_fkey foreign key (delivery_bill_id) references public.billing_documents(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'storage_fees_bill_id_fkey' and conrelid = 'public.storage_fees'::regclass) then
    alter table public.storage_fees add constraint storage_fees_bill_id_fkey foreign key (bill_id) references public.billing_documents(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'container_service_fees_bill_id_fkey' and conrelid = 'public.container_service_fees'::regclass) then
    alter table public.container_service_fees add constraint container_service_fees_bill_id_fkey foreign key (bill_id) references public.billing_documents(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crane_service_charges_bill_id_fkey' and conrelid = 'public.crane_service_charges'::regclass) then
    alter table public.crane_service_charges add constraint crane_service_charges_bill_id_fkey foreign key (bill_id) references public.billing_documents(id) on delete restrict;
  end if;
end;
$$;

alter table public.shipment_events drop constraint if exists shipment_events_event_type_check;
alter table public.shipment_events add constraint shipment_events_event_type_check check (event_type in (
  'inbound', 'message_sent', 'scheduled', 'on_hold', 'pending_warehouse_booking',
  'out_for_delivery', 'delivered', 'picked_up', 'warehouse_delivery', 'returned',
  'status_changed', 'warehouse_location_changed', 'details_updated', 'note_added',
  'exception', 'cancelled', 'billing_updated'
));

create index if not exists billing_items_bill_idx on public.billing_items(bill_id);
create index if not exists shipments_delivery_unbilled_idx on public.shipments(customer_id) where delivery_billed_at is null;

create or replace function private.billing_snapshot(
  p_expected_components jsonb,
  p_expected_amount numeric,
  p_gst_rate numeric,
  p_context jsonb default '{}'::jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_context, '{}'::jsonb) || jsonb_build_object(
    'expected_components', coalesce(p_expected_components, '[]'::jsonb),
    'actual_components', coalesce(p_expected_components, '[]'::jsonb),
    'components', coalesce(p_expected_components, '[]'::jsonb),
    'expected', jsonb_build_object(
      'amount_ex_gst', round(coalesce(p_expected_amount, 0), 3),
      'gst_rate', coalesce(p_gst_rate, 0),
      'gst_amount', round(coalesce(p_expected_amount, 0) * coalesce(p_gst_rate, 0), 3),
      'total_incl_gst', round(coalesce(p_expected_amount, 0) * (1 + coalesce(p_gst_rate, 0)), 3)
    ),
    'actual', jsonb_build_object(
      'amount_ex_gst', round(coalesce(p_expected_amount, 0), 3),
      'gst_rate', coalesce(p_gst_rate, 0),
      'gst_amount', round(coalesce(p_expected_amount, 0) * coalesce(p_gst_rate, 0), 3),
      'total_incl_gst', round(coalesce(p_expected_amount, 0) * (1 + coalesce(p_gst_rate, 0)), 3)
    )
  );
$$;

create or replace function private.add_draft_bill_items(p_bill_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill public.billing_documents%rowtype;
  v_item jsonb;
  v_type text;
  v_source_id uuid;
  v_customer_id uuid;
  v_shipment public.shipments%rowtype;
  v_storage public.storage_fees%rowtype;
  v_container public.container_service_fees%rowtype;
  v_crane public.crane_service_charges%rowtype;
  v_delivery numeric(14, 3);
  v_service numeric(14, 3);
  v_fuel numeric(14, 3);
  v_amount numeric(14, 3);
  v_gst numeric(8, 6);
  v_gst_amount numeric(14, 3);
  v_total numeric(14, 3);
  v_description text;
  v_snapshot jsonb;
begin
  select * into v_bill from public.billing_documents where id = p_bill_id for update;
  if not found or v_bill.status <> 'draft' then raise exception 'Draft Bill was not found'; end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Charges must be an array'; end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_type := v_item ->> 'type';
    v_source_id := (v_item ->> 'id')::uuid;
    v_snapshot := '{}'::jsonb;

    if v_type = 'delivery' then
      select * into v_shipment from public.shipments where id = v_source_id for update;
      if not found then raise exception 'Shipment delivery charge not found'; end if;
      if v_shipment.delivery_billed_at is not null then raise exception 'Delivery charge for % is already billed', v_shipment.tracking_number; end if;
      v_customer_id := v_shipment.customer_id;
      if v_shipment.warehouse_booking_pricing then
        v_gst := 0;
        v_amount := coalesce(v_shipment.warehouse_booking_charge, 150);
        v_description := 'Warehouse Booking';
        v_snapshot := jsonb_build_object('components', jsonb_build_array(
          jsonb_build_object('description', 'Warehouse Booking', 'quantity', 1, 'rate', v_amount, 'rate_kind', 'currency', 'amount_ex_gst', v_amount)
        ));
      elsif v_shipment.total_charge_override is not null then
        v_gst := v_shipment.gst_rate;
        v_amount := round(v_shipment.total_charge_override / (1 + v_gst), 3);
        v_description := 'Delivery Total';
        v_snapshot := jsonb_build_object('components', jsonb_build_array(
          jsonb_build_object('description', 'Delivery Total', 'quantity', 1, 'rate', v_amount, 'rate_kind', 'currency', 'amount_ex_gst', v_amount)
        ));
      else
        if v_shipment.volume_m3 is null or v_shipment.unit_price is null then
          raise exception 'Delivery charge for % is not priced', v_shipment.tracking_number;
        end if;
        v_gst := v_shipment.gst_rate;
        v_delivery := round(greatest(v_shipment.volume_m3, v_shipment.minimum_billable_volume) * v_shipment.unit_price, 3);
        v_service := case when v_shipment.crane_required then v_shipment.crane_truck_fee else v_shipment.tail_lift_service_fee end;
        v_fuel := round(coalesce(v_shipment.fuel_levy_override, v_delivery * v_shipment.fuel_levy_rate), 3);
        v_amount := v_delivery + v_service + v_fuel;
        v_description := 'Delivery Total';
        v_snapshot := jsonb_build_object('components', jsonb_build_array(
          jsonb_build_object('description', 'Last Mile Delivery', 'quantity', greatest(v_shipment.volume_m3, v_shipment.minimum_billable_volume), 'rate', v_shipment.unit_price, 'rate_kind', 'currency', 'amount_ex_gst', v_delivery),
          jsonb_build_object('description', case when v_shipment.crane_required then 'Crane Truck Service' else 'Tail Lift Service' end, 'quantity', 1, 'rate', v_service, 'rate_kind', 'currency', 'amount_ex_gst', v_service),
          jsonb_build_object(
            'description', 'Fuel Levy', 'quantity', 1,
            'rate', case when v_shipment.fuel_levy_override is null then v_shipment.fuel_levy_rate else null end,
            'rate_kind', case when v_shipment.fuel_levy_override is null then 'percentage' else 'manual' end,
            'manual_amount', v_shipment.fuel_levy_override,
            'base_amount_ex_gst', v_delivery,
            'amount_ex_gst', v_fuel
          )
        ));
      end if;
      v_gst_amount := round(v_amount * v_gst, 3);
      v_total := v_amount + v_gst_amount;
      v_snapshot := private.billing_snapshot(
        v_snapshot -> 'components', v_amount, v_gst,
        jsonb_build_object('shipment', to_jsonb(v_shipment))
      );
      insert into public.billing_items (
        bill_id, charge_type, source_id, shipment_id, import_batch_id, tracking_number,
        customer_reference, container_number, description, quantity, rate,
        amount_ex_gst, gst_rate, gst_amount, total_incl_gst, snapshot
      ) values (
        p_bill_id, v_type, v_source_id, v_shipment.id, v_shipment.import_batch_id, v_shipment.tracking_number,
        v_shipment.customer_reference, v_shipment.container_number, v_description, 1, v_amount,
        v_amount, v_gst, v_gst_amount, v_total, v_snapshot
      ) on conflict (bill_id, charge_type, source_id) do nothing;
    elsif v_type = 'storage' then
      select * into v_storage from public.storage_fees where id = v_source_id for update;
      if not found or v_storage.billed_at is not null then raise exception 'Storage fee is already billed or missing'; end if;
      select * into v_shipment from public.shipments where id = v_storage.shipment_id;
      v_customer_id := v_shipment.customer_id;
      v_amount := v_storage.amount;
      v_gst := v_shipment.gst_rate;
      v_gst_amount := round(v_amount * v_gst, 3);
      v_total := v_amount + v_gst_amount;
      v_description := format('Storage %s - %s', to_char(v_storage.period_start, 'DD Mon YYYY'), to_char(v_storage.period_end, 'DD Mon YYYY'));
      insert into public.billing_items (
        bill_id, charge_type, source_id, shipment_id, import_batch_id, tracking_number,
        customer_reference, container_number, description, quantity, rate,
        amount_ex_gst, gst_rate, gst_amount, total_incl_gst, snapshot
      ) values (
        p_bill_id, v_type, v_source_id, v_shipment.id, v_shipment.import_batch_id, v_shipment.tracking_number,
        v_shipment.customer_reference, v_shipment.container_number, v_description, 1, v_amount,
        v_amount, v_gst, v_gst_amount, v_total,
        private.billing_snapshot(
          jsonb_build_array(jsonb_build_object('description', v_description, 'quantity', 1, 'rate', v_amount, 'rate_kind', 'currency', 'amount_ex_gst', v_amount)),
          v_amount, v_gst,
          jsonb_build_object('storage_fee', to_jsonb(v_storage), 'shipment', to_jsonb(v_shipment))
        )
      ) on conflict (bill_id, charge_type, source_id) do nothing;
    elsif v_type = 'container' then
      select * into v_container from public.container_service_fees where id = v_source_id for update;
      if not found or v_container.billed_at is not null then raise exception 'Container service fee is already billed or missing'; end if;
      if v_container.amount is null then raise exception 'Container service fee amount is not configured for %', v_container.container_number; end if;
      select customer_id into v_customer_id from public.import_batches where id = v_container.import_batch_id;
      v_amount := v_container.amount;
      v_gst := v_container.gst_rate;
      v_gst_amount := round(v_amount * v_gst, 3);
      v_total := v_amount + v_gst_amount;
      insert into public.billing_items (
        bill_id, charge_type, source_id, import_batch_id, container_number, description,
        quantity, rate, amount_ex_gst, gst_rate, gst_amount, total_incl_gst, snapshot
      ) values (
        p_bill_id, v_type, v_source_id, v_container.import_batch_id, v_container.container_number,
        'Container Service Fee', 1, v_amount, v_amount, v_gst, v_gst_amount, v_total,
        private.billing_snapshot(
          jsonb_build_array(jsonb_build_object('description', 'Container Service Fee', 'quantity', 1, 'rate', v_amount, 'rate_kind', 'currency', 'amount_ex_gst', v_amount)),
          v_amount, v_gst, jsonb_build_object('container_fee', to_jsonb(v_container))
        )
      ) on conflict (bill_id, charge_type, source_id) do nothing;
    elsif v_type = 'crane' then
      select * into v_crane from public.crane_service_charges where id = v_source_id for update;
      if not found or v_crane.billed_at is not null or v_crane.cancelled_at is not null then raise exception 'Crane Truck Service is already billed, cancelled or missing'; end if;
      select * into v_shipment from public.shipments where id = v_crane.shipment_id;
      v_customer_id := v_shipment.customer_id;
      v_amount := v_crane.amount_ex_gst;
      v_gst := v_crane.gst_rate;
      v_gst_amount := round(v_amount * v_gst, 3);
      v_total := v_amount + v_gst_amount;
      insert into public.billing_items (
        bill_id, charge_type, source_id, shipment_id, import_batch_id, tracking_number,
        customer_reference, container_number, description, quantity, rate,
        amount_ex_gst, gst_rate, gst_amount, total_incl_gst, snapshot
      ) values (
        p_bill_id, v_type, v_source_id, v_shipment.id, v_shipment.import_batch_id, v_shipment.tracking_number,
        v_shipment.customer_reference, v_shipment.container_number, 'Crane Truck Service', 1, v_amount,
        v_amount, v_gst, v_gst_amount, v_total,
        private.billing_snapshot(
          jsonb_build_array(jsonb_build_object('description', 'Crane Truck Service', 'quantity', 1, 'rate', v_amount, 'rate_kind', 'currency', 'amount_ex_gst', v_amount)),
          v_amount, v_gst,
          jsonb_build_object('crane_charge', to_jsonb(v_crane), 'shipment', to_jsonb(v_shipment))
        )
      ) on conflict (bill_id, charge_type, source_id) do nothing;
    else
      raise exception 'Unsupported charge type: %', coalesce(v_type, 'null');
    end if;

    if v_bill.customer_id is null then
      update public.billing_documents set customer_id = v_customer_id where id = p_bill_id;
      v_bill.customer_id := v_customer_id;
    elsif v_bill.customer_id is distinct from v_customer_id then
      raise exception 'All Draft Bill charges must belong to one customer';
    end if;
  end loop;
end;
$$;

create or replace function public.create_draft_bill(p_items jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_bill_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not private.has_any_role(array['admin', 'operations']::text[]) then raise exception 'Permission denied'; end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Select at least one charge'; end if;
  if exists (select 1 from public.billing_documents where status = 'draft') then
    raise exception 'There is an unfinished Draft Bill. Please complete or discard it before creating a new bill.';
  end if;
  insert into public.billing_documents (created_by, updated_by) values (auth.uid(), auth.uid()) returning id into v_bill_id;
  perform private.add_draft_bill_items(v_bill_id, p_items);
  return v_bill_id;
end;
$$;

create or replace function public.add_to_draft_bill(p_bill_id uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'operations']::text[]) then raise exception 'Permission denied'; end if;
  perform private.add_draft_bill_items(p_bill_id, p_items);
  update public.billing_documents set updated_at = now(), updated_by = auth.uid()
  where id = p_bill_id and status = 'draft';
end;
$$;

create or replace function public.remove_draft_bill_item(p_bill_id uuid, p_item_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item public.billing_items%rowtype;
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'operations']::text[]) then raise exception 'Permission denied'; end if;
  select item.* into v_item from public.billing_items as item
  join public.billing_documents as bill on bill.id = item.bill_id
  where item.id = p_item_id and item.bill_id = p_bill_id and bill.status = 'draft'
  for update of item;
  if not found then raise exception 'Draft charge was not found'; end if;
  delete from public.billing_items where id = p_item_id;
  if v_item.shipment_id is not null then
    insert into public.shipment_events (
      shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
    ) select shipment.id, 'billing_updated', shipment.current_status, shipment.current_status,
      now(), auth.uid(), 'Charge removed from Draft Bill', jsonb_build_object(
        'source', 'Draft Bill', 'bill_id', p_bill_id,
        'changes', jsonb_build_array(jsonb_build_object(
          'charge_type', v_item.charge_type, 'description', v_item.description,
          'expected', v_item.snapshot -> 'expected', 'expected_components', v_item.snapshot -> 'expected_components',
          'before_actual', v_item.snapshot -> 'actual', 'before_actual_components', v_item.snapshot -> 'actual_components',
          'after_actual', null, 'action', 'removed_from_draft'
        ))
      )
    from public.shipments as shipment where shipment.id = v_item.shipment_id;
  end if;
  update public.billing_documents set updated_at = now(), updated_by = auth.uid()
  where id = p_bill_id;
end;
$$;

create or replace function public.save_draft_bill_changes(p_bill_id uuid, p_changes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_change jsonb;
  v_changes jsonb;
  v_remove_id uuid;
  v_item public.billing_items%rowtype;
  v_components jsonb;
  v_normalised_components jsonb;
  v_component jsonb;
  v_description text;
  v_rate_kind text;
  v_quantity numeric(14, 3);
  v_rate numeric(14, 6);
  v_component_amount numeric(14, 3);
  v_delivery_base numeric(14, 3);
  v_amount numeric(14, 3);
  v_gst numeric(8, 6);
  v_gst_amount numeric(14, 3);
  v_before_actual jsonb;
  v_expected jsonb;
  v_audit jsonb := '{}'::jsonb;
  v_shipment_key text;
  v_audit_changes jsonb;
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'operations']::text[]) then raise exception 'Permission denied'; end if;
  if not exists (select 1 from public.billing_documents where id = p_bill_id and status = 'draft' for update) then raise exception 'Draft Bill was not found'; end if;
  if jsonb_typeof(p_changes) = 'object' then
    v_changes := coalesce(p_changes -> 'changes', '[]'::jsonb);
    for v_remove_id in select value::uuid from jsonb_array_elements_text(coalesce(p_changes -> 'remove_item_ids', '[]'::jsonb)) loop
      select * into v_item from public.billing_items where id = v_remove_id and bill_id = p_bill_id for update;
      if found and v_item.shipment_id is not null then
        v_shipment_key := v_item.shipment_id::text;
        v_audit := jsonb_set(v_audit, array[v_shipment_key],
          coalesce(v_audit -> v_shipment_key, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'charge_type', v_item.charge_type,
            'description', v_item.description,
            'expected', v_item.snapshot -> 'expected',
            'expected_components', v_item.snapshot -> 'expected_components',
            'before_actual', v_item.snapshot -> 'actual',
            'before_actual_components', v_item.snapshot -> 'actual_components',
            'after_actual', null,
            'action', 'removed_from_draft'
          )), true);
      end if;
      delete from public.billing_items where id = v_remove_id and bill_id = p_bill_id;
      if not found then raise exception 'Draft charge selected for removal was not found'; end if;
    end loop;
  elsif jsonb_typeof(p_changes) = 'array' then
    v_changes := p_changes;
  else
    raise exception 'Draft changes must be an array or editor payload';
  end if;

  for v_change in select value from jsonb_array_elements(v_changes) loop
    select * into v_item from public.billing_items
    where id = (v_change ->> 'item_id')::uuid and bill_id = p_bill_id for update;
    if not found then raise exception 'Draft charge was not found'; end if;
    v_before_actual := v_item.snapshot -> 'actual';
    v_expected := v_item.snapshot -> 'expected';
    v_gst := coalesce((v_change ->> 'gst_rate')::numeric, v_item.gst_rate);
    if v_gst < 0 then raise exception 'GST rate cannot be negative'; end if;

    if v_item.charge_type = 'delivery' then
      v_components := coalesce(v_change -> 'actual_components', v_item.snapshot -> 'actual_components');
      if jsonb_typeof(v_components) is distinct from 'array' or jsonb_array_length(v_components) = 0 then
        raise exception 'Delivery Actual requires at least one component';
      end if;
      if (select count(*) from jsonb_array_elements(v_components)) <>
         (select count(distinct value ->> 'description') from jsonb_array_elements(v_components)) then
        raise exception 'Delivery Actual component descriptions must be unique';
      end if;

      v_delivery_base := 0;
      for v_component in select value from jsonb_array_elements(v_components) loop
        v_description := v_component ->> 'description';
        if v_description not in ('Last Mile Delivery', 'Tail Lift Service', 'Fuel Levy', 'Crane Truck Service', 'Warehouse Booking', 'Delivery Total') then
          raise exception 'Unsupported Delivery Actual component: %', coalesce(v_description, 'null');
        end if;
        if v_description = 'Last Mile Delivery' then
          v_quantity := coalesce((v_component ->> 'quantity')::numeric, 1);
          v_rate := coalesce((v_component ->> 'rate')::numeric, 0);
          if v_quantity <= 0 or v_rate < 0 then raise exception 'Last Mile Delivery quantity/rate is invalid'; end if;
          v_delivery_base := round(v_quantity * v_rate, 3);
        end if;
      end loop;

      v_amount := 0;
      v_normalised_components := '[]'::jsonb;
      for v_component in select value from jsonb_array_elements(v_components) loop
        v_description := v_component ->> 'description';
        v_rate_kind := coalesce(v_component ->> 'rate_kind', 'currency');
        v_quantity := coalesce((v_component ->> 'quantity')::numeric, 1);
        v_rate := coalesce((v_component ->> 'rate')::numeric, 0);
        if v_quantity <= 0 or v_rate < 0 then raise exception '% quantity/rate is invalid', v_description; end if;
        if v_rate_kind = 'percentage' then
          if v_description <> 'Fuel Levy' or v_rate > 1 then raise exception 'Only Fuel Levy supports a decimal percentage rate'; end if;
          v_component_amount := round(v_delivery_base * v_rate, 3);
        elsif v_rate_kind = 'manual' then
          if v_description <> 'Fuel Levy' then raise exception 'Only Fuel Levy supports a manual amount override'; end if;
          v_component_amount := coalesce((v_component ->> 'manual_amount')::numeric, 0);
          if v_component_amount < 0 then raise exception 'Fuel Levy manual amount cannot be negative'; end if;
        elsif v_rate_kind = 'currency' then
          v_component_amount := round(v_quantity * v_rate, 3);
        else
          raise exception 'Unsupported rate kind: %', v_rate_kind;
        end if;
        v_normalised_components := v_normalised_components || jsonb_build_array(
          v_component || jsonb_build_object('quantity', v_quantity, 'rate', v_rate, 'rate_kind', v_rate_kind, 'amount_ex_gst', v_component_amount)
        );
        v_amount := v_amount + v_component_amount;
      end loop;
      v_quantity := 1;
      v_rate := v_amount;
    else
      v_quantity := coalesce((v_change ->> 'quantity')::numeric, v_item.quantity);
      v_rate := coalesce((v_change ->> 'rate')::numeric, v_item.rate);
      if v_quantity <= 0 or v_rate < 0 then raise exception '% quantity/rate is invalid', initcap(v_item.charge_type); end if;
      v_amount := round(v_quantity * v_rate, 3);
      v_normalised_components := jsonb_build_array(jsonb_build_object(
        'description', v_item.description, 'quantity', v_quantity, 'rate', v_rate,
        'rate_kind', 'currency', 'amount_ex_gst', v_amount
      ));
    end if;
    v_gst_amount := round(v_amount * v_gst, 3);

    update public.billing_items set
      quantity = v_quantity,
      rate = v_rate,
      amount_ex_gst = v_amount,
      gst_rate = v_gst,
      gst_amount = v_gst_amount,
      total_incl_gst = v_amount + v_gst_amount,
      snapshot = snapshot || jsonb_build_object(
        'actual_components', v_normalised_components,
        'components', v_normalised_components,
        'actual', jsonb_build_object(
          'amount_ex_gst', v_amount, 'gst_rate', v_gst,
          'gst_amount', v_gst_amount, 'total_incl_gst', v_amount + v_gst_amount
        ),
        'adjustment_ex_gst', v_amount - coalesce((v_expected ->> 'amount_ex_gst')::numeric, v_item.amount_ex_gst),
        'draft_edited_at', now(), 'draft_edited_by', auth.uid()
      )
    where id = v_item.id;

    if v_item.shipment_id is not null then
      v_shipment_key := v_item.shipment_id::text;
      v_audit := jsonb_set(v_audit, array[v_shipment_key],
        coalesce(v_audit -> v_shipment_key, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
          'charge_type', v_item.charge_type,
          'description', v_item.description,
          'expected', v_expected,
          'expected_components', v_item.snapshot -> 'expected_components',
          'before_actual', v_before_actual,
          'before_actual_components', v_item.snapshot -> 'actual_components',
          'after_actual', jsonb_build_object(
            'amount_ex_gst', v_amount, 'gst_rate', v_gst,
            'gst_amount', v_gst_amount, 'total_incl_gst', v_amount + v_gst_amount
          ),
          'after_actual_components', v_normalised_components,
          'adjustment_ex_gst', v_amount - coalesce((v_expected ->> 'amount_ex_gst')::numeric, v_item.amount_ex_gst)
        )), true);
    end if;
  end loop;

  for v_shipment_key, v_audit_changes in select key, value from jsonb_each(v_audit) loop
    insert into public.shipment_events (
      shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
    ) select shipment.id, 'billing_updated', shipment.current_status, shipment.current_status,
      now(), auth.uid(), 'Invoice adjusted from Draft Bill', jsonb_build_object(
        'source', 'Draft Bill', 'bill_id', p_bill_id, 'changes', v_audit_changes
      )
    from public.shipments as shipment where shipment.id = v_shipment_key::uuid;
  end loop;

  update public.billing_documents set updated_at = now(), updated_by = auth.uid()
  where id = p_bill_id;
end;
$$;

create or replace function public.finalise_draft_bill(p_bill_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_bill public.billing_documents%rowtype; v_item public.billing_items%rowtype;
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'operations']::text[]) then raise exception 'Permission denied'; end if;
  select * into v_bill from public.billing_documents where id = p_bill_id for update;
  if not found or v_bill.status <> 'draft' then raise exception 'Draft Bill was not found'; end if;
  if not exists (select 1 from public.billing_items where bill_id = p_bill_id) then raise exception 'Draft Bill has no charges'; end if;
  for v_item in select * from public.billing_items where bill_id = p_bill_id order by created_at for update loop
    if v_item.charge_type = 'delivery' then
      update public.shipments set delivery_billed_at = now(), delivery_bill_id = p_bill_id where id = v_item.source_id and delivery_billed_at is null;
    elsif v_item.charge_type = 'storage' then
      update public.storage_fees set billed_at = now(), bill_id = p_bill_id where id = v_item.source_id and billed_at is null;
    elsif v_item.charge_type = 'container' then
      update public.container_service_fees set billed_at = now(), bill_id = p_bill_id where id = v_item.source_id and billed_at is null;
    else
      update public.crane_service_charges set billed_at = now(), bill_id = p_bill_id where id = v_item.source_id and billed_at is null and cancelled_at is null;
    end if;
    if not found then raise exception '% charge is already billed or no longer exists', initcap(v_item.charge_type); end if;
  end loop;
  insert into public.shipment_events (
    shipment_id, event_type, from_status, to_status, event_at, performed_by, notes, metadata
  )
  select shipment.id, 'billing_updated', shipment.current_status, shipment.current_status,
    now(), auth.uid(), 'Bill Finalised', jsonb_build_object(
      'source', 'Draft Bill', 'bill_id', p_bill_id,
      'finalised_actual_total_incl_gst', round(sum(item.total_incl_gst), 3),
      'charge_count', count(*)
    )
  from public.billing_items as item
  join public.shipments as shipment on shipment.id = item.shipment_id
  where item.bill_id = p_bill_id
  group by shipment.id, shipment.current_status;
  update public.billing_documents set status = 'finalised', finalised_by = auth.uid(), finalised_at = now() where id = p_bill_id;
end;
$$;

create or replace function public.discard_draft_bill(p_bill_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.has_any_role(array['admin', 'operations']::text[]) then raise exception 'Permission denied'; end if;
  update public.billing_documents set status = 'discarded', discarded_by = auth.uid(), discarded_at = now()
  where id = p_bill_id and status = 'draft';
  if not found then raise exception 'Draft Bill was not found'; end if;
end;
$$;

create or replace function private.prevent_finalised_billing_item_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.billing_documents
    where id = old.bill_id and status = 'finalised'
  ) then
    raise exception 'Finalised billing history is immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists prevent_finalised_billing_item_changes_trigger on public.billing_items;
create trigger prevent_finalised_billing_item_changes_trigger
before update or delete on public.billing_items
for each row execute function private.prevent_finalised_billing_item_changes();

alter table public.billing_documents enable row level security;
alter table public.billing_items enable row level security;
drop policy if exists billing_documents_read_policy on public.billing_documents;
create policy billing_documents_read_policy on public.billing_documents for select to authenticated
using (private.has_any_role(array['admin', 'operations', 'viewer']::text[]));
drop policy if exists billing_items_read_policy on public.billing_items;
create policy billing_items_read_policy on public.billing_items for select to authenticated
using (private.has_any_role(array['admin', 'operations', 'viewer']::text[]));

grant select on public.billing_documents, public.billing_items to authenticated;
revoke all on function private.add_draft_bill_items(uuid, jsonb) from public;
revoke all on function private.billing_snapshot(jsonb, numeric, numeric, jsonb) from public;
revoke all on function private.prevent_finalised_billing_item_changes() from public;
revoke all on function public.create_draft_bill(jsonb) from public, anon;
grant execute on function public.create_draft_bill(jsonb) to authenticated;
revoke all on function public.add_to_draft_bill(uuid, jsonb) from public, anon;
grant execute on function public.add_to_draft_bill(uuid, jsonb) to authenticated;
revoke all on function public.remove_draft_bill_item(uuid, uuid) from public, anon;
grant execute on function public.remove_draft_bill_item(uuid, uuid) to authenticated;
revoke all on function public.save_draft_bill_changes(uuid, jsonb) from public, anon;
grant execute on function public.save_draft_bill_changes(uuid, jsonb) to authenticated;
revoke all on function public.finalise_draft_bill(uuid) from public, anon;
grant execute on function public.finalise_draft_bill(uuid) to authenticated;
revoke all on function public.discard_draft_bill(uuid) from public, anon;
grant execute on function public.discard_draft_bill(uuid) to authenticated;

comment on table public.billing_documents is 'Single Draft/finalised billing workspace. Finalise never changes shipment Operations state.';
comment on table public.billing_items is 'Finalised charge snapshots remain immutable when later shipment billing data changes.';

commit;
