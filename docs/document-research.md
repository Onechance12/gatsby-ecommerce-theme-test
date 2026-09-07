# Document research access — source-only release candidate

This extends the existing bridge and Mac plugin. It is not a second operational
router, agent, service, or claim workflow. Implementation/testing approval does
not authorize deployment, credentials, activation, customer reads, or effects.

## Admission

Default: disabled. The bridge requires an explicitly enabled
`DOCUMENT_RESEARCH_GRANT_JSON`, a distinct `DOCUMENT_RESEARCH_TOKEN`, and a
separately configured `DOCUMENT_RESEARCH_JOBNIMBUS_API_KEY`. There is no fallback
to the operational JobNimbus key. Prefer a provider credential limited to reads
when supported. Provider credential permissions must be verified at activation.
Invalid/missing optional research configuration disables research; it does not
loosen the existing operator. Token collisions/malformed tokens reject startup.

The grant JSON has `enabled`, `grantId`, `companyId`, `issuedAt`, `expiresAt`,
`excludedFileNumbers`, and `limits`. Limits are `pageSize`, `maxPages`,
`maxDocuments`, `maxOriginals`, `maxBytesPerFile`, `maxTotalBytes`. Normalization
always includes excluded file 2628, caps lifetime at seven days, and hashes the
exact normalized contract. No endpoint can modify/renew grants or credentials.

The Mac plugin requires a separately installed private local pin and Keychain
credential; see its README and `research-coordinator.mjs`. The pin must match
the server-normalized grant SHA, tenant, expiry, limits, exclusions and exact
provider-attested deployed source commit. No real grant/pin was created while
implementing this feature. Existing Mac build pins and action policy remain
unchanged until an explicitly reviewed release/repinning.

## Surface

Only these routes accept the research principal:

- `GET /document-research/session`: independent read-only attestation.
- `POST /document-research/inventory`: `{}` for the initial page, then only
  `{cursor}` using the exact opaque continuation issued to that run.
- `POST /document-research/original`: exact `{runId, documentId, fileId}` from
  the current inventory. No filename search, arbitrary URLs or provider filters.

Other principals cannot borrow these routes, including legacy/admin and ordinary
Mac operator identities. A research bearer is denied before OAuth, public routes,
static/browser handlers, unknown-route dispatch and WebSocket upgrades. Existing
58-file approvals, receipts, six historical-isolation entries, Retell boundaries,
and operational `companyWideIndexOrSweep:false` are preserved.

## Evidence and transport

Use only fixed GET calls through the dedicated provider adapter. Endpoints are
pinned to JobNimbus HTTPS; redirects are refused, JSON and originals are bounded
while streaming, deadlines are enforced, starts are capped at ten per second,
and Retry-After suppresses further dispatch. Explicit loopback URLs are allowed
only with both `NODE_ENV=test` and `DOCUMENT_RESEARCH_ALLOW_LOOPBACK_TESTS=true`.
Do not set test overrides in production.

Provider `customer` is mapped to the tenant ID without substitution from the
grant. `related` and `primary` contact IDs jointly establish document/file scope;
mixed or unsupported relationships are not silently discarded. Explicit privacy,
active/archive, exact IDs and stable document metadata are checked. Missing
visibility/company facts fail closed. The concrete `/files/{id}` envelope and
contact visibility fields still require an approved live pilot; synthetic tests
are not proof of production API shape or permissions.

Only minimal document/file metadata is returned. Photos and known unrelated
documents do not trigger byte downloads. Generic PDFs are listed as ambiguous,
not downloadable by this permission. Estimate/scope filenames identify candidates,
not verified carrier scopes. HCN ESX files are internal/owner-confirmed estimates.
An ESX and its matching internal PDF are not independent revisions; equivalence
still requires document review. No automatic PDF source-role assignment is made.

Original retrieval re-reads both document and parent before and after acquisition.
It validates bytes, MIME/signatures, length and SHA-256. ESX container validation
bounds compressed/expanded bytes and entry counts, rejects unsafe paths, duplicate
names, encryption/unsupported methods, CRC mismatches, DTD/entity declarations,
and suspicious expansion. No archive entry is executed or extracted to disk.
Unsupported legitimate ESX variants remain blocked for deliberate follow-up.

## Completeness, lifecycle and storage

Inventory totals, candidate/unsupported/excluded/unreviewed counts, continuation
and stop reasons are explicit. A missing total requires a terminal empty page;
short pages alone are not proof of completeness. Duplicate/inconsistent records
fail closed. Provider failure reports partial coverage and invalidates retrieval.
No pagination response claims a consistent point-in-time provider snapshot.

The currently verified provider result window is capped at 10,000 metadata rows.
This implementation stops explicitly at that limit; it does not claim to enumerate
all company files past it. No unverified MIME filter or pagination segmentation
is invented. Completing a larger corpus requires a supported provider export or
a separately verified segmentation mechanism before expansion.

One serialized inventory run is active at a time. A fresh initial read replaces
the previous run/cursors, allowing a new Codex session to reconnect without a
production bridge restart. Page/row/original/byte quotas are cumulative across
these runs and cannot be reset by starting another inventory. Inventory/cursors
and volume budgets are memory-resident; a bridge restart invalidates bindings and
resets those process-local budgets. They are not durable cross-restart spending quotas.
Do not restart to evade a limit. Approval for bulk/paid analysis requires separate
budget controls; this feature calls no OCR, embedding or model service.

The Mac stores immutable, exclusive 0600 originals/manifests in 0700 directories
under its existing private research cache, keyed by company/run/file/document/hash.
It verifies saved bytes by readback, never overwrites an existing original, and
does not automatically retry a failed acquisition. Retention expiry is the grant
expiry; tools stop acquisition at expiry. This is not an automatic-deletion system.
Review retained files and obtain cleanup authorization without destroying evidence.

No HCN originals enter Jobrolo, Brain, Git, shared knowledge, training or embeddings
through this feature. Deidentified learning/benchmark reuse needs separate review.

## Verification and release sequence

`npm run check` first runs the new research suite via `precheck`, then the existing
bridge regression suite. Run with a sanitized environment and a disposable
`TMPDIR`, leaving parent `MEMORY_ROOT` unset: unit fixtures supply their own
memory roots, and smoke children set their own overrides where required. Keep
the tracked `memory/company.jsonl` seed when testing a disposable source copy;
do not copy runtime client-memory stores, credentials or `.env` files.
Plugin tests use synthetic dependency injection, not macOS Keychain/live providers.

Release only after reviewing test results and approving deployment/activation:
publish reviewed bridge commit, deliberately repin/reinstall the plugin, install
the approved expiring research grant/pin/credential, attest both identities, and
run a small exact-original pilot before broader acquisition. No deployment or
activation is performed by the tests. Rollback revokes/disables research only;
it never deletes evidence or changes operational receipts automatically.
