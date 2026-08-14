/**
 * Bentway Logistics - Google Sheets delivery workflow
 *
 * Sheet layout:
 *   Delivering Page: J = 派送状态, K = ADT/ETA, L = 入仓时间
 *   Delivered Page:  J = 派送状态, K = 完成日期, L = 入仓时间
 *
 * Run setupDeliveryAutomation() once after pasting this file into the
 * spreadsheet's bound Apps Script project.
 */

const DELIVERY_CONFIG = Object.freeze({
  deliveringSheet: 'Delivering Page',
  deliveredSheet: 'Delivered Page',
  headerRow: 1,
  firstDataRow: 2,
  statusColumn: 10,        // J
  completedDateColumn: 11, // K
  inboundDateColumn: 12,   // L
  statusHeader: '派送状态',
  sourceScheduleHeader: 'ADT/ETA',
  completedDateHeader: '完成日期',
  inboundDateHeader: '入仓时间',
  containerHeader: '柜号',
  orderHeader: '单号',
  deliveredValue: 'Delivered',
  restoreValue: 'Restore',
  departedValue: '已出仓',
  completedDateFormat: 'yyyy-MM-dd',
  completedDateTimeFormat: 'yyyy-MM-dd HH:mm',
  deliveredRowBackground: '#ff9900',
  deliveredRowFontColor: '#000000',
  highlightHelperHeader: '_系统_恢复高亮截止',
  originalScheduleNoteHeader: '_系统_原派送备注时间',
  originalRowColorsHeader: '_系统_原A到K颜色',
  highlightRuleMarker: 'BENTWAY_RESTORE_HIGHLIGHT',
  editHandlerName: 'handleDeliveryEdit'
});

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('配送管理')
    .addItem('初始化 / 刷新配置', 'setupDeliveryAutomation')
    .addItem('处理所有已选择的 Delivered', 'processAllSelectedDeliveries')
    .addToUi();
}

/**
 * Manual fallback. Normally the edit trigger processes these rows automatically,
 * but this menu item also catches any edits Google did not queue.
 */
function processAllSelectedDeliveries() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = requireSheet_(spreadsheet, DELIVERY_CONFIG.deliveringSheet);
  handleDeliveryEdit({
    source: spreadsheet,
    range: sheet.getRange(
      DELIVERY_CONFIG.firstDataRow,
      DELIVERY_CONFIG.statusColumn
    )
  });
}

/**
 * Run once as the spreadsheet owner. This prepares headers, dropdowns,
 * temporary restore highlighting and the installable edit trigger.
 */
function setupDeliveryAutomation() {
  const context = ensureConfiguration_();
  installEditTrigger_(context.spreadsheet);
  SpreadsheetApp.flush();
  context.spreadsheet.toast(
    'J列下拉选项和自动触发器已安装。请逐行选择 Delivered 进行测试。',
    '配置完成',
    8
  );
}

/**
 * Installable on-edit trigger. Do not run this function manually.
 */
