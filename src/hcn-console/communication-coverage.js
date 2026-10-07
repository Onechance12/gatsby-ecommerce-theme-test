// Only fixed, non-PII scope facts may cross the evidence/model boundary.
const ALLOWED = new Set([
  'bounded_identifier_search',
  'homeowner_phone_only',
  'call_transcripts_not_reviewed',
  'signed_in_employee_line_only',
  'shared_phone_exact_file_messages_only',
  'unattributed_phone_history_withheld',
]);

export function communicationLimitations(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(code => ALLOWED.has(code)))].slice(0, 6);
}
