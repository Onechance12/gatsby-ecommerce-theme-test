// Ephemeral identity proofs only. Contact methods locate people, not claim files.
const CLAIM_KEYS = new Set(['claim', 'claimnumber', 'cfstring2', 'cfstring10']);
const ADDRESS_KEYS = new Set(['addressline1']);
const STREET_WORDS = new Map(Object.entries({
  avenue: 'ave', street: 'st', drive: 'dr', road: 'rd', court: 'ct',
  lane: 'ln', boulevard: 'blvd', circle: 'cir', place: 'pl', terrace: 'ter',
  parkway: 'pkwy', highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w',
  apartment: 'unit', apt: 'unit', suite: 'unit', ste: 'unit',
}));

export function exactFileEvidenceAnchors(contact, contacts) {
  const targetId = providerId(contact);
  if (!targetId || !Array.isArray(contacts)) return null;
  const target = inventory(contact);
  if (!target) return null;
  const rows = new Map();
  for (const row of contacts) {
    const id = providerId(row);
    const values = inventory(row);
    if (!id || !values) return null;
    const previous = rows.get(id);
    if (previous && signature(previous) !== signature(values)) return null;
    rows.set(id, values);
  }
  const indexed = rows.get(targetId);
  if (!indexed || signature(indexed) !== signature(target)) return null;
  const otherClaims = new Set();
  const otherAddresses = new Set();
  for (const [id, values] of rows) {
    if (id === targetId) continue;
    for (const claim of values.claims) otherClaims.add(claim);
    for (const address of values.addresses) otherAddresses.add(address);
  }
  const claims = new Set([...target.claims].filter(value => !otherClaims.has(value)));
  const addresses = new Set([...target.addresses].filter(value => !otherAddresses.has(value)));
  if (!claims.size && !addresses.size) return null;
  // A common property (repeat loss) or claim token is not a foreign-file veto.
  // It is also never a positive anchor. Another independent unique anchor wins.
  return {
    claims, addresses,
    foreignClaims: new Set([...otherClaims].filter(value => !target.claims.has(value))),
    foreignAddresses: new Set([...otherAddresses].filter(value => !target.addresses.has(value))),
  };
}

export function messageMatchesFile(text, anchors) {
  if (typeof text !== 'string' || !anchors) return false;
  const claims = new Set((text.match(/[a-z0-9]+(?:[-_.#/][a-z0-9]+)*/gi) || []).map(normalizeClaim));
  const addressText = ` ${normalizeAddress(text)} `;
  const hasAddress = value => addressText.includes(` ${value} `);
  if (![...anchors.claims].some(value => claims.has(value))
    && ![...anchors.addresses].some(hasAddress)) return false;
  return !messageConflictsWithFile(text, anchors);
}

export function messageConflictsWithFile(text, anchors) {
  if (typeof text !== 'string' || !anchors) return true;
  const claims = new Set((text.match(/[a-z0-9]+(?:[-_.#/][a-z0-9]+)*/gi) || []).map(normalizeClaim));
  const addressText = ` ${normalizeAddress(text)} `;
  return [...anchors.foreignClaims].some(value => claims.has(value))
    || [...anchors.foreignAddresses].some(value => addressText.includes(` ${value} `));
}

export function isContactOptOut(item) {
  if (!item || item.type !== 'text' || typeof item.text !== 'string'
    || !['incoming', 'inbound'].includes(String(item.direction).toLowerCase())) return false;
  const text = item.text.trim().replace(/[\u2018\u2019]/g, "'");
  return /^(?:stop|stopall|unsubscribe|cancel|end|quit)[.!\s]*$/i.test(text)
    || /\b(?:do not|don't|stop)\s+(?:texting|text|contacting|contact)\s+(?:me|us)\b/i.test(text);
}

export function exactFileRecipientProof(file, recipient) {
  const fileId = providerId(file);
  const to = normalizedPhone(recipient);
  if (!fileId || !to) return null;
  const role = to === normalizedPhone(file.phone) ? 'client'
    : to === normalizedPhone(file.adjusterPhone) ? 'desk_adjuster' : null;
  if (!role) return null;
  return {
    fileId, recipient: to, role,
    recipientName: String(role === 'client' ? file.name || '' : file.adjusterName || '').trim(),
    propertyAddress: String(file.address || '').trim(),
    claimNumber: String(file.claimNumber || '').trim(),
    policyNumber: String(file.policyNumber || '').trim(),
    dateOfLoss: String(file.dateOfLoss || '').trim(),
  };
}

function normalizedPhone(value) {
  if (typeof value !== 'string' || !/^\+?[\d\s().-]+$/.test(value.trim())) return '';
  const digits = value.replace(/\D/g, '');
  return /^\d{10}$/.test(digits) ? `+1${digits}`
    : /^1\d{10}$/.test(digits) ? `+${digits}` : '';
}

function providerId(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return '';
  const id = row.jnid || row.id;
  return typeof id === 'string' && id && !/[\s\x00-\x1f\x7f]/.test(id) ? id : '';
}

function inventory(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const claims = new Set();
  const addresses = new Set();
  const lines = [];
  let unit = '';
  for (const [key, value] of Object.entries(row)) {
    const field = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!CLAIM_KEYS.has(field) && !ADDRESS_KEYS.has(field) && field !== 'addressline2') continue;
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    if (CLAIM_KEYS.has(field)) {
      const normalized = normalizeClaim(String(value));
      if (normalized.length >= 6 && normalized.length <= 160) claims.add(normalized);
    } else if (field === 'addressline2') {
      unit = normalizeAddress(String(value));
      if (/^[a-z0-9]+$/.test(unit)) unit = `unit ${unit}`;
    } else {
      lines.push(String(value));
    }
  }
  for (const line of lines) {
    const normalized = normalizeAddress(`${line} ${unit}`);
    if (/^\d+[a-z]?\s+[a-z0-9].{2,}$/.test(normalized) && normalized.length <= 240) addresses.add(normalized);
  }
  return { claims, addresses };
}

function normalizeClaim(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeAddress(value) {
  return (value.toLowerCase().replace(/#\s*(?=[a-z0-9])/g, ' unit ').match(/[a-z0-9]+/g) || [])
    .map(word => STREET_WORDS.get(word) || word).join(' ');
}

function signature(values) {
  return JSON.stringify([[...values.claims].sort(), [...values.addresses].sort()]);
}