function handleDeliveryEdit(event) {
  if (!event || !event.range) return;

  const range = event.range;
  const sheet = range.getSheet();
  const sheetName = sheet.getName();
  const config = DELIVERY_CONFIG;

  if (sheetName !== config.deliveringSheet && sheetName !== config.deliveredSheet) return;
  if (range.getLastRow() < config.firstDataRow) return;
  const editsStatusColumn =
    range.getColumn() <= config.statusColumn && range.getLastColumn() >= config.statusColumn;
  const editsAdtEtaColumn =
    sheetName === config.deliveringSheet &&
    range.getColumn() <= config.completedDateColumn &&
    range.getLastColumn() >= config.completedDateColumn;
  if (!editsStatusColumn && !editsAdtEtaColumn) return;

  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = event.source || SpreadsheetApp.getActiveSpreadsheet();
    const deliveringSheet = requireSheet_(spreadsheet, config.deliveringSheet);
    const deliveredSheet = requireSheet_(spreadsheet, config.deliveredSheet);

    // Editing ADT/ETA means the user has acted on the previous warning. Remove
    // the stale note; the value will be checked again when Delivered is selected.
    if (editsAdtEtaColumn) {
      const noteFirstRow = Math.max(config.firstDataRow, range.getRow());
      const noteLastRow = range.getLastRow();
      deliveringSheet.getRange(
        noteFirstRow,
        config.statusColumn,
        noteLastRow - noteFirstRow + 1,
        1
      ).clearNote();
    }
    if (!editsStatusColumn) return;

    // Delivering Page scans all statuses to catch rapid edits. Restore only
    // processes rows included in this edit event, preventing mass restoration.
    const firstRow = sheetName === config.deliveringSheet
      ? config.firstDataRow
      : Math.max(config.firstDataRow, range.getRow());
    const lastRow = sheetName === config.deliveringSheet
      ? sheet.getLastRow()
      : range.getLastRow();
    if (lastRow < firstRow) return;
    const statusValues = sheet.getRange(
      firstRow,
      config.statusColumn,
      lastRow - firstRow + 1,
      1
    ).getDisplayValues();
    // Duplicate warnings are snapshots from an earlier Restore attempt. Clear
    // them whenever the Delivered Page status is edited, then perform a fresh
    // duplicate check against the current Delivering Page data.
    if (sheetName === config.deliveredSheet) {
      deliveredSheet.getRange(
        firstRow,
        config.statusColumn,
        lastRow - firstRow + 1,
        1
      ).clearNote();
    }
    let movedCount = 0;
    let reconciledDuplicateCount = 0;
    let restoredCount = 0;
    let lastRestoredRow = null;
    const blockedMessages = [];
    const restoreWarnings = [];

    // Work from bottom to top because moving a row deletes it from its source sheet.
    for (let row = lastRow; row >= firstRow; row -= 1) {
      const status = normalizeText_(statusValues[row - firstRow][0]);

      if (sheetName === config.deliveringSheet && status === normalizeText_(config.deliveredValue)) {
        const deliveryTime = readAdtEta_(spreadsheet, deliveringSheet, row);
        if (!deliveryTime.ok) {
          deliveringSheet.getRange(row, config.statusColumn)
            .clearContent()
            .setDataValidation(deliveringPageValidation_())
            .setNote(deliveryTime.message);
          blockedMessages.push('第 ' + row + ' 行：' + deliveryTime.message);
          continue;
        }
        deliveringSheet.getRange(row, config.statusColumn).clearNote();
        const existingDeliveredRow = findDuplicateOrderRow_(
          deliveringSheet,
          row,
          deliveredSheet
        );
        moveRowToDelivered_(
          deliveringSheet,
          deliveredSheet,
          row,
          deliveryTime.date,
          deliveryTime.hasTime,
          existingDeliveredRow
        );
        if (existingDeliveredRow !== null) reconciledDuplicateCount += 1;
        movedCount += 1;
      } else if (sheetName === config.deliveredSheet && status === normalizeText_(config.restoreValue)) {
        const duplicateRow = findDuplicateOrderRow_(deliveredSheet, row, deliveringSheet);
        if (duplicateRow !== null) {
          const message = '相同单号已存在于 Delivering Page 第 ' + duplicateRow + ' 行，已阻止重复恢复。';
          deliveredSheet.getRange(row, config.statusColumn)
            .setValue(config.deliveredValue)
            .setDataValidation(deliveredPageValidation_())
            .setNote(message);
          restoreWarnings.push('第 ' + row + ' 行：' + message);
          continue;
        }
        lastRestoredRow = restoreRowToDelivering_(deliveredSheet, deliveringSheet, row);
        restoredCount += 1;
      }
    }

    if (movedCount > 0) {
      sortDeliveredSheet_(deliveredSheet);
      applyPendingDeliveredColors_(deliveredSheet);
      spreadsheet.toast(
        movedCount + ' 票货物已移至 “' + config.deliveredSheet + '”' +
          (reconciledDuplicateCount > 0
            ? '（其中 ' + reconciledDuplicateCount + ' 票已合并到现有相同单号记录）'
            : ''),
        '派送状态已更新',
        5
      );
    }

    if (restoredCount > 0) {
      spreadsheet.toast(
        restoredCount + ' 票货物已恢复到 “' + config.deliveringSheet + '”' +
          (lastRestoredRow ? '（最后一票位于第 ' + lastRestoredRow + ' 行）' : ''),
        '恢复完成',
        8
      );
    }

    if (blockedMessages.length > 0) {
      spreadsheet.toast(
        blockedMessages.slice(0, 3).join('\n') +
          (blockedMessages.length > 3 ? '\n另外 ' + (blockedMessages.length - 3) + ' 行未移动。' : ''),
        '未标记为 Delivered',
        12
      );
    }

    if (restoreWarnings.length > 0) {
      spreadsheet.toast(
        restoreWarnings.slice(0, 3).join('\n') +
          (restoreWarnings.length > 3 ? '\n另外 ' + (restoreWarnings.length - 3) + ' 行未恢复。' : ''),
        'Restore未执行',
        12
      );
    }
  } finally {
    lock.releaseLock();
  }
}

