(function (root) {
  'use strict';

  const STATE_CODES = 'ACT|NSW|NT|QLD|SA|TAS|VIC|WA';
  const ROAD_TYPES = 'street|st|road|rd|avenue|ave|drive|dr|court|ct|close|cl|crescent|cres|lane|ln|way|terrace|tce|highway|hwy|boulevard|blvd|parade|pde|place|pl|circuit|cct|grove|gr|rise|mews|square|sq|walk|trail|trk';
  const STATE_NAMES = Object.freeze({
    'australian capital territory': 'ACT',
    'new south wales': 'NSW',
    'northern territory': 'NT',
    queensland: 'QLD',
    'south australia': 'SA',
    tasmania: 'TAS',
    victoria: 'VIC',
    'western australia': 'WA'
  });

  function cleanText(value) {
    return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function titleCase(value) {
    return cleanText(value)
      .toLocaleLowerCase('en-AU')
      .replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, prefix, letter) => `${prefix}${letter.toLocaleUpperCase('en-AU')}`)
      .replace(/\b(\d+)([a-z])\b/giu, (_, digits, letter) => `${digits}${letter.toLocaleUpperCase('en-AU')}`);
  }

  function formatPersonName(value) {
    return titleCase(value);
  }

  function formatAustralianMobile(value) {
    const original = cleanText(value);
    let digits = original.replace(/\D/g, '');
    if (/^00614\d{8}$/.test(digits)) digits = `0${digits.slice(4)}`;
    else if (/^614\d{8}$/.test(digits)) digits = `0${digits.slice(2)}`;
    else if (/^6104\d{8}$/.test(digits)) digits = digits.slice(2);
    else if (/^4\d{8}$/.test(digits)) digits = `0${digits}`;
    return /^04\d{8}$/.test(digits)
      ? `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`
      : original;
  }

  function formatState(value) {
    const state = cleanText(value);
    return STATE_NAMES[state.toLocaleLowerCase('en-AU')] || state.toLocaleUpperCase('en-AU');
  }

  function formatPostcode(value) {
    const postcode = cleanText(value);
    return postcode.match(/\b\d{4}\b/)?.[0] || postcode;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isSuburbCandidate(value) {
    const suburb = cleanText(value);
    return Boolean(suburb) && !/\d/.test(suburb) && !new RegExp(`\\b(?:${ROAD_TYPES})\\b$`, 'i').test(suburb);
  }

  function normaliseAddressFields(record = {}) {
    let deliveryAddress = cleanText(record.delivery_address)
      .replace(/(?:,\s*)?australia\.?$/i, '')
      .replace(/\s*,\s*$/, '')
      .trim();
    let suburb = cleanText(record.suburb);
    let state = cleanText(record.state);
    let postcode = cleanText(record.postcode);
    let parsedLocality = false;

    const commaMatch = deliveryAddress.match(new RegExp(`^(.*),\\s*([^,]+?)\\s+(${STATE_CODES})\\s+(\\d{4})$`, 'i'));
    if (commaMatch && isSuburbCandidate(commaMatch[2])) {
      deliveryAddress = commaMatch[1];
      suburb = commaMatch[2];
      state = commaMatch[3];
      postcode = commaMatch[4];
      parsedLocality = true;
    }

    if (!parsedLocality) {
      const inlineMatch = deliveryAddress.match(new RegExp(`^(.*?\\b(?:${ROAD_TYPES})\\b)\\s+(.+?)\\s+(${STATE_CODES})\\s+(\\d{4})$`, 'i'));
      if (inlineMatch && isSuburbCandidate(inlineMatch[2])) {
        deliveryAddress = inlineMatch[1];
        suburb = inlineMatch[2];
        state = inlineMatch[3];
        postcode = inlineMatch[4];
        parsedLocality = true;
      }
    }

    if (!parsedLocality && suburb) {
      const suburbSuffix = new RegExp(`^(.*),\\s*${escapeRegExp(suburb)}$`, 'i');
      const suburbMatch = deliveryAddress.match(suburbSuffix);
      if (suburbMatch) deliveryAddress = suburbMatch[1];
    }

    return {
      delivery_address: titleCase(deliveryAddress).replace(/\s*,\s*/g, ', '),
      suburb: titleCase(suburb),
      state: formatState(state),
      postcode: formatPostcode(postcode)
    };
  }

  function formatLocality(record) {
    const address = normaliseAddressFields(record);
    return [address.suburb, address.state, address.postcode].filter(Boolean).join(' ');
  }

  function formatSingleLineAddress(record) {
    const address = normaliseAddressFields(record);
    const locality = [address.suburb, address.state, address.postcode].filter(Boolean).join(' ');
    return [address.delivery_address, locality].filter(Boolean).join(', ');
  }

  function shipmentSmsDetails(record = {}) {
    const phone = formatAustralianMobile(record.recipient_phone || record.source_data?.recipient_phone).replace(/\D/g, '');
    if (!/^04\d{8}$/.test(phone)) return null;
    const recipient = formatPersonName(record.recipient_name) || 'there';
    return {
      phone,
      message: `Hi ${recipient}, this is BentWay Logistics regarding shipment ${cleanText(record.tracking_number)}.`
    };
  }

  root.BENTWAY_SHIPMENT_FORMATTERS = Object.freeze({
    formatPersonName,
    formatAustralianMobile,
    normaliseAddressFields,
    formatLocality,
    formatSingleLineAddress,
    shipmentSmsDetails
  });
})(globalThis);
