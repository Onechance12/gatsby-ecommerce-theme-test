# WR-2026-10-06 — JobNimbus PDF byte-array repair

## Claim (local release candidate; not deployed)

Chance requested a root-cause PDF-read repair. Work starts at published HCN
foundation `8b044ae` on `codex/pa-pdf-byte-array-repair-20261006`.
Claimed paths: `src/jobnimbus/file-content.js`, the normalization seam in
`src/http/bounded-binary.js`, the native document downloader in `src/server.js`,
and focused regressions in the bounded-binary, signed import transport HTTP,
and native server smoke tests. No unrelated Quo, auth, action, or CRM changes.

## Observed cause

An exact authorized JobNimbus PDF download returned one standard Java serialized
`byte[]`: the fixed descriptor was 23 bytes, followed by a four-byte length and
the PDF payload at offset 27. Declared and actual payload lengths matched. The
native attachment validator rejected the wrapper, not the document contents.
Do not put client identifiers, policy bytes or signed provider URLs in this repo.

Decode only that exact primitive byte-array framing; do not deserialize Java
objects, search for a PDF somewhere in arbitrary bytes, or relax PDF validation.
Preserve raw response size/deadline checks, redirect allowlist, stripped CDN
credentials, fresh actor/assignment/manifest admission, no-store, and signing
of the actual normalized bytes delivered to Jobrolo. No permission expansion,
operator pin update, messages, provider writes, push, merge or deployment.

## Verification

The decoder accepts only the fixed primitive-array descriptor, an exact signed
32-bit payload length, and a PDF header at offset 27. Plain unwrapped downloads
remain unchanged. Malformed descriptors, objects, nested frames, negative or
mismatched lengths, truncation, trailing bytes and non-PDF payloads fail closed.
The raw wire-size cap is enforced before normalization. The signed response's
length and SHA-256 describe the normalized PDF bytes, not the discarded frame.

Focused transport tests passed (14 cases), including direct and fixed-CDN
downloads, signed binary success, malformed signed-route failure, credential
stripping and zero provider writes. The native exact-file smoke test also passed
with a synthetic wrapped PDF. Fixtures contain no provider document content.

The canonical full `npm run check` passed with `TMPDIR=/private/tmp`: 201 precheck
cases, 831 check cases, four Google journey cases and 61 management postcheck
cases. These phases overlap and are not a unique-test total. The initial default
macOS temp path hit the existing canonical-path safety check; no gate was changed.

A private authorized source download was verified locally: the valid frame held
a four-page PDF. The modern Jobrolo reader extracted the first three pages; its
conservative, independently rendered blank-page check admitted the white fourth
page. No OCR/model request, public upload or Jobrolo content copy was needed.
The older native `pdf-parse` reader is not upgraded by this repair; the native
download now supplies valid PDF bytes rather than failing the header check.

## Release boundary

This candidate is local only. Specific approval is still required before push,
merge or deployment. HCN Auto-Deploy stays off; the locked Mac Operator pin is
unchanged. No credentials, permissions, runtime gates, endpoint routes, messages,
CRM records or client-phone correlation rules were changed. Production acceptance
must recheck the actual signed Jobrolo read after an approved exact-SHA release.
