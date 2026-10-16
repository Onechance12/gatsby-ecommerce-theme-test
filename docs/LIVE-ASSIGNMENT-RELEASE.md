# Assigned-file count and live membership repair

## What was wrong

The Mac index applied the fixed 58-file action manifest before counting files,
then described its result as the current assigned book. Exact-file resolution
also discarded assigned files outside that manifest and reported them missing.
The client count, the active-file count, and permission to act are different facts.

## Changes

- The index reports `counts.assignedInsurance` (all assigned insurance records),
  `assignedOpenActiveInsurance`, `matchingRequestedFilters`, `returned`, and
  `restrictedByActionScope`. `total` remains the number of returned records, for
  compatibility. `countScope` and coverage must accompany any reported count.
- Missing ownership metadata is explicitly incomplete. Duplicate identities and
  incomplete or inconsistent pagination fail instead of producing a total.
- A known assigned record blocked by file scope is no longer reported missing.
- The opt-in `chance-live-assigned-sms-v1` schema-2 policy pins an exact owner,
  action/field allowlists, exclusions and expiry, rather than a client count.
  Membership comes from current provider records. A fresh exact contact read
  checks ownership, identity and active/open state before each action, including
  when an approved plan is executed. Reassignment invalidates the operation.

## Release boundary: prepared, not activated

This change does not edit the installed package/cache, production environment,
credentials, live manifest, or compiled release pins. The legacy 58-file release
continues to reject new file membership until the coordinated release is reviewed
and installed. Implementation/tests are not a live send or deployment approval.

Activation requires the reviewed bridge commit, a schema-2 policy with
`assignmentMode: "live_assigned"` and the exact `assignmentOwnerId`, its canonical
SHA-256, and an Operator package pinned to all three. The compiled SMS release
must additionally pin that assignment mode and owner. A fixed-roster package
refuses the new scope; a live package refuses owner drift or a frozen count.
Never patch an installed pin to get past a live rejection.

Preserve the exact prior manifest as `receiptPredecessor` for reviewed receipt
provenance and existing file quarantines; it does not admit new actions. Rebind
the existing six-receipt historical-isolation configuration to the new policy
only after verifying the unchanged six batch IDs and raw-row hashes. Never replay
or discard unknown effects to make readiness green. Missing/unreviewed receipt
provenance must remain a hard block, not be inferred from current ownership.

Do not change #2628's explicit exclusion, company-sweep restrictions, verified
sender/recipient binding, exact content approval, one-use challenges, duplicate
protection, or provider readback. No raw/generic send or browser fallback is added.

After installation, attest the full boundary in a new persistent session and
read the live index. Reconcile the all-assigned and active/open counts using the
same filters as JobNimbus. Test a newly assigned file with a read/plan only.
Any real send requires a new exact plan and approval after installation; an old
"send it" reply is not a post-release approval. The previously drafted client
message remains unsent and its date wording must be rechecked.

## Verification

`npm run test:assigned-roster` covers a 72-record assigned book versus a 57-record
returned subset, late assignments, reassignment, inactive/closed/excluded files,
duplicate/missing metadata, exact SMS approval/readback, and plugin owner drift.
All phone numbers, messages and provider servers in these tests are synthetic
and loopback-only. Run `npm run check` and the full Operator test suite as well.
