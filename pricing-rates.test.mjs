import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('./25_add_v2_postcode_3004.sql', import.meta.url), 'utf8');
const billingSql = readFileSync(new URL('./26_minimum_billable_volume.sql', import.meta.url), 'utf8');
const syncedBillingSql = readFileSync(new URL('./27_sync_minimum_billable_volume.sql', import.meta.url), 'utf8');
const currentBillingSql = readFileSync(new URL('./34_shipment_storage_and_container_charges.sql', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

assert.match(sql, /values \(null, 'V2', '3004', 'VIC', 40,/);
assert.match(sql, /on conflict[\s\S]*do update set/);
assert.match(sql, /btrim\(postcode\) = '3004'/);
assert.doesNotMatch(sql, /delete\s+from/i);
assert.equal((billingSql.match(/greatest\(volume_m3, 1\)/g) || []).length, 2);
assert.equal((syncedBillingSql.match(/greatest\(volume_m3, 1\)/g) || []).length, 3);
assert.match(syncedBillingSql, /drop column fuel_levy/);
assert.match(syncedBillingSql, /add column fuel_levy/);
assert.match(syncedBillingSql, /add column total_charge/);
assert.match(currentBillingSql, /greatest\(v_shipment\.volume_m3, v_shipment\.minimum_billable_volume\)/);
assert.match(currentBillingSql, /case when v_shipment\.crane_required[\s\S]*?crane_truck_fee[\s\S]*?tail_lift_service_fee/);
assert.match(currentBillingSql, /v_delivery \+ v_service \+ v_fuel \+ v_storage/);
assert.match(html, /fuel-levy-formula">Delivery Charge × Rate/);
assert.match(html, /Billable Volume \(m³\)/);
assert.match(app, /Unbilled Storage Fees/);

console.log('Pricing and billing checks passed.');
