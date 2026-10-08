# Exact-file evidence and follow-through

This is guidance for the unreleased evidence-repair candidate. Building source
does not install it. Use only tools actually exposed by the approved, fully
attested Operator; never change pins or use raw providers to bypass a hold.

## Preview versus claim review

For one selected file, request `ops_review_chance_files` with `limit:1`,
`includeCompleteJobNimbusEvidence:true`,
`includeCompleteCommunicationEvidence:true`, `includeGmail:true`,
`includeQuo:true`, `includeQuoTranscripts:true` and the needed date window.
The Retell coordinator requests this review again before planning and execution.
A quick preview is useful for orientation, not claim readiness.

Complete review follows up to 20 Gmail search pages/250 candidate messages,
reviews up to 25 relevant threads, and removes the five-message/1800-character
display preview. Each thread is bounded at 100 messages, 64000 characters per
body representation and 256 KiB of text; the combined packet has a 2 MiB text
budget. `gmail_search_exact_file` and `gmail_read_thread_exact_file` also accept
`completeReview:true`. A budget ceiling, repeat page, unknown/mixed message,
omitted thread/message, truncated body or unavailable provider remains explicit
and blocks a claim call. A known other-file search hit may be excluded only when
fresh proof identifies that other file and there is no target-file indicator.
Its content and identifiers are not returned. Unknown hits are not exclusions.

`providerScanComplete` describes the file-derived search inside its stated
window, not every historical message in the mailbox. Homeowner-number Quo
history does not prove carrier-number conversations were reviewed. Preserve
those limitations; empty results are not universal absence evidence.

## Gmail attachments

Use the `attachmentRef` on the selected attachment from a freshly verified
thread, together with the exact file, message ID, filename and MIME type.
The reference binds the authenticated principal, exact file/message, MIME
part ID/path, filename, type and size for 15 minutes in one bridge boot.
The bridge rechecks correlation and metadata and uses the fresh download ID.
An expired/changed reference requires one refreshed verified thread; a guessed
filename or arbitrary old token is never a fallback. Attachment review neither
uploads nor proves the document legally sufficient. Apply document/PDF review
to the actual content before consequential use.

## Quo identity and transcript coverage

Homeowner phones are distinct from carrier/adjuster routing fields. A malformed
routing value is not a shared homeowner phone. An actual cross-file homeowner
or cross-role routing collision still requires record-level proof.

For a deliberately selected shared-number read, use
`quo_history_exact_file` with `allowSharedPhoneEvidence:true`,
`includeTranscripts:true`, `completeReview:true` and `maxResults:50`.
Shared reads return only messages/calls proving the exact claim, a unique
policy plus property, or an exact canonical JobNimbus file reference. Mixed,
unknown and unrelated records/transcripts are withheld. Their counts and the
incomplete state remain; a returned subset does not clear claim preflight.
`quo_transcript_exact_file` can use the same shared-proof option, but only a
currently verified member call is readable. This option never authorizes text
sending, another phone, another company's file or a stage transition.

Complete review requests transcripts for every returned recorded call, not just
the newest three. Missing/pending speech transcripts block claim admission.
Transcript reads require exact provider call-ID agreement, disallow redirects,
and have a 15-second/2 MiB provider-response bound. Returned speech is limited
to 64000 characters/1000 segments per call and 2 MiB per review; truncation
remains explicit and cannot clear admission. The provider's `completed` state
and exact `callId` follow its [documented transcript payload](https://www.quo.com/docs/mdx/guides/webhooks).
Explicit no-speech calls and verified voicemail text are distinguished from
unreviewed recordings. Preserve `transcriptCoverage`, history pagination and
per-record correlation warnings. A Quo draft is not a sent/delivered message.

## Read-only DOL research

`weather_dol_research_exact_file` uses the existing Census/NWS hail engine and
the property's freshly verified Chance-assigned address. The Mac-only read
accepts the exact file query, optional start/end dates (maximum 800-day window),
radius 1–100 miles, minimum hail 0.25–6 inches and limit 1–20. It never accepts
an alternate address, saves a DOL, changes the claim or places a call.
Nearby reports are candidates, not eyewitness/property-damage evidence.
Resolve conflicting contracts, policy periods, prior claims and actual damage;
Chance must separately approve any selected loss date/time and later action.

## Follow-through in the existing task

Use `jobnimbus.ensure_current_task` through the existing exact approval batch;
do not create a parallel queue, new CRM, legacy Brain memory or recurring job.
Resume the existing marked task and authorized private checkpoint before
repeating a review. Propose one current next action with these description lines:

```text
Do: One evidence-supported next action
Owner: Person responsible for this next step
Waiting on: Exact person/provider/document, or None
Evidence: Exact provider record IDs and observation time; body/original review state
Verified outcome: Not yet, or the actual provider-readback result and receipt ID
```

Set the separately reviewed `dueDate` explicitly. `Owner:` describes workflow
responsibility; it does not reassign the JobNimbus task or notify that person.
Chance's lane is claim/adjuster/scope through verified appraisal handoff.
Routine missing paperwork belongs to Andrea; process/estimate/go-no-go issues
to Richard; check custody/payee/reissue tracking to accounting; post-submission
appraisal work to the current verified appraisal lane.

Retain only permitted derived findings/provenance in one existing authorized
private checkpoint. Honor source retention/no-store restrictions; never save
raw mail, transcripts, documents, credentials or approval tokens as a workaround.
A checkpoint is an as-of finding, not current facts or execution authority.
Creating/updating the task requires exact action approval and verified readback.
Drafted, approved, sent, delivered, carrier-received and completed are distinct.
When a receipt is unknown, reconcile it; never repeat the provider effect.
