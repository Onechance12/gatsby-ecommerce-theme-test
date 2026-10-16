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
