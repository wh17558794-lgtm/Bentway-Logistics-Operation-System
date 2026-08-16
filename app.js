(function () {
  'use strict';

  const config = window.BENTWAY_SUPABASE_CONFIG || {};
  const {
    formatPersonName,
    formatAustralianMobile,
    normaliseAddressFields,
    formatLocality,
    formatSingleLineAddress,
    shipmentSmsDetails
  } = window.BENTWAY_SHIPMENT_FORMATTERS;
  const isConfigured =
    /^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(String(config.url || '').trim()) &&
    /^sb_publishable_[A-Za-z0-9._-]+$/.test(String(config.publishableKey || '').trim());

  const STATUS_LABELS = Object.freeze({
    pending: 'Pending',
    message_sent: 'Message Sent',
    scheduled: 'Scheduled On',
    on_hold: 'On Hold',
    pending_warehouse_booking: 'Pending Warehouse Booking',
    out_for_delivery: 'Out Of Delivery',
    completed: 'Completed',
    exception: 'Exception',
    cancelled: 'Cancelled'
  });
  const DEFAULT_CRANE_TRUCK_FEE = 810;

  const ROLE_LABELS = Object.freeze({
    admin: 'System Administrator',
    operations: 'Operations',
    warehouse: 'Warehouse',
    driver: 'Driver',
    viewer: 'Read Only'
  });

  const OUTBOUND_LABELS = Object.freeze({
    delivered: 'Delivered',
    picked_up: 'Picked up',
    warehouse_delivery: 'DTW',
    returned: 'Returned'
  });

  const IMPORT_FIELDS = Object.freeze([
    { key: 'tracking_number', label: 'Tracking Number', required: true, aliases: ['货物单号', '单号', '运单号', '物流单号', '扫描单号', '条码', 'tracking number', 'tracking no', 'tracking', 'waybill number', 'waybill no', 'barcode'] },
    { key: 'delivery_address', label: 'Delivery Address', required: true, aliases: ['派送地址', '收货地址', '收件地址', '地址', '详细地址', 'delivery address', 'recipient address', 'consignee address', 'address'] },
    { key: 'customer_reference', label: 'Customer Reference', aliases: ['客户参考号', '参考号', '客户单号', 'customer reference', 'customer ref', 'reference', 'reference no'] },
    { key: 'recipient_name', label: 'Name', aliases: ['收货人', '收件人', '联系人', '姓名', 'name', 'contact name', 'recipient name', 'recipient', 'consignee name', 'consignee'] },
    { key: 'recipient_phone', label: 'Contact Phone', aliases: ['联系电话', '收货电话', '收件人电话', '电话', '手机', '手机号', 'recipient phone', 'consignee phone', 'phone', 'mobile', 'tel'] },
    { key: 'container_number', label: 'Container Number', aliases: ['柜号', '集装箱号', '货柜号', 'container number', 'container no', 'container'] },
    { key: 'quantity', label: 'Quantity', aliases: ['数量', '件数', '到仓件数', '实到件数', 'quantity', 'qty', 'received quantity', 'actual quantity', 'pieces', 'piece count', 'item quantity'] },
    { key: 'total_quantity', label: 'Total Quantity', aliases: ['总件数', '总数量', '应到件数', 'total quantity', 'total qty', 'expected quantity'] },
    { key: 'weight_kg', label: 'Weight (kg)', aliases: ['重量', '重量kg', '实际重量', 'weight', 'weight kg', 'weight (kg)', 'gross weight'] },
    { key: 'volume_m3', label: 'Volume (m³)', aliases: ['体积', '立方', '方数', 'volume', 'volume m3', 'volume (m3)', 'cbm', 'cubic metre', 'cubic meter'] },
    { key: 'suburb', label: 'Suburb', aliases: ['suburb', '城市', '城区', '区', 'city', 'town'] },
    { key: 'state', label: 'State', aliases: ['州', '省州', 'state', 'province'] },
    { key: 'postcode', label: 'Postcode', aliases: ['邮编', '邮政编码', 'postcode', 'post code', 'zip', 'zip code'] },
    { key: 'warehouse_location', label: 'Storage Location', aliases: ['仓位', '库位', '仓库位置', 'warehouse location', 'location', 'bin location'] },
    { key: 'delivery_instructions', label: 'Delivery Instructions', aliases: ['派送要求', '送货要求', '派送说明', 'delivery instructions', 'instructions'] },
    { key: 'notes', label: 'Internal Notes', aliases: ['内部备注', '备注', '说明', 'notes', 'note', 'remark', 'comments'] }
  ]);

  const state = {
    client: null,
    session: null,
    profile: null,
    customers: [],
    shipments: [],
    selectedIds: new Set(),
    historySelectedIds: new Set(),
    activeView: 'pending',
    loading: false,
    batchWorkbook: null,
    batchFileName: '',
    batchRows: [],
    batchHeaders: [],
    batchHeaderIndex: 0,
    batchMapping: {},
    batchFuzzyMappings: new Set(),
    batchPreview: [],
    editingShipmentId: null,
    pendingTableMode: 'x',
    pendingSortAscending: false,
    historySortAscending: false,
    statusShipmentId: null,
    scheduledDateValue: ''
  };

  const $ = (selector) => document.querySelector(selector);
  const elements = {
    bootScreen: $('#bootScreen'),
    authScreen: $('#authScreen'),
    appShell: $('#appShell'),
    configAlert: $('#configAlert'),
    loginForm: $('#loginForm'),
    loginButton: $('#loginButton'),
    loginError: $('#loginError'),
    emailInput: $('#emailInput'),
    passwordInput: $('#passwordInput'),
    passwordToggle: $('#passwordToggle'),
    logoutButton: $('#logoutButton'),
    workspacePageLabel: $('#workspacePageLabel'),
    workspacePageSeparator: $('#workspacePageSeparator'),
    pendingShipmentTable: $('#pendingShipmentTable'),
    pendingTableHeadRow: $('#pendingTableHeadRow'),
    pendingTableBody: $('#pendingTableBody'),
    completedTableBody: $('#completedTableBody'),
    pendingEmpty: $('#pendingEmpty'),
    completedEmpty: $('#completedEmpty'),
    pendingSearch: $('#pendingSearch'),
    completedSearch: $('#completedSearch'),
    pendingStatusFilter: $('#pendingStatusFilter'),
    outboundFilter: $('#outboundFilter'),
    selectAllPending: $('#selectAllPending'),
    selectAllHistory: $('#selectAllHistory'),
    showOnMapButton: $('#showOnMapButton'),
    showOnMapIcon: $('#showOnMapIcon'),
    showOnMapLabel: $('#showOnMapLabel'),
    selectedCount: $('#selectedCount'),
    pendingBulkActions: $('#pendingBulkActions'),
    bulkPrepareSmsButton: $('#bulkPrepareSmsButton'),
    bulkDeleteButton: $('#bulkDeleteButton'),
    historyBulkActions: $('#historyBulkActions'),
    historyResumeButton: $('#historyResumeButton'),
    historyBulkDeleteButton: $('#historyBulkDeleteButton'),
    pendingSortToggle: $('#pendingSortToggle'),
    historySortToggle: $('#historySortToggle'),
    tableModeToggle: $('#tableModeToggle'),
    pendingNavCount: $('#pendingNavCount'),
    mapNavCount: $('#mapNavCount'),
    userName: $('#userName'),
    userRole: $('#userRole'),
    userAvatar: $('#userAvatar'),
    deliveryMapFrame: $('#deliveryMapFrame'),
    mapSelectionSummary: $('#mapSelectionSummary'),
    backToPendingButton: $('#backToPendingButton'),
    toast: $('#toast'),
    sidebar: $('#sidebar'),
    sidebarScrim: $('#sidebarScrim'),
    mobileMenu: $('#mobileMenu'),
    manualShipmentForm: $('#manualShipmentForm'),
    manualCustomerSelect: $('#manualCustomerSelect'),
    clearManualFormButton: $('#clearManualFormButton'),
    saveManualShipmentButton: $('#saveManualShipmentButton'),
    shipmentFileDrop: $('#shipmentFileDrop'),
    shipmentFileInput: $('#shipmentFileInput'),
    batchSettings: $('#batchSettings'),
    batchFileName: $('#batchFileName'),
    cancelBatchImportButton: $('#cancelBatchImportButton'),
    replaceBatchFileButton: $('#replaceBatchFileButton'),
    batchCustomerSelect: $('#batchCustomerSelect'),
    batchSheetSelect: $('#batchSheetSelect'),
    batchHeaderRowSelect: $('#batchHeaderRowSelect'),
    batchMappingGrid: $('#batchMappingGrid'),
    batchPreviewBody: $('#batchPreviewBody'),
    importSummary: $('#importSummary'),
    batchImportNote: $('#batchImportNote'),
    importShipmentsButton: $('#importShipmentsButton'),
    shipmentModal: $('#shipmentModal'),
    shipmentModalTitle: $('#shipmentModalTitle'),
    shipmentEditForm: $('#shipmentEditForm'),
    editShipmentId: $('#editShipmentId'),
    editCustomerSelect: $('#editCustomerSelect'),
    editStatusDateField: $('#editStatusDateField'),
    editExceptionReasonField: $('#editExceptionReasonField'),
    editExceptionResolutionReasonField: $('#editExceptionResolutionReasonField'),
    craneTruckFeeField: $('#craneTruckFeeField'),
    billingFormula: $('#billingFormula'),
    shipmentStatusNote: $('#shipmentStatusNote'),
    closeShipmentModalButton: $('#closeShipmentModalButton'),
    dismissShipmentModalButton: $('#dismissShipmentModalButton'),
    saveShipmentChangesButton: $('#saveShipmentChangesButton'),
    prepareShipmentSmsButton: $('#prepareShipmentSmsButton'),
    deleteShipmentButton: $('#deleteShipmentButton'),
    statusDrawer: $('#statusDrawer'),
    statusDrawerTitle: $('#statusDrawerTitle'),
    statusDrawerTracking: $('#statusDrawerTracking'),
    statusUpdateForm: $('#statusUpdateForm'),
    closeStatusDrawerButton: $('#closeStatusDrawerButton'),
    cancelStatusUpdateButton: $('#cancelStatusUpdateButton'),
    saveStatusUpdateButton: $('#saveStatusUpdateButton'),
    scheduledDateSection: $('#scheduledDateSection'),
    scheduledDateText: $('#scheduledDateText'),
    scheduledDatePicker: $('#scheduledDatePicker'),
    scheduledDateError: $('#scheduledDateError'),
    scheduledDateLabel: $('#scheduledDateLabel'),
    scheduledDateHint: $('#scheduledDateHint'),
    openScheduledCalendarButton: $('#openScheduledCalendarButton'),
    confirmationDialog: $('#confirmationDialog'),
    confirmationTitle: $('#confirmationTitle'),
    confirmationMessage: $('#confirmationMessage'),
    closeConfirmationButton: $('#closeConfirmationButton'),
    cancelConfirmationButton: $('#cancelConfirmationButton'),
    confirmActionButton: $('#confirmActionButton')
  };

  let toastTimer = null;
  let scheduleAlertTimer = null;
  let confirmationResolve = null;
  let confirmationReturnFocus = null;
  let selectionDrag = null;
  let shipmentModalPointerDownOutside = false;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatDateTime(value) {
    if (!value) return 'Not set';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not set';
    return new Intl.DateTimeFormat('en-AU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function formatDateOnly(value) {
    if (!value) return 'Not set';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not set';
    return new Intl.DateTimeFormat('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(date);
  }

  const MELBOURNE_TIME_ZONE = 'Australia/Melbourne';
  const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

  function melbourneCalendarDay(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
      timeZone: MELBOURNE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const serial = Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MILLISECONDS_PER_DAY);
    return { date, serial };
  }

  function scheduledWeekdayLabel(value, now = new Date()) {
    const scheduledDay = melbourneCalendarDay(value);
    const currentDay = melbourneCalendarDay(now);
    if (!scheduledDay || !currentDay) return '';

    const currentWeekday = new Date(currentDay.serial * MILLISECONDS_PER_DAY).getUTCDay();
    const currentWeekStart = currentDay.serial - ((currentWeekday + 6) % 7);
    const weekday = new Intl.DateTimeFormat('en-AU', {
      timeZone: MELBOURNE_TIME_ZONE,
      weekday: 'long'
    }).format(scheduledDay.date);

    if (scheduledDay.serial >= currentWeekStart && scheduledDay.serial < currentWeekStart + 7) return weekday;
    if (scheduledDay.serial >= currentWeekStart + 7 && scheduledDay.serial < currentWeekStart + 14) return `Next ${weekday}`;
    return '';
  }

  function melbourneHour(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const hour = new Intl.DateTimeFormat('en-AU', {
      timeZone: MELBOURNE_TIME_ZONE,
      hour: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).find((part) => part.type === 'hour');
    return hour ? Number(hour.value) : null;
  }

  function todayInMelbourne(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
      timeZone: MELBOURNE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    return new Date(parts.year, parts.month - 1, parts.day);
  }

  function scheduledNeedsAttention(shipment, now = new Date()) {
    if (shipment?.current_status !== 'scheduled' || !shipment.scheduled_for) return false;
    const scheduledDay = melbourneCalendarDay(shipment.scheduled_for);
    const currentDay = melbourneCalendarDay(now);
    if (!scheduledDay || !currentDay) return false;
    if (scheduledDay.serial < currentDay.serial) return true;
    return scheduledDay.serial === currentDay.serial && melbourneHour(now) >= 12;
  }

  function optionalNonNegativeNumber(value) {
    const text = cleanCell(value).replaceAll(',', '');
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function calculatedFuelLevy(shipment) {
    if (shipment?.fuel_levy_override !== null && shipment?.fuel_levy_override !== undefined) {
      return Number(shipment.fuel_levy_override);
    }
    const fuelLevy = Number(shipment?.fuel_levy);
    return Number.isFinite(fuelLevy) ? fuelLevy : null;
  }

  function displayedTotalCharge(shipment) {
    if (shipment?.total_charge_override !== null && shipment?.total_charge_override !== undefined) {
      return Number(shipment.total_charge_override);
    }
    const total = Number(shipment?.total_charge);
    return Number.isFinite(total) ? total : null;
  }

  function hasInvalidOptionalNumber(value) {
    return Boolean(cleanCell(value)) && optionalNonNegativeNumber(value) === null;
  }

  function formatMeasurement(value, unit, maximumFractionDigits) {
    const number = optionalNonNegativeNumber(value);
    if (number === null) return '/';
    return `${new Intl.NumberFormat('en-AU', {
      minimumFractionDigits: 0,
      maximumFractionDigits
    }).format(number)} ${unit}`;
  }

  function formatCurrency(value, missingLabel = 'Not available') {
    const number = optionalNonNegativeNumber(value);
    if (number === null) return missingLabel;
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: 'AUD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(number);
  }

  function datePickerValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseFlexibleDate(value) {
    const text = cleanCell(value);
    if (!text) return null;
    const currentYear = new Date().getFullYear();
    let year;
    let month;
    let day;
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      match = text.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?$/);
      if (match) {
        month = Number(match[1]);
        day = Number(match[2]);
        year = match[3] ? Number(match[3]) : currentYear;
        if (year < 100) year += 2000;
      } else {
        const withYear = /\b\d{4}\b/.test(text) ? text : `${text} ${currentYear}`;
        const parsed = new Date(withYear);
        return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
      }
    }
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
    return parsed;
  }

  function isToday(value, now = new Date()) {
    const date = melbourneCalendarDay(value);
    const today = melbourneCalendarDay(now);
    return Boolean(date && today && date.serial === today.serial);
  }

  function showToast(message, type = '') {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast ${type}`.trim();
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => {
      elements.toast.hidden = true;
    }, 4200);
  }

  function closeConfirmation(confirmed = false) {
    elements.confirmationDialog.hidden = true;
    if (elements.shipmentModal.hidden && elements.statusDrawer.hidden) document.body.style.overflow = '';
    const resolve = confirmationResolve;
    confirmationResolve = null;
    confirmationReturnFocus?.focus();
    confirmationReturnFocus = null;
    resolve?.(confirmed);
  }

  function showConfirmation({ title, message, actionLabel, showCancel = true, danger = true, returnFocus = document.activeElement }) {
    elements.confirmationTitle.textContent = title;
    elements.confirmationMessage.textContent = message;
    elements.cancelConfirmationButton.hidden = !showCancel;
    elements.confirmActionButton.querySelector('span').textContent = actionLabel;
    elements.confirmActionButton.classList.toggle('confirmation-danger-button', danger);
    elements.confirmActionButton.classList.toggle('primary-button', !danger);
    confirmationReturnFocus = returnFocus;
    elements.confirmationDialog.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => (showCancel ? elements.cancelConfirmationButton : elements.confirmActionButton).focus());
    return new Promise((resolve) => { confirmationResolve = resolve; });
  }

  function confirmRemoval() {
    return showConfirmation({
      title: 'Confirm to delete the selected shipments',
      message: 'Are you sure you want to delete the selected shipments? This action cannot be undone.',
      actionLabel: 'Delete'
    });
  }

  function showLoginError(message = '') {
    elements.loginError.textContent = message;
    elements.loginError.hidden = !message;
  }

  function setLoginBusy(busy) {
    elements.loginButton.disabled = busy || !isConfigured;
    elements.emailInput.disabled = busy;
    elements.passwordInput.disabled = busy;
    elements.loginForm.toggleAttribute('aria-busy', busy);
    elements.loginButton.querySelector('span').textContent = busy ? 'Signing in...' : 'Sign In';
  }

  function showAuthScreen() {
    elements.bootScreen.hidden = true;
    elements.appShell.hidden = true;
    elements.authScreen.hidden = false;
    elements.configAlert.hidden = isConfigured;
    setLoginBusy(false);
  }

  function showAppScreen() {
    elements.bootScreen.hidden = true;
    elements.authScreen.hidden = true;
    elements.appShell.hidden = false;
  }

  function normaliseSearch(value) {
    return String(value || '').trim().toLocaleLowerCase();
  }

  function cleanCell(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normaliseQuantity(value) {
    const quantity = Number.parseInt(cleanCell(value), 10);
    return Number.isInteger(quantity) && quantity >= 1 ? quantity : 1;
  }

  function totalQuantityFor(record) {
    const quantity = normaliseQuantity(record?.quantity);
    return cleanCell(record?.total_quantity) ? normaliseQuantity(record.total_quantity) : quantity;
  }

  function formatShipmentQuantity(shipment) {
    const quantity = normaliseQuantity(shipment?.quantity);
    const totalQuantity = totalQuantityFor(shipment);
    return quantity === totalQuantity ? String(quantity) : `${quantity}/${totalQuantity}`;
  }

  function normaliseHeader(value) {
    return cleanCell(value).toLocaleLowerCase().replace(/[\s_\-./\\()（）【】\[\]:：]+/g, '');
  }

  function canCreateShipments() {
    return ['admin', 'operations', 'warehouse'].includes(state.profile?.role);
  }

  function canManageShipments() {
    return ['admin', 'operations', 'warehouse'].includes(state.profile?.role);
  }

  function isAdministrator() {
    return state.profile?.role === 'admin';
  }

  function localDateTimeValue(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function resetManualForm() {
    elements.manualShipmentForm.reset();
    elements.manualShipmentForm.elements.quantity.value = '1';
    elements.manualShipmentForm.elements.state.value = 'VIC';
    elements.manualShipmentForm.elements.inbound_at.value = localDateTimeValue();
  }

  function customerOptionLabel(customer) {
    return customer.customer_code ? `${customer.name} (${customer.customer_code})` : customer.name;
  }

  function renderCustomerOptions() {
    const activeCustomers = state.customers.filter((customer) => customer.is_active);
    const emptyLabel = activeCustomers.length ? 'Select an Agent Customer' : 'No active Agent Customers. Add an Agent Customer first.';
    const activeOptions = `<option value="">${escapeHtml(emptyLabel)}</option>` + activeCustomers
      .map((customer) => `<option value="${customer.id}">${escapeHtml(customerOptionLabel(customer))}</option>`)
      .join('');
    const editOptions = '<option value="">Select an Agent Customer</option>' + state.customers
      .map((customer) => `<option value="${customer.id}">${escapeHtml(customerOptionLabel(customer))}${customer.is_active ? '' : ' (Inactive)'}</option>`)
      .join('');
    const manualValue = elements.manualCustomerSelect.value;
    const batchValue = elements.batchCustomerSelect.value;
    const editValue = elements.editCustomerSelect.value;
    elements.manualCustomerSelect.innerHTML = activeOptions;
    elements.batchCustomerSelect.innerHTML = activeOptions;
    elements.editCustomerSelect.innerHTML = editOptions;
    if (activeCustomers.some((item) => item.id === manualValue)) elements.manualCustomerSelect.value = manualValue;
    if (activeCustomers.some((item) => item.id === batchValue)) elements.batchCustomerSelect.value = batchValue;
    if (state.customers.some((item) => item.id === editValue)) elements.editCustomerSelect.value = editValue;
    elements.manualCustomerSelect.disabled = activeCustomers.length === 0;
    elements.batchCustomerSelect.disabled = activeCustomers.length === 0;
    elements.editCustomerSelect.disabled = state.customers.length === 0;
  }

  function readManualRecord() {
    const formData = new FormData(elements.manualShipmentForm);
    return Object.fromEntries([...formData.entries()].map(([key, value]) => [key, cleanCell(value)]));
  }

  function buildShipmentPayload(record, source, originalRow = null) {
    const customer = state.customers.find((item) => item.id === cleanCell(record.customer_id));
    const address = normaliseAddressFields(record);
    const quantity = normaliseQuantity(record.quantity);
    const payload = {
      tracking_number: cleanCell(record.tracking_number),
      delivery_address: address.delivery_address,
      customer_id: customer?.id || null,
      customer_name: customer?.name || '',
      quantity,
      total_quantity: totalQuantityFor({ ...record, quantity }),
      current_status: 'pending',
      created_by: state.session?.user?.id || null,
      source_data: {
        source,
        captured_at: new Date().toISOString(),
        container_number: cleanCell(record.container_number),
        recipient_phone: formatAustralianMobile(record.recipient_phone)
      }
    };

    const weightKg = optionalNonNegativeNumber(record.weight_kg);
    const volumeM3 = optionalNonNegativeNumber(record.volume_m3);
    if (weightKg !== null) payload.weight_kg = weightKg;
    if (volumeM3 !== null) payload.volume_m3 = volumeM3;

    ['customer_reference', 'customer_name', 'warehouse_location', 'delivery_instructions', 'notes'].forEach((key) => {
      const value = cleanCell(record[key]);
      if (value) payload[key] = value;
    });
    const recipientName = formatPersonName(record.recipient_name);
    if (recipientName) payload.recipient_name = recipientName;
    ['suburb', 'state', 'postcode'].forEach((key) => {
      if (address[key]) payload[key] = address[key];
    });

    if (record.inbound_at) {
      const inbound = new Date(record.inbound_at);
      if (!Number.isNaN(inbound.getTime())) payload.inbound_at = inbound.toISOString();
    }
    if (originalRow) payload.source_data.original_row = originalRow;
    return payload;
  }

  async function saveManualShipment(event) {
    event.preventDefault();
    if (!canCreateShipments()) {
      showToast('Your account does not have permission to add shipments.', 'error');
      return;
    }

    const record = readManualRecord();
    if (!record.customer_id || !record.tracking_number || !record.delivery_address) {
      showToast('Select an Agent Customer and enter the tracking number and delivery address.', 'error');
      return;
    }
    if (hasInvalidOptionalNumber(record.weight_kg) || hasInvalidOptionalNumber(record.volume_m3)) {
      showToast('Weight and volume must be zero or a positive number.', 'error');
      return;
    }
    if (totalQuantityFor(record) < normaliseQuantity(record.quantity)) {
      showToast('Total Quantity cannot be less than the received Quantity.', 'error');
      return;
    }
    if (state.shipments.some((item) => normaliseSearch(item.tracking_number) === normaliseSearch(record.tracking_number))) {
      showToast(`Tracking number ${record.tracking_number} already exists. No duplicate was saved.`, 'error');
      return;
    }

    elements.saveManualShipmentButton.disabled = true;
    elements.saveManualShipmentButton.textContent = 'Saving...';
    const { error } = await state.client.from('shipments').insert(buildShipmentPayload(record, 'manual_entry'));
    elements.saveManualShipmentButton.disabled = false;
    elements.saveManualShipmentButton.textContent = 'Save to Pending';

    if (error) {
      const message = error.code === '23505' ? `Tracking number ${record.tracking_number} already exists.` : error.message;
      showToast(`Save failed: ${message}`, 'error');
      return;
    }

    showToast(`${record.tracking_number} was added to Pending Shipments.`, 'success');
    resetManualForm();
    await loadShipments({ quiet: true });
    setActiveView('pending');
  }

  function detectHeaderIndex(rows) {
    let bestIndex = 0;
    let bestScore = -1;
    rows.slice(0, 30).forEach((row, index) => {
      const cells = Array.isArray(row) ? row.map(normaliseHeader).filter(Boolean) : [];
      const aliasHits = IMPORT_FIELDS.filter((field) => field.aliases.some((alias) => cells.includes(normaliseHeader(alias)))).length;
      const score = aliasHits * 100 + Math.min(cells.length, 40);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function uniqueHeaders(row) {
    const counts = new Map();
    return row.map((value, index) => {
      const base = cleanCell(value) || `Unnamed Column ${index + 1}`;
      const count = (counts.get(base) || 0) + 1;
      counts.set(base, count);
      return count === 1 ? base : `${base} (${count})`;
    });
  }

  function findBestHeader(field, usedIndexes, matchLevel = 'partial') {
    const normalisedAliases = field.aliases.map(normaliseHeader);
    const headerValues = state.batchHeaders.map(normaliseHeader);
    if (matchLevel === 'label') {
      const labels = [field.label, field.label.replace(/\s*\([^)]*\)\s*$/, '')].map(normaliseHeader);
      return headerValues.findIndex((header, candidateIndex) => !usedIndexes.has(candidateIndex) && labels.includes(header));
    }
    let index = headerValues.findIndex((header, candidateIndex) => !usedIndexes.has(candidateIndex) && normalisedAliases.includes(header));
    if (index >= 0 || matchLevel === 'alias') return index;
    index = headerValues.findIndex((header, candidateIndex) => {
      if (!header || usedIndexes.has(candidateIndex)) return false;
      return normalisedAliases.some((alias) => alias.length >= 3 && (header.includes(alias) || alias.includes(header)));
    });
    return index;
  }

  function autoMapHeaders() {
    const usedIndexes = new Set();
    state.batchMapping = Object.fromEntries(IMPORT_FIELDS.map((field) => [field.key, '']));
    state.batchFuzzyMappings.clear();
    IMPORT_FIELDS.forEach((field) => {
      const index = findBestHeader(field, usedIndexes, 'label');
      if (index >= 0) state.batchMapping[field.key] = String(index);
      if (index >= 0) usedIndexes.add(index);
    });
    IMPORT_FIELDS.forEach((field) => {
      if (state.batchMapping[field.key]) return;
      const index = findBestHeader(field, usedIndexes, 'alias');
      if (index >= 0) state.batchMapping[field.key] = String(index);
      if (index >= 0) state.batchFuzzyMappings.add(field.key);
      if (index >= 0) usedIndexes.add(index);
    });
    IMPORT_FIELDS.forEach((field) => {
      if (state.batchMapping[field.key]) return;
      const index = findBestHeader(field, usedIndexes);
      if (index >= 0) state.batchMapping[field.key] = String(index);
      if (index >= 0) state.batchFuzzyMappings.add(field.key);
      if (index >= 0) usedIndexes.add(index);
    });
  }

  function renderMappingGrid() {
    const options = state.batchHeaders.map((header, index) => `<option value="${index}">${escapeHtml(header)}</option>`).join('');
    elements.batchMappingGrid.innerHTML = IMPORT_FIELDS.map((field) => {
      const fuzzyNote = state.batchFuzzyMappings.has(field.key) ? '<small class="mapping-match-note">Fuzzy match</small>' : '';
      return `<label class="form-field">
        <span>${escapeHtml(field.label)}${field.required ? ' <small>*</small>' : ''}${fuzzyNote}</span>
        <select data-map-field="${field.key}">
          <option value="">/</option>
          ${options}
        </select>
      </label>`;
    }).join('');

    elements.batchMappingGrid.querySelectorAll('[data-map-field]').forEach((select) => {
      select.value = state.batchMapping[select.dataset.mapField] ?? '';
      updateMappingAttention(select);
    });
  }

  function updateMappingAttention(select) {
    const optionalWithoutWarning = ['quantity', 'total_quantity', 'warehouse_location', 'delivery_instructions', 'notes'];
    select.classList.toggle('is-unmapped', !select.value && !optionalWithoutWarning.includes(select.dataset.mapField));
  }

  function rowToOriginalObject(row) {
    const original = {};
    state.batchHeaders.forEach((header, index) => {
      const value = cleanCell(row[index]);
      if (value) original[header] = value;
    });
    return original;
  }

  function rowToRecord(row) {
    const record = {};
    IMPORT_FIELDS.forEach((field) => {
      const index = Number.parseInt(state.batchMapping[field.key], 10);
      record[field.key] = Number.isInteger(index) ? cleanCell(row[index]) : '';
    });
    return {
      ...record,
      ...normaliseAddressFields(record),
      recipient_name: formatPersonName(record.recipient_name),
      recipient_phone: formatAustralianMobile(record.recipient_phone)
    };
  }

  function isBatchShipmentRow(record) {
    const values = IMPORT_FIELDS.map((field) => cleanCell(record[field.key]));
    const repeatedHeaders = IMPORT_FIELDS.filter((field) => cleanCell(record[field.key]) && field.aliases.some((alias) => normaliseHeader(alias) === normaliseHeader(record[field.key]))).length;
    if (repeatedHeaders >= 2) return false;
    if (values.some((value) => ['total', 'subtotal', 'grandtotal', '合计', '总计', '小计'].includes(normaliseHeader(value)))) return false;
    if (cleanCell(record.tracking_number)) return true;
    if (cleanCell(record.delivery_address)) return true;
    const supportingFields = ['customer_reference', 'recipient_name', 'recipient_phone', 'container_number', 'suburb', 'postcode'];
    return supportingFields.filter((field) => cleanCell(record[field])).length >= 2;
  }

  function trackingNumberBase(value) {
    return cleanCell(value).replace(/-\d+$/, '');
  }

  function batchShipmentGroupKey(record) {
    return [
      trackingNumberBase(record.tracking_number),
      record.customer_reference,
      record.recipient_name,
      record.delivery_address,
      record.recipient_phone || record.source_data?.recipient_phone
    ].map(normaliseSearch).join('\u001f');
  }

  function fillSparseBatchItems(items) {
    const identityFields = ['customer_reference', 'recipient_name', 'delivery_address', 'recipient_phone'];
    const byTrackingBase = new Map();
    items.forEach((item) => {
      const base = normaliseSearch(trackingNumberBase(item.record.tracking_number));
      if (!base) return;
      if (!byTrackingBase.has(base)) byTrackingBase.set(base, []);
      byTrackingBase.get(base).push(item);
    });

    const templatesByBase = new Map();
    byTrackingBase.forEach((group, base) => {
      const maximumScore = Math.max(...group.map((item) => identityFields.filter((field) => cleanCell(item.record[field])).length));
      if (!maximumScore) return;
      const uniqueTemplates = new Map();
      group.filter((item) => identityFields.filter((field) => cleanCell(item.record[field])).length === maximumScore).forEach((item) => {
        const identity = identityFields.map((field) => normaliseSearch(item.record[field])).join('\u001f');
        if (!uniqueTemplates.has(identity)) uniqueTemplates.set(identity, item.record);
      });
      templatesByBase.set(base, [...uniqueTemplates.values()]);
    });

    return items.map((item) => {
      const base = normaliseSearch(trackingNumberBase(item.record.tracking_number));
      const compatible = (templatesByBase.get(base) || []).filter((template) => identityFields.every((field) => {
        const current = normaliseSearch(item.record[field]);
        const candidate = normaliseSearch(template[field]);
        return !current || !candidate || current === candidate;
      }));
      if (compatible.length !== 1) return item;
      const record = { ...item.record };
      Object.entries(compatible[0]).forEach(([key, value]) => {
        if (!['tracking_number', 'quantity', 'weight_kg', 'volume_m3'].includes(key) && !cleanCell(record[key]) && cleanCell(value)) record[key] = value;
      });
      return { ...item, record };
    });
  }

  function sumBatchMeasurement(currentValue, nextValue) {
    if (hasInvalidOptionalNumber(currentValue) || hasInvalidOptionalNumber(nextValue)) return 'invalid';
    const current = optionalNonNegativeNumber(currentValue);
    const next = optionalNonNegativeNumber(nextValue);
    if (current === null && next === null) return '';
    return (current ?? 0) + (next ?? 0);
  }

  function groupBatchItems(items) {
    const groups = new Map();
    items.forEach((item) => {
      const tracking = cleanCell(item.record.tracking_number);
      const key = tracking ? batchShipmentGroupKey(item.record) : `missing:${item.rowNumber}`;
      const existing = groups.get(key);
      if (existing) {
        existing.rowNumbers.push(item.rowNumber);
        existing.originalRows.push(item.originalRow);
        existing.record.quantity = existing.rowNumbers.length;
        if (!cleanCell(existing.record.total_quantity) && cleanCell(item.record.total_quantity)) existing.record.total_quantity = item.record.total_quantity;
        existing.record.weight_kg = sumBatchMeasurement(existing.record.weight_kg, item.record.weight_kg);
        existing.record.volume_m3 = sumBatchMeasurement(existing.record.volume_m3, item.record.volume_m3);
        return;
      }
      groups.set(key, {
        ...item,
        record: { ...item.record, quantity: normaliseQuantity(item.record.quantity) },
        rowNumbers: [item.rowNumber],
        originalRows: [item.originalRow]
      });
    });
    return [...groups.values()];
  }

  function refreshBatchPreview() {
    if (!state.batchRows.length || !state.batchHeaders.length) return;
    const existing = new Set(state.shipments.map(batchShipmentGroupKey));
    const existingTracking = new Set(state.shipments.map((item) => normaliseSearch(item.tracking_number)));
    const parsedRows = [];
    const selectedCustomer = state.customers.find((item) => item.id === elements.batchCustomerSelect.value);

    state.batchRows.slice(state.batchHeaderIndex + 1).forEach((row, sourceIndex) => {
      if (!Array.isArray(row) || !row.some((value) => cleanCell(value))) return;
      const record = rowToRecord(row);
      if (!isBatchShipmentRow(record)) return;
      record.customer_id = selectedCustomer?.id || '';
      record.customer_name = selectedCustomer?.name || '';
      parsedRows.push({
        record,
        originalRow: rowToOriginalObject(row),
        rowNumber: state.batchHeaderIndex + sourceIndex + 2
      });
    });

    const groupedItems = groupBatchItems(fillSparseBatchItems(parsedRows));
    const exactTrackingCounts = groupedItems.reduce((counts, item) => {
      const key = normaliseSearch(item.record.tracking_number);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
      return counts;
    }, new Map());
    const preview = groupedItems.map((item) => {
      const exactTracking = normaliseSearch(item.record.tracking_number);
      let status = 'valid';
      let statusLabel = 'Ready to import';

      if (!item.record.tracking_number || !item.record.delivery_address) {
        status = 'error';
        statusLabel = !item.record.tracking_number ? 'Missing tracking number' : 'Missing address';
      } else if (hasInvalidOptionalNumber(item.record.weight_kg) || hasInvalidOptionalNumber(item.record.volume_m3)) {
        status = 'error';
        statusLabel = 'Invalid weight or volume';
      } else if (totalQuantityFor(item.record) < normaliseQuantity(item.record.quantity)) {
        status = 'error';
        statusLabel = 'Total Quantity is below received Quantity';
      } else if ((exactTrackingCounts.get(exactTracking) || 0) > 1) {
        status = 'error';
        statusLabel = 'Conflicting shipment details';
      } else if (existing.has(batchShipmentGroupKey(item.record)) || existingTracking.has(exactTracking)) {
        status = 'warning';
        statusLabel = 'Already in system';
      }
      return { ...item, status, statusLabel };
    });

    state.batchPreview = preview;
    const valid = preview.filter((item) => item.status === 'valid').length;
    const warnings = preview.filter((item) => item.status === 'warning').length;
    const errors = preview.filter((item) => item.status === 'error').length;
    elements.importSummary.innerHTML = `
      <span class="summary-pill">Rows read: ${parsedRows.length}</span>
      <span class="summary-pill">Shipments: ${preview.length}</span>
      <span class="summary-pill valid">Valid: ${valid}</span>
      <span class="summary-pill warning">Duplicates: ${warnings}</span>
      <span class="summary-pill error">Incomplete: ${errors}</span>`;

    elements.batchPreviewBody.innerHTML = preview.slice(0, 100).map((item) => `
      <tr>
        <td><span class="preview-status ${item.status}" title="Excel row${item.rowNumbers.length > 1 ? 's' : ''} ${item.rowNumbers.join(', ')}">${item.statusLabel}</span></td>
        <td class="tracking-cell"><strong>${escapeHtml(item.record.tracking_number || '/')}</strong><small>Row${item.rowNumbers.length > 1 ? 's' : ''} ${item.rowNumbers.join(', ')}</small></td>
        <td class="quantity-cell"><strong>${escapeHtml(formatShipmentQuantity(item.record))}</strong></td>
        <td class="person-cell"><strong>${escapeHtml(item.record.customer_name || '/')}</strong><small>${escapeHtml(item.record.recipient_name || '/')}</small></td>
        <td class="address-cell">${escapeHtml(item.record.delivery_address || '/')}<small>${escapeHtml([item.record.suburb, item.record.state, item.record.postcode].filter(Boolean).join(' '))}</small></td>
        <td>${escapeHtml(item.record.customer_reference || '/')}</td>
      </tr>`).join('');

    const requiredMapped = IMPORT_FIELDS.filter((field) => field.required).every((field) => state.batchMapping[field.key] !== '');
    elements.importShipmentsButton.disabled = !selectedCustomer || !requiredMapped || valid === 0;
    elements.batchImportNote.textContent = preview.length > 100
      ? `Showing the first 100 rows. All ${preview.length} rows will be processed during import.`
      : selectedCustomer
        ? `All valid shipments in this import will be assigned to Agent Customer: ${selectedCustomer.name}.`
        : 'Select the Agent Customer for this import first.';
  }

  function prepareBatchSheet() {
    const sheetName = elements.batchSheetSelect.value;
    const sheet = state.batchWorkbook?.Sheets?.[sheetName];
    if (!sheet) return;
    state.batchRows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true });
    state.batchHeaderIndex = detectHeaderIndex(state.batchRows);

    const maximum = Math.min(state.batchRows.length, 30);
    elements.batchHeaderRowSelect.innerHTML = Array.from({ length: maximum }, (_, index) => {
      const sample = (state.batchRows[index] || []).map(cleanCell).filter(Boolean).slice(0, 4).join(' | ');
      return `<option value="${index}">Row ${index + 1}${sample ? `: ${escapeHtml(sample)}` : ''}</option>`;
    }).join('');
    elements.batchHeaderRowSelect.value = String(state.batchHeaderIndex);
    applyBatchHeaderRow();
  }

  function applyBatchHeaderRow() {
    state.batchHeaderIndex = Number.parseInt(elements.batchHeaderRowSelect.value, 10) || 0;
    state.batchHeaders = uniqueHeaders(state.batchRows[state.batchHeaderIndex] || []);
    autoMapHeaders();
    renderMappingGrid();
    refreshBatchPreview();
  }

  async function openBatchFile(file) {
    if (!file) return;
    if (!window.XLSX) {
      showToast('The Excel reader did not load. Check your connection and refresh the page.', 'error');
      return;
    }
    try {
      const data = await file.arrayBuffer();
      state.batchWorkbook = window.XLSX.read(data, { type: 'array', cellDates: true });
      state.batchFileName = file.name;
      elements.batchFileName.textContent = file.name;
      elements.batchSheetSelect.innerHTML = state.batchWorkbook.SheetNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
      elements.shipmentFileDrop.hidden = true;
      elements.batchSettings.hidden = false;
      prepareBatchSheet();
    } catch (error) {
      showToast(`Unable to read file: ${error.message}`, 'error');
    }
  }

  function cancelBatchImport() {
    state.batchWorkbook = null;
    state.batchFileName = '';
    state.batchRows = [];
    state.batchHeaders = [];
    state.batchHeaderIndex = 0;
    state.batchMapping = {};
    state.batchFuzzyMappings.clear();
    state.batchPreview = [];
    elements.shipmentFileInput.value = '';
    elements.batchFileName.textContent = 'No file selected';
    elements.batchSheetSelect.innerHTML = '';
    elements.batchHeaderRowSelect.innerHTML = '';
    elements.batchMappingGrid.innerHTML = '';
    elements.batchPreviewBody.innerHTML = '';
    elements.importSummary.innerHTML = '';
    elements.batchImportNote.textContent = 'Review the preview before importing.';
    elements.importShipmentsButton.textContent = 'Import Shipments';
    elements.importShipmentsButton.disabled = true;
    elements.batchSettings.hidden = true;
    elements.shipmentFileDrop.hidden = false;
  }

  async function importBatchShipments() {
    if (!canCreateShipments()) {
      showToast('Your account does not have permission to add shipments.', 'error');
      return;
    }
    const selectedCustomer = state.customers.find((item) => item.id === elements.batchCustomerSelect.value);
    if (!selectedCustomer) {
      showToast('Select the Agent Customer for this import first.', 'error');
      return;
    }
    const validRows = state.batchPreview.filter((item) => item.status === 'valid');
    if (!validRows.length) return;
    if (!window.confirm(`Import ${validRows.length} shipments into Pending Shipments?`)) return;

    elements.importShipmentsButton.disabled = true;
    elements.importShipmentsButton.textContent = 'Importing...';
    let imported = 0;
    let importError = null;
    const payloads = validRows.map((item) => buildShipmentPayload({
      ...item.record,
      customer_id: selectedCustomer.id
    }, 'spreadsheet_import', item.originalRows.length === 1 ? item.originalRows[0] : item.originalRows));

    for (let index = 0; index < payloads.length; index += 100) {
      const chunk = payloads.slice(index, index + 100);
      const { error } = await state.client.from('shipments').insert(chunk);
      if (error) {
        importError = error;
        break;
      }
      imported += chunk.length;
    }

    elements.importShipmentsButton.disabled = false;
    elements.importShipmentsButton.textContent = 'Import Shipments';
    await loadShipments({ quiet: true });

    if (importError) {
      showToast(`${imported} shipments were imported before an error occurred: ${importError.message}`, 'error');
      refreshBatchPreview();
      return;
    }

    showToast(`${imported} shipments imported successfully.`, 'success');
    refreshBatchPreview();
    setActiveView('pending');
  }

  function shipmentMatches(shipment, search) {
    if (!search) return true;
    return [
      shipment.tracking_number,
      shipment.customer_reference,
      shipmentContainerNumber(shipment),
      shipment.customer_name,
      shipment.recipient_name,
      shipmentRecipientPhone(shipment),
      shipment.delivery_address,
      shipment.suburb,
      shipment.postcode,
      shipment.warehouse_location
    ].some((value) => normaliseSearch(value).includes(search));
  }

  function shipmentContainerNumber(shipment) {
    return cleanCell(shipment?.container_number) || cleanCell(shipmentSourceData(shipment).container_number);
  }

  function shipmentRecipientPhone(shipment) {
    return cleanCell(shipment?.recipient_phone) || cleanCell(shipmentSourceData(shipment).recipient_phone);
  }

  function shipmentSmsWasPrepared(shipment) {
    return Boolean(shipmentSourceData(shipment).sms_prepared_at);
  }

  function shipmentSmsCanBePrepared(shipment) {
    return Boolean(shipment)
      && !['completed', 'cancelled', 'exception'].includes(shipment.current_status)
      && !shipmentSmsWasPrepared(shipment);
  }

  function getPendingShipments() {
    const search = normaliseSearch(elements.pendingSearch.value);
    const status = elements.pendingStatusFilter.value;
    const shipments = state.shipments.filter((shipment) => {
      if (shipment.current_status === 'completed' || shipment.current_status === 'cancelled') return false;
      if (status !== 'all' && shipment.current_status !== status) return false;
      return shipmentMatches(shipment, search);
    }).sort((left, right) => {
      const statusDifference = pendingStatusRank(left.current_status) - pendingStatusRank(right.current_status);
      return statusDifference || compareShipmentTime(left, right, 'inbound_at', false);
    });
    return state.pendingSortAscending ? shipments.reverse() : shipments;
  }

  function pendingStatusRank(status) {
    return status === 'on_hold' ? 2 : status === 'pending_warehouse_booking' ? 1 : 0;
  }

  function compareShipmentTime(left, right, field, ascending) {
    const difference = (Date.parse(right[field]) || 0) - (Date.parse(left[field]) || 0);
    return (ascending ? -difference : difference)
      || String(left.tracking_number || '').localeCompare(String(right.tracking_number || ''))
      || String(left.id || '').localeCompare(String(right.id || ''));
  }

  function getCompletedShipments() {
    const search = normaliseSearch(elements.completedSearch.value);
    const method = elements.outboundFilter.value;
    const shipments = state.shipments.filter((shipment) => {
      if (shipment.current_status !== 'completed') return false;
      if (method !== 'all' && shipment.outbound_method !== method) return false;
      return shipmentMatches(shipment, search);
    }).sort((left, right) => compareShipmentTime(left, right, 'outbound_at', false));
    return state.historySortAscending ? shipments.reverse() : shipments;
  }

  function canCompleteShipments() {
    return ['admin', 'operations', 'warehouse'].includes(state.profile?.role);
  }

  const PENDING_TABLE_HEADERS = Object.freeze({
    x: ['QTY', 'Suburb', 'Tracking Number', 'Customer Reference', 'Name', 'Address', 'Contact Phone', 'Inbound Time', 'Container Number', 'Status'],
    y: ['Container Number', 'Tracking Number', 'Customer Reference', 'QTY', 'Weight', 'Volume', 'Status', 'Suburb', 'Unit Price', 'Fuel Levy', 'Total Charge', 'Agent Customer']
  });

  function renderPendingTableHeader() {
    while (elements.pendingTableHeadRow.children.length > 1) {
      elements.pendingTableHeadRow.lastElementChild.remove();
    }
    elements.pendingTableHeadRow.insertAdjacentHTML('beforeend', PENDING_TABLE_HEADERS[state.pendingTableMode]
      .map((label) => `<th${label === 'Status' ? ' class="status-column-header"' : ''}>${escapeHtml(label)}</th>`)
      .join(''));
    elements.pendingShipmentTable.dataset.tableMode = state.pendingTableMode;
    const nextMode = state.pendingTableMode === 'x' ? 'Y' : 'X';
    elements.tableModeToggle.setAttribute('aria-label', `Switch to ${nextMode} table layout`);
    elements.tableModeToggle.title = `Switch to ${nextMode} table layout`;
  }

  function statusActionHtml(shipment) {
    const status = shipment.current_status || 'pending';
    const label = STATUS_LABELS[status] || status;
    let statusDate = '';
    if (status === 'scheduled' && shipment.scheduled_for) {
      const weekdayLabel = scheduledWeekdayLabel(shipment.scheduled_for);
      statusDate = `<small class="scheduled-meta"><span>${escapeHtml(formatDateOnly(shipment.scheduled_for))}${weekdayLabel ? ',' : ''}</span>${weekdayLabel ? `<span>${escapeHtml(weekdayLabel)}</span>` : ''}</small>`;
    } else if (status === 'on_hold' && shipment.on_hold_started_at) {
      statusDate = `<small>${escapeHtml(formatDateOnly(shipment.on_hold_started_at))}</small>`;
    }
    const attention = scheduledNeedsAttention(shipment);
    const alertDot = attention ? '<span class="schedule-alert-dot" aria-hidden="true"></span>' : '';
    const attentionText = attention ? ' Scheduled shipment needs attention.' : '';
    if (!canManageShipments() || status === 'exception') {
      return `<span class="status-action ${escapeHtml(status)} is-readonly" title="${attention ? 'Scheduled shipment needs attention' : ''}">${alertDot}<span>${escapeHtml(label)}</span>${statusDate}</span>`;
    }
    return `<button class="status-action ${escapeHtml(status)}" type="button" data-status-shipment="${shipment.id}" aria-label="Change status for ${escapeHtml(shipment.tracking_number)}.${attentionText}">${alertDot}<span>${escapeHtml(label)}</span>${statusDate}<i class="ti ti-chevron-right" aria-hidden="true"></i></button>`;
  }

  function statusQuickActionHtml(shipment) {
    if (!canManageShipments()) return '';
    const actions = {
      pending: ['prepare_sms', 'ti-mail-forward', 'Prepare SMS'],
    out_for_delivery: ['complete_delivery', 'ti-map-check', 'Mark delivery as completed'],
    on_hold: ['reset_pending', 'ti-package-export', 'Return shipment to Pending'],
      pending_warehouse_booking: ['complete_dtw', 'ti-location-share', 'Complete warehouse delivery as DTW']
    };
    const action = shipment.current_status === 'scheduled' && isToday(shipment.scheduled_for)
    ? ['start_delivery', 'ti-map-share', 'Start delivery']
      : actions[shipment.current_status];
    if (!action) return '';
    const smsPrepared = action[0] === 'prepare_sms' && shipmentSmsWasPrepared(shipment);
    const title = smsPrepared ? 'SMS Prepared By System' : action[2];
    return `<button class="status-quick-action ${action[0]}${smsPrepared ? ' sms-prepared' : ''}" type="button" data-status-quick-action="${action[0]}" data-id="${shipment.id}" title="${title}" aria-label="${title} for ${escapeHtml(shipment.tracking_number)}" ${smsPrepared ? 'disabled' : ''}><i class="ti ${action[1]}${action[3] ? ` ${action[3]}` : ''}" aria-hidden="true"></i></button>`;
  }

  function pendingRowHtml(shipment) {
    const checked = state.selectedIds.has(shipment.id);
    const detailsOpen = state.editingShipmentId === shipment.id;
    const isWarehouseBooking = shipment.current_status === 'pending_warehouse_booking';
    const formattedAddress = normaliseAddressFields(shipment);
    const checkbox = `<td class="check-cell"><input type="checkbox" data-select-id="${shipment.id}" ${checked ? 'checked' : ''} aria-label="Select ${escapeHtml(shipment.tracking_number)}"></td>`;
    const tracking = `<td class="tracking-cell"><strong>${escapeHtml(shipment.tracking_number)}</strong></td>`;
      const reference = `<td class="reference-cell">${escapeHtml(shipment.customer_reference || '/')}</td>`;
      const customer = `<td class="customer-cell">${escapeHtml(shipment.customer_name || '/')}</td>`;
      const container = `<td class="container-cell">${escapeHtml(shipmentContainerNumber(shipment) || '/')}</td>`;
    const name = `<td class="name-cell"><strong>${escapeHtml(formatPersonName(shipment.recipient_name) || '/')}</strong></td>`;
    const address = `<td class="address-cell">${escapeHtml(formatSingleLineAddress(shipment) || '/')}</td>`;
      const phone = `<td class="phone-cell">${escapeHtml(formatAustralianMobile(shipmentRecipientPhone(shipment)) || '/')}</td>`;
    const inbound = `<td class="date-cell">${escapeHtml(formatDateOnly(shipment.inbound_at))}</td>`;
    const craneRequired = shipment.crane_required
      ? '<span class="crane-required-badge"><i class="ti ti-crane" aria-hidden="true"></i>Crane Required</span>'
      : '';
    const status = state.pendingTableMode === 'y'
      ? `<td class="status-cell"><span class="status-action ${escapeHtml(shipment.current_status || 'pending')} is-readonly"><span>${escapeHtml(STATUS_LABELS[shipment.current_status] || shipment.current_status || 'Pending')}</span></span></td>`
      : `<td class="status-cell"><div class="status-cell-content"><div class="status-stack">${statusActionHtml(shipment)}${craneRequired}</div>${statusQuickActionHtml(shipment)}</div></td>`;
    const weight = `<td class="weight-cell">${escapeHtml(formatMeasurement(shipment.weight_kg, 'kg', 3))}</td>`;
    const volume = `<td class="volume-cell">${escapeHtml(formatMeasurement(shipment.volume_m3, 'm³', 4))}</td>`;
    const quantity = `<td class="quantity-cell">${escapeHtml(formatShipmentQuantity(shipment))}</td>`;
      const suburb = `<td class="suburb-cell">${escapeHtml(formattedAddress.suburb || '/')}</td>`;
    const unitPrice = `<td class="money-cell unit-price-cell">${isWarehouseBooking ? '/' : escapeHtml(formatCurrency(shipment.unit_price, 'Not priced'))}</td>`;
    const fuelLevy = `<td class="money-cell fuel-levy-cell">${isWarehouseBooking ? '/' : escapeHtml(formatCurrency(calculatedFuelLevy(shipment)))}</td>`;
    const totalCharge = `<td class="money-cell total-charge-cell"><strong>${escapeHtml(formatCurrency(displayedTotalCharge(shipment)))}</strong></td>`;
    const rowCells = state.pendingTableMode === 'x'
        ? `${checkbox}${quantity}<td class="city-cell">${escapeHtml(formattedAddress.suburb || '/')}</td>${tracking}${reference}${name}${address}${phone}${inbound}${container}${status}`
      : `${checkbox}${container}${tracking}${reference}${quantity}${weight}${volume}${status}${suburb}${unitPrice}${fuelLevy}${totalCharge}${customer}`;

    return `<tr data-row-id="${shipment.id}" class="${[shipment.current_status === 'exception' && 'exception-row', checked && 'selected-row', detailsOpen && 'details-open-row'].filter(Boolean).join(' ')}" aria-selected="${checked ? 'true' : 'false'}" title="Double-click to view or edit">${rowCells}</tr>`;
  }

  function completedRowHtml(shipment) {
    const checked = state.historySelectedIds.has(shipment.id);
    const detailsOpen = state.editingShipmentId === shipment.id;
    const formattedAddress = normaliseAddressFields(shipment);
    const agentCustomer = shipment.customer_name ? `<small>Agent Customer: ${escapeHtml(shipment.customer_name)}</small>` : '';
    const deleteAction = isAdministrator()
      ? `<button class="row-action danger" type="button" data-delete-shipment="${shipment.id}"><i class="ti ti-trash" aria-hidden="true"></i><span>Delete</span></button>`
      : '';
    return `<tr data-row-id="${shipment.id}" class="${[checked && 'selected-row', detailsOpen && 'details-open-row'].filter(Boolean).join(' ')}" aria-selected="${checked ? 'true' : 'false'}">
      <td class="check-cell"><input type="checkbox" data-history-select-id="${shipment.id}" ${checked ? 'checked' : ''} aria-label="Select ${escapeHtml(shipment.tracking_number)}"></td>
      <td class="tracking-cell"><strong>${escapeHtml(shipment.tracking_number)}</strong>${agentCustomer}</td>
            <td class="reference-cell">${escapeHtml(shipment.customer_reference || '/')}</td>
            <td class="container-cell">${escapeHtml(shipmentContainerNumber(shipment) || '/')}</td>
      <td class="name-cell"><strong>${escapeHtml(formatPersonName(shipment.recipient_name) || '/')}</strong></td>
      <td class="address-cell">${escapeHtml(formattedAddress.delivery_address || '/')}<small>${escapeHtml(formatLocality(formattedAddress) || '/')}</small></td>
            <td class="phone-cell">${escapeHtml(formatAustralianMobile(shipmentRecipientPhone(shipment)) || '/')}</td>
            <td><span class="status-badge completed">${escapeHtml(OUTBOUND_LABELS[shipment.outbound_method] || shipment.outbound_method || '/')}</span></td>
      <td>${escapeHtml(formatDateTime(shipment.outbound_at))}</td>
      <td class="history-actions-cell"><div class="row-actions"><button class="row-action outline" type="button" data-edit-shipment="${shipment.id}"><i class="ti ${canManageShipments() ? 'ti-pencil' : 'ti-eye'}" aria-hidden="true"></i><span>${canManageShipments() ? 'Details / Edit' : 'View Details'}</span></button>${deleteAction}</div></td>
    </tr>`;
  }

  function renderNavigationCounts() {
    const pending = state.shipments.filter((item) => !['completed', 'cancelled'].includes(item.current_status));
    elements.pendingNavCount.textContent = String(pending.length);
  }

  function selectedTotalCharge() {
    return state.shipments.reduce((total, shipment) => state.selectedIds.has(shipment.id) ? total + (displayedTotalCharge(shipment) ?? 0) : total, 0);
  }

  function renderSelection() {
    const count = state.selectedIds.size;
    const selected = selectedShipments();
    const smsAvailable = selected.filter(shipmentSmsCanBePrepared).length;
    const showTotal = state.pendingTableMode === 'y';
    elements.pendingBulkActions.closest('.workspace-action-group').classList.toggle('has-selection', count > 0);
    elements.selectedCount.textContent = String(count);
    elements.selectedCount.hidden = showTotal;
    elements.showOnMapIcon.hidden = showTotal;
    elements.showOnMapLabel.textContent = showTotal ? formatCurrency(selectedTotalCharge(), '$0.00') : 'View on Map';
    elements.showOnMapButton.classList.toggle('selection-total', showTotal);
    elements.mapNavCount.hidden = count === 0;
    elements.mapNavCount.textContent = String(count);
    elements.pendingBulkActions.querySelectorAll('button').forEach((button) => {
      button.disabled = count === 0 || !canCompleteShipments();
    });
    elements.bulkPrepareSmsButton.disabled = smsAvailable === 0 || !canManageShipments();
    elements.bulkPrepareSmsButton.querySelector('span').textContent = count > 0 && smsAvailable === 0
      ? 'SMS Prepared By System'
      : 'Prepare SMS';
    elements.bulkPrepareSmsButton.title = count > 0 && smsAvailable === 0
      ? 'SMS Prepared By System'
      : 'Prepare separate SMS messages for selected shipments';
    elements.showOnMapButton.disabled = count === 0;
    elements.bulkDeleteButton.hidden = !isAdministrator();
  }

  function renderHistorySelection() {
    const count = state.historySelectedIds.size;
    elements.historyBulkActions.closest('.workspace-action-group').classList.toggle('has-selection', count > 0);
    elements.historyResumeButton.disabled = count === 0 || !canManageShipments();
    elements.historyBulkDeleteButton.disabled = count === 0 || !isAdministrator();
    elements.historyBulkDeleteButton.hidden = !isAdministrator();
  }

  function renderPendingTable() {
    const shipments = getPendingShipments();
    renderPendingTableHeader();
    const validIds = new Set(state.shipments.filter((item) => !['completed', 'cancelled'].includes(item.current_status)).map((item) => item.id));
    [...state.selectedIds].forEach((id) => {
      if (!validIds.has(id)) state.selectedIds.delete(id);
    });
    elements.pendingTableBody.innerHTML = shipments.map(pendingRowHtml).join('');
    elements.pendingEmpty.hidden = shipments.length > 0;
    elements.selectAllPending.checked = shipments.length > 0 && shipments.every((item) => state.selectedIds.has(item.id));
    elements.selectAllPending.indeterminate = shipments.some((item) => state.selectedIds.has(item.id)) && !elements.selectAllPending.checked;
    updateSortToggle(elements.pendingSortToggle, state.pendingSortAscending);
    renderSelection();
  }

  function renderCompletedTable() {
    const shipments = getCompletedShipments();
    const validIds = new Set(state.shipments.filter((item) => item.current_status === 'completed').map((item) => item.id));
    [...state.historySelectedIds].forEach((id) => {
      if (!validIds.has(id)) state.historySelectedIds.delete(id);
    });
    elements.completedTableBody.innerHTML = shipments.map(completedRowHtml).join('');
    elements.completedEmpty.hidden = shipments.length > 0;
    elements.selectAllHistory.checked = shipments.length > 0 && shipments.every((item) => state.historySelectedIds.has(item.id));
    elements.selectAllHistory.indeterminate = shipments.some((item) => state.historySelectedIds.has(item.id)) && !elements.selectAllHistory.checked;
    updateSortToggle(elements.historySortToggle, state.historySortAscending);
    renderHistorySelection();
  }

  function updateSortToggle(button, reversed) {
    const label = reversed ? 'Restore default shipment order' : 'Reverse current shipment order';
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function renderAll() {
    renderNavigationCounts();
    renderPendingTable();
    renderCompletedTable();
  }

  async function loadShipments({ quiet = false } = {}) {
    if (!state.client || state.loading) return;
    state.loading = true;

    if (canManageShipments()) {
      const { error: refreshError } = await state.client.rpc('refresh_shipment_exceptions');
      if (refreshError && refreshError.code !== 'PGRST202') console.warn('Could not refresh shipment exceptions:', refreshError.message);
    }

    const { data, error } = await state.client
      .from('shipments')
      .select('*')
      .is('cancelled_at', null)
      .order('inbound_at', { ascending: false });

    state.loading = false;

    if (error) {
      showToast(`Unable to load shipments: ${error.message}`, 'error');
      return;
    }

    state.shipments = data || [];
    renderAll();
  }

  async function loadProfile(userId) {
    const { data, error } = await state.client
      .from('profiles')
      .select('id, full_name, role, is_active')
      .eq('id', userId)
      .single();

    if (error) throw new Error(`Unable to load staff profile: ${error.message}`);
    if (!data?.is_active) throw new Error('This staff account has been deactivated.');
    state.profile = data;
    elements.userName.textContent = data.full_name || 'Staff Member';
    elements.userRole.textContent = ROLE_LABELS[data.role] || data.role;
    elements.userAvatar.textContent = (data.full_name || 'U').trim().charAt(0).toUpperCase();
  }

  async function loadCustomers() {
    const { data, error } = await state.client
      .from('customers')
      .select('id, name, customer_code, is_active')
      .order('name', { ascending: true });

    if (error) {
      state.customers = [];
      renderCustomerOptions();
      showToast('The Agent Customer table has not been created. Run 07_create_customers.sql in Supabase first.', 'error');
      return false;
    }

    state.customers = data || [];
    renderCustomerOptions();
    return true;
  }

  async function handleSession(session) {
    state.session = session;
    if (!session?.user) {
      state.profile = null;
      state.customers = [];
      state.shipments = [];
      state.selectedIds.clear();
      state.historySelectedIds.clear();
      state.pendingTableMode = 'x';
      state.pendingSortAscending = false;
      state.historySortAscending = false;
      closeStatusDrawer();
      showAuthScreen();
      return;
    }

    try {
      await loadProfile(session.user.id);
      showAppScreen();
      await loadCustomers();
      await loadShipments();
    } catch (error) {
      showToast(error.message, 'error');
      await state.client.auth.signOut();
      showAuthScreen();
      showLoginError(error.message);
    }
  }

  async function completeShipment(id, method) {
    const shipment = state.shipments.find((item) => item.id === id);
    if (!shipment) return;
    const label = OUTBOUND_LABELS[method] || method;
    if (!window.confirm(`Mark ${shipment.tracking_number} as ${label}?`)) return;

    const rowButtons = document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`);
    rowButtons.forEach((button) => { button.disabled = true; });

    const { error } = await state.client.rpc('complete_shipment', {
      p_shipment_id: id,
      p_outbound_method: method,
      p_notes: null
    });

    rowButtons.forEach((button) => { button.disabled = false; });
    if (error) {
      showToast(`Operation failed: ${error.message}`, 'error');
      return;
    }

    state.selectedIds.delete(id);
    showToast(`${shipment.tracking_number} was marked as ${label}.`, 'success');
    await loadShipments({ quiet: true });
  }

  async function completeSelectedShipments(method) {
    const shipments = selectedShipments().filter((item) => !['completed', 'cancelled', 'exception'].includes(item.current_status));
    if (!shipments.length || !canCompleteShipments()) return;
    const label = OUTBOUND_LABELS[method] || method;
    if (!window.confirm(`Mark ${shipments.length} selected shipment${shipments.length === 1 ? '' : 's'} as ${label}?`)) return;

    elements.pendingBulkActions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const failed = [];
    for (const shipment of shipments) {
      const { error } = await state.client.rpc('complete_shipment', {
        p_shipment_id: shipment.id,
        p_outbound_method: method,
        p_notes: null
      });
      if (error) failed.push(shipment.tracking_number);
      else state.selectedIds.delete(shipment.id);
    }
    await loadShipments({ quiet: true });
    if (failed.length) {
      showToast(`${shipments.length - failed.length} updated. ${failed.length} failed: ${failed.join(', ')}`, 'error');
      return;
    }
    showToast(`${shipments.length} shipment${shipments.length === 1 ? '' : 's'} marked as ${label}.`, 'success');
  }

  async function resetSelectedShipmentsToPending() {
    const shipments = selectedShipments().filter((item) => !['completed', 'cancelled', 'exception'].includes(item.current_status));
    if (!shipments.length || !canManageShipments()) return;

    elements.pendingBulkActions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const failed = [];
    for (const shipment of shipments) {
      const { error } = shipment.current_status === 'pending' ? {} : await state.client.rpc('set_shipment_dispatch_status', {
        p_shipment_id: shipment.id,
        p_status: 'pending',
        p_scheduled_for: null
      });
      if (error) failed.push(shipment.tracking_number);
      else state.selectedIds.delete(shipment.id);
    }
    await loadShipments({ quiet: true });
    if (failed.length) {
      showToast(`${shipments.length - failed.length} reset. ${failed.length} failed: ${failed.join(', ')}`, 'error');
      return;
    }
    showToast(`${shipments.length} shipment${shipments.length === 1 ? '' : 's'} reset to Pending.`, 'success');
  }

  async function deleteSelectedShipments(selection = state.selectedIds, controls = elements.pendingBulkActions) {
    const shipments = state.shipments.filter((item) => selection.has(item.id));
    if (!shipments.length || !isAdministrator()) return;
    if (!await confirmRemoval()) return;

    controls.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const failed = [];
    for (const shipment of shipments) {
      const { error } = await state.client.rpc('archive_shipment', { p_shipment_id: shipment.id });
      if (error) failed.push(shipment.tracking_number);
      else selection.delete(shipment.id);
    }
    await loadShipments({ quiet: true });
    if (failed.length) {
      showToast(`${shipments.length - failed.length} removed. ${failed.length} failed: ${failed.join(', ')}`, 'error');
      return;
    }
    showToast(`${shipments.length} shipment${shipments.length === 1 ? '' : 's'} removed from the system. Database records were kept.`, 'success');
  }

  async function resumeSelectedHistoryShipments() {
    const shipments = state.shipments.filter((item) => state.historySelectedIds.has(item.id) && item.current_status === 'completed');
    if (!shipments.length || !canManageShipments()) return;

    elements.historyBulkActions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const failed = [];
    for (const shipment of shipments) {
      const { error } = await state.client.rpc('resume_completed_shipment', { p_shipment_id: shipment.id });
      if (error) failed.push(shipment.tracking_number);
      else state.historySelectedIds.delete(shipment.id);
    }
    await loadShipments({ quiet: true });
    if (failed.length) {
      showToast(`${shipments.length - failed.length} resumed. ${failed.length} failed: ${failed.join(', ')}`, 'error');
      return;
    }
    showToast(`${shipments.length} shipment${shipments.length === 1 ? '' : 's'} resumed as Pending.`, 'success');
  }

  async function changeDispatchStatus(shipment, status, button) {
    button.disabled = true;
    const { error } = await state.client.rpc('set_shipment_dispatch_status', {
      p_shipment_id: shipment.id,
      p_status: status,
      p_scheduled_for: null
    });
    if (error) {
      button.disabled = false;
      showToast(`Status update failed: ${error.message}`, 'error');
      return;
    }
    showToast(`${shipment.tracking_number} status updated to ${STATUS_LABELS[status]}.`, 'success');
    await loadShipments({ quiet: true });
  }

  async function runStatusQuickAction(id, action, button) {
    const shipment = state.shipments.find((item) => item.id === id);
    if (!shipment || !canManageShipments()) return;
    if (action === 'complete_delivery') return completeShipment(id, 'delivered');
    if (action === 'complete_dtw') return completeShipment(id, 'warehouse_delivery');
    if (action === 'start_delivery') return changeDispatchStatus(shipment, 'out_for_delivery', button);
    if (action === 'reset_pending') return changeDispatchStatus(shipment, 'pending', button);
    if (action === 'prepare_sms') return prepareSingleShipmentSms(shipment, shipmentSmsDetails(shipment), true);
  }

  function selectedDispatchStatus() {
    return elements.statusUpdateForm.elements.dispatch_status.value;
  }

  function renderScheduledDateSection() {
    const status = selectedDispatchStatus();
    const needsDate = status === 'scheduled' || status === 'on_hold';
    elements.scheduledDateSection.hidden = !needsDate;
    elements.scheduledDateText.required = needsDate;
    elements.scheduledDateLabel.textContent = status === 'on_hold' ? 'On hold start date *' : 'Scheduled date *';
    elements.scheduledDateHint.textContent = status === 'on_hold'
      ? 'Defaults to today. You can enter another date if needed.'
      : 'Short dates such as 8.12 are understood as 12 Aug 2026.';
    if (status === 'on_hold' && !elements.scheduledDateText.value.trim()) syncScheduledDate(todayInMelbourne());
    elements.scheduledDateError.hidden = true;
  }

  function syncScheduledDate(date) {
    if (!date || Number.isNaN(date.getTime())) return false;
    state.scheduledDateValue = datePickerValue(date);
    elements.scheduledDatePicker.value = state.scheduledDateValue;
    elements.scheduledDateText.value = formatDateOnly(date);
    elements.scheduledDateError.hidden = true;
    return true;
  }

  function normaliseScheduledDateText() {
    const date = parseFlexibleDate(elements.scheduledDateText.value);
    if (!date) {
      state.scheduledDateValue = '';
      elements.scheduledDateError.hidden = false;
      return null;
    }
    syncScheduledDate(date);
    return date;
  }

  function openStatusDrawer(id) {
    const shipment = state.shipments.find((item) => item.id === id);
    if (!shipment || !canManageShipments()) return;
    state.statusShipmentId = id;
    state.scheduledDateValue = '';
    elements.statusDrawerTitle.textContent = 'Update Shipment Status';
    elements.statusDrawerTracking.textContent = `${shipment.tracking_number} · ${formatPersonName(shipment.recipient_name) || '/'}`;
    const initialStatus = ['pending', 'message_sent', 'scheduled', 'on_hold', 'pending_warehouse_booking', 'out_for_delivery'].includes(shipment.current_status)
      ? shipment.current_status
      : 'pending';
    elements.statusUpdateForm.elements.dispatch_status.value = initialStatus;
    elements.scheduledDateText.value = '';
    elements.scheduledDatePicker.value = '';
    if (initialStatus === 'scheduled' && shipment.scheduled_for) syncScheduledDate(new Date(shipment.scheduled_for));
    if (initialStatus === 'on_hold' && shipment.on_hold_started_at) syncScheduledDate(new Date(shipment.on_hold_started_at));
    renderScheduledDateSection();
    elements.statusDrawer.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeStatusDrawer() {
    elements.statusDrawer.hidden = true;
    state.statusShipmentId = null;
    state.scheduledDateValue = '';
    if (elements.shipmentModal.hidden) document.body.style.overflow = '';
  }

  async function saveDispatchStatus(event) {
    event.preventDefault();
    const shipment = state.shipments.find((item) => item.id === state.statusShipmentId);
    if (!shipment) return;
    const status = selectedDispatchStatus();
    let scheduledFor = null;
    if (status === 'scheduled' || status === 'on_hold') {
      const date = normaliseScheduledDateText();
      if (!date) return;
      scheduledFor = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0).toISOString();
    }
    elements.saveStatusUpdateButton.disabled = true;
    elements.saveStatusUpdateButton.textContent = 'Updating...';
    const { error } = await state.client.rpc('set_shipment_dispatch_status', {
      p_shipment_id: shipment.id,
      p_status: status,
      p_scheduled_for: scheduledFor
    });
    elements.saveStatusUpdateButton.disabled = false;
    elements.saveStatusUpdateButton.textContent = 'Update Status';
    if (error) {
      showToast(`Status update failed: ${error.message}`, 'error');
      return;
    }
    closeStatusDrawer();
    showToast(`${shipment.tracking_number} status updated to ${STATUS_LABELS[status]}.`, 'success');
    await loadShipments({ quiet: true });
  }

  function dateTimeInputValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return localDateTimeValue(date);
  }

  function sameCalendarDate(left, right) {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return datePickerValue(new Date(left)) === datePickerValue(new Date(right));
  }

  function formulaNumber(value, maximumFractionDigits = 4) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('en-AU', {
      minimumFractionDigits: 0,
      maximumFractionDigits
    }).format(number);
  }

  function formulaCurrency(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `$${new Intl.NumberFormat('en-AU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3
    }).format(number)}`;
  }

  function editBillingValues() {
    const shipment = state.shipments.find((item) => item.id === state.editingShipmentId);
    if (!shipment) return null;
    const form = elements.shipmentEditForm.elements;
    const volume = optionalNonNegativeNumber(form.volume_m3.value);
    const billableVolume = volume === null ? null : Math.max(volume, 1);
    const unitPrice = optionalNonNegativeNumber(shipment.unit_price);
    const tailLiftFee = optionalNonNegativeNumber(form.tail_lift_service_fee.value);
    const status = form.current_status.value;
    const isWarehouseBooking = status === 'pending_warehouse_booking';
    const craneRequired = !isWarehouseBooking && form.crane_required.value === 'positive';
    const craneFee = craneRequired ? optionalNonNegativeNumber(form.crane_truck_fee.value) : 0;
    const fuelLevyRate = optionalNonNegativeNumber(shipment.fuel_levy_rate) ?? 0.20;
    const fuelLevy = form.fuel_levy_override.dataset.manualOverride === 'true'
      ? optionalNonNegativeNumber(form.fuel_levy_override.value)
      : billableVolume !== null && unitPrice !== null
        ? billableVolume * unitPrice * fuelLevyRate
        : null;
    const gstRate = optionalNonNegativeNumber(shipment.gst_rate) ?? 0.10;
    let automaticTotal = null;

    if (status === 'pending_warehouse_booking') {
      automaticTotal = optionalNonNegativeNumber(shipment.warehouse_booking_charge) ?? 150;
    } else if (billableVolume !== null && unitPrice !== null && tailLiftFee !== null && fuelLevy !== null) {
      automaticTotal = ((billableVolume * unitPrice) + tailLiftFee + fuelLevy) * (1 + gstRate) + (craneFee ?? 0);
    }

    return { shipment, form, volume, billableVolume, unitPrice, tailLiftFee, craneRequired, craneFee, fuelLevy, gstRate, status, automaticTotal };
  }

  function renderBillingFormula({ updateTotal = true } = {}) {
    const values = editBillingValues();
    if (!values) return;
    const { shipment, form, volume, billableVolume, unitPrice, tailLiftFee, craneRequired, craneFee, fuelLevy, gstRate, status, automaticTotal } = values;
    const isWarehouseBooking = status === 'pending_warehouse_booking';
    if (isWarehouseBooking) {
      form.crane_required.value = 'negative';
      form.crane_truck_fee.value = '';
    }
    form.crane_required.disabled = !canManageShipments() || isWarehouseBooking;
    elements.craneTruckFeeField.hidden = !craneRequired;
    form.crane_truck_fee.required = craneRequired;
    elements.editStatusDateField.hidden = !['scheduled', 'on_hold'].includes(status);
    form.status_date.required = ['scheduled', 'on_hold'].includes(status);

    if (updateTotal && form.total_charge_override.dataset.manualOverride !== 'true') {
      form.total_charge_override.value = automaticTotal === null ? '' : automaticTotal.toFixed(3);
    }
    if (form.fuel_levy_override.dataset.manualOverride !== 'true') {
      form.fuel_levy_override.value = fuelLevy === null ? '' : fuelLevy.toFixed(3);
    }

    if (status === 'pending_warehouse_booking') {
      elements.billingFormula.innerHTML = '<span>TOTAL CHARGE</span><strong>Enter the final charge manually. The default is $150.</strong>';
      return;
    }

    if ([volume, unitPrice, tailLiftFee, fuelLevy].some((value) => value === null)) {
      elements.billingFormula.innerHTML = '<span>FORMULA</span><strong>Complete Volume, Unit Price, Tail Lift Service Fee and Fuel Levy to calculate the total.</strong>';
      return;
    }

    const craneSymbol = craneRequired ? ' + Crane Truck Fee' : '';
    const craneNumber = craneRequired ? ` + ${formulaCurrency(craneFee ?? 0)}` : '';
    const symbolic = `(Volume (min 1 m³) × Unit Price + Tail Lift Service Fee + Fuel Levy) × ${(1 + gstRate).toFixed(2)}${craneSymbol}`;
    const numeric = `(${formulaNumber(billableVolume)} × ${formulaCurrency(unitPrice)} + ${formulaCurrency(tailLiftFee)} + ${formulaNumber(fuelLevy, 3)}) × ${(1 + gstRate).toFixed(2)}${craneNumber} = ${formulaCurrency(automaticTotal)}`;
    const manualTotal = form.total_charge_override.dataset.manualOverride === 'true'
      ? `<small>Manual Total Charge: ${escapeHtml(formulaCurrency(optionalNonNegativeNumber(form.total_charge_override.value)))}</small>`
      : '';
    elements.billingFormula.innerHTML = `<span>FORMULA</span><strong>${escapeHtml(symbolic)}</strong><code>${escapeHtml(numeric)}</code>${manualTotal}`;
  }

  function syncEditStatusDate() {
    const form = elements.shipmentEditForm.elements;
    elements.editStatusDateField.hidden = !['scheduled', 'on_hold'].includes(form.current_status.value);
    form.status_date.required = !elements.editStatusDateField.hidden;
    if (form.current_status.value === 'on_hold' && !form.status_date.value) {
      form.status_date.value = datePickerValue(todayInMelbourne());
    }
  }

  function syncEditExceptionFields() {
    const form = elements.shipmentEditForm.elements;
    const originalStatus = form.current_status.dataset.originalValue || '';
    const nextStatus = form.current_status.value;
    const showExceptionReason = originalStatus === 'exception'
      || nextStatus === 'exception'
      || Boolean(form.exception_reason.value.trim());
    const showResolutionReason = (originalStatus === 'exception' && nextStatus !== 'exception')
      || Boolean(form.exception_resolution_reason.value.trim());

    elements.editExceptionReasonField.hidden = !showExceptionReason;
    elements.editExceptionResolutionReasonField.hidden = !showResolutionReason;
    form.exception_reason.required = originalStatus !== 'exception' && nextStatus === 'exception';
    form.exception_resolution_reason.required = originalStatus === 'exception' && nextStatus !== 'exception';
  }

  function shipmentSourceData(shipment) {
    return shipment?.source_data && typeof shipment.source_data === 'object' && !Array.isArray(shipment.source_data)
      ? shipment.source_data
      : {};
  }

  function setEditFormEditable(editable) {
    elements.shipmentEditForm.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((field) => {
      field.disabled = !editable;
    });
    const form = elements.shipmentEditForm.elements;
    form.crane_required.disabled = !editable || form.current_status.value === 'pending_warehouse_booking';
    elements.saveShipmentChangesButton.hidden = !editable;
    renderShipmentSmsButton(state.shipments.find((item) => item.id === state.editingShipmentId), editable);
  }

  function renderShipmentSmsButton(shipment, editable = canManageShipments()) {
    const prepared = shipmentSmsWasPrepared(shipment);
    elements.prepareShipmentSmsButton.hidden = !editable || (!prepared && !shipmentSmsCanBePrepared(shipment));
    elements.prepareShipmentSmsButton.disabled = prepared;
    elements.prepareShipmentSmsButton.querySelector('i').className = `ti ${prepared ? 'ti-message-check' : 'ti-message'}`;
    elements.prepareShipmentSmsButton.querySelector('span').textContent = prepared ? 'SMS Prepared By System' : 'Prepare SMS';
  }

  async function markShipmentSmsPrepared(shipment) {
    const { data, error } = await state.client.rpc('mark_shipment_sms_prepared', { p_shipment_id: shipment.id });
    if (!error && data) Object.assign(shipment, data);
    return error;
  }

  async function prepareSingleShipmentSms(shipment, sms, openMessagingApp = false) {
    if (!shipmentSmsCanBePrepared(shipment)) return;
    if (!sms) {
      showToast('Enter a valid Australian mobile number before preparing the SMS.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(sms.message);
    } catch {
      showToast('The browser could not copy the SMS message. Check clipboard permission and try again.', 'error');
      return;
    }
    const error = await markShipmentSmsPrepared(shipment);
    if (error) {
      showToast(`SMS copied, but the shipment status could not be updated: ${error.message}`, 'error');
      return;
    }
    renderAll();
    if (state.editingShipmentId === shipment.id) {
      const form = elements.shipmentEditForm.elements;
      form.current_status.value = 'message_sent';
      form.current_status.dataset.originalValue = 'message_sent';
      renderShipmentSmsButton(shipment);
    }
    showToast('SMS message copied. Shipment status updated to Message Sent.', 'success');
    if (openMessagingApp && /Macintosh|iPhone|iPad/i.test(navigator.userAgent)) window.location.href = `sms:${sms.phone}`;
  }

  async function prepareShipmentSms() {
    const form = elements.shipmentEditForm.elements;
    const shipment = state.shipments.find((item) => item.id === state.editingShipmentId);
    const sms = shipmentSmsDetails({
      recipient_phone: form.recipient_phone.value,
      recipient_name: form.recipient_name.value,
      tracking_number: form.tracking_number.value
    });
    await prepareSingleShipmentSms(shipment, sms, true);
  }

  async function prepareSelectedShipmentSms() {
    const prepared = state.shipments
      .filter((shipment) => state.selectedIds.has(shipment.id))
      .filter(shipmentSmsCanBePrepared)
      .map((shipment) => ({ shipment, sms: shipmentSmsDetails(shipment) }))
      .filter((item) => item.sms);
    if (!prepared.length) {
      showToast('None of the selected shipments has a valid Australian mobile number.', 'error');
      return;
    }
    const skipped = state.selectedIds.size - prepared.length;
    const text = prepared.map(({ sms }) => `${formatAustralianMobile(sms.phone)}\n${sms.message}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showToast('The browser could not copy the SMS messages. Check clipboard permission and try again.', 'error');
      return;
    }
    const failed = [];
    for (const { shipment } of prepared) {
      const error = await markShipmentSmsPrepared(shipment);
      if (error) failed.push(shipment.tracking_number);
    }
    renderAll();
    if (failed.length) {
      showToast(`${prepared.length} SMS messages copied. Status update failed for: ${failed.join(', ')}`, 'error');
      return;
    }
    showToast(`${prepared.length} separate SMS message${prepared.length === 1 ? '' : 's'} copied and marked Message Sent.${skipped ? ` ${skipped} already prepared or invalid phone number${skipped === 1 ? '' : 's'} skipped.` : ''}`, 'success');
  }

  function syncEditingRowHighlight() {
    document.querySelectorAll('.shipment-table tr[data-row-id]').forEach((row) => {
      row.classList.toggle('details-open-row', row.dataset.rowId === state.editingShipmentId);
    });
  }

  function openShipmentModal(id) {
    const shipment = state.shipments.find((item) => item.id === id);
    if (!shipment) return;
    state.editingShipmentId = id;
    syncEditingRowHighlight();
    const sourceData = shipmentSourceData(shipment);
    const formattedAddress = normaliseAddressFields(shipment);
    const form = elements.shipmentEditForm.elements;

    form.id.value = shipment.id;
    form.tracking_number.value = shipment.tracking_number || '';
    form.customer_id.value = shipment.customer_id || '';
    form.customer_reference.value = shipment.customer_reference || '';
    form.container_number.value = sourceData.container_number || '';
    form.quantity.value = normaliseQuantity(shipment.quantity);
    form.total_quantity.value = totalQuantityFor(shipment);
    form.weight_kg.value = shipment.weight_kg ?? '';
    form.volume_m3.value = shipment.volume_m3 ?? '';
    form.current_status.value = shipment.current_status || 'pending';
    form.current_status.dataset.originalValue = form.current_status.value;
    form.current_status.dataset.previousValue = form.current_status.value;
    form.exception_reason.value = shipment.exception_reason || '';
    form.exception_resolution_reason.value = shipment.exception_resolution_reason || '';
    form.status_date.value = shipment.current_status === 'scheduled' && shipment.scheduled_for
      ? datePickerValue(new Date(shipment.scheduled_for))
      : shipment.current_status === 'on_hold' && shipment.on_hold_started_at
        ? datePickerValue(new Date(shipment.on_hold_started_at))
        : '';
    form.tail_lift_service_fee.value = shipment.tail_lift_service_fee ?? 80;
    form.crane_required.value = shipment.crane_required ? 'positive' : 'negative';
    form.crane_truck_fee.value = shipment.crane_required ? (shipment.crane_truck_fee ?? DEFAULT_CRANE_TRUCK_FEE) : '';
    form.fuel_levy_override.value = calculatedFuelLevy(shipment) ?? '';
    form.fuel_levy_override.dataset.manualOverride = shipment.fuel_levy_override !== null && shipment.fuel_levy_override !== undefined ? 'true' : 'false';
    form.total_charge_override.value = displayedTotalCharge(shipment) ?? '';
    form.total_charge_override.dataset.manualOverride = shipment.total_charge_override !== null && shipment.total_charge_override !== undefined ? 'true' : 'false';
    form.warehouse_location.value = shipment.warehouse_location || '';
    form.inbound_at.value = dateTimeInputValue(shipment.inbound_at);
    form.recipient_name.value = formatPersonName(shipment.recipient_name);
    form.recipient_phone.value = formatAustralianMobile(shipmentRecipientPhone(shipment));
    form.delivery_address.value = formattedAddress.delivery_address;
    form.suburb.value = formattedAddress.suburb;
    form.state.value = formattedAddress.state;
    form.postcode.value = formattedAddress.postcode;
    form.delivery_instructions.value = shipment.delivery_instructions || '';
    form.notes.value = shipment.notes || '';
    syncEditStatusDate();
    syncEditExceptionFields();
    renderBillingFormula({ updateTotal: form.total_charge_override.dataset.manualOverride !== 'true' });

    elements.shipmentModalTitle.textContent = `${shipment.tracking_number} - Shipment Details`;
    elements.shipmentModal.classList.toggle('billing-table-order', state.activeView === 'pending' && state.pendingTableMode === 'y');
    const statusLabel = STATUS_LABELS[shipment.current_status] || shipment.current_status;
    elements.shipmentStatusNote.hidden = shipment.current_status === 'exception';
    elements.shipmentStatusNote.className = `shipment-status-note ${['cancelled', 'exception'].includes(shipment.current_status) ? shipment.current_status : ''}`;
    elements.shipmentStatusNote.textContent = shipment.current_status === 'cancelled'
        ? `Current status: ${statusLabel}. Cancellation reason: ${shipment.cancellation_reason || '/'}. Cancelled at: ${formatDateTime(shipment.cancelled_at)}.`
      : shipment.current_status === 'exception'
        ? `Current status: ${statusLabel}. Reason: ${shipment.exception_reason || '/'}. Resolve this status here and record a resolution reason.`
      : `Current status: ${statusLabel}. Shipment details, dispatch status and service charges can be updated here.`;

    const manageable = canManageShipments();
    setEditFormEditable(manageable);
    elements.deleteShipmentButton.hidden = !isAdministrator();
    elements.shipmentModal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeShipmentModal() {
    shipmentModalPointerDownOutside = false;
    elements.shipmentEditForm.elements.crane_truck_fee.classList.remove('crane-fee-flash', 'crane-fee-border-lit');
    elements.shipmentModal.hidden = true;
    state.editingShipmentId = null;
    syncEditingRowHighlight();
    document.body.style.overflow = '';
  }

  async function saveShipmentChanges(event) {
    event.preventDefault();
    if (!canManageShipments()) return;
    const shipment = state.shipments.find((item) => item.id === state.editingShipmentId);
    if (!shipment) return;
    const form = elements.shipmentEditForm.elements;
    const record = Object.fromEntries([...new FormData(elements.shipmentEditForm).entries()].map(([key, value]) => [key, cleanCell(value)]));
    const formattedAddress = normaliseAddressFields(record);
    if (!record.customer_id || !record.tracking_number || !record.delivery_address) {
      showToast('Select an Agent Customer and enter the tracking number and delivery address.', 'error');
      return;
    }
    if (hasInvalidOptionalNumber(record.weight_kg) || hasInvalidOptionalNumber(record.volume_m3)) {
      showToast('Weight and volume must be zero or a positive number.', 'error');
      return;
    }
    const quantity = normaliseQuantity(record.quantity);
    const totalQuantity = totalQuantityFor(record);
    if (totalQuantity < quantity) {
      showToast('Total Quantity cannot be less than the received Quantity.', 'error');
      return;
    }
    if (hasInvalidOptionalNumber(record.tail_lift_service_fee) || hasInvalidOptionalNumber(record.fuel_levy_override) || hasInvalidOptionalNumber(record.total_charge_override)) {
      showToast('Tail Lift Service Fee, Fuel Levy and Total Charge must be valid positive numbers.', 'error');
      return;
    }
    const craneRequired = record.crane_required === 'positive';
    const craneTruckFee = optionalNonNegativeNumber(record.crane_truck_fee);
    if (craneRequired && (craneTruckFee === null || craneTruckFee <= 0)) {
      showToast('Enter a Crane Truck Fee greater than zero when Crane Required is Positive.', 'error');
      return;
    }
    if (['scheduled', 'on_hold'].includes(record.current_status) && !record.status_date) {
      showToast('Choose a date for the selected status.', 'error');
      return;
    }
    const enteringException = shipment.current_status !== 'exception' && record.current_status === 'exception';
    const resolvingException = shipment.current_status === 'exception' && record.current_status !== 'exception';
    if (enteringException && !record.exception_reason) {
      showToast('Enter an Exception Reason before changing the status to Exception.', 'error');
      return;
    }
    if (resolvingException && !record.exception_resolution_reason) {
      await showConfirmation({
        title: 'Exception Resolution Reason Required',
        message: 'Enter an Exception Resolution Reason before changing the status.',
        actionLabel: 'OK',
        showCancel: false,
        danger: false,
        returnFocus: form.exception_resolution_reason
      });
      return;
    }

    const sourceData = shipmentSourceData(shipment);
    const payload = {
      tracking_number: record.tracking_number,
      customer_id: record.customer_id,
      customer_reference: record.customer_reference || null,
      quantity,
      total_quantity: totalQuantity,
      weight_kg: optionalNonNegativeNumber(record.weight_kg),
      volume_m3: optionalNonNegativeNumber(record.volume_m3),
      tail_lift_service_fee: optionalNonNegativeNumber(record.tail_lift_service_fee) ?? 0,
      crane_required: craneRequired,
      crane_truck_fee: craneRequired ? craneTruckFee : 0,
      fuel_levy_override: form.fuel_levy_override.dataset.manualOverride === 'true'
        ? optionalNonNegativeNumber(record.fuel_levy_override)
        : null,
      total_charge_override: form.total_charge_override.dataset.manualOverride === 'true'
        ? optionalNonNegativeNumber(record.total_charge_override)
        : null,
      recipient_name: formatPersonName(record.recipient_name) || null,
      delivery_address: formattedAddress.delivery_address,
      suburb: formattedAddress.suburb || null,
      state: formattedAddress.state || null,
      postcode: formattedAddress.postcode || null,
      warehouse_location: record.warehouse_location || null,
      delivery_instructions: record.delivery_instructions || null,
      notes: record.notes || null,
      source_data: {
        ...sourceData,
        container_number: record.container_number || '',
        recipient_phone: formatAustralianMobile(record.recipient_phone),
        last_edited_at: new Date().toISOString(),
        last_edited_by: state.session?.user?.id || null
      },
      updated_at: new Date().toISOString()
    };
    if (record.inbound_at && record.inbound_at !== dateTimeInputValue(shipment.inbound_at)) {
      const inboundAt = new Date(record.inbound_at);
      if (!Number.isNaN(inboundAt.getTime())) payload.inbound_at = inboundAt.toISOString();
    }

    const statusDateSource = record.status_date
      ? new Date(`${record.status_date}T12:00:00`)
      : null;
    const currentStatusDate = shipment.current_status === 'scheduled'
      ? shipment.scheduled_for
      : shipment.current_status === 'on_hold'
        ? shipment.on_hold_started_at
        : null;
    const statusNeedsUpdate = record.current_status !== shipment.current_status
      || (['scheduled', 'on_hold'].includes(record.current_status)
        && !sameCalendarDate(statusDateSource, currentStatusDate));
    if (!statusNeedsUpdate) {
      payload.exception_reason = record.exception_reason || null;
      payload.exception_resolution_reason = record.exception_resolution_reason || null;
    }

    elements.saveShipmentChangesButton.disabled = true;
    elements.saveShipmentChangesButton.textContent = 'Saving...';
    if (statusNeedsUpdate) {
      const { error: statusError } = await state.client.rpc('set_shipment_status', {
        p_shipment_id: shipment.id,
        p_new_status: record.current_status,
        p_notes: enteringException
          ? record.exception_reason
          : resolvingException
            ? record.exception_resolution_reason
            : null,
        p_scheduled_for: statusDateSource?.toISOString() || null
      });
      if (statusError) {
        elements.saveShipmentChangesButton.disabled = false;
        elements.saveShipmentChangesButton.textContent = 'Save Changes';
        showToast(`Status update failed: ${statusError.message}`, 'error');
        return;
      }
    }
    const { error } = await state.client.from('shipments').update(payload).eq('id', shipment.id);
    elements.saveShipmentChangesButton.disabled = false;
    elements.saveShipmentChangesButton.textContent = 'Save Changes';

    if (error) {
      const message = error.code === '23505' ? `Tracking number ${record.tracking_number} already exists.` : error.message;
      showToast(`Update failed: ${message}`, 'error');
      if (statusNeedsUpdate) await loadShipments({ quiet: true });
      return;
    }

    closeShipmentModal();
    showToast(`${record.tracking_number} was updated.`, 'success');
    await loadShipments({ quiet: true });
  }

  async function removeShipment(id) {
    const shipment = state.shipments.find((item) => item.id === id);
    if (!shipment || !isAdministrator()) return;
    if (!await confirmRemoval()) return;

    elements.deleteShipmentButton.disabled = true;
    const { error } = await state.client.rpc('archive_shipment', { p_shipment_id: id });
    elements.deleteShipmentButton.disabled = false;
    if (error) {
      showToast(`Delete failed: ${error.message}`, 'error');
      return;
    }
    closeShipmentModal();
    state.selectedIds.delete(id);
    state.historySelectedIds.delete(id);
    showToast(`${shipment.tracking_number} was removed from the system. Its database record was kept.`, 'success');
    await loadShipments({ quiet: true });
  }

  function refreshMapViewport() {
    if (state.activeView !== 'map' || !elements.deliveryMapFrame.contentWindow) return;
    elements.deliveryMapFrame.contentWindow.postMessage(
      { type: 'BENTWAY_MAP_VISIBLE' },
      window.location.origin === 'null' ? '*' : window.location.origin
    );
  }

  function setActiveView(viewName) {
    state.activeView = viewName;
    const pageLabels = {
      pending: 'Pending Shipments',
      intake: 'Add Received Shipment',
      completed: 'Shipment History',
      map: 'Delivery Map'
    };
    elements.workspacePageLabel.textContent = pageLabels[viewName] || 'Operations';
    elements.workspacePageLabel.hidden = viewName === 'intake';
    elements.workspacePageSeparator.hidden = viewName === 'intake';
    document.querySelectorAll('[data-topbar-actions]').forEach((group) => {
      const supportedViews = group.dataset.topbarActions.split(/\s+/);
      group.hidden = !supportedViews.includes(viewName);
    });
    document.querySelectorAll('[data-pending-only]').forEach((control) => {
      control.hidden = viewName !== 'pending';
    });
    document.querySelectorAll('[data-view-panel]').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.viewPanel === viewName);
    });
    document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === viewName);
    });

    if (viewName === 'map' && !elements.deliveryMapFrame.dataset.loaded) {
      elements.deliveryMapFrame.src = elements.deliveryMapFrame.dataset.src;
      elements.deliveryMapFrame.dataset.loaded = 'true';
    }
    if (viewName === 'map') window.setTimeout(refreshMapViewport, 80);

    closeMobileSidebar();
  }

  function selectedShipments() {
    return state.shipments.filter((item) => state.selectedIds.has(item.id));
  }

  function postShipmentsToMap() {
    const shipments = selectedShipments();
    elements.mapSelectionSummary.textContent = shipments.length
      ? `${shipments.length} shipments sent to the map.`
      : 'Select shipments from Pending Shipments first.';

    if (!shipments.length || !elements.deliveryMapFrame.contentWindow) return;
    elements.deliveryMapFrame.contentWindow.postMessage({
      type: 'BENTWAY_SHOW_SHIPMENTS',
      autoSearch: true,
      shipments: shipments.map((item) => ({
        id: item.id,
        trackingNumber: item.tracking_number,
        address: formatSingleLineAddress(item)
      }))
    }, window.location.origin === 'null' ? '*' : window.location.origin);
  }

  function showSelectedOnMap() {
    if (!state.selectedIds.size || state.pendingTableMode === 'y') return;
    setActiveView('map');
    window.setTimeout(postShipmentsToMap, 150);
  }

  function openMobileSidebar() {
    elements.sidebar.classList.add('open');
    elements.sidebarScrim.hidden = false;
  }

  function closeMobileSidebar() {
    elements.sidebar.classList.remove('open');
    elements.sidebarScrim.hidden = true;
  }

  function handleShipmentActionClick(event) {
    const checkbox = event.target.closest('[data-history-select-id]');
    if (checkbox) return;
    const editButton = event.target.closest('[data-edit-shipment]');
    if (editButton) {
      openShipmentModal(editButton.dataset.editShipment);
      return;
    }
    const deleteButton = event.target.closest('[data-delete-shipment]');
    if (deleteButton) {
      removeShipment(deleteButton.dataset.deleteShipment);
      return;
    }
    const completeButton = event.target.closest('[data-complete]');
    if (completeButton) completeShipment(completeButton.dataset.id, completeButton.dataset.complete);
  }

  function applyDraggedSelection(row) {
    if (!selectionDrag || !row || !selectionDrag.tableBody.contains(row)) return;
    const id = row.dataset.rowId;
    selectionDrag.selecting ? selectionDrag.selection.add(id) : selectionDrag.selection.delete(id);
    row.classList.toggle('selected-row', selectionDrag.selecting);
    row.setAttribute('aria-selected', String(selectionDrag.selecting));
    const checkbox = row.querySelector(selectionDrag.checkboxSelector);
    if (checkbox) checkbox.checked = selectionDrag.selecting;
  }

  function beginSelectionDrag(event, tableBody, selection, checkboxSelector, renderTable) {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.target.closest('button, input, a, select, textarea')) return;
    const row = event.target.closest('tr[data-row-id]');
    if (!row) return;
    event.preventDefault();
    selectionDrag = { tableBody, selection, checkboxSelector, renderTable, selecting: !selection.has(row.dataset.rowId) };
    applyDraggedSelection(row);
  }

  function continueSelectionDrag(event) {
    if (!selectionDrag || !(event.buttons & 1)) return;
    applyDraggedSelection(event.target.closest('tr[data-row-id]'));
  }

  function endSelectionDrag() {
    if (!selectionDrag) return;
    const renderTable = selectionDrag.renderTable;
    selectionDrag = null;
    renderTable();
  }

  function handlePendingTableClick(event) {
    const row = event.target.closest('tr[data-row-id]');
    if (!row) return;
    const quickAction = event.target.closest('[data-status-quick-action]');
    if (quickAction) {
      runStatusQuickAction(row.dataset.rowId, quickAction.dataset.statusQuickAction, quickAction);
      return;
    }
    const checkbox = event.target.closest('[data-select-id]');
    if (checkbox) return;
    const statusButton = event.target.closest('[data-status-shipment]');
    if (statusButton) openStatusDrawer(statusButton.dataset.statusShipment);
  }

  function handlePendingTableDoubleClick(event) {
    const row = event.target.closest('tr[data-row-id]');
    if (!row || event.target.closest('button, input, a, select, textarea')) return;
    openShipmentModal(row.dataset.rowId);
  }

  function bindEvents() {
    elements.loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!isConfigured || !state.client) return;
      showLoginError('');
      setLoginBusy(true);

      const { data, error } = await state.client.auth.signInWithPassword({
        email: elements.emailInput.value.trim(),
        password: elements.passwordInput.value
      });

      setLoginBusy(false);
      if (error) {
        showLoginError(error.message === 'Invalid login credentials' ? 'Incorrect email or password.' : error.message);
        return;
      }
      await handleSession(data.session);
    });

    elements.passwordToggle.addEventListener('click', () => {
      const show = elements.passwordInput.type === 'password';
      elements.passwordInput.type = show ? 'text' : 'password';
      elements.passwordToggle.textContent = show ? 'Hide' : 'Show';
      elements.passwordToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });

    elements.logoutButton.addEventListener('click', async () => {
      await state.client?.auth.signOut();
    });

    elements.pendingSearch.addEventListener('input', renderPendingTable);
    elements.pendingStatusFilter.addEventListener('change', renderPendingTable);
    elements.completedSearch.addEventListener('input', renderCompletedTable);
    elements.outboundFilter.addEventListener('change', renderCompletedTable);
    elements.pendingSortToggle.addEventListener('click', () => {
      state.pendingSortAscending = !state.pendingSortAscending;
      renderPendingTable();
    });
    elements.historySortToggle.addEventListener('click', () => {
      state.historySortAscending = !state.historySortAscending;
      renderCompletedTable();
    });
    elements.tableModeToggle.addEventListener('click', () => {
      state.pendingTableMode = state.pendingTableMode === 'x' ? 'y' : 'x';
      renderPendingTable();
    });
    elements.pendingBulkActions.addEventListener('click', (event) => {
      if (event.target.closest('[data-bulk-prepare-sms]')) {
        prepareSelectedShipmentSms();
        return;
      }
      if (event.target.closest('[data-bulk-pending]')) {
        resetSelectedShipmentsToPending();
        return;
      }
      const completeButton = event.target.closest('[data-bulk-complete]');
      if (completeButton) {
        completeSelectedShipments(completeButton.dataset.bulkComplete);
        return;
      }
      if (event.target.closest('[data-bulk-delete]')) deleteSelectedShipments();
    });
    elements.historyBulkActions.addEventListener('click', (event) => {
      if (event.target.closest('[data-history-resume]')) {
        resumeSelectedHistoryShipments();
        return;
      }
      if (event.target.closest('[data-history-delete]')) {
        deleteSelectedShipments(state.historySelectedIds, elements.historyBulkActions);
      }
    });

    elements.saveManualShipmentButton.addEventListener('click', saveManualShipment);
    elements.manualShipmentForm.addEventListener('submit', (event) => {
      event.preventDefault();
      elements.saveManualShipmentButton.click();
    });
    elements.clearManualFormButton.addEventListener('click', resetManualForm);
    elements.shipmentFileInput.addEventListener('change', () => openBatchFile(elements.shipmentFileInput.files?.[0]));
    elements.cancelBatchImportButton.addEventListener('click', cancelBatchImport);
    elements.replaceBatchFileButton.addEventListener('click', () => elements.shipmentFileInput.click());
    elements.batchCustomerSelect.addEventListener('change', refreshBatchPreview);
    elements.batchSheetSelect.addEventListener('change', prepareBatchSheet);
    elements.batchHeaderRowSelect.addEventListener('change', applyBatchHeaderRow);
    elements.batchMappingGrid.addEventListener('change', (event) => {
      const select = event.target.closest('[data-map-field]');
      if (!select) return;
      state.batchMapping[select.dataset.mapField] = select.value;
      state.batchFuzzyMappings.delete(select.dataset.mapField);
      select.closest('.form-field')?.querySelector('.mapping-match-note')?.remove();
      updateMappingAttention(select);
      refreshBatchPreview();
    });
    elements.importShipmentsButton.addEventListener('click', importBatchShipments);

    ['dragenter', 'dragover'].forEach((eventName) => {
      elements.shipmentFileDrop.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.shipmentFileDrop.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      elements.shipmentFileDrop.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.shipmentFileDrop.classList.remove('dragging');
      });
    });
    elements.shipmentFileDrop.addEventListener('drop', (event) => openBatchFile(event.dataTransfer?.files?.[0]));

    elements.pendingTableBody.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-select-id]');
      if (!checkbox) return;
      checkbox.checked ? state.selectedIds.add(checkbox.dataset.selectId) : state.selectedIds.delete(checkbox.dataset.selectId);
      renderPendingTable();
    });

    elements.pendingTableBody.addEventListener('click', handlePendingTableClick);
    elements.pendingTableBody.addEventListener('dblclick', handlePendingTableDoubleClick);
    elements.pendingTableBody.addEventListener('mousedown', (event) => beginSelectionDrag(event, elements.pendingTableBody, state.selectedIds, '[data-select-id]', renderPendingTable));
    elements.pendingTableBody.addEventListener('mouseover', continueSelectionDrag);
    elements.completedTableBody.addEventListener('click', handleShipmentActionClick);
    elements.completedTableBody.addEventListener('mousedown', (event) => beginSelectionDrag(event, elements.completedTableBody, state.historySelectedIds, '[data-history-select-id]', renderCompletedTable));
    elements.completedTableBody.addEventListener('mouseover', continueSelectionDrag);
    elements.completedTableBody.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-history-select-id]');
      if (!checkbox) return;
      checkbox.checked ? state.historySelectedIds.add(checkbox.dataset.historySelectId) : state.historySelectedIds.delete(checkbox.dataset.historySelectId);
      renderCompletedTable();
    });

    elements.statusUpdateForm.addEventListener('change', (event) => {
      if (event.target.name === 'dispatch_status') {
        if (event.target.value === 'on_hold') syncScheduledDate(todayInMelbourne());
        renderScheduledDateSection();
      }
    });
    elements.statusUpdateForm.addEventListener('submit', saveDispatchStatus);
    elements.closeStatusDrawerButton.addEventListener('click', closeStatusDrawer);
    elements.cancelStatusUpdateButton.addEventListener('click', closeStatusDrawer);
    elements.statusDrawer.addEventListener('click', (event) => {
      if (event.target === elements.statusDrawer) closeStatusDrawer();
    });
    elements.scheduledDateText.addEventListener('blur', () => {
      if (elements.scheduledDateText.value.trim()) normaliseScheduledDateText();
    });
    elements.scheduledDatePicker.addEventListener('change', () => {
      if (!elements.scheduledDatePicker.value) return;
      const [year, month, day] = elements.scheduledDatePicker.value.split('-').map(Number);
      syncScheduledDate(new Date(year, month - 1, day));
    });
    elements.openScheduledCalendarButton.addEventListener('click', () => {
      if (typeof elements.scheduledDatePicker.showPicker === 'function') elements.scheduledDatePicker.showPicker();
      else elements.scheduledDatePicker.click();
    });

    elements.shipmentEditForm.addEventListener('input', (event) => {
      if (event.target.name === 'fuel_levy_override') {
        event.target.dataset.manualOverride = 'true';
      }
      if (event.target.name === 'total_charge_override') {
        event.target.dataset.manualOverride = 'true';
        renderBillingFormula({ updateTotal: false });
        return;
      }
      if (['volume_m3', 'tail_lift_service_fee', 'crane_truck_fee', 'fuel_levy_override'].includes(event.target.name)) {
        renderBillingFormula();
      }
    });
    elements.shipmentEditForm.addEventListener('change', (event) => {
      if (event.target.name === 'crane_required' && event.target.value === 'positive') {
        const craneFeeField = elements.shipmentEditForm.elements.crane_truck_fee;
        if (!craneFeeField.value.trim()) craneFeeField.value = String(DEFAULT_CRANE_TRUCK_FEE);
        craneFeeField.classList.remove('crane-fee-flash', 'crane-fee-border-lit');
        void craneFeeField.offsetWidth;
        craneFeeField.classList.add('crane-fee-flash');
      }
      if (event.target.name === 'current_status') {
        const previousStatus = event.target.dataset.previousValue || '';
        const nextStatus = event.target.value;
        const crossedWarehouseBookingBoundary = previousStatus !== nextStatus
          && (previousStatus === 'pending_warehouse_booking' || nextStatus === 'pending_warehouse_booking');

        if (crossedWarehouseBookingBoundary) {
          const totalField = elements.shipmentEditForm.elements.total_charge_override;
          totalField.dataset.manualOverride = 'false';
          totalField.value = '';
        }

        event.target.dataset.previousValue = nextStatus;
        syncEditStatusDate();
        syncEditExceptionFields();
      }
      if (['current_status', 'crane_required', 'status_date'].includes(event.target.name)) {
        renderBillingFormula();
      }
    });
    elements.shipmentEditForm.elements.crane_truck_fee.addEventListener('animationend', (event) => {
      if (event.animationName !== 'crane-fee-flash') return;
      event.target.classList.remove('crane-fee-flash');
      event.target.classList.add('crane-fee-border-lit');
    });

    elements.saveShipmentChangesButton.addEventListener('click', saveShipmentChanges);
    elements.prepareShipmentSmsButton.addEventListener('click', prepareShipmentSms);
    elements.shipmentEditForm.addEventListener('submit', (event) => {
      event.preventDefault();
      elements.saveShipmentChangesButton.click();
    });
    elements.closeShipmentModalButton.addEventListener('click', closeShipmentModal);
    elements.dismissShipmentModalButton.addEventListener('click', closeShipmentModal);
    elements.deleteShipmentButton.addEventListener('click', () => removeShipment(state.editingShipmentId));
    elements.shipmentModal.addEventListener('pointerdown', (event) => {
      shipmentModalPointerDownOutside = event.button === 0 && event.target === elements.shipmentModal;
    });
    elements.shipmentModal.addEventListener('pointerup', (event) => {
      if (shipmentModalPointerDownOutside && event.button === 0 && event.target === elements.shipmentModal) closeShipmentModal();
      shipmentModalPointerDownOutside = false;
    });
    elements.shipmentModal.addEventListener('pointercancel', () => {
      shipmentModalPointerDownOutside = false;
    });
    elements.cancelConfirmationButton.addEventListener('click', () => closeConfirmation(false));
    elements.closeConfirmationButton.addEventListener('click', () => closeConfirmation(false));
    elements.confirmActionButton.addEventListener('click', () => closeConfirmation(true));
    elements.confirmationDialog.addEventListener('click', (event) => {
      if (event.target === elements.confirmationDialog) closeConfirmation(false);
    });
    elements.confirmationDialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeConfirmation(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const buttons = [elements.closeConfirmationButton, elements.cancelConfirmationButton, elements.confirmActionButton].filter((button) => !button.hidden);
      const currentIndex = buttons.indexOf(document.activeElement);
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault();
      buttons[nextIndex].focus();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !elements.confirmationDialog.hidden) return;
      if (event.key !== 'Escape') return;
      selectionDrag = null;
      if (!elements.shipmentModal.hidden) {
        closeShipmentModal();
        return;
      }
      if (!elements.statusDrawer.hidden) {
        closeStatusDrawer();
        return;
      }
      if (!state.selectedIds.size && !state.historySelectedIds.size) return;
      state.selectedIds.clear();
      state.historySelectedIds.clear();
      renderPendingTable();
      renderCompletedTable();
    });

    elements.selectAllPending.addEventListener('change', () => {
      getPendingShipments().forEach((shipment) => {
        elements.selectAllPending.checked ? state.selectedIds.add(shipment.id) : state.selectedIds.delete(shipment.id);
      });
      renderPendingTable();
    });
    elements.selectAllHistory.addEventListener('change', () => {
      getCompletedShipments().forEach((shipment) => {
        elements.selectAllHistory.checked ? state.historySelectedIds.add(shipment.id) : state.historySelectedIds.delete(shipment.id);
      });
      renderCompletedTable();
    });

    elements.showOnMapButton.addEventListener('click', showSelectedOnMap);
    elements.backToPendingButton.addEventListener('click', () => setActiveView('pending'));
    elements.deliveryMapFrame.addEventListener('load', () => window.setTimeout(postShipmentsToMap, 250));

    document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
      button.addEventListener('click', () => {
        setActiveView(button.dataset.view);
        if (button.dataset.view === 'map') window.setTimeout(postShipmentsToMap, 120);
      });
    });
    elements.sidebar.addEventListener('click', (event) => {
      if (window.matchMedia('(min-width: 901px)').matches && !event.target.closest('button, a, input, select, textarea')) {
        elements.sidebar.classList.add('desktop-open');
      }
    });
    elements.sidebar.addEventListener('mouseleave', () => elements.sidebar.classList.remove('desktop-open'));

    window.addEventListener('message', (event) => {
      if (event.source !== elements.deliveryMapFrame.contentWindow) return;
      if (event.data?.type === 'BENTWAY_MAP_READY') {
        refreshMapViewport();
        postShipmentsToMap();
      }
    });

    elements.mobileMenu.addEventListener('click', openMobileSidebar);
    elements.sidebarScrim.addEventListener('click', closeMobileSidebar);
    document.addEventListener('mouseup', endSelectionDrag);
    window.addEventListener('blur', endSelectionDrag);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.session) renderPendingTable();
    });
    window.addEventListener('focus', () => {
      if (state.session) renderPendingTable();
    });
  }

  async function initialise() {
    bindEvents();
    scheduleAlertTimer = window.setInterval(() => {
      if (state.session) renderPendingTable();
    }, 60 * 1000);
    resetManualForm();
    setActiveView(state.activeView);
    if (!isConfigured || !window.supabase?.createClient) {
      showAuthScreen();
      if (isConfigured && !window.supabase?.createClient) {
        showLoginError('The Supabase connection library failed to load. Check your connection and refresh the page.');
      }
      return;
    }

    state.client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });

    state.client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') handleSession(null);
    });

    const { data, error } = await state.client.auth.getSession();
    if (error) {
      showAuthScreen();
      showLoginError(error.message);
      return;
    }
    await handleSession(data.session);
  }

  initialise();
})();