function ensureConfiguration_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const config = DELIVERY_CONFIG;
  const deliveringSheet = requireSheet_(spreadsheet, config.deliveringSheet);
  const deliveredSheet = requireSheet_(spreadsheet, config.deliveredSheet);

  ensureColumnCount_(deliveringSheet, config.inboundDateColumn);
  ensureColumnCount_(deliveredSheet, config.inboundDateColumn);

  requireOrSetHeader_(deliveringSheet, config.statusColumn, config.statusHeader);
  requireOrSetHeader_(deliveringSheet, config.completedDateColumn, config.sourceScheduleHeader);
  requireOrSetHeader_(deliveringSheet, config.inboundDateColumn, config.inboundDateHeader);
  requireOrSetHeader_(deliveredSheet, config.statusColumn, config.statusHeader);
  requireOrSetHeader_(deliveredSheet, config.completedDateColumn, config.completedDateHeader);
  if (!findHeaderColumn_(deliveringSheet, config.containerHeader)) {
    throw new Error(
      '工作表 “' + config.deliveringSheet + '” 中找不到标题 “' +
      config.containerHeader + '”，无法按柜号恢复。'
    );
  }

  synchronizeBusinessHeaders_(deliveringSheet, deliveredSheet);
  removeRestoreHighlighting_(deliveringSheet);
  // Older versions could copy the restore conditional-format rule together
  // with a row. Remove that marked rule from the archive page as well; otherwise
  // its yellow display overrides the new orange cell background.
  removeRestoreHighlighting_(deliveredSheet);
  ensureOriginalScheduleNoteColumn_(deliveredSheet);
  ensureOriginalRowColorsColumn_(deliveredSheet);
  applyDropdowns_(deliveringSheet, deliveredSheet);

  return {
    spreadsheet: spreadsheet,
    deliveringSheet: deliveringSheet,
    deliveredSheet: deliveredSheet
  };
}

function moveRowToDelivered_(
  sourceSheet,
  targetSheet,
  sourceRow,
  deliveredAt,
  hasTime,
  existingTargetRow
) {
  const config = DELIVERY_CONFIG;
  // Ctrl+Z cannot atomically undo a cross-sheet script move. If it brings an
  // archived record back while the restored copy still exists, update the
  // existing matching order instead of appending a second archive row.
  const targetRow = existingTargetRow === null || existingTargetRow === undefined
    ? nextAppendRow_(targetSheet)
    : existingTargetRow;
  const originalScheduleCell = sourceSheet.getRange(sourceRow, config.completedDateColumn);
  const originalScheduleNote = originalScheduleCell.getValue();
  const originalScheduleNoteFormat = originalScheduleCell.getNumberFormat();
  const colorRange = sourceSheet.getRange(sourceRow, 1, 1, config.completedDateColumn);
  const originalRowColors = JSON.stringify({
    backgrounds: colorRange.getBackgrounds()[0],
    fontColors: colorRange.getFontColors()[0],
    pendingDeliveredColor: true
  });

  copyRowFormat_(sourceSheet, sourceRow, targetSheet, targetRow);
  copyRowByMatchingHeaders_(sourceSheet, sourceRow, targetSheet, targetRow, [
    config.highlightHelperHeader,
    config.originalRowColorsHeader,
    config.sourceScheduleHeader,
    config.statusHeader
  ]);

  targetSheet.getRange(targetRow, config.statusColumn)
    .setValue(config.deliveredValue)
    .setDataValidation(deliveredPageValidation_());
  targetSheet.getRange(targetRow, config.completedDateColumn)
    .setValue(deliveredAt)
    .setNumberFormat(hasTime ? config.completedDateTimeFormat : config.completedDateFormat);
  const originalScheduleNoteColumn = ensureOriginalScheduleNoteColumn_(targetSheet);
  targetSheet.getRange(targetRow, originalScheduleNoteColumn)
    .setValue(originalScheduleNote)
    .setNumberFormat(originalScheduleNoteFormat);
  const originalRowColorsColumn = ensureOriginalRowColorsColumn_(targetSheet);
  targetSheet.getRange(targetRow, originalRowColorsColumn).setValue(originalRowColors);

  SpreadsheetApp.flush();
  sourceSheet.deleteRow(sourceRow);
}

