# Jobrolo Claim-Filing Bridge Work Receipt

Date: 2026-08-14

Branch: `codex/jobrolo-claim-filing-v1` from
`ccafad32c66fdbc2c68201baf639803d284cfede`.

## Claimed scope

Chance authorized connecting the existing Phase 1 HCN Retell claim-filing
workflow to ordinary Rolo chat. This change owns only a new dedicated,
default-off Jobrolo HMAC capability profile and the six signed claim routes
needed for status, prepare, approved call, terminal result, separately prepared
writeback, and separately approved writeback. It reuses the current HCN claim
engine, exact assigned-file checks, one-use approvals, durable receipts, Retell
callback restoration, and JobNimbus readback.

Claimed files are the narrow Jobrolo service-auth/HTTP adapter, claim-filing
bridge contract helpers, focused tests, health/readiness metadata,
`.env.example`, `render.yaml`, the adapter ADR, and this receipt. The browser
employee claim routes, legacy claim routes, generic action-plan adapter,
provider clients, and other HCN workflows remain unchanged except where a
focused compatibility defect is proven.

The carrier call and JobNimbus writeback require independent exact Jobrolo
approvals. Authority is fixed server-side to Chance, an active assigned
JobNimbus file, and the dedicated claim credential. No generic Thresher action,
beta-user claim access, automatic retry, real carrier call, production
writeback, or provider credential disclosure is authorized by this work
receipt. Release validation ends with a signed non-dialing canary.

## Verification

Implemented on the existing HCN claim engine without adding a second worker or
caller. The dedicated Jobrolo profile accepts only these six routes:

- `/integrations/jobrolo/v1/claim-filings/status`
- `/integrations/jobrolo/v1/claim-filings/prepare`
- `/integrations/jobrolo/v1/claim-filings/execute`
- `/integrations/jobrolo/v1/claim-filings/result`
- `/integrations/jobrolo/v1/claim-filings/writeback/prepare`
- `/integrations/jobrolo/v1/claim-filings/writeback/execute`

It uses a fixed Chance principal, a distinct client ID/secret and session
domain, server-owned exact-file conversation context, and Jobrolo approval
attestations that are checked before HCN consumes its one-use challenge. The
existing Retell call, callback packet restoration, terminal result, transcript
review, field-mapped JobNimbus write, and provider readback remain authoritative.

Verification completed locally on Node 22:

```text
node --check src/server.js
TMPDIR=/private/tmp npm run precheck  # 175 tests, 175 passed
git diff --check
```

The canonical `TMPDIR` avoids macOS's `/var` to `/private/var` symlink alias in
the baseline durable-store path assertions; no test or production path was
weakened. Production release still requires matching dedicated credentials,
existing Retell configuration, verified JobNimbus claim-field mapping, manual
deployment of the exact HCN commit, and a signed non-dialing status/prepare
canary. No carrier call or JobNimbus write was made by this work receipt.
