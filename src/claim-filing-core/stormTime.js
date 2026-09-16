// A new-claim carrier needs a usable time paired with the selected date of
// loss. The value may be a sourced clock time or a truthful, explicitly
// approved daypart; placeholders and qualifier-only text are never usable.
export function isCarrierUsableStormTime(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  const daypart = /^(?:early\s+|late\s+)?(?:morning|afternoon|evening|overnight)$/i;
  const clock = /^(?:(?:[01]?\d|2[0-3]):[0-5]\d|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?))(?:\s+(?:[ECMP][SD]T|UTC|CT|ET|MT|PT))?$/i;
  const sourcedTime = /^Approximately\s+(?:(?:[01]?\d|2[0-3]):[0-5]\d|(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?))(?:\s+(?:[ECMP][SD]T|UTC|CT|ET|MT|PT))?\s+(?:based on a nearby reported hail event|from (?:the )?verified file evidence)$/i;
  return daypart.test(text) || clock.test(text) || sourcedTime.test(text);
}
