// Only fixed, non-PII scope facts may cross the evidence/model boundary.
const ALLOWED = new Set([
  'bounded_identifier_search',
  'homeowner_phone_only',
  'call_transcripts_not_reviewed',
]);

export function communicationLimitations(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(code => ALLOWED.has(code)))].slice(0, 3);
}
