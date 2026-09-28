# Approved JobNimbus notes — unreleased candidate

This worktree adds an **off-by-default** exact-file, sole-operation plain-note
lane. It has not been deployed or installed. The currently deployed Mac operator
still rejects note creation; its JobNimbus authentication is not disconnected.

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

This candidate accepts exactly one canonical `@RichardR` token, with the
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
compiled release settings are intentionally disabled and have no candidate
commit/hash filled in. Tests use synthetic local pins only.

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

- Bridge: final 27 targeted note/policy tests passed, including rejection of a
  provider-reused activity ID. Before that last guard, the complete check passed
  (48 precheck tests and 525 main tests).
- Plugin: complete suite passed (239 passed, four optional service integration
  tests skipped); plugin manifest validator passed. Approval-display checks are
  included.
- Syntax and tracked diff whitespace checks passed.

These are local fixture tests, not evidence of production note delivery or a
Richard notification. No paid model test, live deployment, note, or tag ran.
