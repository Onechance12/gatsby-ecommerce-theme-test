/** Pure, ephemeral attribution for a server-authorized file on an employee's own line.
 * A shared destination is NOT an exact-file anchor. Nothing here performs I/O.
 */
const CLAIM_KEYS = new Set(['claim', 'claimnumber', 'cfstring2', 'cfstring10']);
const ADDRESS_KEYS = new Set(['addressline1']);

export function sharedPhoneFileAnchors(contact, contacts) {
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
  const foreignClaims = new Set();
  const foreignAddresses = new Set();
  for (const [id, values] of rows) {
    if (id === targetId) continue;
    for (const claim of values.claims) foreignClaims.add(claim);
    for (const address of values.addresses) foreignAddresses.add(address);
  }
  const claims = new Set([...target.claims].filter(value => !foreignClaims.has(value)));
  const addresses = new Set([...target.addresses].filter(value => !foreignAddresses.has(value)));
  if (!claims.size && !addresses.size) return null;
  return { claims, addresses, foreignClaims, foreignAddresses };
}

export function projectSharedPhoneFileHistory(timeline, anchors) {
  if (!Array.isArray(timeline) || !anchors) return null;
  const items = [];
  let withheld = 0;
  for (const item of timeline) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') {
      withheld += 1;
      continue;
    }
    // Opt-out applies to the destination/work-line pair, not one property.
    // Expose only the safety fact, never an unrelated property's body.
    if (isContactOptOut(item)) {
      items.push({ ...item, text: 'Contact-level opt-out on this phone and work line. Do not send a text.' });
      continue;
    }
    if (!messageMatchesFile(item.text, anchors)) {
      withheld += 1;
      continue;
    }
    items.push(item);
  }
  return { items, withheld };
}

export function messageMatchesFile(text, anchors) {
  if (typeof text !== 'string' || !anchors) return false;
  const claimTokens = new Set((text.match(/[a-z0-9]+(?:[-_.#/][a-z0-9]+)*/gi) || []).map(normalizeClaim));
  const addressText = ` ${normalizeAddress(text)} `;
  const hasAddress = value => addressText.includes(` ${value} `);
  const claimMatch = [...anchors.claims].some(value => claimTokens.has(value));
  const addressMatch = [...anchors.addresses].some(hasAddress);
  if (!claimMatch && !addressMatch) return false;
  if ([...anchors.foreignClaims].some(value => claimTokens.has(value))) return false;
  if ([...anchors.foreignAddresses].some(hasAddress)) return false;
  return true;
}

function isContactOptOut(item) {
  if (!['incoming', 'inbound'].includes(String(item.direction).toLowerCase())) return false;
  const text = item.text.trim();
  return /^(?:stop|stopall|unsubscribe|cancel|end|quit)[.!\s]*$/i.test(text)
    || /\b(?:do not|don't|stop)\s+(?:texting|text|contacting|contact)\s+(?:me|us)\b/i.test(text);
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
  for (const [key, value] of Object.entries(row)) {
    const field = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!CLAIM_KEYS.has(field) && !ADDRESS_KEYS.has(field)) continue;
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) continue;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (CLAIM_KEYS.has(field)) {
      const normalized = normalizeClaim(String(value));
      if (normalized.length >= 6 && normalized.length <= 160) claims.add(normalized);
    } else {
      const normalized = normalizeAddress(String(value));
      if (/^\d+[a-z]?\s+[a-z0-9].{2,}$/.test(normalized) && normalized.length <= 240) addresses.add(normalized);
    }
  }
  return { claims, addresses };
}

function normalizeClaim(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeAddress(value) {
  return value.toLowerCase().match(/[a-z0-9]+/g)?.join(' ') || '';
}

function signature(values) {
  return JSON.stringify([[...values.claims].sort(), [...values.addresses].sort()]);
}
