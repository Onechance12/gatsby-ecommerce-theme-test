import { isContactOptOut, messageMatchesFile } from '../communications/exact-file-evidence.js';
export { exactFileEvidenceAnchors as sharedPhoneFileAnchors, messageMatchesFile } from '../communications/exact-file-evidence.js';

// Projection, not contact identity or authority. It performs no I/O or storage.
export function projectSharedPhoneFileHistory(timeline, anchors) {
  if (!Array.isArray(timeline) || !anchors) return null;
  const items = [];
  let withheld = 0;
  for (const item of timeline) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') {
      withheld += 1;
      continue;
    }
    if (isContactOptOut(item)) {
      // Opt-out belongs to the destination/work-line pair, not one property.
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
