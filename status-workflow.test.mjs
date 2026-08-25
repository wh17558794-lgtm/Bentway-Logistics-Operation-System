import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('./shipment-formatters.js');
const formatters = globalThis.BENTWAY_SHIPMENT_FORMATTERS;

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const operationsCss = readFileSync(new URL('./operations-ui.css', import.meta.url), 'utf8');
const archiveSql = readFileSync(new URL('./23_soft_delete_shipments.sql', import.meta.url), 'utf8');
const resumeSql = readFileSync(new URL('./24_resume_completed_shipments.sql', import.meta.url), 'utf8');
const totalQuantitySql = readFileSync(new URL('./28_add_total_quantity.sql', import.meta.url), 'utf8');
const exceptionSql = readFileSync(new URL('./29_add_automatic_shipment_exceptions.sql', import.meta.url), 'utf8');
const matchingPostcodeSuburbSql = readFileSync(new URL('./30_require_matching_postcode_suburb.sql', import.meta.url), 'utf8');
const messageSentSql = readFileSync(new URL('./31_add_message_sent_and_sms_preparation.sql', import.meta.url), 'utf8');
const unifiedStatusSql = readFileSync(new URL('./32_unify_status_resume_and_exception_fingerprints.sql', import.meta.url), 'utf8');
const rankSource = source.match(/function pendingStatusRank\(status\) \{[\s\S]*?\n  \}/)?.[0];
const timeComparatorSource = source.match(/function compareShipmentTime\(left, right, field, ascending\) \{[\s\S]*?\n  \}/)?.[0];
const nameImportField = source.match(/\{ key: 'recipient_name',[^\n]+\}/)?.[0];
const trackingNumberBaseSource = source.match(/function trackingNumberBase\(value\) \{[\s\S]*?\n  \}/)?.[0];
const batchShipmentGroupKeySource = source.match(/function batchShipmentGroupKey\(record\) \{[\s\S]*?\n  \}/)?.[0];
const fillSparseBatchItemsSource = source.match(/function fillSparseBatchItems\(items\) \{[\s\S]*?\n  \}/)?.[0];
const sumBatchMeasurementSource = source.match(/function sumBatchMeasurement\(currentValue, nextValue\) \{[\s\S]*?\n  \}/)?.[0];
const groupBatchItemsSource = source.match(/function groupBatchItems\(items\) \{[\s\S]*?\n  \}/)?.[0];
const isBatchShipmentRowSource = source.match(/function isBatchShipmentRow\(record\) \{[\s\S]*?\n  \}/)?.[0];
const findBestHeaderSource = source.match(/function findBestHeader\(field, usedIndexes, matchLevel = 'partial'\) \{[\s\S]*?\n  \}/)?.[0];
const autoMapHeadersSource = source.match(/function autoMapHeaders\(\) \{[\s\S]*?\n  \}/)?.[0];
const selectedTotalChargeSource = source.match(/function selectedTotalCharge\(\) \{[\s\S]*?\n  \}/)?.[0];
const totalQuantityForSource = source.match(/function totalQuantityFor\(record\) \{[\s\S]*?\n  \}/)?.[0];
const formatShipmentQuantitySource = source.match(/function formatShipmentQuantity\(shipment\) \{[\s\S]*?\n  \}/)?.[0];
const pendingRowSource = source.match(/function pendingRowHtml\(shipment\) \{[\s\S]*?\n  \}/)?.[0];
const completedRowSource = source.match(/function completedRowHtml\(shipment\) \{[\s\S]*?\n  \}/)?.[0];

