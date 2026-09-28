# Approved JobNimbus notes — live release

The bridge release is live with the opt-in exact-file, sole-operation note lane.
JobNimbus authentication was not disconnected; the former policy excluded notes.

## Verified deployment — 2026-09-28

- PR #45 merged into `jobnimbus-bridge`.
- Provider-attested bridge commit: `c81d30343e608331160ab6246ba1a5ae8dc2de8a`.
- Render deployment: `dep-data64ft8q1s73e86v4g`, observed `live`.
- Installed Mac operator: `0.5.0+codex.20260928172616`.
- Activated policy hash: `08490f603cf1c6d451e49f9cf4a195d8ca52b2253e06e2572b08a82a3a43ab1d`.
- Fresh installed-process attestation: ready, operator and recovery boundaries
  attested, zero unresolved receipts, zero hard-blocked receipts.
- Separate management gap-report status: ready and read-only; no external writes.
- No paid AI tests, JobNimbus notes, emails, or calls were executed.
- Old authoring source preserved at
  `/Users/chancepearson/plugins/jobnimbus-operator.pre-notes-20260928-1726`.

Start a new Codex thread to load the updated plugin tools. Prepare fresh exact
note plans and obtain their approvals before any client note execution.

## Scope

- Retain the existing 58-file roster, assignment checks, and #2628 exclusion.
- Bind one exact note to a fresh plan and separate user approval.
- Detect existing identical notes, make one provider write, and verify the
  provider record by ID, exact file, type, and text before reporting success.
- Preserve ambiguous outcomes for reconciliation; never automatically retry.
- Do not use an operator-authored note as independent proof for a stage change.
- Keep direct mutation routes, arbitrary sends, and company-wide writes closed.

## Richard mention intent is explicit; delivery is not asserted

Chance confirmed that **“tag accounting” means tag Richard in JobNimbus**.
The live JobNimbus editor resolves `@richard` to Richard R and inserts
`@RichardR`. Existing provider notes store that exact token; the UI links it to
user `kyd3walzugh6dlji6wpygdj`. The observed editor save implementation sends the
note text, not a separate mention payload. The public activity API does not
prove notification delivery.

This release accepts exactly one canonical `@RichardR` token, with the
intended recipient and unconfirmed notification status shown in the approval
plan and bound to the immutable receipt. Other mentions remain blocked.
`mentionsVerified` and `accountingNotified` remain false: exact note readback is
not notification proof. After an approved accounting note, verify the rendered
Richard link in JobNimbus; never report inbox/email delivery without evidence.
No payment note or accounting notification has been posted by this change.

## Release boundary

Activation requires a reviewed bridge build, explicitly activated new manifest
(`chance-58-files-notes-v1`), its exact hash, coordinated historical-isolation
binding, and an installed plugin pinned to that same build and manifest. The
merged source leaves plugin pins disabled; this local release record and the
installed plugin bind the exact reviewed build and manifest above. Tests cover
both disabled and activated configurations.

Do not change the active plugin cache, borrow legacy credentials, relax a live
grant, or auto-migrate the six historical receipts to make the feature work.
Installation/deployment and activation are separate from this source change.
After activation, re-attest the live boundary and prepare a new exact approval
plan before any note is posted.

Require zero unresolved and in-flight operations immediately before activation.
Exact predecessor receipt pairs preserve previously created Gmail drafts and
existing file-scoped quarantines; unknown policy or file bindings fail closed.
The six historical receipt rows must not be rewritten.

`scripts/activate-approved-notes.mjs preview` reads only the two named Render
policy values through the existing CLI credential and prints safe metadata.
Its explicit `activate <preview-hash>` mode updates only those two keys and
preserves the exact roster, expiry, exclusions and isolation fingerprints.
Environment activation needs a subsequent exact-commit deployment.

The staged plugin is copied from the currently installed version, not the older
unversioned authoring folder. Run its complete offline test suite and plugin
validator along with the bridge checks before release. No paid AI test or client
effect is necessary for these checks.

## Offline verification (2026-09-28)

- Bridge: 48 precheck and 530 main tests passed; 30 targeted tests also passed,
  including real backend plans checked by the plugin approval validator.
- Plugin: 245 tests passed in disabled, synthetic enabled, and final pinned
  configurations, with four optional service integration tests skipped.
- Plugin manifest and skill validators passed.
- Syntax and tracked diff whitespace checks passed.

Fixture tests and live read-only attestation are not proof of production note
delivery or a Richard notification. Those require an approved live note.
