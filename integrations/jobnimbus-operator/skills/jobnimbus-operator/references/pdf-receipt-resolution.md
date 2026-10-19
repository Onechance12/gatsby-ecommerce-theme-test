# Accepting an existing PDF's normal access

Use only the separately activated, exact-build-pinned native PDF tools.
Diagnosis and approval are different modes; never use an approval plan as a
repeated troubleshooting probe.

## Read-only diagnosis

For an in-scope request to investigate one existing PDF quarantine, call
`pdf_receipt_diagnose` with exactly `{batchId,query,documentId}` after the normal
session is attested. This requires no privacy acceptance or client-action
approval. It creates/consumes no approval, performs no provider or receipt write,
releases no hold, and never reuploads or retries the original action.

The result separates original versus observed privacy, exact-file metadata,
downloaded-byte verification and a blocked transport. A blocked download reports
the specific rule: malformed URL, embedded credentials, fragment, insecure
protocol, nondefault port or disallowed hostname. Known host families are fixed
categories, and unknown hosts have only a one-way hostname fingerprint. Neither
is permission to contact a new host. No signed URL, query/path, credential,
provider body or raw exception should be printed or requested.

Reuse the as-of diagnostic unless a relevant artifact, configuration or provider
condition changed, or Chance explicitly requests a new check. Do not repeatedly
run an unchanged failing diagnosis or resolution plan. A policy rejection does
not prove a failed upload, missing PDF, wrong hostname or broken login.

Metadata/hash verification is not approval to accept a privacy discrepancy.
If a disposition is still needed, proceed to the separate plan below and obtain
its exact approval. Software troubleshooting approval authorizes no client effect.

## Receipt disposition

Use `pdf_receipt_resolution_plan` and `pdf_receipt_resolution_execute` only for
the new exact acceptance described below.
This narrow lane resolves one current-policy, single-PDF, file-scoped
quarantine after a new human approval. It does not change JobNimbus access,
upload, reserve, complete, replace, delete or send anything. Development or
installation approval does not approve the receipt disposition.

The original request must have required private access, while fresh provider
metadata proves explicit boolean nonprivate access. Normal access is not an
assurance of public internet visibility or of which employees can see it.
Private access is permission-based, not necessarily uploader-only. Do not
claim actual team access profiles were reviewed unless they were.

## Planning and approval

Start from the existing exact receipt and reviewed PDF, not a new upload.
Require the ordinary full session attestation to be ready, with no global
unresolved/hard-blocked receipts. Do not rerun ordinary reconciliation on the
quarantined batch. No browser, generic API, one-shot launcher, delegated
worker or manual ledger edit substitutes for this persistent native lane.

Call `pdf_receipt_resolution_plan` with exactly:

```json
{
  "batchId": "EXACT-ORIGINAL-UUID",
  "query": "#EXACT-FILE-NUMBER",
  "documentId": "EXACT-LIVE-DOCUMENT-ID",
  "acceptedIsPrivate": false
}
```

The tool freshly proves active Chance assignment, the immutable original
intent, complete exact-file inventory, unique candidate, filename, explicit
privacy, strict size and downloaded SHA-256. It repeats inventory and owner
checks after byte readback. A candidate present before the original upload
is ineligible. Any other mismatch, another overlapping quarantine, global
hold, reassignment, incomplete inventory or provider failure retains the hold.

Show Chance the returned client/file, original batch, exact document ID and
filename, original private request versus current normal access, size,
SHA-256, source receipt/intent hashes, expiry and `approvalDigest`. Explain
that approval accepts the existing access setting without changing it and
resolves only the internal hold. It creates/sends no email.

Preserve the returned `identityProvenance` distinction:

- `preserved_reservation_id`: the original quarantine retained the reservation ID.
- `human_selected_live_candidate_no_durable_reservation_id`: the historical
  quarantine lost that ID. The new approval selects the freshly verified live
  candidate; it does not restore or prove the lost historical identity.

Do not invent or backfill provenance from chat. Keep the PDF itself unchanged.

## Execution and completion

After explicit approval of that unchanged plan, call
`pdf_receipt_resolution_execute` with only its `approvalDigest`, directly in
the same native process. Do not restart, re-attest manually or create another
plan between the approval reply and execute. The helper performs its own
fresh full attestation. Restart, expiry, newer plan or boundary/proof drift
invalidates/consumes approval; it is never recreated automatically.

Require `mode:"pdf_resolution_verified"`, `fileHoldReleased:true`,
`providerWrites:false`, `originalUploadReplayAllowed:false`, and a verified
internal resolution receipt matching the entire approved proof and boundary.
The original receipt remains `manual_quarantined`, with its original true
privacy request, intent, approval, timestamps, quarantine and unknown outcome
unchanged. The separately hashed resolution is the authority for release of
that one file hold; the upload is never resumable or replayable.

An uncertain/failed response consumes local approval. Read the exact receipt
and its `pdfReceiptResolutionValid` / `fileHoldReleased` facts; do not repeat
execution automatically or clear the ledger. A forged/malformed resolution
cannot release a hold. Report verification, not a new upload or access change.

Only after verified resolution may the next client action receive its own
fresh plan and approval. Gmail draft creation and sending remain separate
approvals, with actual verified file-specific PDF attachments.