function restoreRowToDelivering_(sourceSheet, targetSheet, sourceRow) {
  const config = DELIVERY_CONFIG;
  const sourceHeaderMap = headerMap_(sourceSheet);
  const sourceValues = sourceSheet.getRange(sourceRow, 1, 1, sourceSheet.getLastColumn()).getValues()[0];
  const sourceDisplayValues = sourceSheet.getRange(sourceRow, 1, 1, sourceSheet.getLastColumn()).getDisplayValues()[0];
  const sourceInboundColumn = sourceHeaderMap[config.inboundDateHeader];
  const sourceContainerColumn = sourceHeaderMap[config.containerHeader];
  const sourceCompletedDateColumn = sourceHeaderMap[config.completedDateHeader] || config.completedDateColumn;
  const originalScheduleNoteColumn = sourceHeaderMap[config.originalScheduleNoteHeader];
  const inboundValue = sourceInboundColumn ? sourceValues[sourceInboundColumn - 1] : '';
  const inboundDisplay = sourceInboundColumn ? sourceDisplayValues[sourceInboundColumn - 1] : '';
  const containerValue = sourceContainerColumn ? sourceValues[sourceContainerColumn - 1] : '';
  const containerDisplay = sourceContainerColumn ? sourceDisplayValues[sourceContainerColumn - 1] : '';
  const originalScheduleNote = originalScheduleNoteColumn
    ? sourceValues[originalScheduleNoteColumn - 1]
    : '';
  const originalScheduleDisplay = originalScheduleNoteColumn
    ? String(sourceDisplayValues[originalScheduleNoteColumn - 1] || '').trim()
    : '';
  const originalScheduleNoteFormat = originalScheduleNoteColumn
    ? sourceSheet.getRange(sourceRow, originalScheduleNoteColumn).getNumberFormat()
    : 'General';
  const completedDateValue = sourceValues[sourceCompletedDateColumn - 1];
  const completedDateFormat = sourceSheet.getRange(sourceRow, sourceCompletedDateColumn).getNumberFormat();
  // Records archived by an older script version may not have an ADT/ETA backup.
  // Fall back to the Delivered Page completion date so the restored row never
  // has an unusable blank K cell and can be marked Delivered again if needed.
  const restoredScheduleValue = originalScheduleDisplay !== ''
    ? originalScheduleNote
    : completedDateValue;
  const restoredScheduleFormat = originalScheduleDisplay !== ''
    ? originalScheduleNoteFormat
    : completedDateFormat;
  const targetRow = findRestoreTargetRow_(
    targetSheet,
    inboundValue,
    inboundDisplay,
    containerValue,
    containerDisplay
  );

  makeRoomForRow_(targetSheet, targetRow);
  try {
    copyRowFormat_(sourceSheet, sourceRow, targetSheet, targetRow);
    copyRowByMatchingHeaders_(sourceSheet, sourceRow, targetSheet, targetRow, [
      config.completedDateHeader,
      config.highlightHelperHeader,
      config.originalRowColorsHeader,
      config.statusHeader
    ]);

    targetSheet.getRange(targetRow, config.statusColumn)
      .clearContent()
      .setDataValidation(deliveringPageValidation_());

    // K on delivering page belongs to the user's scheduling workflow. It is never
    // used as a trigger. Prefer the hidden backup; older records fall back to
    // their Delivered Page completion date.
    targetSheet.getRange(targetRow, config.completedDateColumn)
      .setValue(restoredScheduleValue)
      .setNumberFormat(restoredScheduleFormat);

    const restoredColorRange = targetSheet.getRange(
      targetRow,
      1,
      1,
      config.completedDateColumn
    );
    // Restored rows deliberately keep the completed-state orange so they are
    // easy to locate in Delivering Page. This is a permanent cell color, not
    // the removed timed yellow highlight.
    restoredColorRange
      .setBackground(config.deliveredRowBackground)
      .setFontColor(config.deliveredRowFontColor);

    SpreadsheetApp.flush();
    sourceSheet.deleteRow(sourceRow);
    return targetRow;
  } catch (error) {
    // The target row was created solely for this Restore. Roll it back when any
    // later step fails, so the same shipment never remains on both pages.
    try {
      if (targetRow >= config.firstDataRow && targetRow <= targetSheet.getMaxRows()) {
        targetSheet.deleteRow(targetRow);
      }
    } catch (cleanupError) {
      console.error('Restore rollback failed: ' + cleanupError.message);
    }
    throw error;
  }
}

