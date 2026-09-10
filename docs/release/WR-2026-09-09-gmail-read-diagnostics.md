# Gmail read failure diagnosis

Principal claim: `codex/hcn-gmail-read-diagnostics`, based on deployed
`aad89a51fca43d0bd18fac0e6e0b5961fb441ad0`.

Chance requests repair of unavailable Gmail evidence in Jobrolo. Scope is the
existing Gmail exact-file adapter, employee token-refresh error classification,
and synthetic regression tests. No other employee's grant, arbitrary mailbox
fallback, relaxed file matching, customer communication, or source-record write.
The older dirty bridge checkout is untouched. HP's reviewed open Jobrolo work
does not claim these paths; HCN PR6 head is still the pinned deployed baseline.

One native read-only review used `jobrolo-subagent-orchestration`, with a single
inherited-model turn, 20-read/10-minute ceiling, no providers/secrets/effects.
Principal owns code, tests, approval questions and integration.

Observed live before this change: exact-file read reached HCN and returned
Gmail `source_unavailable`; Connections showed a stored Google link. Reconnect
reached Google's unverified test-app warning and was paused for user approval.
At that checkpoint no new Google grant had been accepted. Test-mode refresh expiry is a possible
cause, not a proven diagnosis. Render Shell access was denied; no bypass or
permission change was attempted. This candidate is not deployed.

## Completed local repair and verification

- The existing exact-file Gmail reader now reports the existing safe codes
  `google_not_linked`, `scope_check_failed`, or `provider_check_failed` without
  exposing provider payloads. Failed sources remain incomplete, not empty-success.
- Only confirmed OAuth `invalid_grant` responses (400/401) receive the reconnect
  hint. Rate limits, invalid client configuration, malformed replies and storage
  failures do not tell users to reconnect. No failed refresh deletes or rewrites
  a stored grant.
- Whitespace-only email/claim fields are absent values. Local alias selection
  skips these blanks without changing the shared field selector. Nonblank
  malformed identifiers and all-contact duplicate checks remain fail closed;
  no archived/other-owner records were excluded from Gmail correlation.
- Synthetic comparison of the deployed scalar functions and candidate reproduced
  the blank-field defect: deployed complete=false/matches=0; candidate
  complete=true/matches=1 for the same two synthetic rows.
- Actual HTTP fixture proves blank unrelated fields, sole-email fallback with
  ambiguous claim, list/detail/malformed provider failures, and continued
  zero-provider-read denial for dual-anchor collisions. The fixture uses local
  synthetic providers only. Actual token/helper functions were separately
  evaluated without server startup for invalid-grant/config/storage cases.
- Final `TMPDIR=/private/tmp npm run check`: precheck201/201, main789/789;
  syntax and diff-whitespace checks passed. Node26.4.0. The first targeted run
  using the macOS default temp location failed the existing history-store
  readiness fixture; rerunning with the documented canonical private temp root
  passed without weakening assertions. Final log:
  `/tmp/hcn-gmail-read-diagnostics-final-check.log`.
- Independent final read-only review found no blocker. The
  [Jobrolo subagent review workflow](/Users/chancepearson/Developer/jobrolo-canvasser-20260908/agent-skills/jobrolo-subagent-orchestration/SKILL.md)
  caused an additional correction separating store outages from unlinked grants,
  and strengthened the email-only regression test.

## Approved live reconnect: recovered on September 9

Chance explicitly approved Continue at Google's test-app warning for the existing
Wave employee's Gmail and read-only Calendar permissions. The paused attempt did
not complete; one fresh same-account flow then returned successfully at 13:39
America/Chicago. Google requested exactly the existing Gmail modify and Calendar
read-only scopes. No different account, additional scope, Render access change,
or source code deployment was used.

One actual-model, read-only Jobrolo turn then invoked `review_thresher_file` once
in the same saved exact-file Internal chat, limiting recent communications to3.
The UI showed a one-operation receipt and the answer reported Gmail available
with3 returned items at2026-09-09T18:40:20Z. Their dated subjects were shown;
the result remained bounded/partial (`source_partial`), not a complete mailbox
audit. JobNimbus was fresh. Quo still returned `phone_match_unverified` with
zero accepted items, not a verified empty history. No retries, sends, calls,
drafts, tasks, notes, imports, or customer/source-record changes occurred.

Thus Gmail recovery is observed after renewed authorization on unchanged source.
The original provider error was not exposed, so token expiry specifically is
still not proven. The synthetic whitespace defect is valid but was not required
to recover this live read. OAuth test-mode expiry remains a recurrence risk; see
[Google's refresh-token documentation](https://developers.google.com/identity/protocols/oauth2#expiration).

## Release completed September 10 UTC

PR33 merged as2e93e0c6d2f2f2f5c613d2bd089d8f8ce74759f4 and Render deployment
dep-dah08k61egvs73c0igp0 became live at2026-09-10T01:14:38Z. Public provider-attested
metadata and health200 verified. Normal authorized Render CLI deployment was
used; no Shell/SSH or permission change. Local201 prechecks and789 tests passed.

One exact-file Rolo check at01:16:58Z returned scope_check_failed: neither a
unique email nor claim number was recorded. The source correctly remains
unread, not empty-success; this is not proof of a disconnected Google grant.
Quo's separate model-input repair is deployed in Jobrolo PR361 and a02:00:19Z
exact-phone check returned9 matched events with explicitly incomplete coverage.
Actual document-content reads still failed503; see the September10 download
redirect follow-up. No external sends, calls, imports or source-record writes.

## Historical pre-release checkpoint

Candidate bcf4d01 is published for review in
[PR33](https://github.com/Onechance12/gatsby-ecommerce-theme-test/pull/33),
targeting the deployed `codex/hcn-platform-foundation` branch, not the unrelated
default `main`. A fresh local check again passed 201 prechecks and 789 main tests;
receipt: `/tmp/hcn-gmail-evidence-final-check.log`. No release check is configured
on this PR. At that checkpoint it remained undeployed. Publish the reviewed
hardening only after the required release approval and authorized HCN deployment
access are available. Quo exact-phone matching is a separate unresolved issue.
Do not weaken matching, borrow another employee grant, change Render permissions,
or bypass the denied Shell. No production build was changed during reconnect:
last verified Jobrolo source c3e8bfe and HCN aad89a51.
