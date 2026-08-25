-- STAGING ONLY. Run after SQL32-SQL35 on a disposable/staging database.
-- The script chooses one unbilled active shipment, exercises RPCs, and rolls
-- back every row change. Do not run on production.

begin;

do $$
declare
  v_user_id uuid;
  v_shipment public.shipments%rowtype;
  v_shipment_id uuid;
  v_customer_id uuid;
  v_bill_id uuid;
  v_item public.billing_items%rowtype;
  v_fee public.storage_fees%rowtype;
  v_batch_count bigint;
  v_valid_batch_id uuid;
  v_imported_shipment public.shipments%rowtype;
  v_second_customer_id uuid;
  v_tracking text := 'STAGING-PROFILE-' || substr(gen_random_uuid()::text, 1, 8);
  v_before_expected jsonb;
  v_after_expected jsonb;
  v_components jsonb;
  v_condition_key text;
  v_activity_count bigint;
begin
  select id into v_user_id from public.profiles
  where is_active = true and role in ('admin', 'operations')
  order by case role when 'admin' then 0 else 1 end, id
  limit 1;
  if v_user_id is null then raise exception 'Smoke test requires an active admin/operations profile'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user_id, 'role', 'authenticated')::text, true);

  if exists (select 1 from public.billing_documents where status = 'draft') then
    raise exception 'Smoke test requires no unfinished Draft Bill in staging';
  end if;

  select * into v_shipment from public.shipments
  where cancelled_at is null and delivery_billed_at is null
    and customer_id is not null
  order by inbound_at desc
  limit 1 for update;
  if not found then raise exception 'Smoke test requires one active unbilled staging shipment'; end if;
  v_shipment_id := v_shipment.id;
  v_customer_id := v_shipment.customer_id;

  update public.shipments set
    current_status = 'pending', outbound_method = null, outbound_at = null,
    scheduled_for = null, on_hold_started_at = null,
    warehouse_booking_pricing = false, total_charge_override = null,
    volume_m3 = 4, unit_price = coalesce(unit_price, 60),
    minimum_billable_volume = 1, storage_rate = 20,
    tail_lift_service_fee = 80, fuel_levy_rate = .20, gst_rate = .10,
    crane_required = false, crane_truck_fee = 900
  where id = v_shipment_id;

  -- Ordinary Message Sent and Completed Resume.
  perform public.set_shipment_status(v_shipment_id, 'message_sent', 'staging smoke', null);
  if (select current_status from public.shipments where id = v_shipment_id) <> 'message_sent' then raise exception 'Message Sent failed'; end if;
  perform public.complete_shipment(v_shipment_id, 'delivered', 'staging smoke');
  perform public.resume_completed_shipment(v_shipment_id);
  if exists (select 1 from public.shipments where id = v_shipment_id and (current_status <> 'pending' or outbound_method is not null or outbound_at is not null)) then
    raise exception 'Completed Resume failed';
  end if;

  -- Automatic condition acknowledgement persists, disappears when fixed, and
  -- can trigger again after the same condition genuinely reappears.
  update public.shipments set suburb = 'INVALID SMOKE SUBURB', postcode = '0000' where id = v_shipment_id;
  perform public.refresh_shipment_exceptions();
  select exception_condition_keys[1] into v_condition_key from public.shipments where id = v_shipment_id;
  if v_condition_key is null then raise exception 'Automatic exception did not trigger'; end if;
  perform public.set_shipment_status(v_shipment_id, 'pending', 'staging acknowledgement', null);
  perform public.refresh_shipment_exceptions();
  if (select current_status from public.shipments where id = v_shipment_id) = 'exception' then raise exception 'Acknowledged condition immediately re-triggered'; end if;
  update public.shipments set suburb = v_shipment.suburb, state = v_shipment.state, postcode = v_shipment.postcode where id = v_shipment_id;
  perform public.refresh_shipment_exceptions();
  if v_condition_key = any((select resolved_exception_condition_keys from public.shipments where id = v_shipment_id)) then raise exception 'Disappeared condition acknowledgement was not pruned'; end if;
  update public.shipments set suburb = 'INVALID SMOKE SUBURB', postcode = '0000' where id = v_shipment_id;
  perform public.refresh_shipment_exceptions();
  if (select current_status from public.shipments where id = v_shipment_id) <> 'exception' then raise exception 'Reappeared condition did not trigger'; end if;
  perform public.set_shipment_status(v_shipment_id, 'pending', 'staging cleanup', null);
  update public.shipments set suburb = v_shipment.suburb, state = v_shipment.state, postcode = v_shipment.postcode where id = v_shipment_id;

  -- Storage is volume x customer rate and Warehouse Booking keeps it.
  perform public.set_shipment_status(v_shipment_id, 'on_hold', 'staging storage', now());
  select * into v_fee from public.storage_fees where shipment_id = v_shipment_id order by created_at desc limit 1;
  if v_fee.amount <> 80 then raise exception 'Storage expected 4m3 x $20 = $80, got %', v_fee.amount; end if;
  perform public.set_shipment_status(v_shipment_id, 'pending_warehouse_booking', 'staging DTW', null);
  update public.shipments set warehouse_booking_charge = 200 where id = v_shipment_id;
  perform public.complete_shipment(v_shipment_id, 'warehouse_delivery', 'staging DTW');
  if not exists (select 1 from public.shipments where id = v_shipment_id and warehouse_booking_pricing and total_charge = 288) then
    raise exception 'DTW $200 plus $80 storage and storage GST was not retained';
  end if;
  perform public.resume_completed_shipment(v_shipment_id);

  -- Crane Negative retains $900 but calculation ignores it; Positive enters the
  -- unbilled Delivery Expected before Delivery is billed.
  update public.shipments set crane_required = false, crane_truck_fee = 900 where id = v_shipment_id;
  if (select total_charge from public.shipments where id = v_shipment_id) <> 492.8 then
    raise exception 'Inactive retained crane fee affected Expected total';
  end if;
  update public.shipments set crane_required = true where id = v_shipment_id;
  if (select total_charge from public.shipments where id = v_shipment_id) <> 1394.8 then
    raise exception 'Active crane fee did not replace Tail Lift in Expected total';
  end if;

  -- Draft Expected is frozen; Save changes only Actual and writes one activity.
  select jsonb_build_object(
    'volume_m3', volume_m3, 'unit_price', unit_price, 'tail_lift_service_fee', tail_lift_service_fee,
    'fuel_levy_rate', fuel_levy_rate, 'fuel_levy_override', fuel_levy_override,
    'crane_required', crane_required, 'crane_truck_fee', crane_truck_fee,
    'storage_rate', storage_rate, 'gst_rate', gst_rate
  ) into v_before_expected from public.shipments where id = v_shipment_id;
  v_bill_id := public.create_draft_bill(jsonb_build_array(jsonb_build_object('type', 'delivery', 'id', v_shipment_id)));
  select * into v_item from public.billing_items where bill_id = v_bill_id and charge_type = 'delivery';
  if v_item.snapshot -> 'expected' is null or v_item.snapshot -> 'actual' is null then raise exception 'Expected/Actual snapshot missing'; end if;
  v_components := jsonb_build_array(
    jsonb_build_object('description', 'Last Mile Delivery', 'quantity', 4, 'rate', 55, 'rate_kind', 'currency'),
    jsonb_build_object('description', 'Crane Truck Service', 'quantity', 1, 'rate', 850, 'rate_kind', 'currency'),
    jsonb_build_object('description', 'Fuel Levy', 'quantity', 1, 'rate', .15, 'rate_kind', 'percentage')
  );
  select count(*) into v_activity_count from public.shipment_events where shipment_id = v_shipment_id and event_type = 'billing_updated';
  perform public.save_draft_bill_changes(v_bill_id, jsonb_build_object('changes', jsonb_build_array(
    jsonb_build_object('item_id', v_item.id, 'actual_components', v_components, 'gst_rate', .10)
  ), 'remove_item_ids', '[]'::jsonb));
  select jsonb_build_object(
    'volume_m3', volume_m3, 'unit_price', unit_price, 'tail_lift_service_fee', tail_lift_service_fee,
    'fuel_levy_rate', fuel_levy_rate, 'fuel_levy_override', fuel_levy_override,
    'crane_required', crane_required, 'crane_truck_fee', crane_truck_fee,
    'storage_rate', storage_rate, 'gst_rate', gst_rate
  ) into v_after_expected from public.shipments where id = v_shipment_id;
  if v_after_expected is distinct from v_before_expected then raise exception 'Draft Actual mutated Shipment Expected'; end if;
  if (select count(*) from public.shipment_events where shipment_id = v_shipment_id and event_type = 'billing_updated') <> v_activity_count + 1 then raise exception 'Draft Save did not write one shipment activity'; end if;

  -- Atomic Finalise marks only source billing state and preserves Operations.
  perform public.finalise_draft_bill(v_bill_id);
  if (select current_status from public.shipments where id = v_shipment_id) <> 'pending' then raise exception 'Finalise changed Shipment Operations status'; end if;
  if not exists (select 1 from public.billing_documents where id = v_bill_id and status = 'finalised') then raise exception 'Finalise failed'; end if;

  -- Post-Delivery crane becomes a separate unbilled charge and makes the
  -- shipment outstanding again without changing the finalised Delivery item.
  update public.shipments set crane_required = false where id = v_shipment_id;
  update public.shipments set crane_required = true, crane_truck_fee = 900 where id = v_shipment_id;
  if not exists (select 1 from public.crane_service_charges where shipment_id = v_shipment_id and billed_at is null and cancelled_at is null and amount_ex_gst = 900) then
    raise exception 'Supplementary Crane Truck Service was not created';
  end if;
  if not exists (select 1 from public.billing_items where id = v_item.id and amount_ex_gst = 1103) then
    raise exception 'Finalised Delivery Actual snapshot changed after Operations edit';
  end if;

  -- A newly imported Shipment receives profile defaults. If staging has a
  -- second profile, changing customer replaces untouched old-profile defaults.
  v_valid_batch_id := public.import_shipment_batch(
    jsonb_build_object('customer_id', v_customer_id, 'source_file_name', 'staging-profile.csv'),
    jsonb_build_array(jsonb_build_object(
      'tracking_number', v_tracking, 'delivery_address', '1 Test St',
      'customer_id', v_customer_id, 'volume_m3', 1
    ))
  );
  select * into v_imported_shipment from public.shipments where import_batch_id = v_valid_batch_id;
  if not exists (
    select 1 from public.customer_billing_profiles as profile
    where profile.customer_id = v_imported_shipment.customer_id
      and v_imported_shipment.tail_lift_service_fee = profile.default_tail_lift_fee
      and v_imported_shipment.fuel_levy_rate = profile.default_fuel_levy_rate
      and v_imported_shipment.gst_rate = profile.default_gst_rate
      and v_imported_shipment.warehouse_booking_charge = profile.default_warehouse_booking_fee
      and v_imported_shipment.minimum_billable_volume = profile.minimum_billable_volume
      and v_imported_shipment.storage_rate = profile.default_storage_rate
  ) then raise exception 'New Shipment did not receive Customer Billing Profile defaults'; end if;
  select jsonb_build_object(
    'tail', tail_lift_service_fee, 'fuel', fuel_levy_rate, 'gst', gst_rate,
    'booking', warehouse_booking_charge, 'minimum', minimum_billable_volume, 'storage', storage_rate
  ) into v_before_expected from public.shipments where id = v_imported_shipment.id;
  update public.shipments set suburb = 'INVALID RATE TEST', postcode = '0000' where id = v_imported_shipment.id;
  select jsonb_build_object(
    'tail', tail_lift_service_fee, 'fuel', fuel_levy_rate, 'gst', gst_rate,
    'booking', warehouse_booking_charge, 'minimum', minimum_billable_volume, 'storage', storage_rate
  ) into v_after_expected from public.shipments where id = v_imported_shipment.id;
  if v_after_expected is distinct from v_before_expected then raise exception 'Address repricing overwrote Customer Billing Profile values'; end if;
  select customer_id into v_second_customer_id from public.customer_billing_profiles
  where customer_id <> v_customer_id order by customer_id limit 1;
  if v_second_customer_id is not null then
    update public.shipments set customer_id = v_second_customer_id where id = v_imported_shipment.id;
    if not exists (
      select 1 from public.shipments as shipment
      join public.customer_billing_profiles as profile on profile.customer_id = shipment.customer_id
      where shipment.id = v_imported_shipment.id
        and shipment.tail_lift_service_fee = profile.default_tail_lift_fee
        and shipment.fuel_levy_rate = profile.default_fuel_levy_rate
        and shipment.gst_rate = profile.default_gst_rate
    ) then raise exception 'Customer change did not apply the new Billing Profile'; end if;
  end if;

  -- Import RPC rollback: an invalid second row leaves neither batch nor first shipment.
  select count(*) into v_batch_count from public.import_batches;
  begin
    perform public.import_shipment_batch(
      jsonb_build_object('customer_id', v_customer_id, 'source_file_name', 'staging-rollback.csv'),
      jsonb_build_array(
        jsonb_build_object('tracking_number', 'STAGING-ROLLBACK-1', 'delivery_address', '1 Test St', 'customer_id', v_customer_id),
        jsonb_build_object('tracking_number', 'STAGING-ROLLBACK-2', 'delivery_address', '', 'customer_id', v_customer_id)
      )
    );
    raise exception 'Invalid import unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'Invalid import unexpectedly succeeded' then raise; end if;
  end;
  if (select count(*) from public.import_batches) <> v_batch_count then raise exception 'Partial import batch survived rollback'; end if;
end;
$$;

rollback;