function findRestoreTargetRow_(
  sheet,
  inboundValue,
  inboundDisplay,
  containerValue,
  containerDisplay
) {
  const config = DELIVERY_CONFIG;
  const inboundColumn = findHeaderColumn_(sheet, config.inboundDateHeader) || config.inboundDateColumn;
  const containerColumn = findHeaderColumn_(sheet, config.containerHeader);
  const lastRow = Math.max(sheet.getLastRow(), config.headerRow);
  const inboundKey = comparableKey_(inboundValue, inboundDisplay);
  const containerKey = comparableKey_(containerValue, containerDisplay);

  // Missing inbound date: put the restored row directly below the header so it
  // is visible and can be corrected immediately.
  if (!inboundKey) return config.firstDataRow;
  if (lastRow < config.firstDataRow) return config.firstDataRow;

  const rowCount = lastRow - config.firstDataRow + 1;
  const values = sheet.getRange(config.firstDataRow, inboundColumn, rowCount, 1).getValues();
  const displays = sheet.getRange(config.firstDataRow, inboundColumn, rowCount, 1).getDisplayValues();
  const containerValues = containerColumn
    ? sheet.getRange(config.firstDataRow, containerColumn, rowCount, 1).getValues()
    : [];
  const containerDisplays = containerColumn
    ? sheet.getRange(config.firstDataRow, containerColumn, rowCount, 1).getDisplayValues()
    : [];
  let lastExactMatch = null;
  let lastInboundMatch = null;

  for (let index = 0; index < rowCount; index += 1) {
    if (comparableKey_(values[index][0], displays[index][0]) !== inboundKey) continue;
    lastInboundMatch = config.firstDataRow + index;
    if (containerColumn &&
        comparableKey_(containerValues[index][0], containerDisplays[index][0]) === containerKey) {
      lastExactMatch = config.firstDataRow + index;
    }
  }

  // Preferred rule: insert below the final row that has both the same inbound
  // date and the same container number.
  if (lastExactMatch !== null) return lastExactMatch + 1;

  // There is no matching container yet, but the inbound-date group exists.
  // Add a new container subgroup at the end of that inbound-date group.
  if (lastInboundMatch !== null) return lastInboundMatch + 1;

  // No matching group yet. Preserve the sheet's ascending inbound-date order
  // where possible; otherwise append safely at the bottom.
  const inboundTime = dateTimeValue_(inboundValue, inboundDisplay);
  if (inboundTime !== null) {
    for (let index = 0; index < rowCount; index += 1) {
      const existingTime = dateTimeValue_(values[index][0], displays[index][0]);
      if (existingTime !== null && existingTime > inboundTime) {
        return config.firstDataRow + index;
      }
    }
  }

  return lastRow + 1;
}

function findDuplicateOrderRow_(sourceSheet, sourceRow, targetSheet) {
  const config = DELIVERY_CONFIG;
  const sourceOrderColumn = findHeaderColumn_(sourceSheet, config.orderHeader);
  const targetOrderColumn = findHeaderColumn_(targetSheet, config.orderHeader);
  if (!sourceOrderColumn || !targetOrderColumn) return null;

  const sourceCell = sourceSheet.getRange(sourceRow, sourceOrderColumn);
  const orderKey = comparableKey_(sourceCell.getValue(), sourceCell.getDisplayValue());
  if (!orderKey) return null;

  const lastRow = targetSheet.getLastRow();
  if (lastRow < config.firstDataRow) return null;
  const rowCount = lastRow - config.firstDataRow + 1;
  const values = targetSheet.getRange(
    config.firstDataRow,
    targetOrderColumn,
    rowCount,
    1
  ).getValues();
  const displays = targetSheet.getRange(
    config.firstDataRow,
    targetOrderColumn,
    rowCount,
    1
  ).getDisplayValues();

  for (let index = 0; index < rowCount; index += 1) {
    if (comparableKey_(values[index][0], displays[index][0]) === orderKey) {
      return config.firstDataRow + index;
    }
  }
  return null;
}

function readAdtEta_(spreadsheet, sheet, row) {
  const config = DELIVERY_CONFIG;
  const cell = sheet.getRange(row, config.completedDateColumn);
  const rawValue = cell.getValue();
  const displayValue = String(cell.getDisplayValue() || '').trim();
  const timeZone = spreadsheet.getSpreadsheetTimeZone();

  if (displayValue === '') {
    return {
      ok: false,
      message: 'K列 ADT/ETA 为空，请先填写实际完成日期或时间。'
    };
  }

  // “已出仓” is an approved operational status even though it has no explicit
  // delivery date. Archive it using today's date so Delivered Page remains
  // sortable by its completion-date column. Restore still recovers “已出仓”.
  if (normalizeText_(displayValue) === normalizeText_(config.departedValue)) {
    return {
      ok: true,
      date: new Date(),
      hasTime: false
    };
  }

  const parsed = parseAdtEta_(rawValue, displayValue, timeZone);
  if (!parsed) {
    return {
      ok: false,
      message: 'K列 ADT/ETA 格式无法识别。建议使用 2026-08-10 或 2026-08-10 14:30。'
    };
  }

  const now = new Date();
  const isFuture = parsed.hasTime
    ? parsed.date.getTime() > now.getTime()
    : Utilities.formatDate(parsed.date, timeZone, 'yyyyMMdd') >
      Utilities.formatDate(now, timeZone, 'yyyyMMdd');

  if (isFuture) {
    const formatted = Utilities.formatDate(
      parsed.date,
      timeZone,
      parsed.hasTime ? config.completedDateTimeFormat : config.completedDateFormat
    );
    return {
      ok: false,
      message: 'K列 ADT/ETA 为未来时间（' + formatted + '），可能是ETA或误操作，记录未移动。'
    };
  }

  return {
    ok: true,
    date: parsed.date,
    hasTime: parsed.hasTime
  };
}

