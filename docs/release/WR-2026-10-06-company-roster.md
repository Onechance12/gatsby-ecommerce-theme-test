# WR-2026-10-06 — isolated read-only JobNimbus company roster

Status: implementation verified locally; publication and activation pending.

## Authorized scope

Chance approved updating and publishing the existing HCN bridge with separate
read-only roster access across all adjusters. This is inventory only: no import,
client-record changes, communications, calls, invitations, or operational-token
scope changes. A file means a source client/property work file; repeated client
names must not be collapsed into one row.

## Baseline and ownership

- Existing HCN production tree: `b23851a1c379b321b46d4cc9bd7fcb3ad779e888`.
- Branch: `codex/hcn-company-roster-20261006`, based on that exact production tree.
- Scoped paths: new roster auth/service/client/tests, minimal server/auth routing
  seams, package test registration, `.env.example`, README, and this receipt.
- Preserve the unrelated local PDF publication receipt and untracked dependency
  setup. Do not publish Jobrolo onboarding branches or unrelated open HCN PRs.

## Required verification

- Separate credential, default disabled, finite grant expiry, fixed company
  binding, exact read-only routes; no fallback to existing credentials.
- All source pages plus an explicit end proof; bounds or malformed/conflicting
  data must fail closed, not claim a truncated roster is complete.
- Source IDs, property addresses, assignment and status metadata retained per
  source row; no documents, notes, communication transcripts, or financial data.
- Focused tests and the canonical `TMPDIR=/private/tmp npm run check` gate.
- Exact reviewed deployed commit attestation before any private roster retrieval.
- Private inventory artifacts stay outside source control and Jobrolo.

## Results

- New separate identity: `codex-mac-company-roster`, scope `company_roster:read`.
  Existing Operator, browser, report, provider-effect and import authorities are
  unchanged. Both new routes are explicitly denied before legacy wildcards.
- Roster reads only the existing provider connection's account employee snapshot
  and complete contacts/jobs catalogs. No owner/status filter, file merge,
  activity/document read, model request, persistence, import or external write.
- New private CLI requires a mode-600 profile, separate Keychain grant, exact
  provider-attested deployment SHA, matching tenant/expiry/scope/routes, complete
  end proofs and inventory digest. Failed attestation stops without fallback.
- `TMPDIR=/private/tmp npm run test:company-roster`: 19/19 passed, including real
  HTTP server/provider fixtures. The synthetic 300-file test is capacity evidence,
  not a real source count.
- `TMPDIR=/private/tmp npm run check`: exit 0 on the final candidate tree; existing
  safety suites and the newly registered roster suite passed. No gates relaxed.
- Production branch is pinned for manual deploy; unrelated open PRs and the
  existing locked Mac service/profile are not included or modified.
- The connected GitHub publishing credential cannot edit workflows. The optional
  PR branch-filter change was removed before publication; CI configuration stays
  unchanged. The existing production-push check must pass the exact merged SHA
  before deployment, in addition to the complete local gate above.

Deployment, activation and source inventory receipt pending.
