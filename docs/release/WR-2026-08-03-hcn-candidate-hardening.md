# WR-2026-08-03 HCN candidate hardening

Status: ready for independent re-review

## Source state

- Repository: `Onechance12/gatsby-ecommerce-theme-test`
- Branch: `codex/hcn-platform-foundation`
- Hardened baseline HEAD: `cbd91ab1eefc7d16eabebec4d2c2cd7f15d43c2d`
- Remote and rollback SHA: `2a292269be830e0d40eb4d1445e46f27e67d3aea`
- Delivery target: release-candidate commit on `codex/hcn-platform-foundation`, tracked by draft PR #6
- Production, provider, client, and secret access: none
- Production deploy, merge, provider mutation, and configuration changes: none

## Implemented hardening

1. General conversations cannot retrieve assigned-file listings or exact-file
   tool evidence. Exact-file tools require an exact-file conversation, matching
   opaque file reference, and the existing fresh employee-assignment check.
2. A pending model turn locks conversation selection, creation, archive,
   restore, and related context-changing controls. A response renders only when
   its conversation reference still matches the selected conversation; an
   unexpected mismatch leaves the reply persisted in its original chat.
3. Assistant readiness authenticates and decrypts an existing encrypted
   history store before reporting ready. Wrong keys and tampering fail closed.
4. Assistant HTTP, encrypted-history readiness, and minimized Calendar tests
   are in `precheck`; npm lifecycle runs `precheck` before the CI command
   `npm run check` used by `.github/workflows/hcn-platform-check.yml`.
5. The console states that model requests and necessary retrieved excerpts go
   to the configured Groq model provider and makes no unverified retention
   promise. General-chat starters now route file work through Work Center and
   exact client chats.
6. The public privacy notice now discloses the durable, encrypted,
   principal-scoped transcript store and bounded recent model replay. It no
   longer describes chat history as session-scoped process memory.
7. Every Groq Responses request explicitly transmits `store:false`. Groq's
   current endpoint-specific API reference accepts only `false` or `null` for
   that field. This flag is not treated as ZDR; project Data Controls remain a
   separate external gate.

Official contract reviewed on 2026-08-03:

- [Groq Responses API reference](https://console.groq.com/docs/api-reference)
- [Groq data controls and ZDR](https://console.groq.com/docs/your-data)

## Phase 1 claim-filing vertical slice

1. Added dedicated `/hcn/api/v1/claim-filings/*` employee contracts. The
   legacy Chance-owned claim routes are neither reused nor exposed to browser
   employees.
2. Claim preparation is available only inside one active exact-file
   conversation after a fresh JobNimbus assignment check. A separate
   server-side Google-subject pilot allowlist denies ordinary admitted
   employees and keeps the workflow hidden from their console.
3. Preparation fresh-reads JobNimbus and blocks on missing, malformed,
   placeholder, or ambiguous homeowner, property, carrier, policy, date of
   loss, cause, phone, ZIP, and typed employee-confirmation facts. Reported
   injuries stop preparation for human escalation.
4. The employee reviews the exact call objective, carrier destination,
   verified JobNimbus facts, employee-confirmed facts, missing facts, stop
   rules, and approval digest. The model has no preparation, approval, or
   execution authority.
5. A call requires a fresh short-lived, single-use approval bound to the exact
   principal, conversation, file, assignment, and unchanged plan. A durable
   executing receipt is written before the Retell effect. Unknown, partial,
   callback, or reconciliation outcomes never retry automatically.
6. Browser employees receive only an opaque HCN call reference. Result review
   is built server-side from the exact call metadata and terminal receipt.
   Retell post-call analysis remains explicitly model-analyzed and unconfirmed;
   transcript guesses cannot authorize writeback.
7. JobNimbus writeback is a separate plan and approval. It accepts only exact
   human-confirmed values bound to the server evidence digest, uses a
   configured verified field mapping, and completes only after fresh readback
   of the exact mapped fields and note. Missing mapping and any readback
   mismatch fail closed.
8. The exact-file Thresher UI implements the complete review sequence:
   confirm facts, review/approve one call, manually check the terminal result,
   confirm exact extracted values, separately review/approve JobNimbus
   writeback, and display verified completion or reconciliation.
9. LOR email sending and Jobrolo synchronization are intentionally outside
   this slice.
10. Result review now includes the bounded actual call transcript. The employee
    must explicitly attest that transcript review and independently enter or
    correct the outcome and mapped values; Retell analysis remains a labeled
    suggestion and cannot override the human review.
11. Carrier destinations must match the verified carrier directory. Employee
    phone overrides, homeowner destinations, future loss dates, and malformed
    pilot registries fail closed before a call plan is approvable.
12. Accepted calls are recoverable after a browser reload through durable
    receipt metadata and exact Retell metadata filters. Duplicate or ambiguous
    matches require reconciliation rather than retry.
13. Retell reads have bounded deadlines and response sizes, provider errors are
    sanitized, and exact call lookup no longer scans a global newest-100 list.
14. JobNimbus writeback honors the configured custom-field mapping throughout,
    resolves the requested status against the live status catalog, and verifies
    an existing exact note instead of creating a duplicate.

## Changed files

- `package.json`
- `render.yaml`
- `docs/architecture/001-hcn-system-boundaries.md`
- `src/auth/google-user.js`
- `src/auth/google-user.test.js`
- `src/console/app.css`
- `src/console/app.js`
- `src/console/index.html`
- `src/console/static.test.js`
- `src/hcn-assistant/conversation-store.js`
- `src/hcn-assistant/http.test.js`
- `src/hcn-assistant/readiness.test.js`
- `src/hcn-assistant/thresher-groq-responses.js`
- `src/hcn-assistant/thresher-groq-responses.test.js`
- `src/hcn-claim-filing/contracts.js`
- `src/hcn-claim-filing/contracts.test.js`
- `src/hcn-claim-filing/http.test.js`
- `src/server.js`
- this receipt

## Verification

- `node --check src/console/app.js`: passed
- `node --check src/server.js`: passed
- Final claim-filing and console focused gate: 39 passed, 0 failed, 0 skipped
- `npm run check`: exit 0; 634 tests total, 633 passed, 0 failed, and 1 skipped
- `git diff --check`: passed

The one skipped main-suite test is pre-existing test-suite behavior and is not
a candidate-critical assistant, history, HTTP, or Calendar test.

## External release gates — not performed

1. Restrict the first release to explicitly named internal-only pilot users.
   The current production assigned-work user population was not inspected. If
   any non-pilot assigned-work user exists, an assistant-specific server-side
   allowlist or feature gate is required before deployment; do not infer that
   the existing assigned-file boundary is a pilot-admission gate.
2. Provision and attest a dedicated HCN Groq project with ZDR enabled in its
   Data Controls. `store:false` does not satisfy this gate by itself.
3. Attest distinct, strong HCN-only secrets for assistant history encryption,
   Groq access, references, signatures, tenant isolation, OAuth/session
   protection, and other HCN stores. Record configuration presence only; never
   print secret values or reuse Chance Brain, Jobrolo, or shared bridge secrets.
4. Attest exactly one Render instance and one writer for the encrypted
   file-backed conversation store.
5. Attest the persistent HCN disk and exact assistant-history path, including
   restart persistence and fail-closed wrong-key/tamper readiness.
6. The hardened baseline SHA is
   `cbd91ab1eefc7d16eabebec4d2c2cd7f15d43c2d`, and rollback SHA is
   `2a292269be830e0d40eb4d1445e46f27e67d3aea`. Treat the exact head of draft PR
   #6 as the release-candidate SHA and attest it again before deployment while
   retaining the rollback SHA.
7. Run configured synthetic smoke tests for the pending-turn UI race and for
   restart/decrypt/reload behavior before admitting pilot users.
8. Obtain separate approval for a five-file read-only pilot. The pilot must not
   authorize writes, sends, calls, uploads, or production-wide file access.
9. Complete independent high-reasoning release/security review of this exact
   diff and define transcript retention, export, and deletion policy before
   broad or non-disposable client use.
10. Configure exactly two named pilot Google subjects in
    `HCN_CLAIM_FILING_PILOT_SUBJECTS_JSON`. The current production subject
    values were not inspected. The claim workflow is already denied and hidden
    when that server-side allowlist does not match.
11. Keep `ALLOW_RETELL_CALLS` false until the Retell agent/from-number
    configuration and call destination behavior are independently attested.
    Keep JobNimbus claim writeback blocked until the exact custom-field mapping
    is verified in the live account and configured through
    `HCN_JOBNIMBUS_CLAIM_FIELD_MAPPING_JSON`; configuration presence alone is
    not proof, and the executor still requires exact fresh readback.
12. After the separate five-file read-only pilot, run a separately approved
    synthetic call/result/writeback smoke with no real client. Any eventual
    one-file live canary requires a new action-time approval and must verify the
    durable receipt, opaque result, exact JobNimbus readback, and no-retry
    reconciliation behavior.

## Next integration seams ? not implemented

- LOR email belongs after a successful readback-verified JobNimbus claim
  writeback. The next slice should prepare a dedicated Gmail action plan from
  fresh file documents and representation destination, then require its own
  exact attachment/recipient review and approval. It must not be folded into
  call execution or retried automatically.
- The future Jobrolo sync must remain a separate, one-way integration owned
  outside the HCN runtime. Its reviewed contract may consume only a minimized
  export derived from a terminal HCN receipt plus exact JobNimbus readback; HCN
  must not import Jobrolo, query it as a source of truth, or let it authorize an
  HCN action.
- Calendar is not required by the Phase 1 claim-filing workflow. Its existing
  minimized read-only boundary remains separate and was not expanded here.


## Calendar boundary follow-up

Calendar remains read-only and minimized in this candidate. Its existing small
separation boundary is `src/hcn-assistant/calendar-read.js`, the
`read_calendar_day` tool contract in `src/hcn-assistant/tools.js`, its adapter
and dispatch in `src/server.js`, and the `calendar.readonly` connector scope.
Removing or feature-flagging that boundary is a separate reviewed change; it
was not redesigned in this task.