function parseAdtEta_(rawValue, displayValue, timeZone) {
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) {
    // A time-only Sheets value is based around 1899 and is not enough to decide
    // whether the delivery happened in the past or future.
    const year = Number(Utilities.formatDate(rawValue, timeZone, 'yyyy'));
    if (year < 2000) return null;
    return {
      date: rawValue,
      hasTime: Utilities.formatDate(rawValue, timeZone, 'HH:mm:ss') !== '00:00:00'
    };
  }

  const text = String(displayValue || '').trim();
  let match;

  // ISO: 2026-08-10 or 2026-08-10 14:30
  match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return buildParsedDate_(
      Number(match[1]), Number(match[2]), Number(match[3]),
      match[4] === undefined ? 0 : Number(match[4]),
      match[5] === undefined ? 0 : Number(match[5]),
      match[6] === undefined ? 0 : Number(match[6]),
      match[4] !== undefined,
      timeZone
    );
  }

  // Australian full date: 10/08/2026 or 10/08/2026 14:30
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return buildParsedDate_(
      Number(match[3]), Number(match[2]), Number(match[1]),
      match[4] === undefined ? 0 : Number(match[4]),
      match[5] === undefined ? 0 : Number(match[5]),
      match[6] === undefined ? 0 : Number(match[6]),
      match[4] !== undefined,
      timeZone
    );
  }

  // Existing shorthand: 8.4, 8.04 or 8.10 means month.day in the current year.
  match = text.match(/^(\d{1,2})\.(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const currentYear = Number(Utilities.formatDate(new Date(), timeZone, 'yyyy'));
    return buildParsedDate_(
      currentYear, Number(match[1]), Number(match[2]),
      match[3] === undefined ? 0 : Number(match[3]),
      match[4] === undefined ? 0 : Number(match[4]),
      match[5] === undefined ? 0 : Number(match[5]),
      match[3] !== undefined,
      timeZone
    );
  }

  return null;
}

function buildParsedDate_(year, month, day, hour, minute, second, hasTime, timeZone) {
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }

  const text = [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0')
  ].join('-') + ' ' + [
    String(hour).padStart(2, '0'),
    String(minute).padStart(2, '0'),
    String(second).padStart(2, '0')
  ].join(':');

  try {
    const date = Utilities.parseDate(text, timeZone, 'yyyy-MM-dd HH:mm:ss');
    if (Utilities.formatDate(date, timeZone, 'yyyy-MM-dd HH:mm:ss') !== text) return null;
    return { date: date, hasTime: hasTime };
  } catch (error) {
    return null;
  }
}

function sortDeliveredSheet_(sheet) {
  const config = DELIVERY_CONFIG;
  const lastRow = sheet.getLastRow();
  if (lastRow < config.firstDataRow) return;
  sheet.getRange(
    config.firstDataRow,
    1,
    lastRow - config.firstDataRow + 1,
    Math.max(sheet.getLastColumn(), config.completedDateColumn)
  ).sort({ column: config.completedDateColumn, ascending: false });
}

function applyPendingDeliveredColors_(sheet) {
  const config = DELIVERY_CONFIG;
  const backupColumn = findHeaderColumn_(sheet, config.originalRowColorsHeader);
  const lastRow = sheet.getLastRow();
  if (!backupColumn || lastRow < config.firstDataRow) return;

  // Sorting always finishes before the pending marker is resolved. The marker
  // travels with the row data, so only rows moved by the current/fresh operation
  // are colored at their final sorted positions.
  SpreadsheetApp.flush();
  const rowCount = lastRow - config.firstDataRow + 1;
  const backupRange = sheet.getRange(config.firstDataRow, backupColumn, rowCount, 1);
  const backupValues = backupRange.getValues();

  backupValues.forEach(function(rowValues, index) {
    const rawValue = String(rowValues[0] || '').trim();
    if (!rawValue) return;
    let parsed;
    try {
      parsed = JSON.parse(rawValue);
    } catch (error) {
      return;
    }
    if (parsed.pendingDeliveredColor !== true) return;

    const row = config.firstDataRow + index;
    sheet.getRange(row, 1, 1, config.completedDateColumn)
      .setBackground(config.deliveredRowBackground)
      .setFontColor(config.deliveredRowFontColor);
    delete parsed.pendingDeliveredColor;
    sheet.getRange(row, backupColumn).setValue(JSON.stringify(parsed));
  });
}

