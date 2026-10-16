# Approved PDF metadata readback repair

JobNimbus's published Files collection documents list metadata at
`GET https://app.jobnimbus.com/api1/files` and binary downloads at
`GET https://app.jobnimbus.com/files/<jnid>`. It does not document a metadata
endpoint at `/api1/files/<jnid>`. The original PDF verifier and smoke fixture
incorrectly assumed that endpoint returned JSON.

Source: [JobNimbus API collection](https://documenter.getpostman.com/view/3919598/S11PpG4x),
linked by [JobNimbus Support](https://support.jobnimbus.com/how-do-i-create-an-integration-using-jobnimbuss-open-api).

The verifier now locates the durable provider document ID in a complete, bounded
exact-file inventory before and after downloading its bytes. The exact client,
filename, privacy, size and SHA-256 checks remain unchanged. Missing, ambiguous,
mixed-file, deleted or altered records cannot produce a successful receipt.
The provider adapter requires the complete related/primary inventory union.

Recovery is read-only: no reservation, PUT, completion, overwrite, deletion or
automatic retry. An unresolved receipt remains unresolved until the existing
coordinator verifies provider state or records its existing quarantine outcome.
No ledger migration or policy change is needed. Preserve the current live-owner
policy, expiry, excluded file, action allowlists, six historical receipt hashes,
prior quarantines and unknown outcomes. A replacement versioned Operator package
must pin the reviewed deployed commit without editing the old installed cache.

`npm run test:pdf-upload` includes unit cases for invalid inventories on both
sides of byte readback, and synthetic HTTP upload/recovery tests whose
undocumented single-file metadata route returns HTML. Recovery assertions require
unchanged reserve/PUT/completion counters. No real client data or provider writes
are used by these tests.

## Exact metadata diagnostics and retained identity

Verification failures now name only static failed-check labels instead of
collapsing file binding, filename, privacy and size into one opaque error.
The existing exact-document review returns a typed, allowlisted metadata
summary for Mac PDF reads. It never returns signed URLs, unrelated provider
fields, arbitrary error bodies or credentials. This is diagnostic evidence,
not a successful upload receipt or permission to act on a quarantined file.

When a newly reconciled PDF must be quarantined, retain its already durable
provider document ID in that quarantine and its minimized receipt. Do not
backfill a missing historical ID from conversation text, invent provenance,
remove an existing quarantine, or call reconciliation again on a quarantined
batch. Missing and false privacy flags remain distinct failures; no coercion,
default privacy or weaker match rule is introduced.
