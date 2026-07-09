const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseDate(value) {
  if (value == null || value === "") return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;

  if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return undefined;
    // JobNimbus timestamps are Unix seconds; anything past ~2001 in ms form is already ms.
    const date = new Date(number > 1e12 ? number : number * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  const text = String(value).trim();
  const usFormat = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usFormat) {
    const date = new Date(Date.UTC(Number(usFormat[3]), Number(usFormat[1]) - 1, Number(usFormat[2])));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function todayDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function daysBetween(later, earlier) {
  const a = parseDate(later);
  const b = parseDate(earlier);
  if (!a || !b) return undefined;
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

export function dateOnly(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : "";
}

// Convert a calendar date (Date, "YYYY-MM-DD", or "MM/DD/YYYY") into a
// JobNimbus-safe Unix-seconds epoch for date-only fields (e.g. Date of Loss).
//
// WHY THIS EXISTS: writing midnight UTC for a date renders as the PREVIOUS
// day once JobNimbus displays it in the account's local (US Central) time
// zone — e.g. 2026-04-25T00:00:00Z shows as "Apr 24" or even "Apr 23"
// depending on the client's own timezone handling. Anchoring at NOON UTC
// keeps the date stable across every US timezone. This bit us for real on
// Robert Frazier's Date of Loss (sent as midnight, displayed as Apr 23
// instead of Apr 25) — always use this helper for any JobNimbus date WRITE,
// never hand-roll `Date.UTC(...)` at midnight.
export function toJobNimbusDateEpoch(value) {
  const date = parseDate(value);
  if (!date) return undefined;
  const noonUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0);
  return Math.floor(noonUtc / 1000);
}
