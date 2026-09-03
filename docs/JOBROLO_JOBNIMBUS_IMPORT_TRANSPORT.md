# Jobrolo JobNimbus import transport

This is a dormant, read-only HCN-to-Jobrolo transport for previewing exact
JobNimbus files assigned to one fixed HCN principal and, after a separate
Jobrolo owner approval, transferring one exact document or photo. It is a
separate service authentication domain from the existing Jobrolo/Thresher
adapter and confers no assistant, approval-plan, execution, provider-write,
database, or credential access.

## Exact HTTP contract

- `POST /integrations/jobrolo-import/v1/catalog`
  - request schema: `jobrolo.jobnimbus-import.catalog-request.v1`
  - payload schema: `jobrolo.jobnimbus-import.catalog.v1`
- `POST /integrations/jobrolo-import/v1/snapshot`
  - request schema: `jobrolo.jobnimbus-import.snapshot-request.v1`
  - payload schema: `jobrolo.jobnimbus-import.snapshot.v1`
- `POST /integrations/jobrolo-import/v1/document-content`
  - request schema: `jobrolo.jobnimbus-import.document-content-request.v1`
  - exact body: `schema`, `requestId`, `sourceFileRef`, `sourceRecordRef`,
    `manifestDigest`
  - successful body: raw `application/octet-stream` bytes
- successful response schema:
  `jobrolo.jobnimbus-import.transport-response.v1`
- error schema: `jobrolo.jobnimbus-import.transport-error.v1`

The catalog request contains only `schema` and `requestId`. The snapshot
request adds only `sourceFileRef`. The connection, tenant, principal, owner,
provider identifiers, and provider URL are never caller-selectable. A selected
opaque file reference is resolved by deriving and comparing every reference in
a newly completed assigned-file catalog; there is no fuzzy or direct raw-id
lookup.

Exact activity, task, and document reads also fail closed at the provider
mapping boundary: every contact-typed reference must identify the selected
file. A foreign or untyped id is never presumed safe merely because it is
absent from the eligible assigned catalog, and rejected-row labels are never
returned in an error.

Requests require `Authorization: Jobrolo-Import-HMAC <clientId>` plus:

- `x-jobrolo-import-timestamp`
- `x-jobrolo-import-nonce`
- `x-jobrolo-import-content-sha256`
- `x-jobrolo-import-signature`

Request signature material is UTF-8, joined with literal LF, with no terminal
LF:

```text
jobrolo.jobnimbus-import.request-signature.v1
POST
<pathname>
<canonical-UTC-timestamp>
<nonce>
<SHA-256 of exact request-body bytes>
```

Successful responses include `x-jobrolo-import-response-digest` and
`x-jobrolo-import-response-signature`. The body repeats the response digest and
binds the request id, request nonce, generation time, response kind, canonical
payload digest, and payload. Response signature material is:

```text
jobrolo.jobnimbus-import.response-signature.v1
POST
<pathname>
<request timestamp>
<request nonce>
<request body hash>
<canonical response-material digest>
```

The client must verify both canonical digests and the response HMAC before
using a payload.

The document-content response uses a distinct binary signature. It returns
fixed `application/octet-stream`, exact content length, a generic disposition,
and these headers:

- `x-jobrolo-request-id`
- `x-jobrolo-request-nonce`
- `x-jobrolo-response-timestamp`
- `x-jobrolo-content-sha256`
- `x-jobrolo-manifest-digest`
- `x-jobrolo-response-signature`

Its signature binds the original request timestamp, nonce and body hash; the
request id; both opaque source refs; the canonical manifest digest; response
timestamp; content type; exact length; and SHA-256 of the raw bytes. The route
rebuilds the complete assigned catalog and complete exact-file document list,
requires one opaque-ref match, and recomputes the same manifest before any byte
request. It constructs the provider URL server-side from the fixed base and
the transient provider id. The import-only mapper includes image manifests
while ordinary HCN file reviews continue to omit photo-heavy rows. Redirects
and compressed bodies are rejected. Jobrolo remains responsible for malware
scanning, magic-byte validation, and canonical document/photo promotion.

## Bounds

- request body: 8 KiB; no query string, cookie, compression, or non-JSON body
- authentication skew: 5 minutes; one-time durable nonce receipts, maximum
  8,192 live entries
- eligible assigned catalog: at most 500 files, complete zero-row probe
- snapshot: at most 500 activities, 500 tasks, and 500 document metadata rows;
  all collections complete
