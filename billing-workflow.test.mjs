import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('./billing-logic.js');
const { calculateShipmentBilling, calculateStorageAmount, outstandingTotal, groupConsecutiveStoragePeriods, recalculateDraftComponents, draftTotals } = globalThis.BENTWAY_BILLING;
const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const app = read('app.js');
const html = read('index.html');
const css = read('operations-ui.css');
const sql32 = read('32_unify_status_resume_and_exception_fingerprints.sql');
const sql33 = read('33_customer_billing_profiles_and_import_batches.sql');
const sql34 = read('34_shipment_storage_and_container_charges.sql');
const sql35 = read('35_draft_bills_and_atomic_finalise.sql');
const sql36 = read('36_pickup_profiles_and_storage_schedule_revisions.sql');
const predeploy = read('PREDEPLOY_SCHEMA_CHECK_SQL31.sql');
const stagingSmoke = read('STAGING_SMOKE_SQL32_35.sql');
const predeploy36 = read('PREDEPLOY_SCHEMA_CHECK_SQL36.sql');
const stagingSmoke36 = read('STAGING_SMOKE_SQL36.sql');

const normal = calculateShipmentBilling({ volume: 3.6561, unitPrice: 60, minimumBillableVolume: 1, tailLiftFee: 80, fuelLevyRate: .20, gstRate: .10, unbilledStorage: 80 });
assert.ok(Math.abs(normal.total - ((3.6561 * 60 + 80 + 3.6561 * 60 * .20 + 80) * 1.10)) < 1e-9);
const negativeCrane = calculateShipmentBilling({ volume: 1, unitPrice: 60, tailLiftFee: 80, craneRequired: false, craneFee: 900, fuelLevyRate: .2, gstRate: .1 });
assert.equal(negativeCrane.serviceFee, 80, 'inactive retained crane fee must not be charged');
const crane = calculateShipmentBilling({ volume: .5, unitPrice: 60, minimumBillableVolume: 1, tailLiftFee: 80, craneRequired: true, craneFee: 900, fuelLevyRate: .20, gstRate: .10 });
assert.equal(crane.tailLiftApplicable, false);
assert.equal(crane.total, (60 + 900 + 12) * 1.10);
const booking = calculateShipmentBilling({ warehouseBooking: true, warehouseBookingFee: 200, unbilledStorage: 80, gstRate: .10 });
assert.equal(booking.total, 308, 'warehouse booking and storage are both ex GST and taxed once');
assert.equal(booking.subtotal, 280);
assert.ok(Math.abs(booking.gstAmount - 28) < 1e-9);
const pickup = calculateShipmentBilling({ pickup: true, weight: 610, pickupRatePerKg: .20, unbilledStorage: 80, gstRate: .10 });
assert.equal(pickup.pickupCharge, 122);
assert.equal(pickup.subtotal, 202);
assert.ok(Math.abs(pickup.gstAmount - 20.2) < 1e-9);
assert.ok(Math.abs(pickup.total - 222.2) < 1e-9);
assert.equal(pickup.billableVolume, null);
assert.equal(pickup.serviceFee, 0);
assert.equal(pickup.fuelLevy, 0);
assert.equal(calculateShipmentBilling({ pickup: true, weight: null, pickupRatePerKg: .20, gstRate: .10 }).total, null);
assert.equal(calculateStorageAmount(4, 20), 80);
assert.equal(calculateStorageAmount(null, 20), null);
assert.equal(outstandingTotal([{ totalInclGst: 110 }, { totalInclGst: 88, billedAt: 'x' }, { totalInclGst: 990 }]), 1100);

const storageGroups = groupConsecutiveStoragePeriods([
  { shipmentId: 's', periodStart: '2026-08-01', periodEnd: '2026-08-07', rate: 80, gstRate: .1 },
  { shipmentId: 's', periodStart: '2026-08-08', periodEnd: '2026-08-14', rate: 80, gstRate: .1 },
  { shipmentId: 's', periodStart: '2026-08-15', periodEnd: '2026-08-21', rate: 90, gstRate: .1 }
]);
assert.deepEqual(storageGroups.map((group) => group.length), [2, 1]);
const percentageDraft = recalculateDraftComponents([
  { description: 'Last Mile Delivery', quantity: 2, rate: 60, rate_kind: 'currency' },
  { description: 'Tail Lift Service', quantity: 1, rate: 80, rate_kind: 'currency' },
  { description: 'Fuel Levy', quantity: 1, rate: .20, rate_kind: 'percentage' }
], .10);
assert.equal(percentageDraft.amountExGst, 224);
assert.ok(Math.abs(percentageDraft.gstAmount - 22.4) < 1e-9);
assert.ok(Math.abs(percentageDraft.totalInclGst - 246.4) < 1e-9);
assert.equal(percentageDraft.components.at(-1).amount_ex_gst, 24, 'Fuel Levy percentage uses Last Mile Delivery Actual');
const manualDraft = recalculateDraftComponents([
  { description: 'Last Mile Delivery', quantity: 2, rate: 60, rate_kind: 'currency' },
  { description: 'Fuel Levy', quantity: 1, rate: 0, rate_kind: 'manual', manual_amount: 17 }
], .10);
assert.equal(manualDraft.amountExGst, 137);
assert.deepEqual(draftTotals([
  { id: 'a', amount_ex_gst: 80, gst_amount: 8, total_incl_gst: 88 },
  { id: 'b', amount_ex_gst: 80, gst_amount: 8, total_incl_gst: 88 }
], new Set(['b'])), { subtotal: 80, gst: 8, total: 88 });

