# Read-only management gap reports

For an updated all-adjuster 3x10 report, use `management_report_status`, then
`management_gap_report`. These use the existing HCN management-sweep engine
with a separate report-only Keychain credential and exact provider-attested
build, not the operational Mac credential. A Google/Jobrolo browser login is
not required. This reporting-only path is independent of the operational
session checks below and grants no client effects or arbitrary company reads.

If the current thread has not loaded these tools, run the same client with
`node scripts/management-gap-report.mjs --status` and
`node scripts/management-gap-report.mjs --output /absolute/new-report.json`
from this plugin's root (two directories above this skill folder). Never use
HP, legacy/shared or raw JobNimbus credentials as fallback. Failed attestation
or provider reads stop without automatic retry.

Use fresh returned data, preserve coverage/evidence warnings, and rank by
verified JobNimbus work activity, not days in status. Notes/comments,
supported human work and verified upload creation times count; opens, drafts,
reminders and automation do not. The engine reads upload metadata separately
because an upload may not produce an activity-feed entry. Preserve uncertain
upload and ambiguous-ownership warnings.
Gmail/Quo/Calendar are not evaluated in this report. A PDF should say
"Adjuster Gap Report" and show its refresh time and limitations; no Jobrolo
in the filename. Keep the ordinary operational scope restrictions unchanged.
