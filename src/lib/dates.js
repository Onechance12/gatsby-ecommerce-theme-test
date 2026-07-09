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
