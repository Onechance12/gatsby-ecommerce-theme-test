# JobNimbus Operator for Mac

## Inactive PDF upload candidate

`mcp/pdf-upload-release.mjs` defaults **disabled**. This source introduces
`pdf_upload_plan` / `pdf_upload_execute` over the existing action-batch gate;
it does not activate a direct upload route, install itself or change live pins.
The active PDF release must be separately reviewed with an exact bridge commit,
`chance-58-files-pdf-v1` policy hash and matching historical-isolation binding.
The seven-action manifest preserves all six note-release actions and the exact
58-file roster. Generic/direct upload capability remains absent.

Fred selects a reviewed local regular PDF and explicit privacy. The Operator
captures at most 8 MiB in its one-use local approval slot and displays only the
exact file, filename, size, SHA-256, privacy and digest. After exact approval,
it re-attests the unchanged boundary, executes those captured bytes and verifies
the new provider document ID, exact-file metadata and downloaded byte hash.
No PDF bytes, local paths, bearer credentials or presigned URLs enter bridge
approval/receipt ledgers or chat. Receipt recovery never retries a reservation,
PUT or completion. No browser or raw-provider fallback is permitted.

See the packaged skill's PDF workflow. Deployment, coordinated pin/manifest
migration and a fresh process are separate approval gates. Existing installed
tools are intentionally unchanged by building/testing this candidate.

Release checklist (do not run as part of development approval):

- Review this isolated source diff and synthetic tests. The baseline is the
  deployed notes bridge `c81d30343e608331160ab6246ba1a5ae8dc2de8a`, not the
  separate SPOTIO/Jobrolo branches. Preserve unrelated releases.
- Confirm the existing JobNimbus credential already permits file creation;
  never enlarge its access profile as an implicit fix. Confirm provider file
  metadata exposes the exact ID, filename, related file and `is_private` or
  `isPrivate` boolean. Missing/ambiguous proof fails closed.
- Under explicit activation approval, derive the new manifest from the live
  reviewed notes manifest: change only its ID and append `jobnimbus.upload_pdf`.
  Preserve roster, expiry, exclusions and field restrictions. Rebind only the
  existing six-entry legacy-isolation policy ID/hash; never change fingerprints
  or replay receipts. Do not reuse the old notes activation script.
- Deploy the reviewed bridge commit, then pin its provider-attested full commit
  and exact new manifest SHA in the PDF release constant. Publish/install a new
  versioned Operator release. Repoint Fred's read-only launcher to that reviewed
  installed version without adding writes. Recheck separate management/research
  build pins for the new bridge commit without expanding either profile.
  Do not edit a running cached plugin or disable attestation to bridge the gap.
- Start a fresh persistent Mac tool session, require full readiness and zero
  unresolved/hard-blocked receipts. Use the new skill workflow for a separately
  approved exact PDF. A successful synthetic test is not a live upload receipt.
- If activation cannot attest, stop. Any rollback must retain receipts and
  quarantine unknown provider outcomes; never blindly resume the old manifest
  or retry a reservation/upload/completion. A draft/send needs its own approval.

The transport reuses the existing Files API reservation/PUT/completion flow.
No live provider upload was performed during development. PDF framing checks
are not structural validation, malware scanning or review of document content.
Duplicate checks cover filenames, verified upload receipts and bounded same-size
existing documents. If an older document exposes no size, renamed equal bytes
cannot be ruled out by that check; review the exact-file inventory before approval.

Development verification: `npm run test:pdf-upload` passes 280 tests, including
35 new PDF/upload/local-approval/transport tests; four existing optional research
integration tests are skipped. `npm run check` also passes the 530-test core
bridge suite. The packaged skill validator and syntax/diff checks pass. Tests
use synthetic bytes and local/mock providers, never client uploads. The installed
Operator, live policy and production service are unchanged.

## Approved-note release

This release adds the sixth action, `jobnimbus.create_note`, when
`mcp/approved-note-release.mjs` is explicitly enabled with a reviewed bridge
commit and `chance-58-files-notes-v1` manifest hash. The bridge, manifest,
six-receipt historical-isolation binding, and local plugin must attest together.
Source code or documentation alone does not activate the release.

The optional `chance-58-files-notes-v1` release adds only a sole-operation
`jobnimbus.create_note` action with exactly `{query,note}` on the same allowed
assigned files. Existing content approval, one-use challenge, file binding,
readback receipts and ambiguous-outcome recovery still apply. Direct note
routes, edits/deletes and all other existing restrictions remain unchanged.
Readback must prove the provider note ID and SHA-256 of the exact approved text.

An approved note may contain one canonical `@RichardR` mention request. The
exact intended recipient is Richard R, user ID `kyd3walzugh6dlji6wpygdj`; the plan
and receipts bind `mentionRequested` and `intendedRecipient`. Plain notes use
`mentionRequested:false` and `intendedRecipient:null`. Other `@` text, repeated
tags, and caller-supplied mention fields are rejected. Prepare the exact
canonical text before approval; no automatic substitution changes approved text.