for (const sql of [sql32, sql33, sql34, sql35]) {
  assert.match(sql, /NOT YET EXECUTED IN PRODUCTION/);
  assert.match(sql, /begin;/i);
  assert.match(sql, /commit;/i);
}
assert.doesNotMatch(`${sql32}\n${sql33}\n${sql34}\n${sql35}`, /archived_at/);
assert.match(predeploy, /shipments' and column_name = v_column/);
assert.doesNotMatch(predeploy, /\binsert\b|\bupdate\b|\bdelete\b|\balter\b|\bcreate table\b/i);
assert.match(stagingSmoke, /STAGING ONLY/);
assert.match(stagingSmoke, /rollback;/i);
assert.doesNotMatch(predeploy36, /\bbegin\b|\bcommit\b|\brollback\b/i);
assert.doesNotMatch(predeploy36, /^\s*(insert|update|delete|alter|create)\s/im);
assert.match(stagingSmoke36, /STAGING ONLY/);
assert.match(stagingSmoke36, /rollback;/i);
assert.match(sql36, /begin;/i);
assert.match(sql36, /commit;/i);

// 1 Message Sent ordinary transition; 2 Completed Resume with real RPC errors.
assert.match(sql32, /p_new_status not in \([\s\S]*?'message_sent'/);
assert.match(sql32, /create or replace function public\.resume_completed_shipment/);
assert.match(sql34, /current_status = 'pending',[\s\S]*?outbound_method = null[\s\S]*?scheduled_for = null[\s\S]*?on_hold_started_at = null/);
assert.match(app, /Resume failed for \$\{shipmentReference\(shipment\)\}: \$\{error\.message\}/);

// 3 Independent automatic exception acknowledgements; 9 digest prerequisite.
assert.match(sql32, /exception_condition_keys text\[\]/);
assert.match(sql32, /resolved_exception_condition_keys text\[\]/);
assert.match(sql32, /'delivery_area'/);
assert.match(sql32, /'scheduled_overdue'/);
assert.match(sql32, /pg_catalog\.md5/);
assert.doesNotMatch(sql32, /extensions\.digest/);
assert.match(sql32, /active_key_sets[\s\S]*?resolved_exception_condition_keys[\s\S]*?active\.condition_keys/);

// 4 DTW pricing persistence; 5/6/7 Crane lifecycle.
assert.match(sql34, /warehouse_booking_pricing = true[\s\S]*?outbound_method = 'warehouse_delivery'/);
assert.match(sql34, /DTW completion requires Pending Warehouse Booking/);
assert.match(sql34, /v_shipment\.warehouse_booking_pricing/);
assert.match(sql34, /coalesce\(v_shipment\.warehouse_booking_charge, 150\)[\s\S]*?v_storage/);
assert.match(sql34, /shipments_crane_required_fee_check[\s\S]*?not crane_required or crane_truck_fee > 0/);
assert.match(sql34, /old\.delivery_billed_at is null then return new/);
assert.match(sql34, /create table if not exists public\.crane_service_charges/);
assert.match(sql35, /'Crane Truck Service'/);

// 8 Storage volume pricing and Melbourne period scheduling; 9 billed exclusion.
assert.match(sql34, /round\(new\.volume_m3 \* new\.storage_rate, 3\)/);
assert.match(sql34, /round\(v_episode\.volume_m3 \* v_episode\.rate_per_m3, 3\)/);
assert.match(sql34, /time '23:55'\) at time zone 'Australia\/Melbourne'/);
assert.match(sql34, /where shipment_id = p_shipment_id and billed_at is null/);

// 10 Fully billed visibility is dynamic; 11/12 outstanding total and selection are unbilled only.
assert.match(app, /status === 'billed' \? finalisedBillingChargeRows\(\) : allBillingChargeRows\(\)/);
assert.match(app, /state\.finalisedBillingItems/);
assert.match(app, /const sourceShipment = snapshot\.shipment/);
assert.doesNotMatch(app.match(/function finalisedBillingChargeRows\(\)[\s\S]*?\n  \}/)?.[0] || '', /liveShipments/);
assert.match(app, /state\.craneCharges\.forEach/);
assert.match(app, /outstanding = currentRows\.filter\(\(row\) => !row\.billed/);
assert.match(app, /Total \(incl GST\)/);
assert.match(app, /row\.totalInclGst/);
assert.match(app, /activeType === 'all' \|\| row\.type === activeType/);
assert.doesNotMatch(html, /billingDateFrom|billingDateTo/);
assert.match(html, /Shipment \/ Container \/ Reference[\s\S]*?Delivery Charge[\s\S]*?Tail Lift \/ Crane[\s\S]*?Fuel Levy[\s\S]*?Storage[\s\S]*?GST[\s\S]*?Total \(incl GST\)/);

// 13 Add/remove; 14 storage grouping/Qty maps to actual item ids.
assert.match(sql35, /create or replace function public\.add_to_draft_bill/);
assert.match(sql35, /create or replace function public\.remove_draft_bill_item/);
assert.match(app, /state\.draftRemovedItemIds\.add\(id\)/);
assert.match(app, /remove_item_ids: \[\.\.\.state\.draftRemovedItemIds\]/);
assert.match(app, /data-storage-quantity/);
assert.match(app, /Storage weeks/);
assert.match(html, /id="draftBillItems"/);

// 15 Draft Actual is isolated from Shipment Expected; 16 one auditable billing event source.
const saveDraft = sql35.match(/create or replace function public\.save_draft_bill_changes[\s\S]*?\n\$\$;/)?.[0] || '';
assert.match(saveDraft, /actual_components/);
assert.match(saveDraft, /before_actual[\s\S]*?after_actual[\s\S]*?adjustment_ex_gst/);
assert.doesNotMatch(saveDraft, /update public\.shipments set|update public\.storage_fees set amount|update public\.container_service_fees set amount|update public\.crane_service_charges set amount/);
assert.match(sql35, /'billing_updated'/);
assert.match(sql35, /'source', 'Draft Bill'/);
assert.match(sql35, /expected_components[\s\S]*?actual_components[\s\S]*?'expected'[\s\S]*?'actual'/);
assert.match(app, /recalculateDraftComponents\(components, item\.gst_rate\)/);
assert.match(app, /addEventListener\('input'[\s\S]*?updateDraftComponent/);
assert.match(app, /data-draft-fuel-mode/);
assert.match(app, /\+ Add Charge/);
assert.doesNotMatch(app.match(/function updateDraftComponent\(input\)[\s\S]*?\n  \}/)?.[0] || '', /shipmentChanges|crane_required|tail_lift_service_fee|fuel_levy_override/);

// 17 atomic Finalise; 18 no Operations mutation.
const finalise = sql35.match(/create or replace function public\.finalise_draft_bill[\s\S]*?\n\$\$;/)?.[0] || '';
assert.match(finalise, /for v_item in[\s\S]*?for update loop/);
assert.match(finalise, /delivery_billed_at = now\(\)/);
assert.match(finalise, /storage_fees set billed_at = now\(\)/);
assert.match(finalise, /crane_service_charges set billed_at = now\(\)/);
assert.doesNotMatch(finalise, /current_status\s*=|outbound_method\s*=|scheduled_for\s*=|on_hold_started_at\s*=/);

// 19 import is one RPC transaction; 20 final history snapshot is retained.
assert.match(sql33, /create or replace function public\.import_shipment_batch/);
assert.match(app, /rpc\('import_shipment_batch'/);
assert.doesNotMatch(app.match(/async function importBatchShipments\(\)[\s\S]*?\n  \}/)?.[0] || '', /for \(let index = 0; index < payloads\.length/);
assert.match(sql34, /legacy_total_charge_snapshot/);
assert.match(sql34, /where current_status not in \('completed', 'cancelled'\)/);
assert.match(sql35, /snapshot jsonb not null/);
assert.match(sql35, /Finalised charge snapshots remain immutable/);
assert.match(sql35, /prevent_finalised_billing_item_changes/);
assert.match(app, /snapshot\.actual_components \|\| snapshot\.components/);

assert.match(html, /class="shipment-details-column"[\s\S]*?Overview[\s\S]*?Operations[\s\S]*?class="shipment-details-column"[\s\S]*?Billing[\s\S]*?Activity/);
assert.match(css, /#shipmentModal \.shipment-details-column[\s\S]*?overflow-y: auto/);
assert.match(html, /id="billingCraneTitle"[\s\S]*?id="billingCraneValue"/);
assert.match(html, /Billing Adjustments &amp; Supplementary Charges/);
assert.match(html, /id="toggleCraneRequiredButton"[\s\S]*?ti-switch-horizontal/);
assert.doesNotMatch(html, /select name="crane_required"/);
assert.match(sql33, /default_tail_lift_fee numeric[\s\S]*?default 80/);
assert.match(sql33, /like 'oreo%' then 70[\s\S]*?like 'winmav%' then 80/);
const assignRate = sql33.match(/create or replace function public\.assign_shipment_suburb_rate\(\)[\s\S]*?\n\$\$;/)?.[0] || '';
assert.match(assignRate, /new\.delivery_rate_id := v_rate\.id[\s\S]*?new\.unit_price := v_rate\.unit_price/);
assert.doesNotMatch(assignRate, /new\.fuel_levy_rate|new\.gst_rate|tail_lift_service_fee/);
assert.doesNotMatch(`${app}\n${html}`, /service_role|sb_secret_|postgresql:\/\//i);
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, 'index.html must not contain duplicate IDs');

console.log('Billing workflow checks passed (38+ targeted contracts; pure logic plus static migration/UI checks).');
