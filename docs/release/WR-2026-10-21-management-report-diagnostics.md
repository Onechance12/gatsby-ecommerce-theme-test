# Privacy-safe management report failure diagnostics

This diagnostic-only change targets the HCN management service on
`codex/hcn-platform-foundation`, based on `2875a305d126c1d5122fb8cb2102d3bb207518b7`.
It must not be merged into or deployed to the separately pinned operational
bridge as part of this release.

## Behavior and boundaries

- Only the two existing POST management-sweep routes create a diagnostic.
- A server-generated random diagnostic ID is returned in a response header.
  Failed requests emit one fixed-schema event to existing application logs.
- Events contain allowlisted stage/reason codes, bounded aggregate counters,
  HTTP status, elapsed time and transport. Unknown counts remain null.
- No names, file IDs, phone numbers, addresses, email, provider bodies, request
  bodies, URLs, headers, credentials, raw messages or stack traces are logged.
- The first failed inner operation wins. Concurrent later failures cannot
  replace it; counts freeze at the terminal response, not after background
  work finishes. These counters are diagnostic observations, not a completed
  portfolio or report.
- Provider errors retain their existing identity, public message and status;
  only a fixed internal failure category is added. HTTP responses stay
  fail-closed with their original error messages/statuses.
- Assignment/eligibility, authorization, request budgets, pagination limits,
  admission, freshness, concurrency, retries and all effect gates are unchanged.
- There is no additional provider request, automatic retry or customer write.

## Verification

- Server syntax and diff-whitespace checks passed.
- Eleven focused diagnostic/provider tests passed using synthetic inputs.
- The native HTTP fixture verifies duplicate index pages, wrong activity
  references and budget exhaustion, including fixed diagnostic fields and
  unchanged fail-closed responses.
- The signed Jobrolo HTTP fixture verifies an upstream 429 is safely identified
  while the public response remains 503; it checks one diagnostic event,
  exact request correlation, and unchanged provider-write counts.
- Full `TMPDIR=/private/tmp npm run check` passed: 833 main checks; postcheck
  groups passed 4, 71, 19, 12 and 43 tests. All providers were synthetic/local.
- The first targeted run used macOS's redirected default temporary path and
  failed the pre-existing encrypted-history path check. The canonical private
  temp root passed without weakening that safeguard. Two new fixture assertions
  were corrected: a reused synthetic nonce and the exact existing error text.

After hosted checks and exact-build deployment, the approved verification is
one read-only report attempt through the separately pinned management client.
Its result must not be represented as fixed or complete unless the live report
actually succeeds. Any newly identified functional/configuration correction
requires a separately scoped follow-up; this change supplies diagnosis only.