**A saved note is not proof of notification delivery.** Receipts preserve
`mentionsVerified:false` and `accountingNotified:false`, even when the canonical
tag is requested. Report that the note was saved with a requested Richard
mention; do not claim Richard was tagged or notified without separate provider
or UI verification. Never replace a requested accounting handoff with an
unexplained plain note.

Installation and production activation are coordinated release steps. When the
compiled switch is disabled, the earlier five-action policy remains in force.

Local Codex operator for the production HCN/Wave bridge.

- Production URL: `https://jobnimbus-chatgpt-bridge.onrender.com`
- The MCP server hard-pins that HTTPS origin; no environment variable can redirect the Keychain bearer credential
- Build binding: service `jobnimbus-chatgpt-bridge`, provider-attested to the exact pinned bridge source commit exported by the plugin
- Credential: macOS Keychain service `com.wavepa.jobnimbus-operator`, account `codex-mac-operator`
- Operational scope: an immutable 58-file Chance roster; JobNimbus #2628 is excluded
- Read-only company exact-file review remains available; company mutations and company claim calls are disabled
- Broad company indexes, sweeps, and arbitrary mailbox/phone queries remain blocked

The operator exposes two narrow approval lanes:

1. JobNimbus/Gmail actions use the existing exact dry-run digest and hidden single-use challenge action batch. Contact corrections, forward stage moves, and marked current-control tasks may group up to five exact Chance files in contact → status → task order. Gmail draft creation is a sole-operation batch and is not a send. A bridge-created draft may be delivered only through a later sole-operation `gmail.send_existing_draft` plan using its exact returned `draftId`, fresh immutable snapshot, and a new Chance approval. The bridge verifies the Gmail `SENT` message and retained unchanged source draft.
2. Retell claim filing uses a separate single-file plan and execution pair. It supports only `file_new_claim` and `find_existing_claim`, always forces `includeCarrierBatch:false`, freshly reads the exact manifest file, and places no call until Chance explicitly approves the complete current packet, destination, communication preflight, `planDigest`, local `approvalId`, and unchanged input. Planning first runs a fresh exact-file JobNimbus, Gmail, and transcript-requested Quo review; unavailable, ambiguous, provider-incomplete, paginated, or partially reviewed evidence fails closed, and strong existing-claim, prior-filing, carrier-receipt, carrier-inspection, or callback signals stop a new-claim plan. New claims bind an explicit coverage disposition and practical file-specific damage facts; a prior/unverified policy is a lookup reference only. The bridge challenge stays hidden and is consumed once.

Before a Retell plan and again immediately before an approved call, the wrapper freshly re-attests the exact boot, provider build, run policy, historical isolation, runtime, identity, access, and capability boundary. It also reruns the exact-file JobNimbus/Gmail/Quo review and requires the approval-bound communication evidence digest to remain unchanged, then compares the exact published Retell agent/LLM versions and configuration digest, prompt, DTMF and guarded-end-call tools, extraction schema, timezone, signed callback restoration, no-default-inbound-agent route, full approved callback-packet digest, distinct isolated guarded-end and inbound-webhook credentials, and no-automatic-writeback contract. Any boundary, evidence, configuration, packet, digest, or input change consumes the local approval and fails closed before the call POST.

Claim-call results and pending carrier callbacks are read-only. Completed results require a transcript-bound guarded-completion receipt with the exact carrier-issued claim/reference number. A policy correction volunteered by the carrier may be retained as optional evidence, but Retell does not proactively investigate active coverage or policy terms. Conditional/unattributed callbacks and different-ANI recovery fail closed. The plugin does not expose `/claim-filing/writeback`; a call never automatically updates JobNimbus, creates a note or task, schedules an event, or sends an email/text. Any verified post-call JobNimbus change requires fresh evidence and a separate supported action-batch plan and approval.

The Retell provider and claim-call release gates may be enabled only together for this claim-filing lane. Generic voice calls, homeowner/client-coordinator calls, carrier-follow-up calls, generic Gmail/Quo send capabilities and gates, HCN action execution, direct mutation routes, task completion/deletion, direct note routes, calendar writes, backward stage moves, #2628, and nonmanifest files remain blocked. The only email-delivery exception is the manifest-pinned reviewed-draft action inside the existing action-batch process; raw/new-message sends remain impossible. `jobNimbusWritesActionBatchOnly` and `claimFilingApprovalLane` must be enabled; `actionBatchOnly` and `directEffectRoutes` must be disabled.

Forward stages require an exact related active JobNimbus Note that is not deleted or archived, a non-DRAFT/TRASH/SPAM exact-file Gmail message, or a delivered/received/sent/completed Quo message. Appointments, mixed files/claims, calls, failed/queued messages, operator-authored tasks, document filenames, and request/checklist/draft/planned language cannot prove a gate.

Grouped JobNimbus execution is ordered, fail-stop, and non-transactional. Completed readback receipts are preserved and later actions are not attempted after a failure. Direct provider mutations outside the approval-gated action batch are not exposed.

