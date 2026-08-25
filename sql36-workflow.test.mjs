import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('./billing-logic.js');
const { calculateShipmentBilling } = globalThis.BENTWAY_BILLING;
const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const sql = read('36_pickup_profiles_and_storage_schedule_revisions.sql');
const predeploy = read('PREDEPLOY_SCHEMA_CHECK_SQL36.sql');
const smoke = read('STAGING_SMOKE_SQL36.sql');
const app = read('app.js');
const html = read('index.html');
const css = read('operations-ui.css');

let staticChecks = 0;
const contract = (source, pattern, message) => {
  assert.match(source, pattern, message);
  staticChecks += 1;
};
const absent = (source, pattern, message) => {
  assert.doesNotMatch(source, pattern, message);
  staticChecks += 1;
};

// Pickup profiles and snapshots (static migration/UI contracts).
contract(sql, /default_pickup_rate_per_kg numeric\(14, 4\) not null default 0\.20/);
contract(sql, /customer_billing_profiles_pickup_rate_check[\s\S]*?default_pickup_rate_per_kg > 0/);
contract(sql, /add column pickup_rate_per_kg numeric\(14, 4\)/);
contract(sql, /set pickup_rate_per_kg = profile\.default_pickup_rate_per_kg/);
contract(sql, /alter column pickup_rate_per_kg set not null/);
contract(sql, /new\.pickup_rate_per_kg := v_profile\.default_pickup_rate_per_kg/);
contract(sql, /new\.tail_lift_service_fee := v_profile\.default_tail_lift_fee/);
contract(sql, /new\.fuel_levy_rate := v_profile\.default_fuel_levy_rate/);
contract(sql, /new\.gst_rate := v_profile\.default_gst_rate/);
contract(sql, /new\.warehouse_booking_charge := v_profile\.default_warehouse_booking_fee/);
contract(sql, /new\.minimum_billable_volume := v_profile\.minimum_billable_volume/);
contract(sql, /new\.storage_rate := v_profile\.default_storage_rate/);
contract(sql, /Admin permission is required to update Billing Profiles/);
contract(sql, /updated_by = auth\.uid\(\)/);
contract(sql, /Pickup rate per kg must be greater than zero/);
contract(sql, /Fuel Levy and GST rates must be decimal values from 0 to 1/);
contract(sql, /Billing Email is invalid/);
contract(html, /id="billingProfilesNav"[^>]*data-view="billing-profiles"[^>]*hidden/);
contract(html, /Storage Rate \(AUD \/ m³ \/ week\)/);
contract(html, /Pickup Rate \(AUD \/ kg\)/);
contract(app, /rpc\('update_customer_billing_profile'/);

// Pickup and Warehouse Booking calculations (pure unit checks plus SQL contracts).
const pickup = calculateShipmentBilling({ pickup: true, weight: 610, pickupRatePerKg: .20, gstRate: .10 });
assert.equal(pickup.pickupCharge, 122);
assert.ok(Math.abs(pickup.gstAmount - 12.2) < 1e-9);
assert.ok(Math.abs(pickup.total - 134.2) < 1e-9);
assert.equal(pickup.billableVolume, null);
assert.equal(pickup.serviceFee, 0);
assert.equal(pickup.fuelLevy, 0);
assert.equal(pickup.tailLiftApplicable, false);
const pickupWithStorage = calculateShipmentBilling({ pickup: true, weight: 610, pickupRatePerKg: .20, unbilledStorage: 80, gstRate: .10 });
assert.ok(Math.abs(pickupWithStorage.total - 222.2) < 1e-9);
assert.equal(calculateShipmentBilling({ pickup: true, weight: 0, pickupRatePerKg: .20, gstRate: .10 }).total, null);
assert.equal(calculateShipmentBilling({ pickup: true, weight: 610, pickupRatePerKg: 0, gstRate: .10 }).total, null);
const warehouse150 = calculateShipmentBilling({ warehouseBooking: true, warehouseBookingFee: 150, gstRate: .10 });
const warehouse200 = calculateShipmentBilling({ warehouseBooking: true, warehouseBookingFee: 200, gstRate: .10 });
const warehouseStorage = calculateShipmentBilling({ warehouseBooking: true, warehouseBookingFee: 200, unbilledStorage: 80, gstRate: .10 });
assert.ok(Math.abs(warehouse150.total - 165) < 1e-9);
assert.ok(Math.abs(warehouse200.total - 220) < 1e-9);
assert.ok(Math.abs(warehouseStorage.total - 308) < 1e-9);
assert.ok(Math.abs(warehouseStorage.gstAmount - 28) < 1e-9);
contract(sql, /current_status = 'completed' and v_shipment\.outbound_method = 'picked_up'/);
contract(sql, /v_core_ex := round\(v_shipment\.weight_kg \* v_shipment\.pickup_rate_per_kg, 3\)/);
contract(sql, /v_amount := round\(v_shipment\.weight_kg \* v_shipment\.pickup_rate_per_kg, 3\)/);
contract(sql, /v_description := 'Pickup Service'/);
contract(sql, /'description', 'Pickup Service', 'quantity', v_shipment\.weight_kg/);
contract(sql, /Weight must be greater than zero before completing Shipment as Picked Up/);
contract(sql, /Pickup rate per kg must be greater than zero before completing Shipment as Picked Up/);
contract(sql, /v_shipment\.warehouse_booking_pricing[\s\S]*?v_core_ex := coalesce\(v_shipment\.warehouse_booking_charge, 150\)/);
contract(sql, /Active Draft contains pre-SQL36 Warehouse Booking pricing/);
contract(predeploy, /Active Draft Warehouse Booking items using old GST semantics/);
contract(app, /Pickup Service · \$\{Number\(delivery\.breakdown\?\.pickupWeight/);

// Crane fallback and retained-history behavior.
contract(sql, /alter column crane_truck_fee set default 850/);
contract(sql, /then 850[\s\S]*?else crane_truck_fee/);
contract(app, /const DEFAULT_CRANE_TRUCK_FEE = 850/);
contract(app, /Number\(craneFeeField\.value\) <= 0[\s\S]*?String\(DEFAULT_CRANE_TRUCK_FEE\)/);
contract(html, /Crane Truck fallback \(AUD\)[\s\S]*?value="850" readonly/);
contract(css, /@keyframes crane-fee-flash/);

// Storage episode snapshots, backfill, revision, credits and immutable history.
contract(sql, /alter table public\.storage_episodes[\s\S]*?add column start_date date[\s\S]*?add column gst_rate/);
contract(sql, /storage_episodes_gst_rate_check check \(gst_rate between 0 and 1\)/);
contract(sql, /create table public\.storage_schedule_revisions/);
contract(sql, /billed_credit_count integer not null default 0/);
contract(sql, /credit_required_count integer not null default 0/);
contract(sql, /removed_draft_item_ids jsonb not null default '\[\]'::jsonb/);
contract(sql, /previous_schedule jsonb not null default '\{\}'::jsonb/);
contract(sql, /revised_schedule jsonb not null default '\{\}'::jsonb/);
contract(sql, /private\.storage_due_week_count/);
contract(sql, /p_start_date \+ \(v_count \* 7 - 1\)/);
contract(sql, /time '23:55'\) at time zone 'Australia\/Melbourne'/);
contract(sql, /v_start := v_episode\.start_date \+ \(v_index \* 7\)/);
contract(sql, /v_start \+ 6/);
contract(sql, /round\(v_episode\.volume_m3 \* v_episode\.rate_per_m3, 3\)/);
contract(sql, /v_index < v_billed[\s\S]*?'covered_by_billed_credit'/);
contract(sql, /order by period_start, created_at offset v_index limit 1/);
contract(sql, /greatest\(v_billed - v_due, 0\)/);
contract(sql, /where fee\.episode_id = p_episode_id and fee\.billed_at is not null/);
contract(sql, /delete from public\.billing_items[\s\S]*?bill\.status = 'draft'/);
contract(sql, /delete from public\.storage_fees where episode_id = v_episode\.id and billed_at is null/);
contract(sql, /perform private\.rebuild_storage_unbilled\(v_episode\.id, now\(\)\)/);
contract(sql, /Storage Start Date cannot be earlier than Inbound Time/);
contract(sql, /Storage Start Date cannot be after today in Melbourne/);
contract(sql, /Storage Start Date cannot be after the Storage episode end date/);
contract(sql, /Storage schedule can only be changed while Shipment is On Hold/);
contract(sql, /Admin permission is required to revise Storage Start Date/);
contract(sql, /event_type[\s\S]*?'storage_schedule_updated'/);
contract(sql, /current_status = 'on_hold'[\s\S]*?not exists \([\s\S]*?storage_episodes/);
contract(sql, /set storage_rate = profile\.default_storage_rate[\s\S]*?profile\.default_storage_rate > 0/);
contract(sql, /Generates at most the next due week after Melbourne 23:55/);
contract(app, /rpc\('preview_storage_schedule_change'/);
contract(app, /rpc\('get_storage_schedule'/);
contract(app, /Covered by previous Bill/);
contract(app, /Storage Credit Required/);
contract(app, /No automatic refund or negative charge was created/);
contract(app, /data-storage-show-all/);
contract(html, /<h3>Storage Schedule<\/h3>/);
absent(`${app}\n${html}`, /['"`]([^'"`]*\bperiods?\b[^'"`]*)['"`]/i, 'User-visible copy must say week(s), not period(s)');

// Details Activity and permission hardening.
contract(sql, /'details_updated'[\s\S]*?'changed_fields'[\s\S]*?'old_values'[\s\S]*?'new_values'/);
contract(sql, /'source', 'Shipment Details'/);
contract(app, /event\.event_type === 'details_updated'/);
contract(app, /event\.event_type === 'storage_schedule_updated'/);
contract(app, /performerNames\.get\(event\.performed_by\)/);
absent(app, /\.from\(['"]shipments['"]\)\.update\(/, 'Browser must not update shipments directly');
contract(sql, /revoke all on table public\.shipments from authenticated/);
contract(sql, /grant select, insert on table public\.shipments to authenticated/);
contract(sql, /drop policy if exists import_batches_insert_policy/);
contract(sql, /grant select on table public\.import_batches to authenticated/);
contract(sql, /revoke all on function public\.rls_auto_enable\(\) from public, anon, authenticated/);
contract(sql, /revoke all on function public\.sync_shipment_customer\(\) from public, anon, authenticated/);
contract(sql, /revoke all on function public\.update_customer_billing_profile[\s\S]*?grant execute[\s\S]*?to authenticated/);
contract(sql, /revoke all on function public\.apply_storage_schedule_change[\s\S]*?grant execute[\s\S]*?to authenticated/);
contract(sql, /set search_path = ''/);

// Deployment and integration-test artifacts are intentionally separate from unit/static checks.
contract(predeploy, /SQL36 not already applied/i);
contract(predeploy, /bentway-storage-periods/);
contract(predeploy, /private\.delivery_postcode_suburbs/);
absent(predeploy, /^\s*(insert|update|delete|alter|create|begin|commit|rollback)\s/im, 'Predeploy script must remain read-only');
contract(smoke, /STAGING ONLY/);
contract(smoke, /New Shipment did not snapshot Pickup rate/);
contract(smoke, /Pickup expected 610kg x \$0\.20/);
contract(smoke, /Warehouse Booking expected \$200 ex GST \/ \$220 incl GST/);
contract(smoke, /Backdated Storage expected three \$80 weeks/);
contract(smoke, /Billed Storage history changed/);
contract(smoke, /Storage Credit Required handling failed/);
contract(smoke, /Shipment Details did not write one details_updated Activity/);
contract(smoke, /Partial import batch survived rollback/);
contract(smoke, /rollback;/i);

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, 'index.html must not contain duplicate IDs');
assert.doesNotMatch(`${sql}\n${app}\n${html}`, /^(<{7}|={7}|>{7})/m, 'No merge markers');

console.log(`SQL36 checks passed: 14 pure billing assertions + ${staticChecks} static contracts. Database behavior is covered separately by STAGING_SMOKE_SQL36.sql.`);
