# Evidence reliability repair — HCN

Base: `7467bf8` on `codex/hcn-platform-foundation`.

## Changed

- Each Gmail message must independently match the exact file. Shared carrier routing addresses are not client identity. Known foreign company claims/client addresses veto attribution, including content beyond displayed previews.
- Mixed threads return only verified messages. Identifierless replies are withheld, not inherited from a nearby matched message.
- Search/preview coverage is explicit. A bounded 365-day Gmail query is not complete file communication history.
- Quo file history is marked partial: it covers homeowner-number history, not carrier-number discovery or call transcript review. Fixed, non-PII limitation codes survive the mapper, fresh-read and assistant projections.
- Explicit Quo `transcriptLimit: 0` performs no transcript reads. Defaults and numeric bounds are preserved.

## Observed verification

Full `TMPDIR=/private/tmp npm run check` passed after integration: precheck 201/201, main check 807/807, postcheck 2/2 and 61/61. These are suite counts, not unique tests. Synthetic providers only; no paid model calls or customer changes.

Initial verification hit a missing local dependency fixture path; a local dependency symlink resolved it. A later run failed when the Mac ran out of disk space. The final complete run above succeeded after clearing regenerable caches. Neither failure is counted as a passing run.

## Not claimed

Not deployed or live-provider accepted. No widened roles, private transport grants, credential/pin changes, automatic outreach, or durable communication retention. Carrier-ANI discovery and full evidence detail retrieval remain separate work. A partial or zero-result search cannot establish that insurance never communicated.
