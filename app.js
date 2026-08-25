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
  const { calculateShipmentBilling, groupConsecutiveStoragePeriods, recalculateDraftComponents, draftTotals } = window.BENTWAY_BILLING;
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
  const DEFAULT_CRANE_TRUCK_FEE = 850;

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
    storageEpisodes: [],
    storageFees: [],
    storageSchedules: new Map(),
    storageShowAll: new Set(),
    billingProfiles: [],
    profileNames: new Map(),
    selectedBillingProfileId: null,
    importBatches: [],
    containerFees: [],
    craneCharges: [],
    finalisedBills: [],
    finalisedBillingItems: [],
    billingSelection: new Set(),
    billingExpandedIds: new Set(),
    activeDraft: null,
    draftItems: [],
    draftEditorOpen: false,
    draftEdits: new Map(),
    draftRemovedItemIds: new Set(),
    selectedIds: new Set(),
    historySelectedIds: new Set(),
    activeView: 'pending',
    loading: false,
    batchWorkbook: null,
    batchFileName: '',
    batchFileMetadata: null,
    batchRows: [],
    batchHeaders: [],
    batchHeaderIndex: 0,
    batchMapping: {},
    batchFuzzyMappings: new Set(),
    batchPreview: [],
    editingShipmentId: null,
    pendingTableMode: 'ov',
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
    billingCustomerFilter: $('#billingCustomerFilter'),
    billingBatchFilter: $('#billingBatchFilter'),
    billingContainerFilter: $('#billingContainerFilter'),
    billingSearch: $('#billingSearch'),
    billingChargeTypeFilter: $('#billingChargeTypeFilter'),
    billingStatusFilter: $('#billingStatusFilter'),
    billingTableBody: $('#billingTableBody'),
    billingEmpty: $('#billingEmpty'),
    createBillButton: $('#createBillButton'),
    billingSelectionSummary: $('#billingSelectionSummary'),
    billingWorkspace: $('#billingWorkspace'),
    draftBillPanel: $('#draftBillPanel'),
    draftBillSummary: $('#draftBillSummary'),
    draftBillItems: $('#draftBillItems'),
    draftBillTotals: $('#draftBillTotals'),
    draftDirtyState: $('#draftDirtyState'),
    backToBillingButton: $('#backToBillingButton'),
    discardDraftChangesButton: $('#discardDraftChangesButton'),
    saveDraftChangesButton: $('#saveDraftChangesButton'),
    discardDraftBillButton: $('#discardDraftBillButton'),
    finaliseDraftBillButton: $('#finaliseDraftBillButton'),
    billingProfilesNav: $('#billingProfilesNav'),
    billingProfileList: $('#billingProfileList'),
    billingProfileForm: $('#billingProfileForm'),
    billingProfileTitle: $('#billingProfileTitle'),
    billingProfileUpdated: $('#billingProfileUpdated'),
    saveBillingProfileButton: $('#saveBillingProfileButton'),
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
    editStatusDateLabel: $('#editStatusDateLabel'),
    editExceptionReasonField: $('#editExceptionReasonField'),
    editExceptionResolutionReasonField: $('#editExceptionResolutionReasonField'),
    craneTruckFeeField: $('#craneTruckFeeField'),
    warehouseBookingFeeField: $('#warehouseBookingFeeField'),
    toggleWarehouseBookingFeeButton: $('#toggleWarehouseBookingFeeButton'),
    billingFormula: $('#billingFormula'),
    billingCraneTitle: $('#billingCraneTitle'),
    billingCraneValue: $('#billingCraneValue'),
    craneRequiredValue: $('#craneRequiredValue'),
    toggleCraneRequiredButton: $('#toggleCraneRequiredButton'),
    shipmentStorageFees: $('#shipmentStorageFees'),
    shipmentBillingAdjustments: $('#shipmentBillingAdjustments'),
    shipmentActivityList: $('#shipmentActivityList'),
    shipmentStatusNote: $('#shipmentStatusNote'),
    closeShipmentModalButton: $('#closeShipmentModalButton'),
    dismissShipmentModalButton: $('#dismissShipmentModalButton'),
    saveShipmentChangesButton: $('#saveShipmentChangesButton'),
    prepareShipmentSmsButton: $('#prepareShipmentSmsButton'),
    resumeShipmentButton: $('#resumeShipmentButton'),
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
  let sidebarCloseTimer = null;

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
    const total = shipment?.total_charge === null || shipment?.total_charge === undefined ? null : Number(shipment.total_charge);
    if (total !== null && Number.isFinite(total)) return total;
    if (shipment?.total_charge_override !== null && shipment?.total_charge_override !== undefined) {
      return Number(shipment.total_charge_override);
    }
    return null;
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
    }, String(message).includes('\n') ? 12000 : 4200);
  }

  function shipmentReference(shipment) {
    return [shipment?.tracking_number || '/', shipment?.customer_reference || '/'].join(' / ');
  }

  function showBulkResults(action, results) {
    const failed = results.filter((result) => result.error);
    const lines = results.map(({ shipment, error }) => `${shipmentReference(shipment)}: ${error ? `failed — ${error.message}` : 'success'}`);
    showToast(`${action}: ${results.length - failed.length} success, ${failed.length} failed.\n${lines.join('\n')}`, failed.length ? 'error' : 'success');
  }

  function clearVisibleSelection(scope = 'pending') {
    const selection = scope === 'history' ? state.historySelectedIds : scope === 'billing' ? state.billingSelection : state.selectedIds;
    if (!selection.size) return;
    selection.clear();
  }

  async function transitionShipment(shipment, action) {
    if (!shipment) return { message: 'Shipment not found' };
    if (action.kind === 'resume') {
      return (await state.client.rpc('resume_completed_shipment', { p_shipment_id: shipment.id })).error;
    }
    if (action.kind === 'complete') {
      return (await state.client.rpc('complete_shipment', {
        p_shipment_id: shipment.id,
        p_outbound_method: action.outboundMethod,
        p_notes: action.notes || null
      })).error;
    }
    if (action.kind === 'prepare_sms') {
      const { data, error } = await state.client.rpc('mark_shipment_sms_prepared', { p_shipment_id: shipment.id });
      if (!error && data) Object.assign(shipment, data);
      return error;
    }
    return (await state.client.rpc('set_shipment_status', {
      p_shipment_id: shipment.id,
      p_new_status: action.status,
      p_notes: action.notes || null,
      p_scheduled_for: action.scheduledFor || null
    })).error;
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

  async function confirmStorageSchedulePreview(shipment, startDate) {
    const { data, error } = await state.client.rpc('preview_storage_schedule_change', {
      p_shipment_id: shipment.id,
      p_new_start_date: startDate
    });
    if (error) {
      showToast(`Storage schedule could not be previewed: ${error.message}`, 'error');
      return false;
    }
    const weeks = Number(data?.due_week_count || 0);
    const credits = Number(data?.billed_credit_count || 0);
    const creditRequired = Number(data?.credit_required_count || 0);
    const removedDraft = Array.isArray(data?.removed_draft_item_ids) ? data.removed_draft_item_ids.length : 0;
    const details = [
      `Storage Start Date: ${formatDateOnly(startDate)}.`,
      `${weeks} ${weeks === 1 ? 'week' : 'weeks'} currently due at ${formatCurrency(data?.weekly_amount_ex_gst)} ex GST each.`,
      credits ? `${credits} billed ${credits === 1 ? 'week is' : 'weeks are'} retained as earliest-week credit.` : '',
      creditRequired ? `Storage Credit Required: ${creditRequired} ${creditRequired === 1 ? 'week' : 'weeks'} for Admin review.` : '',
      removedDraft ? `${removedDraft} old Draft Storage ${removedDraft === 1 ? 'item will' : 'items will'} be removed and must be selected again.` : ''
    ].filter(Boolean).join(' ');
    return showConfirmation({
      title: 'Confirm Storage Schedule',
      message: details,
      actionLabel: 'Apply Schedule',
      showCancel: true,
      danger: creditRequired > 0
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

  function renderBillingProfiles() {
    if (!elements.billingProfileList || !elements.billingProfileForm) return;
    const allowed = isAdministrator();
    elements.billingProfilesNav.hidden = !allowed;
    if (!allowed) return;
    if (!state.selectedBillingProfileId || !state.billingProfiles.some((profile) => profile.customer_id === state.selectedBillingProfileId)) {
      state.selectedBillingProfileId = state.billingProfiles[0]?.customer_id || null;
    }
    elements.billingProfileList.innerHTML = state.billingProfiles.length ? state.billingProfiles.map((profile) => {
      const customer = state.customers.find((item) => item.id === profile.customer_id);
      return `<button type="button" data-billing-profile="${profile.customer_id}" class="${profile.customer_id === state.selectedBillingProfileId ? 'active' : ''}"><strong>${escapeHtml(customer?.name || profile.trading_name || 'Customer')}</strong><small>${escapeHtml(profile.billing_frequency || 'On Demand')}</small></button>`;
    }).join('') : '<p class="empty-inline">No Billing Profiles found.</p>';
    const profile = state.billingProfiles.find((item) => item.customer_id === state.selectedBillingProfileId);
    const form = elements.billingProfileForm.elements;
    [...elements.billingProfileForm.querySelectorAll('input, select, button')].forEach((field) => { field.disabled = !profile; });
    if (!profile) {
      elements.billingProfileTitle.textContent = 'Select a customer';
      elements.billingProfileUpdated.textContent = 'Last updated: /';
      return;
    }
    const customer = state.customers.find((item) => item.id === profile.customer_id);
    elements.billingProfileTitle.textContent = customer?.name || profile.trading_name || 'Billing Profile';
    const updatedBy = profile.updated_by ? (state.profileNames.get(profile.updated_by) || 'Unknown user') : 'System';
    elements.billingProfileUpdated.textContent = `Last updated: ${formatDateTime(profile.updated_at)} · ${updatedBy}`;
    ['customer_id','legal_company_name','trading_name','abn','billing_address','billing_contact','billing_email','cc_email','billing_phone','billing_frequency','default_tail_lift_fee','default_storage_rate','default_warehouse_booking_fee','minimum_billable_volume','default_pickup_rate_per_kg'].forEach((key) => {
      if (form[key]) form[key].value = profile[key] ?? '';
    });
    form.default_fuel_levy_percent.value = Number(profile.default_fuel_levy_rate || 0) * 100;
    form.default_gst_percent.value = Number(profile.default_gst_rate || 0) * 100;
  }

  async function loadBillingProfiles() {
    state.billingProfiles = [];
    state.profileNames.clear();
    if (!isAdministrator()) {
      renderBillingProfiles();
      return;
    }
    const { data, error } = await state.client.from('customer_billing_profiles').select('*').order('trading_name');
    if (error) {
      showToast(`Unable to load Billing Profiles: ${error.message}`, 'error');
      renderBillingProfiles();
      return;
    }
    state.billingProfiles = data || [];
    const ids = [...new Set(state.billingProfiles.map((profile) => profile.updated_by).filter(Boolean))];
    if (ids.length) {
      const names = await state.client.from('profiles').select('id, full_name').in('id', ids);
      if (!names.error) (names.data || []).forEach((profile) => state.profileNames.set(profile.id, profile.full_name || 'Unknown user'));
    }
    renderBillingProfiles();
  }

  async function saveBillingProfile(event) {
    event.preventDefault();
    if (!isAdministrator() || !state.selectedBillingProfileId) return;
    if (!elements.billingProfileForm.reportValidity()) return;
    const form = elements.billingProfileForm.elements;
    const payload = {
      legal_company_name: cleanCell(form.legal_company_name.value) || null,
      trading_name: cleanCell(form.trading_name.value) || null,
      abn: cleanCell(form.abn.value) || null,
      billing_address: cleanCell(form.billing_address.value) || null,
      billing_contact: cleanCell(form.billing_contact.value) || null,
      billing_email: cleanCell(form.billing_email.value) || null,
      cc_email: cleanCell(form.cc_email.value) || null,
      billing_phone: cleanCell(form.billing_phone.value) || null,
      billing_frequency: form.billing_frequency.value,
      default_tail_lift_fee: Number(form.default_tail_lift_fee.value),
      default_fuel_levy_rate: Number(form.default_fuel_levy_percent.value) / 100,
      default_storage_rate: Number(form.default_storage_rate.value),
      default_gst_rate: Number(form.default_gst_percent.value) / 100,
      default_warehouse_booking_fee: Number(form.default_warehouse_booking_fee.value),
      minimum_billable_volume: Number(form.minimum_billable_volume.value),
      default_pickup_rate_per_kg: Number(form.default_pickup_rate_per_kg.value)
    };
    elements.saveBillingProfileButton.disabled = true;
    elements.saveBillingProfileButton.textContent = 'Saving...';
    const { error } = await state.client.rpc('update_customer_billing_profile', {
      p_customer_id: state.selectedBillingProfileId,
      p_profile: payload
    });
    elements.saveBillingProfileButton.disabled = false;
    elements.saveBillingProfileButton.textContent = 'Save Profile';
    if (error) return showToast(`Billing Profile could not be saved: ${error.message}`, 'error');
    await loadBillingProfiles();
    showToast('Billing Profile saved. Existing Shipment snapshots were not changed.', 'success');
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
    const containerNumber = cleanCell(record.container_number);
    if (containerNumber) payload.container_number = containerNumber;

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
      state.batchFileMetadata = { name: file.name, size: file.size, type: file.type || null, lastModified: file.lastModified || null };
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
    state.batchFileMetadata = null;
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
    const batch = {
      customer_id: selectedCustomer.id,
      source_file_name: state.batchFileName,
      source_file_size: state.batchFileMetadata?.size ?? null,
      source_file_type: state.batchFileMetadata?.type || null,
      source_file_metadata: state.batchFileMetadata || {}
    };
    const payloads = validRows.map((item) => buildShipmentPayload({
      ...item.record,
      customer_id: selectedCustomer.id
    }, 'spreadsheet_import', item.originalRows.length === 1 ? item.originalRows[0] : item.originalRows));
    const { error: importError } = await state.client.rpc('import_shipment_batch', { p_batch: batch, p_shipments: payloads });
    elements.importShipmentsButton.disabled = false;
    elements.importShipmentsButton.textContent = 'Import Shipments';
    await loadShipments({ quiet: true });

    if (importError) {
      showToast(`Import failed and no partial batch was kept: ${importError.message}`, 'error');
      refreshBatchPreview();
      return;
    }

    showToast(`${payloads.length} shipments imported successfully.`, 'success');
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

  function canManageBilling() {
    return ['admin', 'operations'].includes(state.profile?.role);
  }

  const PENDING_TABLE_HEADERS = Object.freeze({
    ov: ['QTY', 'Suburb', 'Tracking Number', 'Customer Reference', 'Name', 'Address', 'Contact Phone', 'Inbound Time', 'Container Number', 'Status'],
    bv: ['Container Number', 'Tracking Number', 'Customer Reference', 'QTY', 'Weight', 'Volume', 'Status', 'Suburb', 'Unit Price', 'Fuel Levy', 'Total Charge', 'Agent Customer']
  });

  function renderPendingTableHeader() {
    while (elements.pendingTableHeadRow.children.length > 1) {
      elements.pendingTableHeadRow.lastElementChild.remove();
    }
    elements.pendingTableHeadRow.insertAdjacentHTML('beforeend', PENDING_TABLE_HEADERS[state.pendingTableMode]
      .map((label) => `<th${label === 'Status' ? ' class="status-column-header"' : ''}>${escapeHtml(label)}</th>`)
      .join(''));
    elements.pendingShipmentTable.dataset.tableMode = state.pendingTableMode;
    const nextMode = state.pendingTableMode === 'ov' ? 'Billing View' : 'Operations View';
    elements.tableModeToggle.setAttribute('aria-label', `Switch to ${nextMode}`);
    elements.tableModeToggle.title = `Switch to ${nextMode}`;
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
    const status = state.pendingTableMode === 'bv'
      ? `<td class="status-cell"><span class="status-action ${escapeHtml(shipment.current_status || 'pending')} is-readonly"><span>${escapeHtml(STATUS_LABELS[shipment.current_status] || shipment.current_status || 'Pending')}</span></span></td>`
      : `<td class="status-cell"><div class="status-cell-content"><div class="status-stack">${statusActionHtml(shipment)}${craneRequired}</div>${statusQuickActionHtml(shipment)}</div></td>`;
    const weight = `<td class="weight-cell">${escapeHtml(formatMeasurement(shipment.weight_kg, 'kg', 3))}</td>`;
    const volume = `<td class="volume-cell">${escapeHtml(formatMeasurement(shipment.volume_m3, 'm³', 4))}</td>`;
    const quantity = `<td class="quantity-cell">${escapeHtml(formatShipmentQuantity(shipment))}</td>`;
      const suburb = `<td class="suburb-cell">${escapeHtml(formattedAddress.suburb || '/')}</td>`;
    const unitPrice = `<td class="money-cell unit-price-cell">${isWarehouseBooking ? '/' : escapeHtml(formatCurrency(shipment.unit_price, 'Not priced'))}</td>`;
    const fuelLevy = `<td class="money-cell fuel-levy-cell">${isWarehouseBooking ? '/' : escapeHtml(formatCurrency(calculatedFuelLevy(shipment)))}</td>`;
    const hasStorage = state.storageFees.some((fee) => fee.shipment_id === shipment.id);
    const storageBadge = hasStorage ? '<span class="storage-badge">Storage</span>' : '';
    const totalCharge = `<td class="money-cell total-charge-cell"><strong>${escapeHtml(formatCurrency(displayedTotalCharge(shipment)))}</strong>${storageBadge}</td>`;
    const rowCells = state.pendingTableMode === 'ov'
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
    const showTotal = state.pendingTableMode === 'bv';
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
    const validIds = new Set(shipments.map((item) => item.id));
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
    const validIds = new Set(shipments.map((item) => item.id));
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

  function deliveryBreakdown(shipment) {
    const warehouseBooking = Boolean(shipment.warehouse_booking_pricing || shipment.current_status === 'pending_warehouse_booking');
    const pickup = shipment.current_status === 'completed' && shipment.outbound_method === 'picked_up';
    const calculation = calculateShipmentBilling({
      volume: shipment.volume_m3,
      unitPrice: shipment.unit_price,
      minimumBillableVolume: shipment.minimum_billable_volume || 1,
      tailLiftFee: shipment.tail_lift_service_fee,
      craneRequired: shipment.crane_required,
      craneFee: shipment.crane_truck_fee,
      fuelLevyRate: shipment.fuel_levy_rate,
      fuelLevyOverride: shipment.fuel_levy_override,
      gstRate: shipment.gst_rate,
      unbilledStorage: 0,
      warehouseBooking,
      warehouseBookingFee: shipment.warehouse_booking_charge,
      pickup,
      weight: shipment.weight_kg,
      pickupRatePerKg: shipment.pickup_rate_per_kg
    });
    if (warehouseBooking) {
      const amountExGst = Number(shipment.warehouse_booking_charge ?? 150);
      const gstRate = Number(shipment.gst_rate || 0);
      return { ...calculation, amountExGst, gstRate, gstAmount: amountExGst * gstRate, totalInclGst: amountExGst * (1 + gstRate) };
    }
    if (pickup) {
      const amountExGst = calculation.pickupCharge;
      const gstRate = Number(shipment.gst_rate || 0);
      return { ...calculation, amountExGst, gstRate, gstAmount: amountExGst === null ? null : amountExGst * gstRate, totalInclGst: calculation.total };
    }
    const gstRate = Number(shipment.gst_rate || 0);
    if (shipment.total_charge_override !== null && shipment.total_charge_override !== undefined) {
      const totalInclGst = Number(shipment.total_charge_override);
      const amountExGst = totalInclGst / (1 + gstRate);
      return { ...calculation, deliveryCharge: amountExGst, serviceFee: 0, fuelLevy: 0, amountExGst, gstRate, gstAmount: totalInclGst - amountExGst, totalInclGst };
    }
    const amountExGst = calculation.subtotal;
    return { ...calculation, amountExGst, gstRate, gstAmount: amountExGst === null ? null : amountExGst * gstRate, totalInclGst: calculation.total };
  }

  function renderBillingFilterOptions() {
    const customerValue = elements.billingCustomerFilter.value || 'all';
    elements.billingCustomerFilter.innerHTML = '<option value="all">All customers</option>' + state.customers
      .map((customer) => `<option value="${customer.id}">${escapeHtml(customer.name)}</option>`).join('');
    elements.billingCustomerFilter.value = [...elements.billingCustomerFilter.options].some((option) => option.value === customerValue) ? customerValue : 'all';
    const batchValue = elements.billingBatchFilter.value || 'all';
    elements.billingBatchFilter.innerHTML = '<option value="all">All import batches</option>' + state.importBatches
      .map((batch) => `<option value="${batch.id}">${escapeHtml(batch.source_file_name)} · ${escapeHtml(formatDateOnly(batch.imported_at))}</option>`).join('');
    elements.billingBatchFilter.value = [...elements.billingBatchFilter.options].some((option) => option.value === batchValue) ? batchValue : 'all';
  }

  function allBillingChargeRows() {
    const shipmentById = new Map(state.shipments.map((shipment) => [shipment.id, shipment]));
    const batchById = new Map(state.importBatches.map((batch) => [batch.id, batch]));
    const rows = [];
    state.shipments.forEach((shipment) => {
      const breakdown = deliveryBreakdown(shipment);
      rows.push({
        key: `delivery:${shipment.id}`, type: 'delivery', sourceId: shipment.id, shipment,
        customerId: shipment.customer_id, batchId: shipment.import_batch_id, container: shipmentContainerNumber(shipment),
        description: shipment.current_status === 'completed' && shipment.outbound_method === 'picked_up'
          ? 'Pickup Service'
          : shipment.warehouse_booking_pricing ? 'Warehouse Booking' : 'Delivery Total',
        amountExGst: breakdown.amountExGst, gstAmount: breakdown.gstAmount,
        totalInclGst: breakdown.totalInclGst, breakdown, billed: Boolean(shipment.delivery_billed_at)
      });
    });
    state.storageFees.forEach((fee) => {
      const shipment = shipmentById.get(fee.shipment_id);
      if (!shipment) return;
      const episode = state.storageEpisodes.find((item) => item.id === fee.episode_id);
      const gstRate = Number(episode?.gst_rate ?? shipment.gst_rate ?? 0);
      rows.push({
        key: `storage:${fee.id}`, type: 'storage', sourceId: fee.id, shipment,
        customerId: shipment.customer_id, batchId: shipment.import_batch_id, container: shipmentContainerNumber(shipment),
        description: `${formatDateOnly(fee.period_start)} - ${formatDateOnly(fee.period_end)}`,
        amountExGst: Number(fee.amount), gstAmount: Number(fee.amount) * gstRate,
        totalInclGst: Number(fee.amount) * (1 + gstRate), billed: Boolean(fee.billed_at), fee
      });
    });
    state.craneCharges.forEach((charge) => {
      const shipment = shipmentById.get(charge.shipment_id);
      if (!shipment || charge.cancelled_at) return;
      const amount = Number(charge.amount_ex_gst);
      const gst = amount * Number(charge.gst_rate || 0);
      rows.push({ key: `crane:${charge.id}`, type: 'crane', sourceId: charge.id, shipment,
        customerId: shipment.customer_id, batchId: shipment.import_batch_id, container: shipmentContainerNumber(shipment),
        description: 'Crane Truck Service', amountExGst: amount, gstAmount: gst,
        totalInclGst: amount + gst, billed: Boolean(charge.billed_at) });
    });
    state.containerFees.forEach((fee) => {
      const batch = batchById.get(fee.import_batch_id);
      rows.push({
        key: `container:${fee.id}`, type: 'container', sourceId: fee.id, shipment: null,
        customerId: batch?.customer_id, batchId: fee.import_batch_id, container: fee.container_number,
        description: 'Container Service Fee', amountExGst: fee.amount === null ? null : Number(fee.amount),
        gstAmount: fee.amount === null ? null : Number(fee.amount) * Number(fee.gst_rate || 0),
        totalInclGst: fee.amount === null ? null : Number(fee.amount) * (1 + Number(fee.gst_rate || 0)), billed: Boolean(fee.billed_at)
      });
    });
    return rows;
  }

  function finalisedBillingChargeRows() {
    return state.finalisedBillingItems.map((item) => {
      const snapshot = item.snapshot || {};
      const sourceShipment = snapshot.shipment || {};
      const shipment = item.shipment_id ? {
        ...sourceShipment,
        id: item.shipment_id,
        tracking_number: item.tracking_number,
        customer_reference: item.customer_reference,
        container_number: item.container_number
      } : null;
      const components = snapshot.actual_components || snapshot.components || [];
      const component = (description) => components.find((entry) => entry.description === description);
      const service = component('Crane Truck Service') || component('Tail Lift Service') || component('Warehouse Booking');
      const lastMile = component('Pickup Service') || component('Last Mile Delivery') || component('Delivery Total');
      const breakdown = item.charge_type === 'delivery' ? {
        deliveryCharge: lastMile ? Number(lastMile.amount_ex_gst || 0) : null,
        serviceFee: service ? Number(service.amount_ex_gst || 0) : 0,
        fuelLevy: Number(component('Fuel Levy')?.amount_ex_gst || 0)
      } : null;
      return {
        key: `billed:${item.id}`,
        type: item.charge_type,
        sourceId: item.source_id,
        shipment,
        customerId: sourceShipment.customer_id || state.finalisedBills.find((bill) => bill.id === item.bill_id)?.customer_id,
        batchId: item.import_batch_id,
        container: item.container_number,
        description: item.description,
        amountExGst: Number(item.amount_ex_gst),
        gstAmount: Number(item.gst_amount),
        totalInclGst: Number(item.total_incl_gst),
        breakdown,
        billed: true,
        finalisedItem: item
      };
    });
  }

  function billingChargeGroups() {
    const status = elements.billingStatusFilter.value;
    const rows = status === 'billed' ? finalisedBillingChargeRows() : allBillingChargeRows();
    const customer = elements.billingCustomerFilter.value;
    const batch = elements.billingBatchFilter.value;
    const container = normaliseSearch(elements.billingContainerFilter.value);
    const search = normaliseSearch(elements.billingSearch.value);
    const type = elements.billingChargeTypeFilter.value;
    const filtered = rows.filter((row) => {
      if (customer !== 'all' && row.customerId !== customer) return false;
      if (batch !== 'all' && row.batchId !== batch) return false;
      if (container && !normaliseSearch(row.container).includes(container)) return false;
      if (search && ![row.shipment?.tracking_number, row.shipment?.customer_reference, row.container].some((value) => normaliseSearch(value).includes(search))) return false;
      return true;
    });
    const groups = new Map();
    filtered.forEach((row) => {
      const key = row.shipment ? `shipment:${row.shipment.id}` : `container:${row.sourceId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return [...groups.entries()].filter(([, groupRows]) => {
      const relevant = type === 'all' ? groupRows : groupRows.filter((row) => row.type === type);
      if (!relevant.length) return false;
      const hasUnbilled = relevant.some((row) => !row.billed && row.totalInclGst !== null);
      return status === 'billed' ? relevant.every((row) => row.billed) : hasUnbilled;
    }).sort((left, right) => String(left[1][0].shipment?.tracking_number || left[1][0].container)
      .localeCompare(String(right[1][0].shipment?.tracking_number || right[1][0].container)));
  }

  function renderDraftBill() {
    elements.draftBillPanel.hidden = !state.activeDraft || !state.draftEditorOpen;
    elements.billingWorkspace.hidden = Boolean(state.activeDraft && state.draftEditorOpen);
    if (!state.activeDraft) return;
    const activeItems = state.draftItems.filter((item) => !state.draftRemovedItemIds.has(item.id));
    const shipmentCount = new Set(activeItems.map((item) => item.shipment_id).filter(Boolean)).size;
    const totals = draftTotals(state.draftItems, state.draftRemovedItemIds);
    elements.draftBillSummary.textContent = `${shipmentCount} shipments · ${activeItems.length} charges · Total (incl GST) ${formatCurrency(totals.total)}`;
    elements.draftBillTotals.innerHTML = `<span>Subtotal (ex GST) <strong>${escapeHtml(formatCurrency(totals.subtotal))}</strong></span><span>GST <strong>${escapeHtml(formatCurrency(totals.gst))}</strong></span><span>Total (incl GST) <strong>${escapeHtml(formatCurrency(totals.total))}</strong></span>`;
    const storageGroups = groupConsecutiveStoragePeriods(state.draftItems.filter((item) => item.charge_type === 'storage').map((item) => ({
      item, shipmentId: item.shipment_id, periodStart: item.snapshot?.storage_fee?.period_start,
      periodEnd: item.snapshot?.storage_fee?.period_end, rate: item.rate, gstRate: item.gst_rate
    }))).filter((group) => group[0].periodStart && group.some((entry) => !state.draftRemovedItemIds.has(entry.item.id)));
    const displayItems = activeItems.filter((item) => item.charge_type !== 'storage').map((item) => ({ item }))
      .concat(storageGroups.map((storageGroup) => ({ item: storageGroup[0].item, storageGroup })));
    elements.draftBillItems.innerHTML = displayItems.flatMap(({ item, storageGroup }) => {
      if (storageGroup) {
        const first = storageGroup[0];
        const included = storageGroup.filter((entry) => !state.draftRemovedItemIds.has(entry.item.id));
        const last = included.at(-1);
        return `<tr data-storage-item-ids="${storageGroup.map((entry) => entry.item.id).join(',')}">
          <td>${escapeHtml(item.container_number || '/')}</td><td>${escapeHtml(item.customer_reference || item.tracking_number || '/')}</td>
          <td>Storage ${escapeHtml(formatDateOnly(first.periodStart))} - ${escapeHtml(formatDateOnly(last.periodEnd))}</td>
          <td><input class="draft-cell-input" data-storage-quantity type="number" min="1" max="${storageGroup.length}" step="1" value="${included.length}" aria-label="Storage weeks"></td>
          <td><input class="draft-cell-input" data-storage-rate type="number" min="0" step="0.01" value="${Number(item.rate).toFixed(2)}"></td>
          <td>${escapeHtml(formatCurrency(included.reduce((sum, entry) => sum + Number(entry.item.amount_ex_gst || 0), 0)))}</td><td>${escapeHtml(`${Number(item.gst_rate || 0) * 100}%`)}</td>
          <td>${escapeHtml(formatCurrency(included.reduce((sum, entry) => sum + Number(entry.item.total_incl_gst || 0), 0)))}</td>
          <td><button class="table-icon-button danger" type="button" data-remove-storage-group title="Remove Storage weeks from Draft"><i class="ti ti-x"></i></button></td></tr>`;
      }
      const components = item.charge_type === 'delivery' && Array.isArray(item.snapshot?.actual_components)
        ? item.snapshot.actual_components
        : item.charge_type === 'delivery' && Array.isArray(item.snapshot?.components) ? item.snapshot.components : null;
      const rows = components || [{ description: item.description, quantity: item.quantity, rate: item.rate, amount_ex_gst: item.amount_ex_gst }];
      const componentRows = rows.map((component, componentIndex) => {
        const removed = component.removed === true;
        const percentageFuel = component.description === 'Fuel Levy' && component.rate_kind === 'percentage';
        const manualFuel = component.description === 'Fuel Levy' && component.rate_kind === 'manual';
        const rateCell = removed ? '/'
          : percentageFuel
          ? `<span class="draft-fuel-control"><select data-draft-fuel-mode aria-label="Fuel Levy calculation"><option value="percentage" selected>Rate</option><option value="manual">Manual</option></select><span class="draft-percent-input"><input class="draft-cell-input" data-draft-field="rate" data-rate-kind="percentage" type="number" min="0" max="100" step="0.01" value="${escapeHtml((Number(component.rate || 0) * 100).toFixed(2))}"><small>%</small></span></span>`
          : manualFuel ? '<span class="draft-fuel-control"><select data-draft-fuel-mode aria-label="Fuel Levy calculation"><option value="percentage">Rate</option><option value="manual" selected>Manual</option></select><span class="draft-manual-label">Manual</span></span>'
            : `<input class="draft-cell-input" data-draft-field="rate" type="number" min="0" step="0.01" value="${escapeHtml(Number(component.rate ?? component.amount_ex_gst ?? 0).toFixed(2))}">`;
        const subCell = removed ? '/'
          : manualFuel
          ? `<input class="draft-cell-input" data-draft-field="manual_amount" type="number" min="0" step="0.01" value="${escapeHtml(Number(component.manual_amount ?? component.amount_ex_gst ?? 0).toFixed(2))}" aria-label="Fuel Levy manual amount">`
          : escapeHtml(formatCurrency(component.amount_ex_gst));
        return `<tr data-draft-item="${item.id}" data-component-index="${componentIndex}">
          <td>${escapeHtml(item.container_number || '/')}</td><td>${escapeHtml(item.customer_reference || item.tracking_number || '/')}</td><td>${escapeHtml(component.description)}</td>
          <td>${removed ? '/' : `<input class="draft-cell-input" data-draft-field="quantity" type="number" min="0.001" step="0.001" value="${escapeHtml(component.quantity ?? 1)}">`}</td>
          <td>${rateCell}</td><td>${subCell}</td><td>${escapeHtml(`${Number(item.gst_rate || 0) * 100}%`)}</td><td>${escapeHtml(formatCurrency(Number(component.amount_ex_gst || 0) * (1 + Number(item.gst_rate || 0))))}</td>
          <td>${removed ? '' : `<button class="table-icon-button danger" type="button" ${components ? 'data-remove-draft-component' : `data-remove-draft-item="${item.id}"`} title="${components ? 'Set this component to no charge' : 'Remove billable item'}"><i class="ti ti-x"></i></button>`}</td></tr>`;
      });
      if (components && item.description !== 'Pickup Service') componentRows.push(`<tr class="draft-add-component-row" data-draft-item="${item.id}"><td></td><td></td><td colspan="6"><select data-add-draft-component-select aria-label="Charge to add"><option value="">Select a defined charge</option><option>Tail Lift Service</option><option>Fuel Levy</option><option>Crane Truck Service</option><option>Warehouse Booking</option></select><button class="secondary-button" type="button" data-add-draft-component>+ Add Charge</button></td><td></td></tr>`);
      return componentRows;
    }).join('');
    elements.discardDraftBillButton.hidden = !canManageBilling();
    elements.finaliseDraftBillButton.hidden = !canManageBilling();
    const dirty = state.draftEdits.size > 0 || state.draftRemovedItemIds.size > 0;
    elements.draftDirtyState.hidden = !dirty;
    elements.saveDraftChangesButton.disabled = !dirty;
    elements.discardDraftChangesButton.disabled = !dirty;
  }

  function renderBillingTable() {
    if (!elements.billingTableBody) return;
    renderBillingFilterOptions();
    const groups = billingChargeGroups();
    const rows = groups.flatMap(([, groupRows]) => groupRows);
    const visibleKeys = new Set(rows.filter((row) => !row.billed && row.totalInclGst !== null).map((row) => row.key));
    [...state.billingSelection].forEach((key) => { if (!visibleKeys.has(key)) state.billingSelection.delete(key); });
    elements.billingTableBody.innerHTML = groups.map(([groupKey, groupRows]) => {
      const shipment = groupRows[0].shipment;
      const activeType = elements.billingChargeTypeFilter.value;
      const currentRows = activeType === 'all' ? groupRows : groupRows.filter((row) => row.type === activeType);
      const selectable = currentRows.filter((row) => canManageBilling() && !row.billed && row.totalInclGst !== null);
      const allSelected = selectable.length > 0 && selectable.every((row) => state.billingSelection.has(row.key));
      const heading = shipment
        ? `<strong>${escapeHtml(shipment.tracking_number)}</strong><small>Container: ${escapeHtml(shipmentContainerNumber(shipment) || '/')} · Reference: ${escapeHtml(shipment.customer_reference || '/')}</small>`
        : `<strong>${escapeHtml(groupRows[0].container)}</strong><small>Import Batch container charge</small>`;
      const outstanding = currentRows.filter((row) => !row.billed && row.totalInclGst !== null);
      const displayRows = elements.billingStatusFilter.value === 'billed' ? currentRows : outstanding;
      const delivery = displayRows.find((row) => row.type === 'delivery');
      const storage = displayRows.filter((row) => row.type === 'storage');
      const crane = displayRows.find((row) => row.type === 'crane');
      const containerCharge = displayRows.find((row) => row.type === 'container');
      const gstAmount = displayRows.reduce((sum, row) => sum + Number(row.gstAmount || 0), 0);
      const total = displayRows.reduce((sum, row) => sum + Number(row.totalInclGst || 0), 0);
      const extras = groupRows.some((row) => ['storage', 'crane'].includes(row.type));
      const expanded = shipment && state.billingExpandedIds.has(shipment.id);
      const storageLabel = storage.length ? `${storage.length} ${storage.length === 1 ? 'week' : 'weeks'}` : '/';
      const service = delivery && delivery.description !== 'Pickup Service' ? delivery.breakdown?.serviceFee : crane?.amountExGst;
      const deliveryCell = delivery
        ? `${delivery.breakdown?.deliveryCharge === null ? '/' : escapeHtml(formatCurrency(delivery.breakdown?.deliveryCharge ?? delivery.amountExGst))}${delivery.description === 'Pickup Service' ? `<small class="billing-mode-note">${escapeHtml(`Pickup Service · ${Number(delivery.breakdown?.pickupWeight || 0).toFixed(3)} kg × ${formatCurrency(delivery.breakdown?.pickupRatePerKg || 0)}`)}</small>` : ''}`
        : containerCharge ? 'Container Service Fee' : '/';
      const main = `<tr class="billing-shipment-row ${allSelected ? 'selected-row' : ''}">
        <td class="check-cell"><input type="checkbox" data-billing-group="${escapeHtml(groupKey)}" ${allSelected ? 'checked' : ''} ${selectable.length ? '' : 'disabled'} aria-label="Select all unbilled charges"></td>
        <td><div class="billing-shipment-heading">${extras ? `<button type="button" data-billing-expand="${shipment?.id || ''}" aria-expanded="${expanded}"><i class="ti ti-chevron-${expanded ? 'down' : 'right'}"></i></button>` : ''}${heading}${groupRows.some((row) => row.type === 'storage') ? '<span class="storage-badge">Storage</span>' : ''}</div></td>
        <td>${deliveryCell}</td>
        <td>${service === undefined || service === null ? '/' : escapeHtml(formatCurrency(service))}${crane ? '<small>Crane Truck Service</small>' : ''}</td>
        <td>${delivery?.breakdown?.fuelLevy === null || delivery?.breakdown?.fuelLevy === undefined ? '/' : escapeHtml(formatCurrency(delivery.breakdown.fuelLevy))}</td>
        <td>${storage.length ? escapeHtml(storageLabel) : '/'}</td><td>${escapeHtml(formatCurrency(gstAmount))}</td><td><strong>${escapeHtml(formatCurrency(total))}</strong></td></tr>`;
      if (!expanded) return main;
      const children = (activeType === 'all' ? groupRows : currentRows).map((row) => {
        const disabled = !canManageBilling() || row.billed || row.totalInclGst === null;
        const checked = state.billingSelection.has(row.key);
        const typeLabel = row.type === 'delivery' ? row.description : row.type === 'storage' ? 'Storage' : row.type === 'crane' ? 'Crane Truck Service' : 'Container Service Fee';
        return `<tr data-row-id="${escapeHtml(row.key)}" class="billing-detail-row ${[disabled && 'billed', checked && 'selected-row'].filter(Boolean).join(' ')}" aria-selected="${checked}">
          <td class="check-cell">${disabled ? '' : `<input type="checkbox" data-billing-select="${escapeHtml(row.key)}" ${checked ? 'checked' : ''} aria-label="Select ${escapeHtml(typeLabel)}">`}</td>
          <td><strong>${escapeHtml(typeLabel)}</strong><small>${escapeHtml(row.description)}${row.billed ? ' · Billed' : ''}</small></td><td>${row.type === 'delivery' && row.breakdown?.deliveryCharge !== null ? escapeHtml(formatCurrency(row.breakdown?.deliveryCharge ?? row.amountExGst)) : '/'}</td>
          <td>${row.type === 'crane' ? escapeHtml(formatCurrency(row.amountExGst)) : row.type === 'delivery' && row.description !== 'Pickup Service' ? escapeHtml(formatCurrency(row.breakdown?.serviceFee || 0)) : '/'}</td>
          <td>${row.type === 'delivery' && row.description !== 'Pickup Service' ? escapeHtml(formatCurrency(row.breakdown?.fuelLevy || 0)) : '/'}</td><td>${row.type === 'storage' ? escapeHtml(formatCurrency(row.amountExGst)) : '/'}</td>
          <td>${escapeHtml(formatCurrency(row.gstAmount))}</td><td>${escapeHtml(formatCurrency(row.totalInclGst))}</td></tr>`;
      }).join('');
      return main + children;
    }).join('');
    elements.billingEmpty.hidden = groups.length > 0;
    elements.createBillButton.hidden = !canManageBilling();
    elements.createBillButton.disabled = !state.activeDraft && state.billingSelection.size === 0;
    elements.createBillButton.querySelector('span').textContent = state.activeDraft
      ? state.billingSelection.size ? 'Add to Draft' : 'Open Draft Bill'
      : 'Create Bill';
    const selectedRows = allBillingChargeRows().filter((row) => state.billingSelection.has(row.key));
    const selectedShipments = new Set(selectedRows.map((row) => row.shipment?.id || `container:${row.sourceId}`)).size;
    const selectedTotal = selectedRows.reduce((sum, row) => sum + Number(row.totalInclGst || 0), 0);
    elements.billingSelectionSummary.textContent = `${selectedShipments} Shipments · ${selectedRows.length} Charges · Total (incl GST) ${formatCurrency(selectedTotal)}`;
    renderDraftBill();
  }

  async function loadBillingData() {
    const [batchResult, containerResult, craneResult, draftResult, finalisedResult] = await Promise.all([
      state.client.from('import_batches').select('*').order('imported_at', { ascending: false }),
      state.client.from('container_service_fees').select('*').order('created_at', { ascending: false }),
      state.client.from('crane_service_charges').select('*').order('created_at', { ascending: false }),
      state.client.from('billing_documents').select('*').eq('status', 'draft').order('created_at', { ascending: false }).limit(1),
      state.client.from('billing_documents').select('*').eq('status', 'finalised').order('finalised_at', { ascending: false })
    ]);
    state.importBatches = batchResult.error ? [] : (batchResult.data || []);
    state.containerFees = containerResult.error ? [] : (containerResult.data || []);
    state.craneCharges = craneResult.error ? [] : (craneResult.data || []);
    state.activeDraft = draftResult.error ? null : (draftResult.data?.[0] || null);
    state.finalisedBills = finalisedResult.error ? [] : (finalisedResult.data || []);
    if (state.finalisedBills.length) {
      const { data, error } = await state.client.from('billing_items').select('*')
        .in('bill_id', state.finalisedBills.map((bill) => bill.id)).order('created_at', { ascending: false });
      state.finalisedBillingItems = error ? [] : (data || []);
    } else state.finalisedBillingItems = [];
    if (state.activeDraft) {
      const { data, error } = await state.client.from('billing_items').select('*').eq('bill_id', state.activeDraft.id).order('created_at');
      state.draftItems = error ? [] : (data || []);
    } else state.draftItems = [];
    state.draftEdits.clear();
    state.draftRemovedItemIds.clear();
  }

  async function createDraftBill() {
    if (state.activeDraft && state.billingSelection.size === 0) {
      state.draftEditorOpen = true;
      renderBillingTable();
      return;
    }
    const items = [...state.billingSelection].map((key) => {
      const [type, id] = key.split(':');
      return { type, id };
    });
    const rpc = state.activeDraft ? 'add_to_draft_bill' : 'create_draft_bill';
    const params = state.activeDraft ? { p_bill_id: state.activeDraft.id, p_items: items } : { p_items: items };
    const { error } = await state.client.rpc(rpc, params);
    if (error) {
      showToast(`Draft Bill could not be created: ${error.message}`, 'error');
      return;
    }
    state.billingSelection.clear();
    await loadBillingData();
    state.draftEditorOpen = true;
    renderBillingTable();
    showToast(state.activeDraft ? 'Charges added to Draft. They remain unbilled until Finalise succeeds.' : 'Draft Bill created.', 'success');
  }

  async function discardDraftBill() {
    if (!state.activeDraft) return;
    const confirmed = await showConfirmation({ title: 'Discard Draft Bill?', message: 'Discard this Draft Bill? Its charges will remain unbilled.', actionLabel: 'Discard Draft', showCancel: true, danger: true, returnFocus: elements.discardDraftBillButton });
    if (!confirmed) return;
    const { error } = await state.client.rpc('discard_draft_bill', { p_bill_id: state.activeDraft.id });
    if (error) return showToast(`Discard failed: ${error.message}`, 'error');
    await loadBillingData();
    renderBillingTable();
    showToast('Draft Bill discarded. Charges remain unbilled.', 'success');
  }

  async function removeDraftBillItem(itemId) {
    if (!state.activeDraft) return;
    const { error } = await state.client.rpc('remove_draft_bill_item', { p_bill_id: state.activeDraft.id, p_item_id: itemId });
    if (error) return showToast(`Charge could not be removed: ${error.message}`, 'error');
    await loadBillingData();
    state.draftEditorOpen = true;
    renderBillingTable();
  }

  function updateDraftComponent(input) {
    const row = input.closest('[data-draft-item]');
    const item = state.draftItems.find((entry) => entry.id === row?.dataset.draftItem);
    if (!item) return;
    const components = Array.isArray(item.snapshot?.actual_components)
      ? item.snapshot.actual_components
      : Array.isArray(item.snapshot?.components) ? item.snapshot.components.map((component) => ({ ...component })) : null;
    const component = components?.[Number(row.dataset.componentIndex)];
    const quantity = Number(row.querySelector('[data-draft-field="quantity"]')?.value || 1);
    const rateInput = row.querySelector('[data-draft-field="rate"]');
    const rate = Number(rateInput?.value || 0) / (rateInput?.dataset.rateKind === 'percentage' ? 100 : 1);
    if (component) {
      component.quantity = quantity;
      component.rate = rate;
      if (input.dataset.draftField === 'manual_amount') component.manual_amount = Number(input.value || 0);
      const calculated = recalculateDraftComponents(components, item.gst_rate);
      item.snapshot.actual_components = calculated.components;
      item.snapshot.components = calculated.components;
      item.amount_ex_gst = calculated.amountExGst;
      item.gst_amount = calculated.gstAmount;
      item.total_incl_gst = calculated.totalInclGst;
      item.quantity = 1;
      item.rate = calculated.amountExGst;
    } else {
      item.quantity = quantity;
      item.rate = rate;
      item.amount_ex_gst = quantity * rate;
      item.gst_amount = item.amount_ex_gst * Number(item.gst_rate || 0);
      item.total_incl_gst = item.amount_ex_gst + item.gst_amount;
    }
    state.draftEdits.set(item.id, {
      item_id: item.id,
      quantity: item.quantity || 1,
      rate: item.rate || item.amount_ex_gst,
      gst_rate: item.gst_rate,
      ...(components ? { actual_components: item.snapshot.actual_components } : {})
    });
    rerenderDraftKeepingFocus(input);
  }

  function rerenderDraftKeepingFocus(input) {
    const row = input.closest('[data-draft-item], [data-storage-item-ids]');
    const marker = row?.dataset.draftItem || row?.dataset.storageItemIds;
    const componentIndex = row?.dataset.componentIndex;
    const field = input.dataset.draftField || (input.matches('[data-storage-quantity]') ? 'storage-quantity' : 'storage-rate');
    const rawValue = input.value;
    const selection = [input.selectionStart, input.selectionEnd];
    renderDraftBill();
    const nextRow = [...elements.draftBillItems.querySelectorAll('[data-draft-item], [data-storage-item-ids]')].find((candidate) =>
      (candidate.dataset.draftItem || candidate.dataset.storageItemIds) === marker
        && (componentIndex === undefined || candidate.dataset.componentIndex === componentIndex));
    const selector = field === 'storage-quantity' ? '[data-storage-quantity]'
      : field === 'storage-rate' ? '[data-storage-rate]'
        : `[data-draft-field="${field}"]`;
    const nextInput = nextRow?.querySelector(selector);
    if (!nextInput) return;
    nextInput.value = rawValue;
    nextInput.focus({ preventScroll: true });
    if (selection.every((value) => value !== null)) {
      try { nextInput.setSelectionRange(...selection); } catch { /* Number inputs do not expose a text selection. */ }
    }
  }

  function updateDraftStorageGroup(input) {
    const row = input.closest('[data-storage-item-ids]');
    const ids = row?.dataset.storageItemIds.split(',') || [];
    const quantity = Math.max(1, Math.min(ids.length, Number(row.querySelector('[data-storage-quantity]').value || ids.length)));
    const rate = Math.max(0, Number(row.querySelector('[data-storage-rate]').value || 0));
    ids.forEach((id, index) => {
      const item = state.draftItems.find((entry) => entry.id === id);
      if (!item) return;
      if (index >= quantity) {
        state.draftRemovedItemIds.add(id);
        state.draftEdits.delete(id);
        return;
      }
      state.draftRemovedItemIds.delete(id);
      item.quantity = 1;
      item.rate = rate;
      item.amount_ex_gst = rate;
      item.gst_amount = rate * Number(item.gst_rate || 0);
      item.total_incl_gst = rate + item.gst_amount;
      state.draftEdits.set(id, { item_id: id, quantity: 1, rate, gst_rate: item.gst_rate });
    });
    rerenderDraftKeepingFocus(input);
  }

  function addDraftComponent(button) {
    const row = button.closest('[data-draft-item]');
    const item = state.draftItems.find((entry) => entry.id === row?.dataset.draftItem);
    const description = row?.querySelector('[data-add-draft-component-select]')?.value;
    if (!item || item.charge_type !== 'delivery' || !description) return;
    const components = (item.snapshot.actual_components || item.snapshot.components || []).map((component) => ({ ...component }));
    const existingIndex = components.findIndex((component) => component.description === description);
    if (existingIndex >= 0 && !components[existingIndex].removed) {
      showToast(`${description} is already in this Draft Actual.`, 'error');
      return;
    }
    const shipment = item.snapshot.shipment || {};
    const component = description === 'Fuel Levy'
      ? { description, quantity: 1, rate: Number(shipment.fuel_levy_rate ?? 0.2), rate_kind: 'percentage', amount_ex_gst: 0 }
      : { description, quantity: 1, rate: Number(description === 'Crane Truck Service' ? (shipment.crane_truck_fee ?? DEFAULT_CRANE_TRUCK_FEE) : description === 'Warehouse Booking' ? (shipment.warehouse_booking_charge ?? 150) : (shipment.tail_lift_service_fee ?? 0)), rate_kind: 'currency', amount_ex_gst: 0 };
    if (existingIndex >= 0) components.splice(existingIndex, 1, component);
    else components.push(component);
    const calculated = recalculateDraftComponents(components, item.gst_rate);
    item.snapshot.actual_components = calculated.components;
    item.snapshot.components = calculated.components;
    item.amount_ex_gst = calculated.amountExGst;
    item.gst_amount = calculated.gstAmount;
    item.total_incl_gst = calculated.totalInclGst;
    item.rate = calculated.amountExGst;
    state.draftEdits.set(item.id, { item_id: item.id, quantity: 1, rate: item.rate, gst_rate: item.gst_rate, actual_components: calculated.components });
    renderDraftBill();
  }

  function changeDraftFuelMode(select) {
    const row = select.closest('[data-draft-item]');
    const item = state.draftItems.find((entry) => entry.id === row?.dataset.draftItem);
    const components = (item?.snapshot.actual_components || item?.snapshot.components || []).map((component) => ({ ...component }));
    const component = components[Number(row?.dataset.componentIndex)];
    if (!item || component?.description !== 'Fuel Levy') return;
    if (select.value === 'manual') {
      component.rate_kind = 'manual';
      component.manual_amount = Number(component.amount_ex_gst || 0);
      component.rate = 0;
    } else {
      component.rate_kind = 'percentage';
      component.rate = Number(item.snapshot?.shipment?.fuel_levy_rate ?? 0.2);
      delete component.manual_amount;
    }
    const calculated = recalculateDraftComponents(components, item.gst_rate);
    item.snapshot.actual_components = calculated.components;
    item.snapshot.components = calculated.components;
    Object.assign(item, { amount_ex_gst: calculated.amountExGst, gst_amount: calculated.gstAmount, total_incl_gst: calculated.totalInclGst, rate: calculated.amountExGst });
    state.draftEdits.set(item.id, { item_id: item.id, quantity: 1, rate: item.rate, gst_rate: item.gst_rate, actual_components: calculated.components });
    renderDraftBill();
  }

  async function saveDraftChanges() {
    if (!state.activeDraft || (!state.draftEdits.size && !state.draftRemovedItemIds.size)) return;
    const { error } = await state.client.rpc('save_draft_bill_changes', {
      p_bill_id: state.activeDraft.id,
      p_changes: { changes: [...state.draftEdits.values()], remove_item_ids: [...state.draftRemovedItemIds] }
    });
    if (error) return showToast(`Draft changes could not be saved: ${error.message}`, 'error');
    await loadShipments({ quiet: true });
    state.draftEditorOpen = true;
    showToast('Draft Actual values were saved. Shipment Expected billing was not changed.', 'success');
  }

  async function finaliseDraftBill() {
    if (!state.activeDraft) return;
    if (state.draftEdits.size || state.draftRemovedItemIds.size) return showToast('Save or discard Draft changes before Finalise.', 'error');
    const shipmentCount = new Set(state.draftItems.map((item) => item.shipment_id).filter(Boolean)).size;
    const total = state.draftItems.reduce((sum, item) => sum + Number(item.total_incl_gst || 0), 0);
    const confirmed = await showConfirmation({ title: 'Finalise Bill?', message: `${shipmentCount} shipments · ${state.draftItems.length} charges · Total (incl GST): ${formatCurrency(total)}. Finalise atomically?`, actionLabel: 'Finalise', showCancel: true, danger: false, returnFocus: elements.finaliseDraftBillButton });
    if (!confirmed) return;
    const { error } = await state.client.rpc('finalise_draft_bill', { p_bill_id: state.activeDraft.id });
    if (error) return showToast(`Finalise failed: ${error.message}`, 'error');
    await loadShipments({ quiet: true });
    showToast('Bill finalised. Selected charges are now Billed.', 'success');
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
    renderBillingTable();
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

    if (error) {
      state.loading = false;
      showToast(`Unable to load shipments: ${error.message}`, 'error');
      return;
    }

    state.shipments = data || [];
    const [episodeResult, storageResult] = await Promise.all([
      state.client.from('storage_episodes').select('id, shipment_id, start_date, started_at, ended_at, rate_per_m3, volume_m3, gst_rate, created_at').order('started_at'),
      state.client.from('storage_fees').select('id, shipment_id, episode_id, period_start, period_end, amount, billed_at, bill_id, created_at').order('period_start', { ascending: true })
    ]);
    state.storageEpisodes = episodeResult.error ? [] : (episodeResult.data || []);
    state.storageFees = storageResult.error ? [] : (storageResult.data || []);
    state.storageSchedules.clear();
    await loadBillingData();
    state.loading = false;
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
    elements.billingProfilesNav.hidden = data.role !== 'admin';
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
      state.storageEpisodes = [];
      state.storageFees = [];
      state.storageSchedules.clear();
      state.billingProfiles = [];
      state.selectedIds.clear();
      state.historySelectedIds.clear();
      state.billingSelection.clear();
      state.activeDraft = null;
      state.draftItems = [];
      state.pendingTableMode = 'ov';
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
      await loadBillingProfiles();
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
    if (method === 'picked_up' && (!Number.isFinite(Number(shipment.weight_kg)) || Number(shipment.weight_kg) <= 0)) {
      showToast('Weight must be greater than zero before completing Shipment as Picked Up.', 'error');
      return;
    }
    if (method === 'picked_up' && (!Number.isFinite(Number(shipment.pickup_rate_per_kg)) || Number(shipment.pickup_rate_per_kg) <= 0)) {
      showToast('Pickup rate per kg must be greater than zero before completing Shipment as Picked Up.', 'error');
      return;
    }
    const label = OUTBOUND_LABELS[method] || method;
    if (!window.confirm(`Mark ${shipment.tracking_number} as ${label}?`)) return;

    const rowButtons = document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`);
    rowButtons.forEach((button) => { button.disabled = true; });

    const error = await transitionShipment(shipment, { kind: 'complete', outboundMethod: method });

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
    const shipments = selectedShipments();
    if (!shipments.length || !canCompleteShipments()) return;
    const label = OUTBOUND_LABELS[method] || method;
    if (!window.confirm(`Mark ${shipments.length} selected shipment${shipments.length === 1 ? '' : 's'} as ${label}?`)) return;

    elements.pendingBulkActions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const results = [];
    for (const shipment of shipments) {
      const error = shipment.current_status === 'exception'
        ? { message: 'Resolve the Exception from Shipment Details before completing the shipment' }
        : method === 'picked_up' && (!Number.isFinite(Number(shipment.weight_kg)) || Number(shipment.weight_kg) <= 0)
          ? { message: 'Weight must be greater than zero before completing Shipment as Picked Up' }
        : method === 'picked_up' && (!Number.isFinite(Number(shipment.pickup_rate_per_kg)) || Number(shipment.pickup_rate_per_kg) <= 0)
          ? { message: 'Pickup rate per kg must be greater than zero before completing Shipment as Picked Up' }
        : await transitionShipment(shipment, { kind: 'complete', outboundMethod: method });
      results.push({ shipment, error });
      if (!error) state.selectedIds.delete(shipment.id);
    }
    await loadShipments({ quiet: true });
    showBulkResults(`Mark as ${label}`, results);
  }

  async function resetSelectedShipmentsToPending() {
    const shipments = selectedShipments();
    if (!shipments.length || !canManageShipments()) return;

    elements.pendingBulkActions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const results = [];
    for (const shipment of shipments) {
      const error = shipment.current_status === 'exception'
        ? { message: 'Resolve the Exception from Shipment Details and record a resolution reason' }
        : shipment.current_status === 'pending' ? null : await transitionShipment(shipment, { kind: 'status', status: 'pending' });
      results.push({ shipment, error });
      if (!error) state.selectedIds.delete(shipment.id);
    }
    await loadShipments({ quiet: true });
    showBulkResults('Reset to Pending', results);
  }

  async function deleteSelectedShipments(selection = state.selectedIds, controls = elements.pendingBulkActions) {
    const shipments = state.shipments.filter((item) => selection.has(item.id));
    if (!shipments.length || !isAdministrator()) return;
    if (!await confirmRemoval()) return;

    controls.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const results = [];
    for (const shipment of shipments) {
      const { error } = await state.client.rpc('archive_shipment', { p_shipment_id: shipment.id });
      results.push({ shipment, error });
      if (!error) selection.delete(shipment.id);
    }
    await loadShipments({ quiet: true });
    showBulkResults('Remove shipment', results);
  }

  async function resumeSelectedHistoryShipments() {
    const shipments = state.shipments.filter((item) => state.historySelectedIds.has(item.id) && item.current_status === 'completed');
    if (!shipments.length || !canManageShipments()) return;

    elements.historyBulkActions.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const results = [];
    for (const shipment of shipments) {
      const error = await transitionShipment(shipment, { kind: 'resume' });
      results.push({ shipment, error });
      if (!error) state.historySelectedIds.delete(shipment.id);
    }
    await loadShipments({ quiet: true });
    showBulkResults('Resume to Pending', results);
  }

  async function changeDispatchStatus(shipment, status, button) {
    button.disabled = true;
    const error = await transitionShipment(shipment, { kind: 'status', status });
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
    elements.scheduledDateLabel.textContent = status === 'on_hold' ? 'Storage Start Date *' : 'Scheduled date *';
    elements.scheduledDateHint.textContent = status === 'on_hold'
      ? 'Defaults to Melbourne today. Existing Storage schedules are revised by Admin in Shipment Details.'
      : 'Short dates such as 8.12 are understood as 12 Aug 2026.';
    if (status === 'on_hold' && !elements.scheduledDateText.value.trim()) syncScheduledDate(todayInMelbourne());
    const shipment = state.shipments.find((item) => item.id === state.statusShipmentId);
    const lockedExistingStorage = status === 'on_hold' && shipment?.current_status === 'on_hold';
    elements.scheduledDateText.disabled = lockedExistingStorage;
    elements.openScheduledCalendarButton.disabled = lockedExistingStorage;
    elements.scheduledDateHint.textContent = lockedExistingStorage
      ? 'Use Shipment Details to revise an existing Storage Start Date.'
      : elements.scheduledDateHint.textContent;
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
    if (status === 'on_hold' && shipment.current_status !== 'on_hold') {
      const confirmed = await confirmStorageSchedulePreview(shipment, state.scheduledDateValue);
      if (!confirmed) return;
    }
    elements.saveStatusUpdateButton.disabled = true;
    elements.saveStatusUpdateButton.textContent = 'Updating...';
    const error = await transitionShipment(shipment, { kind: 'status', status, scheduledFor });
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
    const unitPrice = optionalNonNegativeNumber(shipment.unit_price);
    const tailLiftFee = optionalNonNegativeNumber(form.tail_lift_service_fee.value);
    const status = form.current_status.value;
    const isWarehouseBooking = status === 'pending_warehouse_booking'
      || (shipment.warehouse_booking_pricing && status === 'completed');
    const isPickup = status === 'completed' && shipment.outbound_method === 'picked_up';
    const craneRequired = !isWarehouseBooking && form.crane_required.value === 'positive';
    const craneFee = craneRequired ? optionalNonNegativeNumber(form.crane_truck_fee.value) : 0;
    const fuelLevyRate = optionalNonNegativeNumber(shipment.fuel_levy_rate) ?? 0;
    const gstRate = optionalNonNegativeNumber(shipment.gst_rate) ?? 0;
    const unbilledStorage = state.storageFees
      .filter((fee) => fee.shipment_id === shipment.id && !fee.billed_at)
      .reduce((total, fee) => total + Number(fee.amount || 0), 0);
    const unbilledStorageInclGst = state.storageFees
      .filter((fee) => fee.shipment_id === shipment.id && !fee.billed_at)
      .reduce((total, fee) => {
        const episode = state.storageEpisodes.find((item) => item.id === fee.episode_id);
        return total + Number(fee.amount || 0) * (1 + Number(episode?.gst_rate ?? shipment.gst_rate ?? 0));
      }, 0);
    const calculation = calculateShipmentBilling({
      volume,
      unitPrice,
      minimumBillableVolume: shipment.minimum_billable_volume || 1,
      tailLiftFee,
      craneRequired,
      craneFee,
      fuelLevyRate,
      fuelLevyOverride: form.fuel_levy_override.dataset.manualOverride === 'true' ? form.fuel_levy_override.value : null,
      gstRate,
      unbilledStorage,
      unbilledStorageInclGst,
      warehouseBooking: isWarehouseBooking,
      warehouseBookingFee: form.warehouse_booking_charge.value,
      pickup: isPickup,
      weight: form.weight_kg.value,
      pickupRatePerKg: shipment.pickup_rate_per_kg
    });

    return { shipment, form, volume, unitPrice, tailLiftFee, craneRequired, craneFee, fuelLevyRate, gstRate, status, isWarehouseBooking, isPickup, calculation, automaticTotal: calculation.total };
  }

  function renderBillingFormula({ updateTotal = true } = {}) {
    const values = editBillingValues();
    if (!values) return;
    const { shipment, form, volume, unitPrice, tailLiftFee, craneRequired, craneFee, gstRate, status, isWarehouseBooking, isPickup, calculation, automaticTotal } = values;
    if (isWarehouseBooking) form.crane_required.value = 'negative';
    elements.craneRequiredValue.textContent = form.crane_required.value === 'positive' ? 'Positive' : 'Negative';
    elements.toggleCraneRequiredButton.disabled = !canManageShipments() || isWarehouseBooking;
    elements.toggleCraneRequiredButton.setAttribute('aria-label', `Set Crane Required to ${form.crane_required.value === 'positive' ? 'Negative' : 'Positive'}`);
    elements.craneTruckFeeField.hidden = !craneRequired;
    elements.billingCraneTitle.textContent = craneRequired ? 'Crane Required' : 'Crane Not Required';
    elements.billingCraneValue.textContent = craneRequired ? formulaCurrency(craneFee) : '/';
    elements.warehouseBookingFeeField.hidden = !isWarehouseBooking;
    form.crane_truck_fee.required = craneRequired;
    form.tail_lift_service_fee.readOnly = craneRequired;
    form.total_charge_override.readOnly = true;
    form.tail_lift_service_fee.closest('.form-field').querySelector('span').textContent = craneRequired
      ? 'Tail Lift: Not applicable – Crane Service'
      : 'Tail Lift';
    elements.editStatusDateField.hidden = !['scheduled', 'on_hold'].includes(status);
    form.status_date.required = ['scheduled', 'on_hold'].includes(status);
    form.unit_price.value = unitPrice ?? '';
    form.billable_volume.value = calculation.billableVolume ?? '';

    if (updateTotal && form.total_charge_override.dataset.manualOverride !== 'true') {
      form.total_charge_override.value = automaticTotal === null ? '' : automaticTotal.toFixed(3);
    }
    if (form.fuel_levy_override.dataset.manualOverride !== 'true') {
      form.fuel_levy_override.value = calculation.fuelLevy === null ? '' : calculation.fuelLevy.toFixed(3);
    }

    if (isWarehouseBooking) {
      elements.billingFormula.innerHTML = `<span>TOTAL CHARGE</span><strong>Warehouse Booking ${escapeHtml(formulaCurrency(form.warehouse_booking_charge.value))} ex GST + unbilled Storage ${escapeHtml(formulaCurrency(calculation.storage))} ex GST + applicable GST = ${escapeHtml(formulaCurrency(automaticTotal))} incl GST.</strong>`;
      return;
    }

    if (isPickup) {
      if (calculation.pickupCharge === null) {
        elements.billingFormula.innerHTML = '<span>PICKUP SERVICE</span><strong>Weight and Pickup Rate must both be greater than zero.</strong>';
        return;
      }
      elements.billingFormula.innerHTML = `<span>PICKUP SERVICE</span><strong>${escapeHtml(`${Number(calculation.pickupWeight).toFixed(3)} kg × ${formatCurrency(calculation.pickupRatePerKg)} + unbilled Storage ${formatCurrency(calculation.storage)} ex GST + applicable GST = ${formatCurrency(automaticTotal)} incl GST`)}</strong>`;
      return;
    }

    if ([volume, unitPrice, calculation.fuelLevy].some((value) => value === null)) {
      elements.billingFormula.innerHTML = '<span>FORMULA</span><strong>Complete Volume and Unit Price to calculate the total.</strong>';
      return;
    }

    const serviceLabel = craneRequired ? 'Crane Truck Fee' : 'Tail Lift Fee';
    const symbolic = `(Billable Volume × Unit Price + ${serviceLabel} + Fuel Levy + Unbilled Storage Fees) × ${(1 + gstRate).toFixed(2)}`;
    const numeric = `(${formulaNumber(calculation.billableVolume)} × ${formulaCurrency(unitPrice)} + ${formulaCurrency(craneRequired ? craneFee : tailLiftFee)} + ${formulaNumber(calculation.fuelLevy, 3)} + ${formulaCurrency(calculation.storage)}) × ${(1 + gstRate).toFixed(2)} = ${formulaCurrency(automaticTotal)}`;
    const manualTotal = form.total_charge_override.dataset.manualOverride === 'true'
      ? `<small>Manual Total Charge: ${escapeHtml(formulaCurrency(optionalNonNegativeNumber(form.total_charge_override.value)))}</small>`
      : '';
    elements.billingFormula.innerHTML = `<span>FORMULA</span><strong>${escapeHtml(symbolic)}</strong><code>${escapeHtml(numeric)}</code>${manualTotal}`;
  }

  function syncEditStatusDate() {
    const form = elements.shipmentEditForm.elements;
    elements.editStatusDateField.hidden = !['scheduled', 'on_hold'].includes(form.current_status.value);
    elements.editStatusDateLabel.textContent = form.current_status.value === 'on_hold' ? 'Storage Start Date' : 'Scheduled Date';
    form.status_date.required = !elements.editStatusDateField.hidden;
    form.status_date.max = form.current_status.value === 'on_hold' ? datePickerValue(todayInMelbourne()) : '';
    const shipment = state.shipments.find((item) => item.id === state.editingShipmentId);
    form.status_date.min = form.current_status.value === 'on_hold' && shipment?.inbound_at
      ? datePickerValue(new Date(shipment.inbound_at)) : '';
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
    const originalStatus = form.current_status.dataset.originalValue || '';
    form.status_date.disabled = !editable || (originalStatus === 'on_hold' && form.current_status.value === 'on_hold' && !isAdministrator());
    elements.toggleCraneRequiredButton.disabled = !editable || form.current_status.value === 'pending_warehouse_booking';
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
    return transitionShipment(shipment, { kind: 'prepare_sms' });
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
    const selected = state.shipments.filter((shipment) => state.selectedIds.has(shipment.id));
    const prepared = selected.map((shipment) => ({ shipment, sms: shipmentSmsDetails(shipment) }))
      .filter(({ shipment, sms }) => shipmentSmsCanBePrepared(shipment) && sms);
    const preparedIds = new Set(prepared.map(({ shipment }) => shipment.id));
    const results = selected.filter((shipment) => !preparedIds.has(shipment.id)).map((shipment) => ({
      shipment,
      error: { message: shipmentSmsWasPrepared(shipment) ? 'SMS was already prepared' : shipment.current_status === 'exception' ? 'Resolve the Exception before preparing SMS' : 'A valid Australian mobile number is required' }
    }));
    if (!prepared.length) {
      showBulkResults('Prepare SMS', results);
      return;
    }
    const text = prepared.map(({ sms }) => `${formatAustralianMobile(sms.phone)}\n${sms.message}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showToast('The browser could not copy the SMS messages. Check clipboard permission and try again.', 'error');
      return;
    }
    for (const { shipment } of prepared) {
      const error = await markShipmentSmsPrepared(shipment);
      results.push({ shipment, error });
    }
    renderAll();
    showBulkResults(`Prepare SMS (${prepared.length} message${prepared.length === 1 ? '' : 's'} copied)`, results);
  }

  function syncEditingRowHighlight() {
    document.querySelectorAll('.shipment-table tr[data-row-id]').forEach((row) => {
      row.classList.toggle('details-open-row', row.dataset.rowId === state.editingShipmentId);
    });
  }

  function renderShipmentStorageFees(shipmentId) {
    const schedule = state.storageSchedules.get(shipmentId);
    if (!schedule) {
      const fees = state.storageFees.filter((fee) => fee.shipment_id === shipmentId);
      elements.shipmentStorageFees.innerHTML = fees.length ? fees.map((fee) => `
        <div class="storage-fee-row ${fee.billed_at ? 'billed' : ''}">
          <span>${escapeHtml(formatDateOnly(fee.period_start))} - ${escapeHtml(formatDateOnly(fee.period_end))}</span>
          <strong>${escapeHtml(formatCurrency(fee.amount))}</strong>
          ${fee.billed_at ? '<small>Billed</small>' : ''}
        </div>`).join('') : '<p class="empty-inline">No storage fees.</p>';
      return;
    }
    const episodes = Array.isArray(schedule.episodes) ? schedule.episodes : [];
    elements.shipmentStorageFees.innerHTML = episodes.length ? episodes.map((episode, episodeIndex) => {
      const weeks = Array.isArray(episode.weeks) ? episode.weeks : [];
      const showAll = state.storageShowAll.has(episode.episode_id);
      const visibleWeeks = showAll ? weeks : weeks.slice(-4);
      const history = Array.isArray(episode.billed_history) ? episode.billed_history : [];
      const creditWarning = Number(episode.credit_required_count || 0) > 0
        ? `<p class="storage-credit-warning"><strong>Storage Credit Required:</strong> ${escapeHtml(episode.credit_required_count)} ${Number(episode.credit_required_count) === 1 ? 'week' : 'weeks'} requires Admin review. No automatic refund or negative charge was created.</p>` : '';
      return `<section class="storage-episode">
        <div class="storage-episode-summary"><strong>Episode ${episodeIndex + 1}</strong><span>Storage Start Date: ${escapeHtml(formatDateOnly(episode.start_date))}</span><small>${escapeHtml(`${Number(episode.volume_m3).toFixed(4)} m³ × ${formatCurrency(episode.rate_per_m3)} / week = ${formatCurrency(episode.weekly_amount_ex_gst)} ex GST`)}</small><small>${episode.ended_at ? `Closed ${escapeHtml(formatDateOnly(episode.ended_at))}` : 'Open'}</small></div>
        ${creditWarning}
        <div class="storage-week-list">${visibleWeeks.map((week) => {
          const covered = week.status === 'covered_by_billed_credit';
          const missing = week.status === 'missing';
      return `<div class="storage-week-row ${covered ? 'covered' : ''}"><span>${escapeHtml(formatDateOnly(week.period_start))} - ${escapeHtml(formatDateOnly(week.period_end))}</span><strong>${escapeHtml(formatCurrency(week.amount_ex_gst))}</strong><small>${covered ? 'Covered by previous Bill' : missing ? 'Needs repair' : ''}</small></div>`;
        }).join('')}</div>
        ${weeks.length > 4 ? `<button class="storage-show-all" type="button" data-storage-show-all="${episode.episode_id}">${showAll ? 'Show recent weeks' : `Show all ${weeks.length} weeks`}</button>` : ''}
        ${history.length ? `<p class="storage-history-heading">Billed history</p><div class="storage-history-list">${history.map((fee) => `<div class="storage-week-row billed"><span>${escapeHtml(formatDateOnly(fee.period_start))} - ${escapeHtml(formatDateOnly(fee.period_end))}</span><strong>${escapeHtml(formatCurrency(fee.amount_ex_gst))}</strong><small>Billed</small></div>`).join('')}</div>` : ''}
      </section>`;
    }).join('') : '<p class="empty-inline">No storage schedule.</p>';
  }

  async function loadShipmentStorageSchedule(shipmentId) {
    elements.shipmentStorageFees.innerHTML = '<p class="empty-inline">Loading Storage schedule...</p>';
    const { data, error } = await state.client.rpc('get_storage_schedule', { p_shipment_id: shipmentId });
    if (state.editingShipmentId !== shipmentId) return;
    if (error) {
      elements.shipmentStorageFees.innerHTML = `<p class="empty-inline">${escapeHtml(error.message)}</p>`;
      return;
    }
    state.storageSchedules.set(shipmentId, data || { shipment_id: shipmentId, episodes: [] });
    renderShipmentStorageFees(shipmentId);
  }

  function renderShipmentBillingAdjustments(shipmentId) {
    const billStatus = new Map([
      ...state.finalisedBills.map((bill) => [bill.id, 'Finalised']),
      ...(state.activeDraft ? [[state.activeDraft.id, 'Draft']] : [])
    ]);
    const items = [...state.finalisedBillingItems, ...state.draftItems].filter((item) => item.shipment_id === shipmentId);
    const rows = items.flatMap((item) => {
      const expectedComponents = item.snapshot?.expected_components || [];
      const actualComponents = item.snapshot?.actual_components || item.snapshot?.components || [];
      const names = new Set([...expectedComponents, ...actualComponents].map((component) => component.description));
      const changedComponents = [...names].map((description) => {
        const expected = expectedComponents.find((component) => component.description === description);
        const actual = actualComponents.find((component) => component.description === description);
        const expectedAmount = Number(expected?.amount_ex_gst || 0);
        const actualAmount = Number(actual?.amount_ex_gst || 0);
        return { description, expectedAmount, actualAmount, difference: actualAmount - expectedAmount };
      }).filter((component) => Math.abs(component.difference) > 0.0005 || !expectedComponents.length);
      if (!changedComponents.length && item.charge_type !== 'crane') return [];
      return changedComponents.length ? changedComponents.map((component) => ({ ...component, status: billStatus.get(item.bill_id) || 'Draft' })) : [{
        description: item.description,
        expectedAmount: Number(item.snapshot?.expected?.amount_ex_gst ?? item.amount_ex_gst),
        actualAmount: Number(item.snapshot?.actual?.amount_ex_gst ?? item.amount_ex_gst),
        difference: Number(item.snapshot?.actual?.amount_ex_gst ?? item.amount_ex_gst) - Number(item.snapshot?.expected?.amount_ex_gst ?? item.amount_ex_gst),
        status: billStatus.get(item.bill_id) || 'Draft'
      }];
    });
    const representedCraneIds = new Set(items.filter((item) => item.charge_type === 'crane').map((item) => item.source_id));
    state.craneCharges.filter((charge) => charge.shipment_id === shipmentId && !charge.cancelled_at && !representedCraneIds.has(charge.id)).forEach((charge) => {
      rows.push({ description: 'Crane Truck Service', expectedAmount: Number(charge.amount_ex_gst), actualAmount: Number(charge.amount_ex_gst), difference: 0, status: charge.billed_at ? 'Billed' : 'Unbilled' });
    });
    elements.shipmentBillingAdjustments.innerHTML = rows.length ? rows.map((row) => `<div class="billing-adjustment-row">
      <strong>${escapeHtml(row.description)}</strong><span>Expected ${escapeHtml(formatCurrency(row.expectedAmount))}</span><span>Actual ${escapeHtml(formatCurrency(row.actualAmount))}</span><span>Difference ${escapeHtml(formatCurrency(row.difference))}</span><small>${escapeHtml(row.status)}</small>
    </div>`).join('') : '<p class="empty-inline">No billing adjustments or supplementary charges.</p>';
  }

  function billingActivityDetails(event) {
    if (event.event_type === 'details_updated') {
      const fields = Array.isArray(event.metadata?.changed_fields) ? event.metadata.changed_fields : [];
      const labels = Object.freeze({ tracking_number: 'Tracking Number', customer_id: 'Agent Customer', customer_reference: 'Customer Reference', container_number: 'Container Number', quantity: 'Quantity', total_quantity: 'Total Quantity', weight_kg: 'Weight', volume_m3: 'Volume', recipient_name: 'Recipient', phone: 'Phone', delivery_address: 'Delivery Address', suburb: 'Suburb', state: 'State', postcode: 'Postcode', inbound_at: 'Inbound Time', warehouse_location: 'Warehouse Location', delivery_instructions: 'Delivery Instructions', notes: 'Internal Notes', tail_lift_service_fee: 'Tail Lift Fee', crane_required: 'Crane Required', crane_truck_fee: 'Crane Truck Fee', fuel_levy_override: 'Fuel Levy Override', warehouse_booking_charge: 'Warehouse Booking Fee', exception_reason: 'Exception Reason', exception_resolution_reason: 'Exception Resolution Reason' });
      const oldValues = event.metadata?.old_values || {};
      const newValues = event.metadata?.new_values || {};
      const display = (value) => value === null || value === undefined || value === '' ? '/' : typeof value === 'boolean' ? (value ? 'Positive' : 'Negative') : String(value);
      const lines = fields.map((field) => `${labels[field] || field}: ${display(oldValues[field])} → ${display(newValues[field])}`);
      return [event.notes, event.metadata?.source, ...lines].filter(Boolean).map(escapeHtml).join('<br>');
    }
    if (event.event_type === 'storage_schedule_updated') {
      const metadata = event.metadata || {};
      const lines = [
        event.notes,
        metadata.source,
        metadata.old_start_date || metadata.new_start_date ? `Storage Start Date: ${metadata.old_start_date ? formatDateOnly(metadata.old_start_date) : '/'} → ${formatDateOnly(metadata.new_start_date)}` : '',
        Number(metadata.billed_credit_count || 0) ? `Billed credits retained: ${metadata.billed_credit_count} ${Number(metadata.billed_credit_count) === 1 ? 'week' : 'weeks'}` : '',
        Number(metadata.credit_required_count || 0) ? `Storage Credit Required: ${metadata.credit_required_count} ${Number(metadata.credit_required_count) === 1 ? 'week' : 'weeks'}` : '',
        metadata.reason ? `Reason: ${metadata.reason}` : ''
      ];
      return lines.filter(Boolean).map(escapeHtml).join('<br>');
    }
    if (event.event_type !== 'billing_updated') return escapeHtml(event.notes || '');
    const changes = Array.isArray(event.metadata?.changes) ? event.metadata.changes : [];
    const lines = changes.flatMap((change) => {
      const before = change.before_actual?.amount_ex_gst;
      const after = change.after_actual?.amount_ex_gst;
      const values = before === undefined && after === undefined ? '' : `: ${formatCurrency(before || 0)} -> ${after === null ? 'Removed from Draft' : formatCurrency(after || 0)}`;
      const summary = `${change.description || change.charge_type || 'Billing'}${values}`;
      const beforeComponents = Array.isArray(change.before_actual_components) ? change.before_actual_components : [];
      const afterComponents = Array.isArray(change.after_actual_components) ? change.after_actual_components : [];
      const names = new Set([...beforeComponents, ...afterComponents].map((component) => component.description));
      const componentLines = [...names].flatMap((description) => {
        const oldValue = beforeComponents.find((component) => component.description === description);
        const newValue = afterComponents.find((component) => component.description === description);
        if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
        if (description === 'Fuel Levy' && oldValue?.rate_kind === 'percentage' && newValue?.rate_kind === 'percentage') {
          return [`Fuel Levy Rate: ${Number(oldValue.rate || 0) * 100}% -> ${Number(newValue.rate || 0) * 100}%`];
        }
        if (description === 'Fuel Levy' && newValue?.rate_kind === 'manual') {
          return [`Fuel Levy Amount: ${formatCurrency(oldValue?.amount_ex_gst || 0)} -> ${formatCurrency(newValue.manual_amount || 0)}`];
        }
        return [`${description}: ${formatCurrency(oldValue?.amount_ex_gst || 0)} -> ${newValue?.removed ? '/' : formatCurrency(newValue?.amount_ex_gst || 0)}`];
      });
      return [summary, ...componentLines];
    });
    const source = event.metadata?.source ? `${event.metadata.source}${event.metadata.bill_id ? ` · Bill ${String(event.metadata.bill_id).slice(0, 8)}` : ''}` : '';
    return [event.notes, source, ...lines].filter(Boolean).map((line) => escapeHtml(line)).join('<br>');
  }

  async function loadShipmentActivity(shipmentId) {
    elements.shipmentActivityList.innerHTML = '<li class="empty-inline">Loading activity…</li>';
    const { data, error } = await state.client.from('shipment_events').select('*').eq('shipment_id', shipmentId).order('event_at', { ascending: false });
    if (state.editingShipmentId !== shipmentId) return;
    if (error) {
      elements.shipmentActivityList.innerHTML = `<li class="empty-inline">${escapeHtml(error.message)}</li>`;
      return;
    }
    const performerIds = [...new Set((data || []).map((event) => event.performed_by).filter(Boolean))];
    const performerNames = new Map();
    if (performerIds.length) {
      const profileResult = await state.client.from('profiles').select('id, full_name').in('id', performerIds);
      if (!profileResult.error) (profileResult.data || []).forEach((profile) => performerNames.set(profile.id, profile.full_name || 'Unknown user'));
    }
    if (state.editingShipmentId !== shipmentId) return;
    elements.shipmentActivityList.innerHTML = data?.length ? data.map((event) => {
      const transition = event.from_status || event.to_status
        ? `<span>${escapeHtml(STATUS_LABELS[event.from_status] || event.from_status || '/')} → ${escapeHtml(STATUS_LABELS[event.to_status] || event.to_status || '/')}</span>`
        : '';
      return `<li><div><strong>${escapeHtml((event.event_type || 'activity').replaceAll('_', ' '))}</strong>${transition}</div><p>${billingActivityDetails(event)}</p><small>${escapeHtml(formatDateTime(event.event_at))} · ${escapeHtml(event.performed_by ? (performerNames.get(event.performed_by) || 'Unknown user') : 'System')}</small></li>`;
    }).join('') : '<li class="empty-inline">No activity recorded.</li>';
  }

  async function resumeShipmentFromDetails() {
    const shipment = state.shipments.find((item) => item.id === state.editingShipmentId);
    if (!shipment || shipment.current_status !== 'completed') return;
    elements.resumeShipmentButton.disabled = true;
    const error = await transitionShipment(shipment, { kind: 'resume' });
    elements.resumeShipmentButton.disabled = false;
    if (error) {
      showToast(`Resume failed for ${shipmentReference(shipment)}: ${error.message}`, 'error');
      return;
    }
    closeShipmentModal();
    showToast(`${shipmentReference(shipment)} resumed to Pending.`, 'success');
    await loadShipments({ quiet: true });
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
    form.container_number.value = shipment.container_number || sourceData.container_number || '';
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
    form.unit_price.value = shipment.unit_price ?? '';
    form.billable_volume.value = shipment.volume_m3 === null || shipment.volume_m3 === undefined
      ? ''
      : Math.max(Number(shipment.volume_m3), Number(shipment.minimum_billable_volume || 1));
    form.crane_required.value = shipment.crane_required ? 'positive' : 'negative';
    const storedCraneFee = Number(shipment.crane_truck_fee);
    form.crane_truck_fee.value = shipment.crane_required && (!Number.isFinite(storedCraneFee) || storedCraneFee <= 0)
      ? DEFAULT_CRANE_TRUCK_FEE
      : (shipment.crane_truck_fee ?? DEFAULT_CRANE_TRUCK_FEE);
    form.fuel_levy_override.value = calculatedFuelLevy(shipment) ?? '';
    form.fuel_levy_override.dataset.manualOverride = shipment.fuel_levy_override !== null && shipment.fuel_levy_override !== undefined ? 'true' : 'false';
    const isWarehouseBooking = Boolean(shipment.warehouse_booking_pricing || shipment.current_status === 'pending_warehouse_booking');
    form.total_charge_override.value = isWarehouseBooking
      ? (displayedTotalCharge(shipment) ?? '')
      : (displayedTotalCharge(shipment) ?? '');
    form.total_charge_override.dataset.manualOverride = 'false';
    form.warehouse_booking_charge.value = shipment.warehouse_booking_charge ?? 150;
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
    loadShipmentStorageSchedule(shipment.id);
    renderShipmentBillingAdjustments(shipment.id);
    loadShipmentActivity(shipment.id);
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
    elements.resumeShipmentButton.hidden = !manageable || shipment.current_status !== 'completed';
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
      container_number: record.container_number || null,
      quantity,
      total_quantity: totalQuantity,
      weight_kg: optionalNonNegativeNumber(record.weight_kg),
      volume_m3: optionalNonNegativeNumber(record.volume_m3),
      tail_lift_service_fee: optionalNonNegativeNumber(record.tail_lift_service_fee) ?? 0,
      crane_required: craneRequired,
      crane_truck_fee: craneTruckFee ?? shipment.crane_truck_fee ?? 0,
      fuel_levy_override: form.fuel_levy_override.dataset.manualOverride === 'true'
        ? optionalNonNegativeNumber(record.fuel_levy_override)
        : null,
      total_charge_override: record.current_status === 'pending_warehouse_booking' ? null : shipment.total_charge_override,
      warehouse_booking_charge: optionalNonNegativeNumber(record.warehouse_booking_charge) ?? 150,
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
    if (record.current_status === 'on_hold' && statusNeedsUpdate) {
      if (shipment.current_status === 'on_hold' && !isAdministrator()) {
        showToast('Only an Admin can revise an existing Storage Start Date.', 'error');
        return;
      }
      const confirmed = await confirmStorageSchedulePreview(shipment, record.status_date);
      if (!confirmed) return;
    }

    elements.saveShipmentChangesButton.disabled = true;
    elements.saveShipmentChangesButton.textContent = 'Saving...';
    const { error } = await state.client.rpc('update_shipment_details', {
      p_shipment_id: shipment.id,
      p_payload: payload,
      p_new_status: record.current_status,
      p_notes: enteringException ? record.exception_reason : resolvingException ? record.exception_resolution_reason : null,
      p_scheduled_for: statusDateSource?.toISOString() || null
    });
    elements.saveShipmentChangesButton.disabled = false;
    elements.saveShipmentChangesButton.textContent = 'Save Changes';

    if (error) {
      const message = error.code === '23505' ? `Tracking number ${record.tracking_number} already exists.` : error.message;
      showToast(`Update failed: ${message}`, 'error');
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
    if (viewName === 'billing-profiles' && !isAdministrator()) viewName = 'pending';
    state.activeView = viewName;
    const pageLabels = {
      pending: 'Pending Shipments',
      intake: 'Add Received Shipment',
      billing: 'Billing',
      'billing-profiles': 'Billing Profiles',
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
    if (viewName === 'billing-profiles') renderBillingProfiles();

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
    if (!state.selectedIds.size || state.pendingTableMode === 'bv') return;
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

    elements.pendingSearch.addEventListener('input', () => { clearVisibleSelection('pending'); renderPendingTable(); });
    elements.pendingStatusFilter.addEventListener('change', () => { clearVisibleSelection('pending'); renderPendingTable(); });
    elements.completedSearch.addEventListener('input', () => { clearVisibleSelection('history'); renderCompletedTable(); });
    elements.outboundFilter.addEventListener('change', () => { clearVisibleSelection('history'); renderCompletedTable(); });
    [elements.billingCustomerFilter, elements.billingBatchFilter, elements.billingContainerFilter, elements.billingSearch, elements.billingChargeTypeFilter, elements.billingStatusFilter].forEach((control) => {
      const eventName = control.matches('input[type="search"]') ? 'input' : 'change';
      control.addEventListener(eventName, () => { clearVisibleSelection('billing'); renderBillingTable(); });
    });
    elements.pendingSortToggle.addEventListener('click', () => {
      state.pendingSortAscending = !state.pendingSortAscending;
      renderPendingTable();
    });
    elements.historySortToggle.addEventListener('click', () => {
      state.historySortAscending = !state.historySortAscending;
      renderCompletedTable();
    });
    elements.tableModeToggle.addEventListener('click', () => {
      clearVisibleSelection('pending');
      state.pendingTableMode = state.pendingTableMode === 'ov' ? 'bv' : 'ov';
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
    elements.billingTableBody.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-billing-select]');
      if (checkbox) {
        checkbox.checked ? state.billingSelection.add(checkbox.dataset.billingSelect) : state.billingSelection.delete(checkbox.dataset.billingSelect);
        renderBillingTable();
        return;
      }
      const group = event.target.closest('[data-billing-group]');
      if (!group) return;
      const [kind, id] = group.dataset.billingGroup.split(':');
      const activeType = elements.billingChargeTypeFilter.value;
      allBillingChargeRows().filter((row) => !row.billed && row.totalInclGst !== null
        && (activeType === 'all' || row.type === activeType)
        && (kind === 'shipment' ? row.shipment?.id === id : row.sourceId === id))
        .forEach((row) => { group.checked ? state.billingSelection.add(row.key) : state.billingSelection.delete(row.key); });
      renderBillingTable();
    });
    elements.billingTableBody.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-billing-expand]');
      if (!toggle) return;
      const id = toggle.dataset.billingExpand;
      state.billingExpandedIds.has(id) ? state.billingExpandedIds.delete(id) : state.billingExpandedIds.add(id);
      renderBillingTable();
    });
    elements.billingTableBody.addEventListener('mousedown', (event) => beginSelectionDrag(event, elements.billingTableBody, state.billingSelection, '[data-billing-select]', renderBillingTable));
    elements.billingTableBody.addEventListener('mouseover', continueSelectionDrag);
    elements.createBillButton.addEventListener('click', createDraftBill);
    elements.discardDraftBillButton.addEventListener('click', discardDraftBill);
    elements.finaliseDraftBillButton.addEventListener('click', finaliseDraftBill);
    elements.billingProfileList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-billing-profile]');
      if (!button || !isAdministrator()) return;
      state.selectedBillingProfileId = button.dataset.billingProfile;
      renderBillingProfiles();
    });
    elements.billingProfileForm.addEventListener('submit', saveBillingProfile);
    elements.backToBillingButton.addEventListener('click', () => { state.draftEditorOpen = false; renderBillingTable(); });
    elements.discardDraftChangesButton.addEventListener('click', async () => { await loadBillingData(); state.draftEditorOpen = true; renderBillingTable(); });
    elements.saveDraftChangesButton.addEventListener('click', saveDraftChanges);
    elements.draftBillItems.addEventListener('input', (event) => {
      if (event.target.matches('[data-draft-field]')) updateDraftComponent(event.target);
      if (event.target.matches('[data-storage-quantity], [data-storage-rate]')) updateDraftStorageGroup(event.target);
    });
    elements.draftBillItems.addEventListener('change', (event) => {
      if (event.target.matches('[data-draft-fuel-mode]')) changeDraftFuelMode(event.target);
    });
    elements.draftBillItems.addEventListener('click', (event) => {
      const storageButton = event.target.closest('[data-remove-storage-group]');
      if (storageButton) {
        storageButton.closest('[data-storage-item-ids]').dataset.storageItemIds.split(',').forEach((id) => state.draftRemovedItemIds.add(id));
        renderDraftBill();
        return;
      }
      const componentButton = event.target.closest('[data-remove-draft-component]');
      if (componentButton) {
        const row = componentButton.closest('[data-draft-item]');
        const item = state.draftItems.find((entry) => entry.id === row.dataset.draftItem);
        const components = (item?.snapshot.actual_components || item?.snapshot.components || []).map((component) => ({ ...component }));
        const component = components[Number(row.dataset.componentIndex)];
        Object.assign(component, { quantity: 1, rate: 0, manual_amount: 0, rate_kind: 'currency', amount_ex_gst: 0, removed: true });
        if (components.every((entry) => entry.removed)) return showToast('Remove the Delivery Total from Draft instead of deleting its last component.', 'error');
        const calculated = recalculateDraftComponents(components, item.gst_rate);
        item.snapshot.actual_components = calculated.components;
        item.snapshot.components = calculated.components;
        Object.assign(item, { amount_ex_gst: calculated.amountExGst, gst_amount: calculated.gstAmount, total_incl_gst: calculated.totalInclGst, rate: calculated.amountExGst });
        state.draftEdits.set(item.id, { item_id: item.id, quantity: 1, rate: item.rate, gst_rate: item.gst_rate, actual_components: calculated.components });
        renderDraftBill();
        return;
      }
      const addComponentButton = event.target.closest('[data-add-draft-component]');
      if (addComponentButton) {
        addDraftComponent(addComponentButton);
        return;
      }
      const button = event.target.closest('[data-remove-draft-item]');
      if (button) {
        state.draftRemovedItemIds.add(button.dataset.removeDraftItem);
        state.draftEdits.delete(button.dataset.removeDraftItem);
        renderDraftBill();
      }
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
      if (event.target.name === 'warehouse_booking_charge') {
        elements.shipmentEditForm.elements.total_charge_override.dataset.manualOverride = 'false';
      }
      if (['volume_m3', 'tail_lift_service_fee', 'crane_truck_fee', 'fuel_levy_override', 'warehouse_booking_charge'].includes(event.target.name)) {
        renderBillingFormula();
      }
    });
    elements.toggleCraneRequiredButton.addEventListener('click', () => {
      const form = elements.shipmentEditForm.elements;
      const positive = form.crane_required.value !== 'positive';
      form.crane_required.value = positive ? 'positive' : 'negative';
      if (positive) {
        const craneFeeField = form.crane_truck_fee;
        if (!Number.isFinite(Number(craneFeeField.value)) || Number(craneFeeField.value) <= 0) {
          craneFeeField.value = String(DEFAULT_CRANE_TRUCK_FEE);
        }
        craneFeeField.classList.remove('crane-fee-flash', 'crane-fee-border-lit');
        void craneFeeField.offsetWidth;
        craneFeeField.classList.add('crane-fee-flash');
      }
      renderBillingFormula();
    });
    elements.shipmentEditForm.addEventListener('change', (event) => {
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
      if (['current_status', 'status_date'].includes(event.target.name)) {
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
    elements.resumeShipmentButton.addEventListener('click', resumeShipmentFromDetails);
    elements.toggleWarehouseBookingFeeButton.addEventListener('click', () => {
      const field = elements.shipmentEditForm.elements.warehouse_booking_charge;
      field.value = Number(field.value) === 150 ? '200' : '150';
      elements.shipmentEditForm.elements.total_charge_override.dataset.manualOverride = 'false';
      renderBillingFormula();
    });
    elements.shipmentStorageFees.addEventListener('click', (event) => {
      const button = event.target.closest('[data-storage-show-all]');
      if (!button) return;
      const episodeId = button.dataset.storageShowAll;
      state.storageShowAll.has(episodeId) ? state.storageShowAll.delete(episodeId) : state.storageShowAll.add(episodeId);
      if (state.editingShipmentId) renderShipmentStorageFees(state.editingShipmentId);
    });
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
    elements.sidebar.addEventListener('mouseenter', () => {
      window.clearTimeout(sidebarCloseTimer);
      if (window.matchMedia('(min-width: 901px)').matches) elements.sidebar.classList.add('desktop-open');
    });
    elements.sidebar.addEventListener('mouseleave', () => {
      window.clearTimeout(sidebarCloseTimer);
      sidebarCloseTimer = window.setTimeout(() => elements.sidebar.classList.remove('desktop-open'), 200);
    });

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