Platform admission is fail-closed: the exact five Retell claim-filing capabilities (configuration review, prepare, call placement, result review, and callbacks) must be present alongside the pinned read/action-batch surface; claim writeback, automatic Chance Brain writeback, generic/direct JobNimbus effects, generic Gmail/Quo send capabilities, and every other call capability must be absent. JobNimbus, Gmail, and claim-filing connectors must be configured, `externalWrites` and only `claimFilingCalls` may be enabled, and every generic send, generic/homeowner/follow-up call, and HCN action gate must be disabled. Reviewed-draft delivery is authorized only by its exact action-batch plan, not by an enabled generic send capability or gate.

Historical admission pins the immutable batch ID and raw-row SHA-256 fingerprint of each of six exact pre-scope receipts under `chance-58-prelock-receipts-v1` as visible, never-replayable, unknown-outcome audit attention. This is manual risk acceptance, not recovery or evidence; every new file action or call still requires a fresh provider read.

After an app restart or in every new chat, run `bridge_restart_verify` before any plan. It verifies the local plugin version, dedicated Mac identity, provider-attested exact pinned bridge commit, remote runtime/capability boundary, exact six-receipt historical-isolation contract, exact manifest ID/hash/count/expiry, #2628 as the sole exclusion, the six action-batch actions when notes are activated, the single Retell claim-call lane, and the recovery boundary. Normal work requires `ready:true`, `unresolvedCount:0`, and `hardBlockedCount:0`. The note policy must attest `noteCreationAllowed:true`, `noteCreationSoleOperation:true`, `noteMentionRequestsAllowed:true`, and `noteMentionsAllowed:false`.

If `ready:false` is caused only by enumerated unresolved action receipts, the response exposes `recoveryBoundaryAttested:true` and `recoveryAllowed:true`: receipt reads, attested Retell configuration/result/callback reads, and reconciliation may use that boundary, but planning and execution may not. Read each exact receipt and reconcile only every listed reconciliation-eligible nonhistorical batch, then rerun `bridge_restart_verify`. Hard-blocked receipts stop work and are never reconciled. Reconciliation never resumes or retries an action or call.

Calling `bridge_restart_verify`, starting any newer action-batch plan, or starting any newer Retell call plan clears every pending local approval across both lanes. Approval challenges live only in the current MCP process; a restart or new chat always requires a fresh plan and approval.

The credential is intentionally absent from files and environment configuration.

## Read-only 3x10 gap reports

`management_report_status` and `management_gap_report` use the existing HCN
management-sweep engine at `https://hcn-operations-platform.onrender.com`, not
the operational bridge. They use a separate Keychain credential, service
`com.wavepa.hcn-management-report`, account `codex-mac-management-report`, with
only two allowed routes and an exact provider-attested build pin. No browser
login, HP credential, shared token, model call, or client write is involved.
The report returns up to ten active Estimating-board files per configured
adjuster, ranked by verified JobNimbus work activity. Preserve evidence and
ownership exclusions; do not substitute days in status or imply Gmail/Quo were
reviewed. The ordinary Mac operator's broad-company restrictions are unchanged.

For a current thread that has not loaded the new MCP tools, the same pinned
client is available as `node scripts/management-gap-report.mjs --status` and
`node scripts/management-gap-report.mjs --output /absolute/new-report.json`.
The output must not already exist. A failed attestation or read stops without
automatic retry or fallback to another credential.

## Optional document research (unreleased, disabled by default)

This source change adds only `document_research_session`,
`document_research_inventory` and `document_research_original` in the existing MCP
server. It does not change the Mac operator's credential, capability pins,
58-file action policy, six historical receipts or operational approvals.

No research tools are registered unless an explicitly installed private JSON
pin is selected by `JOBNIMBUS_DOCUMENT_RESEARCH_PIN_PATH`. No pin is created by
the plugin. Research uses only Keychain service
`com.wavepa.jobnimbus-document-research`, account `codex-document-research`,
never the operational credential as fallback. Do not configure or reinstall
this source merely because implementation/tests were approved.

The reviewed pin contains company ID, grant ID/hash/issuance/expiry, provider-
attested bridge build, exact limits/exclusions and cache retention. Its file
must be an owned regular 0600 file in an owned 0700 directory, with no symlinks.
Verify the research session before acquisition. A changed/expired grant, build
or document/file binding fails closed. Research cannot reach operational routes.

Originals are stored under the existing private `files/research` cache, isolated
by company/run/file/document/hash, with 0700 directories and exclusive 0600
original/manifest files. SHA-256 and length are checked before and after saving.
Expired grants prevent further acquisition; retention is recorded, not a claim
of automatic secure deletion. Any cleanup is separately reviewed. An existing
original or failed attempt is never silently overwritten or blindly retried.

HCN ESX provenance is internal/owner-confirmed. PDFs remain unverified until
reviewed; matching internal PDF/ESX pairs are not independent estimates. No HCN
data is transferred into Jobrolo, Brain, training or embeddings by this feature.
