(function (root) {
  'use strict';

  const numberOrNull = (value) => value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);

  function calculateStorageAmount(volume, ratePerM3 = 20) {
    const cubicMetres = numberOrNull(volume);
    const rate = numberOrNull(ratePerM3);
    return cubicMetres === null || cubicMetres <= 0 || rate === null || rate <= 0 ? null : cubicMetres * rate;
  }

  function calculateShipmentBilling(input) {
    const volume = numberOrNull(input.volume);
    const unitPrice = numberOrNull(input.unitPrice);
    const minimumVolume = numberOrNull(input.minimumBillableVolume) ?? 1;
    const gstRate = numberOrNull(input.gstRate) ?? 0;
    const storage = numberOrNull(input.unbilledStorage) ?? 0;
    const storageInclGst = numberOrNull(input.unbilledStorageInclGst) ?? storage * (1 + gstRate);
    const warehouseBookingFee = numberOrNull(input.warehouseBookingFee) ?? 150;
    const billableVolume = volume === null ? null : Math.max(volume, minimumVolume);

    if (input.warehouseBooking) {
      const coreTotal = warehouseBookingFee * (1 + gstRate);
      return { pricingMode: 'warehouse_booking', billableVolume, deliveryCharge: null, pickupCharge: null, fuelLevy: 0, serviceFee: warehouseBookingFee, storage, subtotal: warehouseBookingFee + storage, gstAmount: coreTotal - warehouseBookingFee + storageInclGst - storage, total: coreTotal + storageInclGst, tailLiftApplicable: false };
    }
    if (input.pickup) {
      const weight = numberOrNull(input.weight);
      const pickupRate = numberOrNull(input.pickupRatePerKg);
      if (weight === null || weight <= 0 || pickupRate === null || pickupRate <= 0) {
        return { pricingMode: 'pickup', billableVolume: null, deliveryCharge: null, pickupCharge: null, fuelLevy: 0, serviceFee: 0, storage, subtotal: null, gstAmount: null, total: null, tailLiftApplicable: false };
      }
      const pickupCharge = weight * pickupRate;
      const coreTotal = pickupCharge * (1 + gstRate);
      return { pricingMode: 'pickup', billableVolume: null, deliveryCharge: pickupCharge, pickupCharge, pickupWeight: weight, pickupRatePerKg: pickupRate, fuelLevy: 0, serviceFee: 0, storage, subtotal: pickupCharge + storage, gstAmount: coreTotal - pickupCharge + storageInclGst - storage, total: coreTotal + storageInclGst, tailLiftApplicable: false };
    }
    if (billableVolume === null || unitPrice === null) {
      return { pricingMode: 'delivery', billableVolume, deliveryCharge: null, pickupCharge: null, fuelLevy: null, serviceFee: null, storage, subtotal: null, gstAmount: null, total: null, tailLiftApplicable: !input.craneRequired };
    }

    const deliveryCharge = billableVolume * unitPrice;
    const fuelLevy = numberOrNull(input.fuelLevyOverride) ?? deliveryCharge * (numberOrNull(input.fuelLevyRate) ?? 0);
    const serviceFee = numberOrNull(input.craneRequired ? input.craneFee : input.tailLiftFee) ?? 0;
    const coreSubtotal = deliveryCharge + serviceFee + fuelLevy;
    const subtotal = coreSubtotal + storage;
    const coreTotal = coreSubtotal * (1 + gstRate);
    return { pricingMode: 'delivery', billableVolume, deliveryCharge, pickupCharge: null, fuelLevy, serviceFee, storage, subtotal, gstAmount: coreTotal - coreSubtotal + storageInclGst - storage, total: coreTotal + storageInclGst, tailLiftApplicable: !input.craneRequired };
  }

  function outstandingTotal(items) {
    return items.filter((item) => !item.billedAt && !item.cancelledAt)
      .reduce((sum, item) => sum + (numberOrNull(item.totalInclGst) ?? 0), 0);
  }

  function groupConsecutiveStoragePeriods(items) {
    return [...items].sort((left, right) => String(left.periodStart).localeCompare(String(right.periodStart)))
      .reduce((groups, item) => {
        const group = groups.at(-1);
        const nextDay = group ? new Date(`${group.at(-1).periodEnd}T00:00:00Z`).getTime() + 86400000 : null;
        if (group && group.at(-1).shipmentId === item.shipmentId
          && Number(group.at(-1).rate) === Number(item.rate)
          && Number(group.at(-1).gstRate) === Number(item.gstRate)
          && nextDay === new Date(`${item.periodStart}T00:00:00Z`).getTime()) group.push(item);
        else groups.push([item]);
        return groups;
      }, []);
  }

  function recalculateDraftComponents(components, gstRate = 0) {
    const rows = (components || []).map((component) => ({ ...component }));
    const delivery = rows.find((component) => component.description === 'Last Mile Delivery');
    const deliveryBase = delivery
      ? (numberOrNull(delivery.quantity) ?? 1) * (numberOrNull(delivery.rate) ?? 0)
      : 0;
    rows.forEach((component) => {
      const quantity = numberOrNull(component.quantity) ?? 1;
      const rate = numberOrNull(component.rate) ?? 0;
      component.quantity = quantity;
      component.rate = rate;
      if (component.rate_kind === 'percentage' && component.description === 'Fuel Levy') {
        component.amount_ex_gst = deliveryBase * rate;
      } else if (component.rate_kind === 'manual' && component.description === 'Fuel Levy') {
        component.amount_ex_gst = numberOrNull(component.manual_amount) ?? 0;
      } else component.amount_ex_gst = quantity * rate;
    });
    const amountExGst = rows.reduce((sum, component) => sum + (numberOrNull(component.amount_ex_gst) ?? 0), 0);
    const gst = amountExGst * (numberOrNull(gstRate) ?? 0);
    return { components: rows, amountExGst, gstAmount: gst, totalInclGst: amountExGst + gst };
  }

  function draftTotals(items, removedIds = new Set()) {
    return items.filter((item) => !removedIds.has(item.id)).reduce((totals, item) => {
      totals.subtotal += numberOrNull(item.amount_ex_gst) ?? 0;
      totals.gst += numberOrNull(item.gst_amount) ?? 0;
      totals.total += numberOrNull(item.total_incl_gst) ?? 0;
      return totals;
    }, { subtotal: 0, gst: 0, total: 0 });
  }

  root.BENTWAY_BILLING = Object.freeze({
    calculateShipmentBilling,
    calculateStorageAmount,
    outstandingTotal,
    groupConsecutiveStoragePeriods,
    recalculateDraftComponents,
    draftTotals
  });
})(typeof window !== 'undefined' ? window : globalThis);
