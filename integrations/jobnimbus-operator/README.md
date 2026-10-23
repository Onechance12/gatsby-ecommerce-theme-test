# JobNimbus Operator for Mac

## Modern workflow stage closure verification (2026-10-23)

Current JobNimbus workflow statuses may omit `is_closed` as well as the contact
record. They instead carry the provider's built-in `stage`. The first closure
fallback therefore still blocked these records even with an exact active
workflow/status match.

The fallback now accepts a known in-progress provider stage only after the
existing ID/name, active and nonarchived checks. `Lead`, `Estimating`, `Sold`,
`In Production` and `Accounts Receivable` qualify; `Completed` and `Lost`
remain closed, while `None`, missing, malformed and unknown stages remain
unverified. Explicit closure flags are never replaced, and contradictions
between a workflow flag and stage are rejected. Provenance identifies the
`workflow_stage` basis and exact stage. No provider field or setting is changed.
JobNimbus documents its fixed stages in [What Are Stages?](https://support.jobnimbus.com/what-are-stages).

Read-only runtime diagnostics inspected workflow configuration only. The revised
mapper was also tested against the live configuration using a synthetic record,
proving the `Estimating` mapping and closed/unknown/owner/archive/exclusion
denials without reading or writing a customer record. The final exact-file
native check still requires the coordinated deployed bridge/package pin.
Existing approval-continuity, action policy, ownership and receipt rules remain.

## Local approval-continuity repair candidate (2026-10-22)

Not installed or deployed. Pending approvals use an encrypted Mac cache and a
unique public approval ID as well as the exact digest. Same-package/credential
MCP reconnects and unrelated file/action plans preserve them. Same-file/action
replacement, expiry, changed content or attested boundary still blocks execution.
The bridge now supersedes only overlapping server-resolved file/action scopes
for the assigned Mac identity; unknown/legacy scopes and other interfaces retain
the conservative behavior. No permission, policy or recipient gate is broadened.

Local claim-before-POST is atomic across processes. The durable states distinguish
pending, executing, verified, unknown and invalid; no ambiguous outcome is ever
restored to pending. A temporary attestation-read outage makes no execution POST
and retains the same unexpired approval for a later explicit attempt. Replanning
identical content creates a new approval ID and needs fresh human approval.

The cache uses AES-256-GCM with a domain/version-separated key derived from the
already-held transport credential, private owned paths, atomic fsynced writes and
per-plan locks. It adds no Keychain lookup or credential setup. Claiming removes
the stored challenge and payload before POST; expiry scrubs payload on access,
not by a promised timed deletion job. Interrupted locks fail closed for that
exact plan and are never stolen automatically. Credential/package rotations use
isolated namespaces and cannot resume old plans. Never manually copy approval
secrets or clear unknown tombstones to retry.

Synthetic validation includes actual coordinator calls through MCP stdio across
separate process lifetimes and concurrent clients, plus bridge HTTP fixtures.
This is not proof of the installed Codex app's native connection lifecycle.
Run `npm run test:approval-continuity` from the repository root with both the
root and `integrations/jobnimbus-operator` declared dependencies available.
The tests use generated synthetic fixtures and block harness network access;
they never load the installed server or read a credential. Serial test-file
execution avoids the existing HTTP fixture's short startup deadline under load.
Release requires separate approval for a coordinated bridge deployment and a new
versioned Operator package pinned to its provider-attested commit; preserve every
current policy, owner, expiry, exclusion, action, runtime and historical receipt
pin. Do not edit the installed cache or execute a customer plan as a smoke test.
The session/approval reference is the current workflow; older release sections
below describe their historical behavior where it differs.

Local verification on the unchanged deployment base `d6eb0790`:

- `npm run test:approval-continuity`: 567 tests, 563 passed, four optional
  research tests skipped, zero failures. Includes 13 encrypted-store/MCP
  lifecycle tests, plus exact-file HTTP approval and one-use regressions.
- Six focused `src/server-smoke.test.js` tests passed: unchanged batch digest,
  concurrent same-file reservation, reviewed-draft/SENT readback, current and
  predecessor draft provenance, post-approval draft changes, and old-draft
  follow-up/cleanup with completed-send duplicate protection.
- Operator skill validation, server syntax checks and `git diff --check` passed.
- Earlier combined runs hit local test-server startup deadlines, not provider
  assertions. Final serial reruns above passed; the note fixture now has a
  bounded 15-second startup deadline and 500-ms health-request timeout.
- No installed package, release pin, production configuration, customer
  action, receipt disposition, source commit/push or deployment was changed.

## Omitted contact closure verification repair (2026-10-22)

A successful partial contact update can be followed by a JobNimbus read that
omits `is_closed`. The live-assignment guard correctly refuses an unknown
closure state, but previously could not recover the provider's workflow value.

For an otherwise eligible live-assigned contact with an absent closure field,
the bridge now reads only `GET /account/settings?field=workflows`. It requires
one active contact workflow and one active, nonarchived status, matched by both
provider IDs and names, with an explicit valid closure flag. The returned
contact carries the derived flag and `closureVerification` provenance; no
derived field or workflow setting is written to JobNimbus. An existing contact
closure value, including an invalid one, is never overridden. Missing, duplicate,
mismatched, closed, archived or unavailable metadata stays blocked.

Workflow evidence is cached only inside the current authenticated request and
discarded before every provider write, so post-write verification rereads it.
Synthetic HTTP regressions cover successful readback after a partial update,
closure changes before execution and after a write, unavailable metadata,
unchanged ownership/exclusion checks, and retention of uncertain receipts.
The owner/action policy, permissions, effect gates and historical receipts do
not change. Deployment requires a coordinated versioned Operator build pin.

## Authoritative Retell model contract repair (2026-10-22)

The deployed c7501 bridge rejects the current provider's `model_config` and
`model_ultrafast` fields as unreviewed retained LLM configuration. Read-only
diagnosis confirmed the recognized live values are cascading GPT-4.1, standard
tier, temperature zero, no backup, and ultrafast false. The aggregate configuration
digest and saved publication proof therefore differ even though prompt, tools,
voice, callback routing and the older model controls match.

The claim settings now explicitly pin the authoritative model selector and the
ultrafast flag. Publication sends `backup:null` to clear inherited fallbacks.
Attestation equates only null and omitted backup with no backup; every other
model setting, nested extension, changed tier/temperature and non-null backup
remains part of the strict digest. Unknown top-level fields remain retained and
blocked. This follows [Retell's current model update contract](https://docs.retellai.com/api-references/update-retell-llm).

Synthetic HTTP regressions reproduce the provider's omitted-backup readback,
reject authoritative model/backup/extra-field drift even when legacy model
fields match, and verify explicit clearing during the existing dedicated,
digest-approved publication workflow. Existing receipt tampering, immutable
published-base, callback, identity, wrong-file and one-use approval checks remain.

Production rollout still requires the reviewed bridge deployment and a matching
versioned Operator package with all operational/management/research boundaries,
policy/owner/hash/expiry, eight actions, exclusions and historical fingerprints
preserved. Then prepare and approve the exact fresh Retell publication preview
using the dedicated one-route publisher. Do not edit or manufacture a publication
receipt: the existing publish/readback workflow must create the signed proof.
Require fresh native attestation and claim-agent `ready:true` afterward. No
claim call, retry, client communication or CRM update is authorized by this repair.

## Retell configuration failure diagnostics (2026-10-22)

Configuration verification now identifies each failed safety check using fixed
names instead of one generic missing-attestation error. The same checks remain
mandatory for read-only verification, call preparation and execution. Diagnostics
never echo provider values, credentials, webhook URLs, arbitrary mismatch strings
or bridge instructions into errors. Execution failures still consume the local
approval before any call POST; incomplete or conflicting communications still
block the ordinary full-evidence path.

`node scripts/verify-release.mjs --retell` checks the operational boundary and
then the claim-agent configuration through a fresh native MCP process. It never
reads a client file, prepares a claim, calls a carrier or publishes an agent.
The default verifier retains its separate management-status check.

Release this wrapper-only fix in a new versioned Operator package, preserving
the current operational and management build pins, owner, policy hash/expiry,
actions, exclusions, historical receipt fingerprints and all provider gates.
No bridge deployment or Retell prompt publication is needed for diagnostics.
Installing this package does not repair the live Retell configuration by itself;
use its failed-check names to prepare the exact underlying repair. Verify which
package the native session loaded before reporting that its tools were updated.

## Approved exact-host PDF download repair (2026-10-19)

The PDF transport permits HTTPS `files.jobnimbus.com` only for read requests.
Reservation validation and PUT destinations retain their previous allowlist;
PUT redirects remain forbidden. All cross-origin redirects strip the bearer
permanently, including redirects back to an authenticated provider origin.
Credentials in URLs, fragments, nondefault ports, other JobNimbus subdomains,
lookalike hosts and untrusted onward redirects remain blocked. Existing byte,
deadline and redirect bounds still apply. No wildcard domain or credential
forwarding exception is added. This repair changes no client access, receipt,
hold, upload, draft or send and requires a matching versioned release pin.

## Read-only PDF diagnosis and focused instruction candidate (2026-10-19)

The native `pdf_receipt_diagnose` tool separates troubleshooting from approval.
It accepts only an exact batch/file/document triple and uses the existing
read-only receipt route with fresh current-policy/identity/build attestation.
It reports original/observed privacy, exact metadata and byte proof, or precise
allowlisted URL-rejection causes and fixed host categories with a hostname hash.
No signed URL, raw hostname, provider body or credential is returned.

The diagnostic creates/consumes no approval, changes no ledger or provider state,
releases no hold and never resumes an upload. Tests prove the original receipt
and approval store remain byte-for-byte unchanged, an existing native approval
remains usable, unsafe response fields fail closed, and wrong-file/authority
overrides are refused. Trust destinations, duplicate guards and action policy
are not expanded. The same classifier powers actual transport enforcement and
diagnostic output, so different URL causes are no longer collapsed into one label.
When a receipt/plan already supplies an immutable file ID, PDF checks fresh-read
that exact record rather than repeatedly enumerating the contact index. Identity,
number, Insurance type, live owner and active/open eligibility are still checked.

The skill entrypoint now routes to mode-specific references rather than loading
all calling/reporting/payload procedures for every request. The detailed approval,
recovery, runtime and effect restrictions remain in linked references and code.

This candidate is built/tested locally, not installed or deployed. A coordinated
versioned release must retain the existing policy, owner, expiry, eight actions,
#2628 exclusion, historical fingerprints and independent connection boundaries.
Development approval does not deploy or activate the candidate. No client effect
is authorized by tool maintenance or installation.

## PDF verifier transport maintenance (2026-10-19)

The bridge retains PDF download authentication only across redirects within the
same trusted JobNimbus origin. Every cross-origin hop strips it permanently;
storage redirects cannot restore it. The existing host allowlist, four-request
bound, deadline, byte limits, metadata/hash proof and no-retry rules remain.
PUT requests still never follow redirects.

Fail-closed HTTP 409 responses now contain only fixed failure categories,
operation/destination categories, bounded hop numbers and safe upstream HTTP
status. Structured bridge logs contain the same minimized diagnostic. They
never contain provider bodies, signed URLs, credentials or raw exception text.
Synthetic tests cover redirect authentication, credential stripping, safe
diagnostics and unchanged receipts after a read-only verification failure.

Chance approved repair/deployment and a coordinated versioned Operator release,
not a client effect. Pin the provider-attested deployed commit in a new package;
never edit a running cache or bypass exact-build checks. Keep the live-assigned
policy/hash/owner/actions/expiry, #2628 exclusion, historical receipt hashes,
file quarantines and all approval gates unchanged. After fresh attestation,
an exact read-only verification pilot may check the repaired path. Upload,
access changes, receipt disposition, draft creation and sending each remain
separately approval-gated. A reproduced redirect defect is not proof that it
caused every live verification failure; use the new diagnostics if one remains.

## Inactive exact Quo SMS candidate (2026-10-14)

`mcp/quo-sms-release.mjs` defaults **disabled**. This source adds a dedicated
`quo_sms_plan` / `quo_sms_execute` pair over the existing action-batch approval
and receipt ledgers. It does not enable `ALLOW_QUO_SEND`, expose the generic
Quo send route/capability, send a client message, modify the installed plugin,
or alter production configuration.

Activation requires a separately reviewed bridge commit, exact
`chance-58-files-sms-v1` manifest hash, unchanged 58-file roster/#2628
exclusion/six historical fingerprints, and a versioned installed Operator pin.
The cumulative manifest preserves the reviewed note and PDF actions and adds
only sole-operation `quo.send_text`. The dedicated tool accepts exactly
`{query,from,to,content}`. It requires an exact numeric manifest file, exact
E.164 verified Wave sender, freshly unique client/adjuster recipient on that
file, full displayed text, short-lived one-use approval, and unchanged
boot/build/policy/runtime immediately before execution.

The bridge reserves the immutable send digest before the provider POST. A
completed receipt must read the exact Quo provider message ID back and prove
outgoing direction, sender, recipient, exact-content SHA-256/character count,
and current delivery status. Queued/sent is evidence that the exact provider
message exists, not proof of carrier delivery. Any timeout, missing ID,
incomplete history, mismatched readback, restart window, or receipt-write
failure becomes reconciliation-only and is never automatically resent. An
unprovable outcome quarantines that exact file. Message text is kept out of
durable action/outbound ledgers; the approval plan necessarily displays it.
The hidden approval challenge is retained by the encrypted local approval store.
Execution requires the exact public approval ID and digest, fresh attestation,
and explicit human approval; see the current session/approval reference.

Development verification uses only local synthetic JobNimbus/Quo providers.
It covers changed text/sender/recipient, generic-route denial with the global
Quo gate off, provider readback, duplicate execution, restart invalidation,
reconciliation without a second POST, and missing-ID quarantine. Publishing,
deployment, manifest creation, installation, restart, and any client SMS
each require their own later approval. No live message was sent here.

Under an explicit release approval, `scripts/activate-approved-quo-sms.mjs
preview` reads only the live manifest and historical-isolation variables and
prints safe metadata. Its `activate <preview-hash>` mode changes only those two
variables, preserves the exact roster, expiry, #2628 exclusion, allowed contact
fields, evidence sources, and six immutable fingerprints, and appends only
`quo.send_text`. It does not enable generic Quo sending or deploy the service.

## Unreleased reviewed-claim-packet separation (2026-10-09)

The existing Retell plan/execute tools now have an explicit `reviewed_packet`
candidate mode. Default `full_evidence` is unchanged. Human-directed execution
can use a file-bound, timestamped packet and field-specific review provenance
without repeating Gmail/Quo scans. Unchecked history and caller-reported source
review stay prominent in the one-call approval screen; they are not reported
as a completed communication audit or proof of no existing claim.

Fresh complete JobNimbus evidence, known-stop detection, pending-callback reads,
unchanged packet/callback variables, exact build/configuration, single-use
approval, and existing atomic Retell duplicate guards still apply. No bridge
handler, agent prompt, capability, manifest, roster, writeback or send changes.
See [the mode's workflow](skills/jobnimbus-operator/references/reviewed-claim-packet.md).

Development approval does not deploy or activate this candidate. Do not edit
the installed plugin cache or change pins to use it. A separate versioned
Operator release must preserve the live exact bridge/manifest/legacy-isolation
pins and all previously released helpers/actions, then pass full attestation.
If publishing source also deploys the bridge, coordinate its new provider-
attested commit and Operator pin instead of disabling the exact-build check.
Do not publish a new Retell prompt for this wrapper-only change. A read-only
pilot never approves a call, DOL, retry or JobNimbus update.

## Unreleased communication-evidence repair (2026-10-08)

This local candidate builds on the existing bridge and Mac Operator. It fixes
Gmail attachment-token rotation with an exact signed MIME reference, adds a
bounded complete Gmail review, separates homeowner identity from Quo routing
fields, enables explicitly proof-scoped shared-phone **reads**, reviews all
returned Quo call transcripts, and exposes the existing read-only DOL engine.
The native Retell preflight uses the complete review and still blocks unknown,
mixed, omitted, truncated or unavailable evidence. Transport-token changes alone
do not change an evidence digest; material MIME metadata and content still do.

Follow-through uses the existing `jobnimbus.ensure_current_task` approval lane
and one authorized private checkpoint, as documented in the packaged evidence
reference. No new CRM, Brain persistence, autonomous worker or client write was
activated. Quo texting, carrier follow-up calls, calendar writes and task
completion remain unavailable in this candidate's Mac effect boundary.

Development approval does not deploy or activate this candidate. The installed
plugin cache, version, bridge build pin, 58-file policy/hash/expiry, six historical
receipt fingerprints and production environment are unchanged. The local
expected capability set adds only `weather.date_of_loss.research` (Mac-only,
assigned exact-file read); release must explicitly approve and attest that
addition. No company sweep or new effect capability is added.

Coordinated release gate:

1. Review the exact source commit and synthetic regression results, including
   expired/forged/wrong-file attachment refs; token rotation versus changed MIME
   metadata; Gmail pagination/full-body/unknown/mixed/budget cases; Quo routing,
   shared-phone privacy, old transcripts/voicemails and transcript failures;
   immutable Retell evidence approval; and existing note/PDF/receipt protections.
2. Obtain separate approval for push/merge/deployment and the versioned native
   Operator release. Do not edit a running cached plugin. Pin the deployed
   provider-attested bridge SHA and review the exact read-only weather capability
   change. Keep the approved PDF/note release configuration, manifest roster,
   action set, expiry, #2628 exclusion and six-receipt isolation unchanged.
   Recheck the independent management/research/Fred launcher build pins without
   widening those profiles. Policy expiry renewal is a separate reviewed change.
3. Start a fresh session; require the full build/identity/capability/runtime/
   policy/receipt attestation and zero unresolved or hard-blocked receipts.
4. Run a read-only pilot on the previously selected unfiled-policy/property,
   cancellation-PDF, old-appraisal-draft, prior-filing-attempt and shared-number
   cases. Record source freshness and exact remaining holds. No draft, send,
   call, upload, task or CRM change is authorized by this pilot.
5. Obtain separate exact-file approvals for any subsequent supported action.
   Carrier-follow-up activation needs its own reviewed immutable plan,
   single-use approval, configured line/recipient proof, uncertain-outcome
   reconciliation, provider readback and restart/build-drift tests. Existing
   backend routes alone do not activate those lanes.

See [the packaged evidence workflow](skills/jobnimbus-operator/references/evidence-review.md).

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

The activated production operator exposes two narrow approval lanes; the
inactive SMS candidate described above would add a third dedicated plan/execute
pair only after its coordinated release:

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

Read-only `bridge_restart_verify`, unrelated plans and unchanged same-Mac reconnects preserve pending approvals. Exact replacement, changed boundary or expiry still blocks them; only the explicit current plan's ID/digest may execute.

The credential is intentionally absent from files and environment configuration.

## Retell preflight evidence contract (release candidate)

Ordinary evidence cards keep their 30-activity, 30-open-task and 60-document
display previews. Retell planning and its immediate execution recheck request
`includeCompleteJobNimbusEvidence:true` through the existing exact-file review
route. This returns every activity, open task and operational document metadata
record within the strict 5000-record source/related-primary-union bound. It does
not expand the manifest or review other clients. Pagination failure or a larger
union fails closed; it is never silently sliced into a supposedly complete scan.

Admission requires versioned `liveJobNimbus.coverage` in `complete` mode,
provider completion and consistent available/returned/omitted counts. The full
record set and coverage bind the one-use approval digest. Prior-filing signals
in older activities or open-task text stop a new-claim plan; these are review
holds, not proof that a particular claim was filed. Document metadata remains
metadata, not verified document contents.

Gmail's 3650-day search window is an explicitly disclosed bound, not an unknown
provider omission. The 15-result/five-thread search and five-message/1800-character
thread previews remain bounded: remaining pages, withheld search **or** thread
messages, omitted threads/messages, body/preview truncation or missing/inconsistent
coverage prevent call admission. The Operator independently validates those
counts rather than trusting only `providerScanComplete`. A clean bounded search
may proceed; a partial review must not be labelled complete.

Release requires the reviewed bridge deployment and a matching versioned Operator
build pin in a fresh process. This candidate does not alter the installed plugin,
policy, roster, credentials or live Retell configuration. Development approval
does not deploy or activate it, and activation never authorizes a carrier call.

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
