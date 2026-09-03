# HCN Two-PA Jobrolo Readiness Work Receipt

Date: 2026-09-03

Branch: `codex/hcn-two-pa-readiness` from
`9082bb109b98b3dc53a0b300e2730a8468bfa70b`
(`origin/codex/hcn-platform-foundation`).

Candidate status: locally verified and not deployed. GitHub records the
immutable candidate SHA and pull request when this branch is published; this
source-controlled receipt does not try to refer to its own commit.

## Claimed scope

This candidate prepares the existing HCN-to-Jobrolo boundary for additional
public adjusters without letting a request select another employee, JobNimbus
owner, connector, caller identity, callback line, or file. It adds distinct,
server-owned profile registries for:

- general assigned-file Thresher, Gmail, and Quo access, with new profiles
  admitted as `read_only` until separately promoted after an isolation canary;
- exact-one-note JobNimbus writeback;
- Retell claim filing with a complete public-adjuster identity and unique
  callback number; and
- read-only JobNimbus import transport bound to one opaque Jobrolo connection.

The legacy singleton credentials remain backward-compatible primary profiles.
Every additional profile requires a unique client id, secret, approved HCN
principal, and its capability-specific identity fields. Runtime admission
rechecks the current active HCN employee and exact active JobNimbus owner.

The candidate also adds the versioned `jobrolo.hcn.carrier-email.v1` facade.
HCN resolves the fresh assigned file, current adjuster email, claim-number
subject, and exactly one same-file JobNimbus document. Draft creation and send
are separate sole-operation plans with separate approvals and provider
readback. A send uses the reviewed immutable draft snapshot, confirms the Sent
message, and confirms the source draft remains unchanged. Durable carrier
receipt recovery binds the current principal, approval digest, HCN batch
reference, operation count, exact file, and supported Gmail operation; missing,
duplicate, or mismatched evidence fails closed and never causes an automatic
retry.

Claim preparation now requires HCN's returned call plan to match the requested
source file exactly, and result review requires the returned plan id to match
the approved call plan. Retell prompts and callback selection use the assigned
public adjuster's server-owned identity. Inbound callbacks resolve exactly one
configured queue number and are limited to that profile's JobNimbus owner,
callback number, and complete caller identity.

## Safety boundaries

- Additional general profiles begin read-only; effect routes fail before plan
  creation or provider access until that exact server profile is configured as
  `approved_effects`.
- Carrier draft and send remain separate approval-gated effects. Receipt
  lookup is reconciliation only and never retries an effect.
- Note-only credentials still authorize exactly one
  `jobnimbus.create_note` operation.
- Claim calls and JobNimbus writeback remain separately approved, exact-file
  operations with durable receipts and provider readback.
- Import remains assigned-file read-only. Signed client identity selects one
  server-owned principal and one opaque destination connection.
- No provider credential or raw provider identifier crosses the Jobrolo
  facade.
- No live Gmail message, Quo text, Retell call, JobNimbus mutation, credential
  change, or production provider request was used for verification.

## Local verification

Verification completed locally on Node `v26.4.0`:

```text
TMPDIR=/private/tmp npm run check
precheck: 199 tests, 199 passed
full check: 783 tests, 783 passed
node --check src/server.js: passed via npm run check
git diff --check: passed
```

Independent release-blocker review found no remaining P0 or P1 issue in this
candidate. The review covered signed-profile selection, active employee and
JobNimbus-owner authorization, cross-profile isolation, legacy compatibility,
carrier-email approvals and receipt recovery, Retell caller/callback identity,
claim plan/result binding, and effect-route admission.

The release-required production read-only precheck also passed: the grouped
query over active `ExternalSourceConnection` rows returned zero duplicate
`(contractorId, provider)` groups. It made no write and exposed no credential.

## Release gates not performed

This receipt is not deployment approval. Before production:

1. Commit and review the complete candidate, including the new carrier-email
   contract and regression-test files; record the resulting immutable SHA.
2. Open and merge a reviewed pull request into
   `codex/hcn-platform-foundation`.
3. After deployment, provision each additional PA's distinct credentials and exact server-owned
   identity only in the production secret manager. Do not commit live values.
4. Verify each employee is active and uniquely bound to the intended active
   JobNimbus owner, Google identity/connectors, and Quo line.
5. Start each additional general profile as `read_only` and run cross-profile,
   wrong-owner, wrong-file, and wrong-connection isolation canaries.
6. Run signed non-effecting status/prepare canaries for import and claim filing;
   do not dial, send, or write without a separate action-time approval.
7. Attest the deployed SHA, durable HCN disk, restart continuity, runtime gates,
   and provider readiness before describing the candidate as live.

Production remains unchanged until those steps are separately authorized and
completed.