- provider response: 4 MiB and at most 15 seconds per call
- catalog: 3 provider calls and a 45-second total route deadline
- snapshot: 12 provider calls and a 90-second total route deadline
- one document: 6 provider calls including the byte GET, a 70-second total
  route deadline, and a 25 MiB advertised plus streaming ceiling
- canonical catalog payload: 256 KiB
- canonical snapshot payload: 512 KiB
- canonical response body: 544 KiB
- freshness: both envelope legs at most 15 minutes, 60-second future skew,
  current at completion; HCN normally issues a 2-minute live window
- canonical complexity: depth 24 and 20,000 nodes

The Jobrolo client timeout is 50 seconds for catalog, 95 seconds for snapshot,
and uses a reviewed 75-second document deadline while retaining its own
streaming cap and cancellation boundary. The shorter HCN route preserves the
rest of Jobrolo's 120-second execution lease for malware scanning and storage.

## Configuration and rollout

The five legacy transport variables are deliberately separate:

- `HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED`
- `HCN_JOBROLO_IMPORT_CLIENT_ID`
- `HCN_JOBROLO_IMPORT_SHARED_SECRET`
- `HCN_JOBROLO_IMPORT_PRINCIPAL_EMAIL`
- `HCN_JOBROLO_IMPORT_CONNECTION_REF`

Additional public adjusters use the optional server-only
`HCN_JOBROLO_IMPORT_ADDITIONAL_PROFILES_JSON` registry with the exact schema
`hcn.jobrolo.import-profiles.v1`. Each profile contains only `clientId`,
`sharedSecret`, normalized `principalEmail`, and opaque `connectionRef`. All
four values must be unique across profiles. The authenticated client id is the
only selector; request bodies, query strings, and browser state cannot choose
an HCN principal or connection. The original five variables remain the
backward-compatible primary profile.

The transport also requires the existing tenant-scoped opaque-reference inputs
`HCN_TENANT_ID` and `HCN_REFERENCE_KEY`, plus an absolute durable
`HCN_OPERATIONS_ROOT`. Nonce receipts are stored below that root in the
isolated `jobrolo-import/request-nonces` directory. The import client id and
secret must differ from the existing `HCN_JOBROLO_*` adapter and every provider,
OAuth, operator, storage, Thresher, AI, and communications credential checked
at startup.

`render.yaml` keeps the transport disabled and supplies no client, secret,
principal, connection, or additional-profile value. Enabling with a missing/malformed value,
reused credential, unavailable opaque-reference factory, or missing durable
operations root fails closed. Runtime principal admission additionally requires
each configured employee to remain enabled, assigned-scope authorized, and an
exactly matching active JobNimbus user. A duplicate client id, secret,
principal email, connection reference, or cross-capability credential fails
startup closed.

The kill switch is non-disruptive: an unset or exact `false` enable flag keeps
the route inert even if Render retains staged values. Only exact `true` parses
and requires the other four settings. This permits emergency disable/rollback
without crashing unrelated HCN service surfaces; no dormant value grants route
authority.

The Jobrolo counterpart verifies signed transport before parsing payloads or
bytes. Document activation additionally remains on hold until Jobrolo has a
default-deny malware scanner and proves that unclean/unavailable scans stay in
inaccessible quarantine rather than becoming canonical Documents. Rollout
also requires distinct live values, durable nonce proof, and synthetic
catalog, snapshot, direct-byte, redirect-rejection, size, hash, signature, and
malware canaries. No live value or deployment is part of this slice.

## Frozen vectors

- normalized snapshot: 2,119 UTF-8 bytes; SHA-256
  `042101b2a9f7e8a11c60f39c7db6319e888f031bc7e0ed3fc5a074a6678ef04d`
- catalog payload SHA-256:
  `206a18ee8c97187b89204c5fbeb537a13ac90517c8d0ab73168b271673ead22e`
- request fixture body SHA-256:
  `7316733c31099b005739513d550a24580cb76ec846436722540f92365b987429`
- request fixture signature:
  `17386b9a851fbda53de5ea53125b23dd79c17e9debaa0fb5f4785d3486fc815d`
- response fixture digest:
  `c2561e76c9857d1ed704a1fe8757d6f4fb69703f51c5e81d7babc4dd2a6e30e9`
- response fixture signature:
  `ae7c1270de2ad1d31604c83679587a3c2efeb3610c0a2c224f08e6f3a08b828b`
