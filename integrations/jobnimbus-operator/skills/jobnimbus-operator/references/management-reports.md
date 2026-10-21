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
supported JobNimbus work activity, not days in status. Eligible notes/comments,
other supported work metadata and verified upload creation times count; opens,
drafts, reminders and explicitly marked automation do not. The engine reads upload metadata separately
because an upload may not produce an activity-feed entry. Preserve uncertain
upload and ambiguous-ownership warnings.
Read `criteria.workflowScope` and the population census before describing
coverage. `all_active` includes all statuses of active Insurance contacts
assigned to exactly one of the three configured adjusters; the census counts
inactive/closed, unknown state/type/assignment, ambiguous owners, and exclusions
separately. Ten is the per-adjuster output limit, never a contact/history read
limit. Legacy `estimating_board` results are limited and must not be described
as all assigned files. Unknown counts are not zero. Per-adjuster assigned counts
include shared files and are not additive. A generated report is a triage list,
not a completed sweep or proof every file was worked. Explicit automation
metadata is excluded; unmarked automation cannot be ruled out, and a recorded
touch is not proof of progress or individual effort.
Gmail/Quo/Calendar are not evaluated in this report. A PDF should say
"Adjuster Gap Report" and show its refresh time and limitations; no Jobrolo
in the filename. Keep the ordinary operational scope restrictions unchanged.
