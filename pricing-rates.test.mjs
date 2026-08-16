import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('./25_add_v2_postcode_3004.sql', import.meta.url), 'utf8');
const billingSql = readFileSync(new URL('./26_minimum_billable_volume.sql', import.meta.url), 'utf8');
const syncedBillingSql = readFileSync(new URL('./27_sync_minimum_billable_volume.sql', import.meta.url), 'utf8');
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
assert.match(app, /const billableVolume = volume === null \? null : Math\.max\(volume, 1\)/);
assert.match(html, /fuel-levy-formula">Volume × Unit Price × 20%/);
assert.match(app, /\(Volume \(min 1 m³\) × Unit Price \+ Tail Lift Service Fee \+ Fuel Levy\)/);
assert.match(app, /\+ \$\{formulaNumber\(fuelLevy, 3\)\}/);
assert.doesNotMatch(app, /Billable Volume/);

console.log('Pricing and billing checks passed.');
