# Reviewed portfolio intake — release candidate

Chance authorized extending the existing importer and shared-file flow after
the private roster/matching review. Branch codex/hcn-portfolio-import-20261007
starts from published 7fc25b88. Claims import-only grant/configuration,
catalog/snapshot admission, the exact provider mapper extension and focused
tests and the proposed existing HCN CI's production-branch PR admission. The legacy
assigned transport, document route, Mac Operator identity,
pins and effects remain unchanged. No source data or private selected-file
manifest belongs in this repository.

The new authority is an explicit expiring, immutable selected-file grant,
bound to the existing import client, connection and HCN reference tenant. It
does not impersonate other source owners or grant company-wide effects.
Source version, owner relationships, archive state and all exact-file
collection boundaries must be checked live. Jobrolo independently pins the
grant reference/digest/expiry before admitting the portfolio response.

Implemented on the existing signed catalog/snapshot routes. Selected catalog
pages use at most 25 exact contact reads plus the existing principal directory
check. A selected snapshot reuses the same complete exact-file collections and
adapter, with v2 source admission and separately verified original source
owners. The original assigned v1 wire vectors remain byte-identical.

Activation requires both HCN_JOBROLO_IMPORT_PORTFOLIO_ENABLED=true and the
private HCN_JOBROLO_IMPORT_PORTFOLIO_GRANTS_JSON registry. The exact registry
schema is hcn.jobrolo.import-portfolio-grants.v1; grants contain grantRef,
tenantId, clientId, connectionRef, issuedAt, expiresAt and providerFileIds.
Never put that selected-file manifest in Git. Limits: at most 10 grants,
500 unique selected files per grant, 24-hour lifetime. Jobrolo must independently
pin the exact grantRef/grantDigest/expiresAt to its existing tenant, connection
and client using JOBROLO_JOBNIMBUS_PORTFOLIO_IMPORT_ENABLED and the private
JOBROLO_JOBNIMBUS_PORTFOLIO_PINS_JSON registry. No profile/ref rebinding.

Verification: full npm run check passed on Node 26.4.0 with a canonical private
TMPDIR on macOS. The initial default-temp run correctly rejected redirected
Mac paths; no path guard was weakened. A full isolation check caught the new
unprefixed boundary constant; it was renamed to HCN_JOBROLO_PORTFOLIO_LIMITS
and all checks then passed. Focused portfolio suite: 43 passing tests, including
real signed loopback HTTP serving another source adjuster's file, unknown
grant/file denials, exact original-owner directory joins, unchanged v1 wire,
and provider-read-only requests. Pagination fixtures are synthetic.

No grant installation, release, source read, live import or provider effect has
occurred. Paired publication/runtime checks and a separately reviewed live
pilot still precede activation. Existing dirty release receipts are preserved.
Implementation claim released; the paired native build and owner publication
decision remain pending. GitHub rejected the proposed workflow edit because the
connected OAuth credential lacks workflow scope. That edit remains local and
is excluded from the review commit; no hosted CI pass is claimed.
