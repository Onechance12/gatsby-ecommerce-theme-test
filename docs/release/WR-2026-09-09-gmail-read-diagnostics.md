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
No new Google grant has been accepted. Test-mode refresh expiry is a possible
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

## Still required

The live trigger is not established; local reproduction does not prove the
customer index contains the same defect. No new live model test was run, and
Gmail has not been verified recovered. The same-account reconnect is paused
pending approval of Google's test-app warning. OAuth test-mode expiry remains
a plausible additional issue; see
[Google's refresh-token documentation](https://developers.google.com/identity/protocols/oauth2#expiration).

Resume by completing the approved existing-scope Google reconnect and rechecking
the exact file through Jobrolo. If it still fails, publish the reviewed source
diagnostic candidate only after the required release approval and authorized
HCN deployment access are available, then repeat the exact-file read. Do not
weaken matching, use another employee grant, change Render permissions, bypass
denied Shell access, or claim the candidate fixes the live account before that
read succeeds. Jobrolo production remains c3e8bfe and HCN remains aad89a51.