function synchronizeBusinessHeaders_(sourceSheet, targetSheet) {
  const config = DELIVERY_CONFIG;
  const sourceLastColumn = Math.max(sourceSheet.getLastColumn(), config.inboundDateColumn);
  const sourceHeaders = sourceSheet.getRange(config.headerRow, 1, 1, sourceLastColumn).getDisplayValues()[0];
  let targetHeaders = headerMap_(targetSheet);

  sourceHeaders.forEach(function(rawHeader, index) {
    const header = String(rawHeader || '').trim();
    const preferredColumn = index + 1;
    if (!header ||
        header === config.highlightHelperHeader ||
        header === config.sourceScheduleHeader ||
        targetHeaders[header]) return;

    if (preferredColumn !== config.completedDateColumn &&
        String(targetSheet.getRange(config.headerRow, preferredColumn).getDisplayValue() || '').trim() === '') {
      targetSheet.getRange(config.headerRow, preferredColumn).setValue(header);
    } else {
      const newColumn = Math.max(targetSheet.getLastColumn() + 1, config.inboundDateColumn + 1);
      ensureColumnCount_(targetSheet, newColumn);
      targetSheet.getRange(config.headerRow, newColumn).setValue(header);
    }
    targetHeaders = headerMap_(targetSheet);
  });
}

function copyRowByMatchingHeaders_(sourceSheet, sourceRow, targetSheet, targetRow, excludedHeaders) {
  const sourceLastColumn = sourceSheet.getLastColumn();
  const targetLastColumn = targetSheet.getLastColumn();
  const sourceHeaders = sourceSheet.getRange(DELIVERY_CONFIG.headerRow, 1, 1, sourceLastColumn).getDisplayValues()[0];
  const sourceValues = sourceSheet.getRange(sourceRow, 1, 1, sourceLastColumn).getValues()[0];
  const sourceFormulas = sourceSheet.getRange(sourceRow, 1, 1, sourceLastColumn).getFormulas()[0];
  const targetHeaders = headerMap_(targetSheet);
  const output = new Array(targetLastColumn).fill('');
  const excluded = {};
  (excludedHeaders || []).forEach(function(header) { excluded[header] = true; });

  sourceHeaders.forEach(function(rawHeader, index) {
    const header = String(rawHeader || '').trim();
    if (!header || excluded[header] || !targetHeaders[header]) return;
    output[targetHeaders[header] - 1] = sourceFormulas[index] || sourceValues[index];
  });

  targetSheet.getRange(targetRow, 1, 1, targetLastColumn).setValues([output]);
}

function copyRowFormat_(sourceSheet, sourceRow, targetSheet, targetRow) {
  const width = Math.min(sourceSheet.getLastColumn(), targetSheet.getMaxColumns());
  if (width > 0) {
    sourceSheet.getRange(sourceRow, 1, 1, width).copyTo(
      targetSheet.getRange(targetRow, 1, 1, width),
      SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
      false
    );
  }
  targetSheet.setRowHeight(targetRow, sourceSheet.getRowHeight(sourceRow));
}

function applyDropdowns_(deliveringSheet, deliveredSheet) {
  const config = DELIVERY_CONFIG;
  const deliveringRows = Math.max(deliveringSheet.getMaxRows() - config.headerRow, 1);
  const deliveredRows = Math.max(deliveredSheet.getMaxRows() - config.headerRow, 1);

  deliveringSheet.getRange(config.firstDataRow, config.statusColumn, deliveringRows, 1)
    .setDataValidation(deliveringPageValidation_())
    .clearNote();
  deliveredSheet.getRange(config.firstDataRow, config.statusColumn, deliveredRows, 1)
    .setDataValidation(deliveredPageValidation_())
    .clearNote();
}

function deliveringPageValidation_() {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList([DELIVERY_CONFIG.deliveredValue], true)
    .setAllowInvalid(false)
    .setHelpText('选择 Delivered 后，该行会自动移至 Delivered Page。')
    .build();
}

function deliveredPageValidation_() {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList([DELIVERY_CONFIG.deliveredValue, DELIVERY_CONFIG.restoreValue], true)
    .setAllowInvalid(false)
    .setHelpText('选择 Restore 后，该行会恢复到 Delivering Page。')
    .build();
}

function ensureOriginalScheduleNoteColumn_(sheet) {
  const config = DELIVERY_CONFIG;
  let column = findHeaderColumn_(sheet, config.originalScheduleNoteHeader);
  if (!column) {
    column = Math.max(sheet.getLastColumn() + 1, config.inboundDateColumn + 1);
    ensureColumnCount_(sheet, column);
    sheet.getRange(config.headerRow, column).setValue(config.originalScheduleNoteHeader);
  }
  sheet.hideColumns(column);
  return column;
}

