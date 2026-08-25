-- STAGING ONLY / DISPOSABLE DATABASE. Run after SQL36, never in production.
-- Exercises real PostgreSQL functions, triggers, RLS grants and transaction rollback.

begin;

do $$
declare
  v_admin uuid;
  v_customer uuid;
  v_profile public.customer_billing_profiles%rowtype;
  v_batch uuid;
  v_pickup_id uuid;
  v_storage_id uuid;
  v_warehouse_id uuid;
  v_new_id uuid;
  v_bill uuid;
  v_item public.billing_items%rowtype;
  v_fee_ids jsonb;
  v_before_billed jsonb;
  v_after_billed jsonb;
  v_preview jsonb;
  v_schedule jsonb;
  v_events bigint;
  v_batches bigint;
  v_today date := (now() at time zone 'Australia/Melbourne')::date;
begin
  -- Existing Drafts are isolated only inside this transaction and restored by
  -- the final ROLLBACK, allowing the current test database to run the suite.
  delete from public.billing_items as item
  using public.billing_documents as bill
  where item.bill_id= bill.id and bill.status='draft';
  delete from public.billing_documents where status='draft';
  select id into v_admin from public.profiles
  where is_active=true and role='admin' order by id limit 1;
  if v_admin is null then raise exception 'SQL36 smoke requires an active Admin profile'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_admin,'role','authenticated')::text, true);
  select customer_id into v_customer from public.customer_billing_profiles order by customer_id limit 1;
  if v_customer is null then raise exception 'SQL36 smoke requires a Customer Billing Profile'; end if;

  select * into v_profile from public.customer_billing_profiles where customer_id=v_customer;
  perform public.update_customer_billing_profile(v_customer, jsonb_build_object(
    'legal_company_name',v_profile.legal_company_name,'trading_name',v_profile.trading_name,
    'abn',v_profile.abn,'billing_address',v_profile.billing_address,
    'billing_contact',v_profile.billing_contact,'billing_email',v_profile.billing_email,
    'cc_email',v_profile.cc_email,'billing_phone',v_profile.billing_phone,
    'billing_frequency',v_profile.billing_frequency,'default_tail_lift_fee',v_profile.default_tail_lift_fee,
    'default_fuel_levy_rate',v_profile.default_fuel_levy_rate,
    'default_storage_rate',20,'default_gst_rate',.10,
    'default_warehouse_booking_fee',150,'minimum_billable_volume',v_profile.minimum_billable_volume,
    'default_pickup_rate_per_kg',.20
  ));
  if not exists (select 1 from public.customer_billing_profiles where customer_id=v_customer and updated_by=v_admin) then
    raise exception 'Billing Profile RPC did not write Updated By';
  end if;

  v_batch := public.import_shipment_batch(
    jsonb_build_object('customer_id',v_customer,'source_file_name','sql36-smoke.csv'),
    jsonb_build_array(
      jsonb_build_object('tracking_number','SQL36-PICKUP-'||substr(gen_random_uuid()::text,1,8),'delivery_address','1 Test St','customer_id',v_customer,'weight_kg',610,'volume_m3',2),
      jsonb_build_object('tracking_number','SQL36-STORAGE-'||substr(gen_random_uuid()::text,1,8),'delivery_address','2 Test St','customer_id',v_customer,'weight_kg',100,'volume_m3',4,'inbound_at',(v_today-30)::text),
      jsonb_build_object('tracking_number','SQL36-WAREHOUSE-'||substr(gen_random_uuid()::text,1,8),'delivery_address','3 Test St','customer_id',v_customer,'weight_kg',100,'volume_m3',2)
    )
  );
  select id into v_pickup_id from public.shipments where import_batch_id=v_batch and tracking_number like 'SQL36-PICKUP-%';
  select id into v_storage_id from public.shipments where import_batch_id=v_batch and tracking_number like 'SQL36-STORAGE-%';
  select id into v_warehouse_id from public.shipments where import_batch_id=v_batch and tracking_number like 'SQL36-WAREHOUSE-%';
  if exists (select 1 from public.shipments where id=v_pickup_id and pickup_rate_per_kg<>.20) then
    raise exception 'New Shipment did not snapshot Pickup rate';
  end if;

  -- Later Profile edits do not rewrite old Shipment snapshots; the next Shipment gets the new value.
  perform public.update_customer_billing_profile(v_customer, jsonb_build_object(
    'legal_company_name',v_profile.legal_company_name,'trading_name',v_profile.trading_name,
    'abn',v_profile.abn,'billing_address',v_profile.billing_address,
    'billing_contact',v_profile.billing_contact,'billing_email',v_profile.billing_email,
    'cc_email',v_profile.cc_email,'billing_phone',v_profile.billing_phone,
    'billing_frequency',v_profile.billing_frequency,'default_tail_lift_fee',v_profile.default_tail_lift_fee,
    'default_fuel_levy_rate',v_profile.default_fuel_levy_rate,
    'default_storage_rate',20,'default_gst_rate',.10,
    'default_warehouse_booking_fee',150,'minimum_billable_volume',v_profile.minimum_billable_volume,
    'default_pickup_rate_per_kg',.25
  ));
  v_batch := public.import_shipment_batch(
    jsonb_build_object('customer_id',v_customer,'source_file_name','sql36-new-profile.csv'),
    jsonb_build_array(jsonb_build_object(
      'tracking_number','SQL36-NEW-'||substr(gen_random_uuid()::text,1,8),
      'delivery_address','4 Test St','customer_id',v_customer,'weight_kg',100,'volume_m3',1
    ))
  );
  select id into v_new_id from public.shipments where import_batch_id=v_batch;
  if (select pickup_rate_per_kg from public.shipments where id=v_pickup_id)<>.20
     or (select pickup_rate_per_kg from public.shipments where id=v_new_id)<>.25 then
    raise exception 'Pickup snapshot isolation failed';
  end if;

  perform public.complete_shipment(v_pickup_id,'picked_up','SQL36 smoke');
  if (select total_charge from public.shipments where id=v_pickup_id)<>134.2 then
    raise exception 'Pickup expected 610kg x $0.20 plus 10%% GST = $134.20';
  end if;
  v_bill := public.create_draft_bill(jsonb_build_array(jsonb_build_object('type','delivery','id',v_pickup_id)));
  select * into v_item from public.billing_items where bill_id=v_bill and source_id=v_pickup_id;
  if v_item.description<>'Pickup Service' or v_item.amount_ex_gst<>122 or v_item.gst_amount<>12.2 or v_item.total_incl_gst<>134.2 then
    raise exception 'Pickup Draft line is incorrect';
  end if;
  perform public.save_draft_bill_changes(v_bill,jsonb_build_object(
    'changes',jsonb_build_array(jsonb_build_object(
      'item_id',v_item.id,'gst_rate',.10,
      'actual_components',jsonb_build_array(jsonb_build_object('description','Pickup Service','quantity',600,'rate',.20,'rate_kind','currency'))
    )),'remove_item_ids','[]'::jsonb
  ));
  perform public.finalise_draft_bill(v_bill);
  if (select current_status from public.shipments where id=v_pickup_id)<>'completed' then
    raise exception 'Finalise changed Pickup Operations status';
  end if;
  begin
    update public.billing_items set amount_ex_gst=1 where id=v_item.id;
    raise exception 'Finalised Billing Item was mutable';
  exception when others then
    if sqlerrm='Finalised Billing Item was mutable' then raise; end if;
  end;

  -- Warehouse Booking is now ex GST.
  perform public.set_shipment_status(v_warehouse_id,'pending_warehouse_booking','SQL36 smoke',null);
  update public.shipments set warehouse_booking_charge=200 where id=v_warehouse_id;
  perform public.complete_shipment(v_warehouse_id,'warehouse_delivery','SQL36 smoke');
  if (select total_charge from public.shipments where id=v_warehouse_id)<>220 then
    raise exception 'Warehouse Booking expected $200 ex GST / $220 incl GST';
  end if;

  -- Backdated On Hold creates all due weeks immediately from episode snapshots.
  perform public.set_shipment_status(
    v_storage_id,'on_hold','SQL36 smoke',
    (((v_today-15)::timestamp+time '12:00') at time zone 'Australia/Melbourne')
  );
  if (select count(*) from public.storage_fees where shipment_id=v_storage_id and billed_at is null)<>3
     or exists (select 1 from public.storage_fees where shipment_id=v_storage_id and amount<>80) then
    raise exception 'Backdated Storage expected three $80 weeks';
  end if;
  update public.shipments set volume_m3=5 where id=v_storage_id;
  if exists (
    select 1 from public.storage_episodes where shipment_id=v_storage_id and (volume_m3<>4 or rate_per_m3<>20 or gst_rate<>.10)
  ) then raise exception 'Open Storage episode snapshots changed with Shipment volume'; end if;

  v_preview := public.preview_storage_schedule_change(v_storage_id,v_today-7);
  if (v_preview->>'unbilled_week_count')::integer<>2 then raise exception 'Storage revision preview is not server authoritative'; end if;
  v_schedule := public.apply_storage_schedule_change(v_storage_id,v_today-7,'SQL36 smoke no billed history');
  if (v_schedule->>'due_week_count')::integer<>2
     or (select count(*) from public.storage_fees where shipment_id=v_storage_id and billed_at is null)<>2 then
    raise exception 'Storage schedule rebuild failed';
  end if;

  select jsonb_agg(jsonb_build_object('type','storage','id',id) order by period_start)
    into v_fee_ids from public.storage_fees where shipment_id=v_storage_id and billed_at is null;
  v_bill := public.create_draft_bill(v_fee_ids);
  perform public.finalise_draft_bill(v_bill);
  select jsonb_agg(jsonb_build_object('id',id,'period_start',period_start,'period_end',period_end,'amount',amount,'bill_id',bill_id,'billed_at',billed_at) order by id)
    into v_before_billed from public.storage_fees where shipment_id=v_storage_id and billed_at is not null;
  v_schedule := public.apply_storage_schedule_change(v_storage_id,v_today,'SQL36 smoke billed credits');
  select jsonb_agg(jsonb_build_object('id',id,'period_start',period_start,'period_end',period_end,'amount',amount,'bill_id',bill_id,'billed_at',billed_at) order by id)
    into v_after_billed from public.storage_fees where shipment_id=v_storage_id and billed_at is not null;
  if v_before_billed is distinct from v_after_billed then raise exception 'Billed Storage history changed'; end if;
  if (v_schedule->>'credit_required_count')::integer<>1
     or exists (select 1 from public.storage_fees where shipment_id=v_storage_id and billed_at is null) then
    raise exception 'Storage Credit Required handling failed';
  end if;

  select count(*) into v_events from public.shipment_events where shipment_id=v_storage_id and event_type='details_updated';
  perform public.update_shipment_details(v_storage_id,jsonb_build_object(
    'delivery_address','22 Revised Test St','inbound_at',(v_today-20)::text
  ),'on_hold','SQL36 details activity',
    (((v_today)::timestamp+time '12:00') at time zone 'Australia/Melbourne'));
  if (select count(*) from public.shipment_events where shipment_id=v_storage_id and event_type='details_updated')<>v_events+1 then
    raise exception 'Shipment Details did not write one details_updated Activity';
  end if;

  if has_table_privilege('authenticated','public.shipments','UPDATE')
     or has_table_privilege('authenticated','public.customer_billing_profiles','UPDATE')
     or has_function_privilege('anon','public.rls_auto_enable()','EXECUTE')
     or has_function_privilege('anon','public.sync_shipment_customer()','EXECUTE') then
    raise exception 'SQL36 permission hardening failed';
  end if;

  -- Invalid import remains atomic.
  select count(*) into v_batches from public.import_batches;
  begin
    perform public.import_shipment_batch(
      jsonb_build_object('customer_id',v_customer,'source_file_name','sql36-rollback.csv'),
      jsonb_build_array(
        jsonb_build_object('tracking_number','SQL36-ROLLBACK-1','delivery_address','1 Test St','customer_id',v_customer),
        jsonb_build_object('tracking_number','SQL36-ROLLBACK-2','delivery_address','','customer_id',v_customer)
      )
    );
    raise exception 'Invalid import unexpectedly succeeded';
  exception when others then
    if sqlerrm='Invalid import unexpectedly succeeded' then raise; end if;
  end;
  if (select count(*) from public.import_batches)<>v_batches then raise exception 'Partial import batch survived rollback'; end if;
end;
$$;

rollback;
