# Isolated HCN Thresher operational brain

This directory is the foundation for Home Claim Network's operational brain.
It is not connected to Chance Brain, Jobrolo, provider SDKs, network clients,
or legacy client-memory storage.

Integration contract:

1. Supply `HCN_THRESHER_STORE_PATH` as an absolute path on HCN's private
   persistent volume.
2. Supply `HCN_THRESHER_STORE_KEY` as a new canonical base64url value encoding
   32–128 cryptographically random bytes. It must differ from every OAuth,
   provider, bridge, Chance Brain, Jobrolo, reference, and approval secret.
3. Use a separate `HCN_THRESHER_REFERENCE_KEY` when deriving the opaque
   tenant/file/evidence/rule/work/plan/receipt/source references accepted here.
4. Reserve a separate `HCN_THRESHER_SIGNING_KEY` for a later reviewed
   cross-process plan/receipt signature contract. The current store provides
   authenticated encryption at rest but does not claim cross-process signing.
5. Convert fresh provider results to minimized records outside this boundary.
   Never pass provider objects, client values, message bodies, transcripts, or
   documents into the store.
6. Persist evidence before rule state, rule state before work/plan state, and
   a reviewed approved plan before its terminal receipts. The store rejects
   missing, stale, cross-file, superseded, or conflicting dependencies.
7. Keep public runtime metadata at `persistenceConfigured: false`. The server
   may validate this foundation's isolated path and keys, but it must not
   activate state reads or writes until retention, compaction, migration,
   rollback, and recovery behavior receive a separate review.
8. This foundation executes no external action. The existing exact dry-run,
   digest, short-lived challenge, explicit approval, and receipt gates remain
   authoritative.

The encrypted store is bounded, atomic, fail-closed on corruption or unsafe
paths, and returns immutable minimized snapshots. A snapshot exposes only the
newest current evidence for each coded source slot; it does not fall back to
older evidence after a newer observation expires.