function ensureOriginalRowColorsColumn_(sheet) {
  const config = DELIVERY_CONFIG;
  let column = findHeaderColumn_(sheet, config.originalRowColorsHeader);
  if (!column) {
    column = Math.max(sheet.getLastColumn() + 1, config.inboundDateColumn + 1);
    ensureColumnCount_(sheet, column);
    sheet.getRange(config.headerRow, column).setValue(config.originalRowColorsHeader);
  }
  sheet.hideColumns(column);
  return column;
}

function parseOriginalRowColors_(rawValue, expectedWidth) {
  if (String(rawValue || '').trim() === '') return null;
  try {
    const parsed = JSON.parse(String(rawValue));
    if (!Array.isArray(parsed.backgrounds) ||
        !Array.isArray(parsed.fontColors) ||
        parsed.backgrounds.length !== expectedWidth ||
        parsed.fontColors.length !== expectedWidth) {
      return null;
    }
    return {
      backgrounds: parsed.backgrounds,
      fontColors: parsed.fontColors
    };
  } catch (error) {
    return null;
  }
}

function removeRestoreHighlighting_(sheet) {
  const config = DELIVERY_CONFIG;
  const helperColumn = findHeaderColumn_(sheet, config.highlightHelperHeader);
  if (helperColumn) {
    const rowCount = Math.max(sheet.getMaxRows() - config.headerRow, 1);
    sheet.getRange(config.firstDataRow, helperColumn, rowCount, 1).clearContent();
    sheet.hideColumns(helperColumn);
  }
  const rules = sheet.getConditionalFormatRules().filter(function(rule) {
    const condition = rule.getBooleanCondition();
    if (!condition) return true;
    return !condition.getCriteriaValues().some(function(value) {
      return String(value).indexOf(config.highlightRuleMarker) !== -1;
    });
  });
  sheet.setConditionalFormatRules(rules);
}

function installEditTrigger_(spreadsheet) {
  const handlerName = DELIVERY_CONFIG.editHandlerName;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger(handlerName).forSpreadsheet(spreadsheet).onEdit().create();
}

function requireSheet_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('找不到工作表 “' + sheetName + '”。请检查名称和空格是否完全一致。');
  }
  return sheet;
}

function requireOrSetHeader_(sheet, column, expectedHeader) {
  ensureColumnCount_(sheet, column);
  const cell = sheet.getRange(DELIVERY_CONFIG.headerRow, column);
  const current = String(cell.getDisplayValue() || '').trim();
  if (current === '') {
    cell.setValue(expectedHeader);
    return;
  }
  if (current !== expectedHeader) {
    throw new Error(
      '工作表 “' + sheet.getName() + '” 的 ' + columnLetter_(column) +
      '1 当前标题是 “' + current + '”，预期为 “' + expectedHeader + '”。'
    );
  }
}

function headerMap_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(DELIVERY_CONFIG.headerRow, 1, 1, lastColumn).getDisplayValues()[0];
  const map = {};
  headers.forEach(function(rawHeader, index) {
    const header = String(rawHeader || '').trim();
    if (header && !map[header]) map[header] = index + 1;
  });
  return map;
}

function findHeaderColumn_(sheet, header) {
  return headerMap_(sheet)[header] || null;
}

function ensureColumnCount_(sheet, requiredColumn) {
  const missing = requiredColumn - sheet.getMaxColumns();
  if (missing > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), missing);
}

function ensureRowCount_(sheet, requiredRow) {
  const missing = requiredRow - sheet.getMaxRows();
  if (missing > 0) sheet.insertRowsAfter(sheet.getMaxRows(), missing);
}

function nextAppendRow_(sheet) {
  const row = Math.max(sheet.getLastRow() + 1, DELIVERY_CONFIG.firstDataRow);
  ensureRowCount_(sheet, row);
  return row;
}

function makeRoomForRow_(sheet, targetRow) {
  const lastRow = sheet.getLastRow();
  ensureRowCount_(sheet, Math.max(targetRow, lastRow + 1));
  if (targetRow <= lastRow) sheet.insertRowsBefore(targetRow, 1);
}

function comparableKey_(value, displayValue) {
  if (value instanceof Date && !isNaN(value.getTime())) return 'date:' + value.getTime();
  if (typeof value === 'number' && !isNaN(value)) return 'number:' + value;
  const text = normalizeText_(displayValue !== '' ? displayValue : value);
  return text ? 'text:' + text : '';
}

function dateTimeValue_(value, displayValue) {
  if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
  if (typeof value === 'number' && !isNaN(value)) return value;
  const parsed = Date.parse(String(displayValue || value || '').trim());
  return isNaN(parsed) ? null : parsed;
}

function normalizeText_(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
}

function columnLetter_(column) {
  let number = column;
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}
