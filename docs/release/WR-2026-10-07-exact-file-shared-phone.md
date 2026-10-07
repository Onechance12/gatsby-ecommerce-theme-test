# Exact-file, own-line shared-phone evidence

Principal claim: `codex/hcn-exact-phone-match-20261007`, based on reviewed
HCN platform source `7fc25b88775eede6a7d7c389d6b55aade36da311`.

Scope: the existing employee exact-file Quo reader and its synthetic tests.
No company sweep, other employee history, caller-selected sender, CRM edits,
permission changes, raw-phone fallback, or deployment is authorized by this
candidate. The separately open Jobrolo private-file repair is not merged here.

The observed failure is a valid shared-phone collision between separate
properties, not a disconnected sender. JobNimbus can keep a Billed insurance
record active. Do not change the source record or redefine Billed as closed to
silence the collision. A shared phone alone never authorizes file attribution.

Candidate design: the existing freshly authorized file and server-bound own
line may yield only messages with a unique, current claim/property anchor.
Cross-file, unanchored, malformed, stale, and mixed messages stay withheld.
Destination-level opt-outs are minimized safety observations, not another
property's message content. Coverage remains explicitly partial. The all-line
phone-history route retains its existing strict uniqueness gate.

## Verification

- The real signed HTTP fixture reproduces an active Billed record sharing the
  destination. It returns only the target property's independently anchored
  text and a minimized opt-out; other/mixed/generic property content and raw
  foreign provider identifiers are absent. Only the server-bound employee
  line is queried; provider write count remains zero.
- Without unique current anchors, no Quo history is queried and the explicit
  `phone_match_shared_active_files` failure remains incomplete. Malformed
  matching phone records still fail closed with zero Quo history requests.
- The separate all-line route continues to reject shared destinations before
  any message/call reads. Source values, assignments, sender bindings,
  permission gates, effect approvals and Mac Operator pins are unchanged.
- `TMPDIR=/private/tmp npm run check` passed: 201 prechecks, 831 main tests,
  4 connector-journey tests, 61 management/smoke tests, 19 company-roster tests
  and 5 new matcher tests. These are test executions, not distinct test counts.
  Log: `/private/tmp/hcn-exact-phone-match-final-green-check-20261007.log`.
  Syntax and diff-whitespace checks passed. Node 26.4.0; no installations.
- The first signed fixture caught a wrong timeline-kind assumption; it was
  corrected to the provider client's actual `text` type. Replay-protected
  fixture nonces were made unique. The existing missing-anchor regression now
  expects the more specific failure code while retaining its no-provider-read
  assertion. No production or authorization control was weakened for tests.

## Release boundary

Candidate only, not deployed. No live model/source acceptance or SMS send is
claimed. Approval is required before publishing this exact-file attribution
change. After approval, verify the deployed source and one current native
Jobrolo file review, then use the existing exact-plan approval/send/readback
workflow for the already reviewed text. Do not retry a denied all-line route.
Do not merge the separate Jobrolo PR392 as part of this release.