assert.ok(formatters, 'Shipment formatters must load');
assert.ok(pendingRowSource, 'Pending row renderer must exist');
assert.ok(completedRowSource, 'Completed row renderer must exist');
assert.equal(formatters.formatPersonName('ZULE NG'), 'Zule Ng');
assert.equal(formatters.formatPersonName("MARY-JANE O'CONNOR"), "Mary-Jane O'Connor");
assert.equal(formatters.formatAustralianMobile('0450185200'), '0450 185 200');
assert.equal(formatters.formatAustralianMobile('+61 456 425 048'), '0456 425 048');
assert.equal(formatters.formatAustralianMobile('0061456425048'), '0456 425 048');
assert.equal(formatters.formatAustralianMobile('61 421 652 666'), '0421 652 666');
assert.deepEqual(formatters.shipmentSmsDetails({
  recipient_name: 'ZULE NG',
  recipient_phone: '+61 450 185 200',
  tracking_number: 'TH260529'
}), {
  phone: '0450185200',
  message: 'Hi Zule Ng, this is BentWay Logistics regarding shipment TH260529.'
});
assert.equal(formatters.shipmentSmsDetails({ recipient_phone: '03 9000 0000' }), null);
assert.deepEqual(formatters.normaliseAddressFields({
  delivery_address: '1 MAXIA RD, DONCASTER EAST VIC 3109',
  suburb: 'RAVENHALL',
  state: 'vic',
  postcode: '3109'
}), {
  delivery_address: '1 Maxia Rd',
  suburb: 'Doncaster East',
  state: 'VIC',
  postcode: '3109'
});
assert.equal(formatters.formatSingleLineAddress({
  delivery_address: '15 SIMMONS STREET',
  suburb: 'BOX HILL NORTH',
  state: 'vic',
  postcode: '3129'
}), '15 Simmons Street, Box Hill North VIC 3129');
assert.deepEqual(formatters.normaliseAddressFields({
  delivery_address: '9 MANOR COURT DONVALE VIC 3111'
}), {
  delivery_address: '9 Manor Court',
  suburb: 'Donvale',
  state: 'VIC',
  postcode: '3111'
});
assert.equal(formatters.formatSingleLineAddress({
  delivery_address: '6/5 ILLAWARRA CLOSE, CHADSTONE',
  suburb: 'Chadstone',
  state: 'vic',
  postcode: '3148'
}), '6/5 Illawarra Close, Chadstone VIC 3148');
assert.match(html, /shipment-formatters\.js/);
assert.match(html, /id="prepareShipmentSmsButton"[^>]*>[\s\S]*?Prepare SMS/);
assert.match(html, /id="bulkPrepareSmsButton"[^>]*data-bulk-prepare-sms[^>]*>[\s\S]*?Prepare SMS/);
assert.match(source, /shipmentSmsDetails\(\{[\s\S]*?recipient_phone: form\.recipient_phone\.value/);
assert.match(source, /function prepareSelectedShipmentSms\(\)[\s\S]*?state\.selectedIds\.has[\s\S]*?navigator\.clipboard\.writeText\(text\)/);
assert.match(source, /navigator\.clipboard\.writeText\(sms\.message\)/);
assert.match(source, /window\.location\.href = `sms:\$\{sms\.phone\}`/);
assert.match(pendingRowSource, /formatSingleLineAddress\(shipment\)/);
assert.match(pendingRowSource, /formatAustralianMobile\(shipmentRecipientPhone\(shipment\)\)/);
assert.match(completedRowSource, /tracking-cell[\s\S]*?agentCustomer[\s\S]*?name-cell/);
assert.match(completedRowSource, /name-cell[\s\S]*?formatPersonName\(shipment\.recipient_name\)/);
assert.doesNotMatch(completedRowSource, /name-cell[^\n]*Agent Customer/);
assert.match(pendingRowSource, /detailsOpen && 'details-open-row'/);
assert.match(completedRowSource, /detailsOpen && 'details-open-row'/);
assert.match(source, /function syncEditingRowHighlight\(\)[\s\S]*?details-open-row[\s\S]*?state\.editingShipmentId/);
assert.match(source, /state\.editingShipmentId = id;\s*syncEditingRowHighlight\(\)/);
assert.match(source, /state\.editingShipmentId = null;\s*syncEditingRowHighlight\(\)/);
assert.match(operationsCss, /tr\.details-open-row td \{[\s\S]*?background: #f1f5f9/);
assert.match(operationsCss, /#shipmentModal \.shipment-modal :is\([^)]+\) \{\s*font-size: 14px;\s*font-weight: 500;/);
assert.match(source, /const DEFAULT_CRANE_TRUCK_FEE = 850;/);
assert.match(source, /shipment\.crane_truck_fee \?\? DEFAULT_CRANE_TRUCK_FEE/);
assert.match(html, /id="toggleCraneRequiredButton"[^>]*type="button"[^>]*aria-label="Set Crane Required to Positive"[\s\S]*?ti-switch-horizontal/);
assert.match(source, /toggleCraneRequiredButton\.addEventListener\('click'[\s\S]*?craneFeeField\.value = String\(DEFAULT_CRANE_TRUCK_FEE\)/);
assert.match(source, /craneFeeField\.classList\.add\('crane-fee-flash'\)/);
assert.match(operationsCss, /@keyframes crane-fee-flash/);
assert.match(source, /animationName !== 'crane-fee-flash'[\s\S]*?classList\.add\('crane-fee-border-lit'\)/);
assert.match(source, /function closeShipmentModal\(\)[\s\S]*?classList\.remove\('crane-fee-flash', 'crane-fee-border-lit'\)/);
assert.match(operationsCss, /input\.crane-fee-border-lit \{/);
assert.match(source, /shipmentModal\.addEventListener\('pointerdown'[\s\S]*?shipmentModalPointerDownOutside = event\.button === 0 && event\.target === elements\.shipmentModal/);
assert.match(source, /shipmentModal\.addEventListener\('pointerup'[\s\S]*?shipmentModalPointerDownOutside && event\.button === 0 && event\.target === elements\.shipmentModal/);
assert.doesNotMatch(source, /shipmentModal\.addEventListener\('click'/);
assert.match(operationsCss, /\.sidebar:has\(\.nav-item:hover\)/);
assert.match(operationsCss, /\.sidebar\.desktop-open/);
assert.match(operationsCss, /\.sidebar:hover/);
assert.match(source, /sidebar\.addEventListener\('click'[\s\S]*?classList\.add\('desktop-open'\)/);
assert.match(source, /sidebar\.addEventListener\('mouseleave'[\s\S]*?setTimeout\([\s\S]*?classList\.remove\('desktop-open'\), 200\)/);

assert.ok(rankSource, 'pendingStatusRank must exist');
assert.ok(timeComparatorSource, 'compareShipmentTime must exist');
assert.ok(nameImportField, 'Name import mapping must exist');
assert.ok(trackingNumberBaseSource, 'trackingNumberBase must exist');
assert.ok(batchShipmentGroupKeySource, 'batchShipmentGroupKey must exist');
assert.ok(fillSparseBatchItemsSource, 'fillSparseBatchItems must exist');
assert.ok(sumBatchMeasurementSource, 'sumBatchMeasurement must exist');
assert.ok(groupBatchItemsSource, 'groupBatchItems must exist');
assert.ok(isBatchShipmentRowSource, 'isBatchShipmentRow must exist');
assert.ok(findBestHeaderSource, 'findBestHeader must exist');
assert.ok(autoMapHeadersSource, 'autoMapHeaders must exist');
assert.ok(selectedTotalChargeSource, 'selectedTotalCharge must exist');
assert.ok(totalQuantityForSource, 'totalQuantityFor must exist');
assert.ok(formatShipmentQuantitySource, 'formatShipmentQuantity must exist');
assert.match(nameImportField, /'name', 'contact name'/);
assert.doesNotMatch(nameImportField, /'contact'(?:,|\])/);
assert.doesNotMatch(source, /Not provided/);
const cleanCellForGrouping = (value) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
const normaliseSearchForGrouping = (value) => String(value || '').trim().toLocaleLowerCase();
const normaliseQuantityForGrouping = (value) => {
  const quantity = Number.parseInt(cleanCellForGrouping(value), 10);
  return Number.isInteger(quantity) && quantity >= 1 ? quantity : 1;
};
const totalQuantityForTest = Function('cleanCell', 'normaliseQuantity', `${totalQuantityForSource}\nreturn totalQuantityFor;`)(cleanCellForGrouping, normaliseQuantityForGrouping);
const formatShipmentQuantityTest = Function('normaliseQuantity', 'totalQuantityFor', `${formatShipmentQuantitySource}\nreturn formatShipmentQuantity;`)(normaliseQuantityForGrouping, totalQuantityForTest);
assert.equal(totalQuantityForTest({ quantity: 8, total_quantity: 10 }), 10);
assert.equal(totalQuantityForTest({ quantity: 8, total_quantity: '' }), 8);
assert.equal(formatShipmentQuantityTest({ quantity: 8, total_quantity: 10 }), '8/10');
assert.equal(formatShipmentQuantityTest({ quantity: 8, total_quantity: 8 }), '8');
const optionalNonNegativeNumberForGrouping = (value) => {
  const text = cleanCellForGrouping(value).replaceAll(',', '');
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const hasInvalidOptionalNumberForGrouping = (value) => Boolean(cleanCellForGrouping(value)) && optionalNonNegativeNumberForGrouping(value) === null;
const groupBatchItems = Function('cleanCell', 'normaliseSearch', 'normaliseQuantity', 'optionalNonNegativeNumber', 'hasInvalidOptionalNumber', `${trackingNumberBaseSource}\n${batchShipmentGroupKeySource}\n${sumBatchMeasurementSource}\n${groupBatchItemsSource}\nreturn groupBatchItems;`)(cleanCellForGrouping, normaliseSearchForGrouping, normaliseQuantityForGrouping, optionalNonNegativeNumberForGrouping, hasInvalidOptionalNumberForGrouping);
const fillSparseBatchItems = Function('cleanCell', 'normaliseSearch', `${trackingNumberBaseSource}\n${fillSparseBatchItemsSource}\nreturn fillSparseBatchItems;`)(cleanCellForGrouping, normaliseSearchForGrouping);
const importFieldsForRows = [
  { key: 'tracking_number', aliases: ['tracking number', '单号'] },
  { key: 'delivery_address', aliases: ['address', '地址'] },
  { key: 'recipient_name', aliases: ['name', '收件人'] },
  { key: 'recipient_phone', aliases: ['contact phone', '电话'] },
  { key: 'customer_reference', aliases: ['customer reference'] },
  { key: 'container_number', aliases: ['container number'] },
  { key: 'quantity', aliases: ['quantity'] },
  { key: 'total_quantity', aliases: ['total quantity', '总件数'] },
  { key: 'weight_kg', aliases: ['weight'] },
  { key: 'volume_m3', aliases: ['volume'] },
  { key: 'suburb', aliases: ['suburb'] },
  { key: 'postcode', aliases: ['postcode'] }
];
const normaliseHeaderForRows = (value) => cleanCellForGrouping(value).toLocaleLowerCase().replace(/[\s_\-./\\()（）【】\[\]:：]+/g, '');
const mappingState = { batchHeaders: ['Tracking Number', 'Total Qty', 'Customer Ref Number', 'Weight', 'Volume'], batchMapping: {}, batchFuzzyMappings: new Set() };
const mappingFields = [
  { key: 'tracking_number', label: 'Tracking Number', aliases: ['tracking number', 'tracking'] },
  { key: 'quantity', label: 'Quantity', aliases: ['quantity', 'qty'] },
  { key: 'total_quantity', label: 'Total Quantity', aliases: ['total quantity', 'total qty'] },
  { key: 'customer_reference', label: 'Customer Reference', aliases: ['customer ref'] },
  { key: 'weight_kg', label: 'Weight (kg)', aliases: ['weight'] },
  { key: 'volume_m3', label: 'Volume (m³)', aliases: ['volume'] }
];
const findBestHeaderForTest = Function('state', 'normaliseHeader', `${findBestHeaderSource}\nreturn findBestHeader;`)(mappingState, normaliseHeaderForRows);
const autoMapHeadersForTest = Function('state', 'IMPORT_FIELDS', 'findBestHeader', `${autoMapHeadersSource}\nreturn autoMapHeaders;`)(mappingState, mappingFields, findBestHeaderForTest);
autoMapHeadersForTest();
assert.deepEqual(mappingState.batchMapping, { tracking_number: '0', quantity: '', total_quantity: '1', customer_reference: '2', weight_kg: '3', volume_m3: '4' });
assert.deepEqual(mappingState.batchFuzzyMappings, new Set(['total_quantity', 'customer_reference']));
const isBatchShipmentRow = Function('IMPORT_FIELDS', 'cleanCell', 'normaliseHeader', `${isBatchShipmentRowSource}\nreturn isBatchShipmentRow;`)(importFieldsForRows, cleanCellForGrouping, normaliseHeaderForRows);
assert.equal(isBatchShipmentRow({ weight_kg: '531', quantity: '2', volume_m3: '2.099463' }), false);
assert.equal(isBatchShipmentRow({ tracking_number: 'Total', weight_kg: '531' }), false);
assert.equal(isBatchShipmentRow({ tracking_number: 'Tracking Number', delivery_address: 'Address' }), false);
assert.equal(isBatchShipmentRow({ delivery_address: '1 Test St', weight_kg: '531' }), true);
assert.equal(isBatchShipmentRow({ recipient_name: 'Amy', recipient_phone: '0400' }), true);
assert.equal(isBatchShipmentRow({ notes: 'Prepared by Amy' }), false);
assert.equal(isBatchShipmentRow({ tracking_number: 'AUH0189800756', weight_kg: '531' }), true);
assert.match(source, /const record = rowToRecord\(row\);\s*if \(!isBatchShipmentRow\(record\)\) return;/);
const selectedTotalCharge = Function('state', 'displayedTotalCharge', `${selectedTotalChargeSource}\nreturn selectedTotalCharge;`)(
  { shipments: [{ id: '1', total_charge: 10.25 }, { id: '2', total_charge: 20 }, { id: '3', total_charge: 99 }], selectedIds: new Set(['1', '2']) },
  (shipment) => shipment.total_charge
);
assert.equal(selectedTotalCharge(), 30.25);
assert.match(html, /id="showOnMapIcon"[\s\S]*?id="showOnMapLabel"[\s\S]*?id="selectedCount"/);
assert.match(source, /showTotal \? formatCurrency\(selectedTotalCharge\(\), '\$0\.00'\) : 'View on Map'/);
assert.match(operationsCss, /\.map-button\.selection-total > \.map-button-label[\s\S]*?font-size: 16px;[\s\S]*?font-weight: 700;/);
assert.match(operationsCss, /\.map-button:not\(\.selection-total\) > \.map-button-label[\s\S]*?font-size: 14px;[\s\S]*?font-weight: 620;/);
const groupedItems = groupBatchItems([
  { record: { tracking_number: 'WMAU47520129-1', customer_reference: 'REF', recipient_name: 'Amy', delivery_address: '1 Test St', recipient_phone: '0400' }, rowNumber: 2, originalRow: {} },
  { record: { tracking_number: 'WMAU47520129-10', customer_reference: 'REF', recipient_name: 'Amy', delivery_address: '1 Test St', recipient_phone: '0400' }, rowNumber: 3, originalRow: {} },
  { record: { tracking_number: 'WMAU47520129-2', customer_reference: 'REF', recipient_name: 'Amy', delivery_address: '1 Test St', recipient_phone: '0499' }, rowNumber: 4, originalRow: {} },
  { record: { tracking_number: 'HYN059-MEL', customer_reference: 'B', recipient_name: '', delivery_address: '2 Test St', recipient_phone: '' }, rowNumber: 5, originalRow: {} },
  { record: { tracking_number: 'HYN059-MEL', customer_reference: 'B', recipient_name: '', delivery_address: '2 Test St', recipient_phone: '' }, rowNumber: 6, originalRow: {} }
]);
assert.deepEqual(groupedItems.map((item) => item.record.quantity), [2, 1, 2]);
assert.equal(groupedItems[0].record.tracking_number, 'WMAU47520129-1');
const [millParkShipment] = groupBatchItems([
  ['16', '0.066'], ['19', '0.135'], ['19', '0.130'], ['29', '0.150'],
  ['19', '0.071'], ['19', '0.071'], ['22', '0.131'], ['11.15', '0.166']
].map(([weight_kg, volume_m3], index) => ({
  record: { tracking_number: 'AUH01898007562', recipient_name: 'Vicky Suen', delivery_address: '11 Gypsy Court', recipient_phone: '0406360318', weight_kg, volume_m3 },
  rowNumber: index + 2,
  originalRow: {}
})));
assert.equal(millParkShipment.record.quantity, 8);
assert.equal(millParkShipment.record.weight_kg, 154.15);
assert.ok(Math.abs(millParkShipment.record.volume_m3 - 0.92) < 1e-10);
const sparseItems = [
  { record: { tracking_number: 'WMAU47520129-4', customer_reference: 'CJ260401', recipient_name: 'Elizabeth', delivery_address: '61 Pear Parade', recipient_phone: '0432', suburb: 'Fraser Rise', weight_kg: '10', volume_m3: '0.5' }, rowNumber: 2, originalRow: {} },
  ...Array.from({ length: 9 }, (_, index) => ({ record: { tracking_number: `WMAU47520129-${index + 1}` }, rowNumber: index + 3, originalRow: {} }))
];
const sparseGrouped = groupBatchItems(fillSparseBatchItems(sparseItems));
assert.equal(sparseGrouped.length, 1);
assert.equal(sparseGrouped[0].record.quantity, 10);
assert.equal(sparseGrouped[0].record.delivery_address, '61 Pear Parade');
assert.equal(sparseGrouped[0].record.weight_kg, 10);
assert.equal(sparseGrouped[0].record.volume_m3, 0.5);
assert.match(source, /exactTrackingCounts[\s\S]*?Conflicting shipment details/);
const pendingStatusRank = Function(`return (${rankSource})`)();
const compareShipmentTime = Function(`return (${timeComparatorSource})`)();
assert.deepEqual(
  ['on_hold', 'pending', 'pending_warehouse_booking', 'scheduled'].sort((a, b) => pendingStatusRank(a) - pendingStatusRank(b)),
  ['pending', 'scheduled', 'pending_warehouse_booking', 'on_hold']
);
assert.equal(pendingStatusRank('pending'), pendingStatusRank('scheduled'));
assert.equal(pendingStatusRank('pending'), pendingStatusRank('out_for_delivery'));
assert.equal(pendingStatusRank('pending'), pendingStatusRank('exception'));
assert.deepEqual(
  [{ at: '2026-08-14' }, { at: '2026-08-15' }].sort((a, b) => compareShipmentTime(a, b, 'at', false)).map((item) => item.at),
  ['2026-08-15', '2026-08-14']
);
assert.deepEqual(
  [{ at: '2026-08-14' }, { at: '2026-08-15' }].sort((a, b) => compareShipmentTime(a, b, 'at', true)).map((item) => item.at),
  ['2026-08-14', '2026-08-15']
);
assert.deepEqual(
  [
    { at: '2026-08-15', tracking_number: 'B' },
    { at: '2026-08-15', tracking_number: 'A' }
  ].sort((a, b) => compareShipmentTime(a, b, 'at', false)).map((item) => item.tracking_number),
  ['A', 'B']
);
assert.deepEqual(
  [
    { at: '2026-08-15', tracking_number: 'A', id: '2' },
    { at: '2026-08-15', tracking_number: 'A', id: '1' }
  ].sort((a, b) => compareShipmentTime(a, b, 'at', false)).map((item) => item.id),
  ['1', '2']
);
assert.match(html, /id="pendingSortToggle"[\s\S]*?ti-switch-vertical/);
assert.match(source, /return state\.pendingSortAscending \? shipments\.reverse\(\) : shipments;/);
assert.match(source, /return state\.historySortAscending \? shipments\.reverse\(\) : shipments;/);
assert.match(source, /record\.inbound_at !== dateTimeInputValue\(shipment\.inbound_at\)/);
assert.match(source, /pendingTableMode: 'ov'/);
assert.match(source, /ov: \['QTY', 'Suburb', 'Tracking Number', 'Customer Reference', 'Name', 'Address', 'Contact Phone', 'Inbound Time', 'Container Number', 'Status'\]/);
assert.match(source, /bv: \[[^\]]*'Total Charge', 'Agent Customer'\]/);
assert.match(html, /Agent Customer &amp; Delivery Details/);
assert.match(html, />Name<\/span><input name="recipient_name"/);
assert.match(source, /class="customer-cell"/);
assert.match(source, /pendingTableMode === 'ov' \? 'bv' : 'ov'/);
assert.match(pendingRowSource, /formatShipmentQuantity\(shipment\)/);
assert.match(html, /name="quantity"[\s\S]*?name="total_quantity"/);
assert.match(source, /form\.total_quantity\.value = totalQuantityFor\(shipment\)/);
assert.match(source, /total_quantity: totalQuantityFor\(\{ \.\.\.record, quantity \}\)/);
assert.match(source, /total_quantity: totalQuantity/);
assert.match(source, /pendingTableMode === 'bv'[\s\S]*?status-action[\s\S]*?: `<td class="status-cell"><div class="status-cell-content">/);
assert.match(html, /Switch to Billing View/);
assert.match(html, /data-bulk-pending[\s\S]*?<span>Pending<\/span>[\s\S]*?data-bulk-complete="delivered"/);
assert.match(source, /function resetSelectedShipmentsToPending\(\)/);
assert.match(source, /kind: 'status', status: 'pending'/);
assert.match(pendingRowSource, /shipment\.current_status === 'exception' && 'exception-row'/);
assert.match(source, /!canManageShipments\(\) \|\| status === 'exception'/);
assert.match(source, /rpc\('refresh_shipment_exceptions'\)/);
assert.match(source, /Resolve the Exception from Shipment Details before completing the shipment/);
assert.match(operationsCss, /tr\.exception-row td \{\s*background: #fff3f5/);
assert.match(operationsCss, /:is\(#editExceptionReasonField, #editExceptionResolutionReasonField\)[\s\S]*?border-left: 3px solid #cf969f[\s\S]*?background: #fff7f8/);
assert.match(html, /id="editExceptionReasonField"[\s\S]*?name="exception_reason"/);
assert.match(html, /id="editExceptionResolutionReasonField"[\s\S]*?name="exception_resolution_reason"/);
assert.doesNotMatch(html, /data-details-tab|data-details-panel/);
assert.doesNotMatch(source, /function selectShipmentDetailsTab\(name\)/);
assert.match(html, /class="shipment-details-column"[\s\S]*?name="current_status"[\s\S]*?name="exception_reason"[\s\S]*?name="exception_resolution_reason"[\s\S]*?name="notes"/);
assert.match(source, /Enter an Exception Reason before changing the status to Exception/);
assert.match(source, /shipmentStatusNote\.hidden = shipment\.current_status === 'exception'/);
assert.doesNotMatch(source, /window\.alert\('Enter an Exception Resolution Reason/);
assert.match(source, /title: 'Exception Resolution Reason Required'[\s\S]*?showCancel: false[\s\S]*?returnFocus: form\.exception_resolution_reason/);
assert.match(source, /notes: enteringException[\s\S]*?record\.exception_resolution_reason/);
assert.match(html, /id="historySortToggle"[\s\S]*?ti-switch-vertical/);
assert.match(html, /data-view="intake"[\s\S]*?data-view="pending"[\s\S]*?data-view="completed"[\s\S]*?data-view="map"/);
assert.match(html, /class="intake-split-layout"[\s\S]*?id="manualIntakePanel"[\s\S]*?id="batchIntakePanel"/);
assert.doesNotMatch(html, /id="batchIntakePanel" hidden/);
assert.doesNotMatch(html, /id="intakeModePicker"/);
assert.doesNotMatch(source, /function setIntakeMode/);
assert.match(source, /workspacePageSeparator\.hidden = viewName === 'intake'/);
assert.match(operationsCss, /\.intake-split-layout\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(operationsCss, /#intakeView :is\(button, input, select, textarea\)\s*\{\s*font-size: 15px;/);
assert.match(html, /class="import-summary-row"[\s\S]*?id="importSummary"[\s\S]*?id="importShipmentsButton"[\s\S]*?>Import Shipments</);
assert.doesNotMatch(html, />Import Valid Shipments</);
assert.match(html, /id="cancelBatchImportButton"[\s\S]*?Cancel Importing Excel\/CSV/);
assert.match(source, /function cancelBatchImport\(\)[\s\S]*?batchWorkbook = null[\s\S]*?batchSettings\.hidden = true[\s\S]*?shipmentFileDrop\.hidden = false/);
assert.match(html, /id="batchCustomerSelect" required/);
assert.match(source, /<option value="">\/<\/option>/);
assert.match(source, /function updateMappingAttention\(select\)[\s\S]*?\['quantity', 'total_quantity', 'warehouse_location', 'delivery_instructions', 'notes'\][\s\S]*?classList\.toggle\('is-unmapped'/);
assert.match(source, /mapping-match-note">Fuzzy match/);
assert.match(source, /batchFuzzyMappings\.delete\(select\.dataset\.mapField\)[\s\S]*?mapping-match-note/);
assert.match(operationsCss, /\.mapping-match-note \{[\s\S]*?font-size: inherit;[\s\S]*?font-style: italic;[\s\S]*?font-weight: 500;/);
assert.match(html, /<th>Tracking Number<\/th><th>Quantity<\/th>/);
assert.match(operationsCss, /#batchCustomerSelect:invalid,[\s\S]*?select\.is-unmapped[\s\S]*?background: #fff7f6/);
assert.match(source, /message_sent: 'Message Sent'/);
assert.match(html, /option value="message_sent">Message Sent/);
assert.match(source, /pending: \['prepare_sms', 'ti-mail-forward', 'Prepare SMS'\]/);
assert.match(source, /out_for_delivery: \['complete_delivery', 'ti-map-check'/);
assert.match(source, /\['start_delivery', 'ti-map-share', 'Start delivery'\]/);
assert.match(source, /on_hold: \['reset_pending', 'ti-package-export', 'Return shipment to Pending'\]/);
assert.match(source, /pending_warehouse_booking: \['complete_dtw', 'ti-location-share'/);
assert.match(source, /function shipmentSmsWasPrepared\(shipment\)[\s\S]*?sms_prepared_at/);
assert.match(source, /rpc\('mark_shipment_sms_prepared'/);
assert.match(source, /SMS Prepared By System/);
assert.match(source, /function prepareSingleShipmentSms\(shipment, sms, openMessagingApp = false\)[\s\S]*?markShipmentSmsPrepared\(shipment\)/);
assert.match(source, /function saveDispatchStatus\(event\)[\s\S]*?transitionShipment\(shipment, \{ kind: 'status'/);
assert.doesNotMatch(source.match(/function saveDispatchStatus\(event\)[\s\S]*?\n  \}/)?.[0] || '', /prepareSingleShipmentSms|prepareShipmentSms/);
assert.match(operationsCss, /status-action\.message_sent/);
assert.doesNotMatch(operationsCss, /status-quick-action i\.is-mirrored/);
assert.match(messageSentSql, /shipments_current_status_check[\s\S]*?'message_sent'/);
assert.match(messageSentSql, /shipment_events_event_type_check[\s\S]*?'message_sent'/);
assert.match(messageSentSql, /create or replace function public\.mark_shipment_sms_prepared/);
assert.match(messageSentSql, /'sms_prepared_at', now\(\)/);
assert.match(source, /completeShipment\(id, 'warehouse_delivery'\)/);
assert.match(unifiedStatusSql, /'pending', 'message_sent', 'scheduled'/);
assert.match(unifiedStatusSql, /resolved_exception_condition_keys text\[\]/);
assert.doesNotMatch(unifiedStatusSql, /extensions\.digest/);
assert.match(source, /rpc\('archive_shipment'/);
assert.doesNotMatch(source, /rpc\('delete_shipment_permanently'/);
assert.doesNotMatch(source, /window\.prompt\(/);
assert.match(source, /function confirmRemoval\(/);
assert.match(source, /await confirmRemoval\(\)/);
assert.match(html, /Confirm to delete the selected shipments/);
assert.match(html, /Are you sure you want to delete the selected shipments\? This action cannot be undone\./);
assert.match(source, /historySelectedIds: new Set\(\)/);
assert.match(source, /event\.ctrlKey \|\| event\.metaKey/);
assert.match(source, /function beginSelectionDrag\(/);
assert.match(source, /function continueSelectionDrag\(/);
assert.match(source, /selectionDrag\.selecting \? selectionDrag\.selection\.add/);
assert.match(source, /addEventListener\('mouseover', continueSelectionDrag\)/);
assert.match(source, /state\.historySelectedIds\.clear\(\)/);
assert.match(source, /classList\.toggle\('has-selection', count > 0\)/);
assert.match(html, /class="workspace-default-actions"/);
assert.match(html, /id="bulkDeleteButton"[\s\S]*?id="showOnMapButton"[\s\S]*?<\/div>\s*<div class="workspace-default-actions">/);
assert.match(operationsCss, /workspace-action-group:not\(\.has-selection\) \.shipment-bulk-actions/);
assert.match(operationsCss, /\.status-column-header,[\s\S]*?\.status-cell \{[\s\S]*?width: 410px;[\s\S]*?min-width: 410px;[\s\S]*?max-width: 410px;/);
assert.match(operationsCss, /prefers-reduced-motion: reduce/);
assert.match(operationsCss, /\.shipment-table th,[\s\S]*?\.shipment-table td \{[\s\S]*?text-align: left/);
assert.match(operationsCss, /data-table-mode="bv"[\s\S]*?:nth-child\(5\)[\s\S]*?text-align: left/);
assert.match(operationsCss, /data-table-mode="bv"[\s\S]*?:nth-child\(2\)[\s\S]*?text-align: left/);
assert.match(operationsCss, /data-table-mode="bv"[\s\S]*?table-layout: fixed/);
assert.match(source, /rpc\('resume_completed_shipment'/);
assert.match(html, /id="selectAllHistory"/);
assert.match(html, /data-history-resume/);
assert.match(html, /data-history-delete/);
assert.match(source, /\.is\('cancelled_at', null\)/);
assert.doesNotMatch(archiveSql, /delete\s+from/i);
assert.match(archiveSql, /update public\.shipments/);
assert.doesNotMatch(resumeSql, /delete\s+from/i);
assert.match(resumeSql, /current_status = 'pending'/);
assert.match(resumeSql, /'completed',\s*'pending'/);
assert.match(totalQuantitySql, /add column if not exists total_quantity integer/);
assert.match(totalQuantitySql, /check \(total_quantity is null or total_quantity >= quantity\)/);
assert.doesNotMatch(totalQuantitySql, /\bupdate\s+public\.shipments\b/i);
assert.doesNotMatch(totalQuantitySql, /\bdelete\b/i);
assert.match(exceptionSql, /add column if not exists exception_reason text/);
assert.match(exceptionSql, /add column if not exists exception_resolution_reason text/);
assert.match(exceptionSql, /shipments_exception_reason_check/);
assert.match(exceptionSql, /create or replace function public\.refresh_shipment_exceptions\(\)/);
assert.match(exceptionSql, /Australia\/Melbourne/);
assert.match(exceptionSql, /upper\(btrim\(rate\.zone\)\) in \('V1', 'V2', 'V3', 'V4'\)/);
assert.match(exceptionSql, /Scheduled On date %s has passed without changing to Out Of Delivery/);
assert.match(exceptionSql, /An exception reason is required/);
assert.match(exceptionSql, /An exception resolution reason is required/);
assert.match(exceptionSql, /Exception shipments must be resolved from Shipment Details/);
assert.match(exceptionSql, /insert into public\.shipment_events/);
assert.doesNotMatch(exceptionSql, /\bdelete\b|\btruncate\b|\bdrop\b/i);
const postcodeSuburbValues = matchingPostcodeSuburbSql.match(/insert into private\.delivery_postcode_suburbs[\s\S]*?values([\s\S]*?)on conflict/)?.[1] || '';
assert.match(matchingPostcodeSuburbSql, /create table if not exists private\.delivery_postcode_suburbs/);
assert.equal((postcodeSuburbValues.match(/\('VIC',/g) || []).length, 402);
assert.match(postcodeSuburbValues, /\('VIC', '3000', 'MELBOURNE'\)/);
assert.match(postcodeSuburbValues, /\('VIC', '3149', 'MOUNT WAVERLEY'\)/);
assert.match(matchingPostcodeSuburbSql, /mapping\.postcode = btrim\(new\.postcode\)[\s\S]*?mapping\.suburb = upper\(btrim\(new\.suburb\)\)/);
assert.match(matchingPostcodeSuburbSql, /mapping\.postcode = btrim\(shipment\.postcode\)[\s\S]*?mapping\.suburb = upper\(btrim\(shipment\.suburb\)\)/);
assert.match(matchingPostcodeSuburbSql, /Postcode\/suburb pair is outside V1-V4 delivery areas/);
assert.doesNotMatch(matchingPostcodeSuburbSql, /\bdelete\b|\btruncate\b|\bdrop\b/i);

console.log('Status workflow checks passed.');
