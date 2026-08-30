# ADR 003: Narrow Jobrolo-to-HCN Thresher Adapter

Status: accepted for the owner pilot

Date: 2026-08-05

## Decision

ADR 001 remains the default boundary: Jobrolo and the HCN operations platform
do not share code, databases, backups, provider credentials, model keys,
client-memory stores, or broad access tokens. This decision creates one narrow
exception: Jobrolo may call a dedicated, signed server-to-server API that
delegates to the existing HCN fresh-read, Thresher assistant, exact action-plan,
private approval-challenge, durable receipt, and provider-readback machinery.

The HCN service fixes the approved HCN employee principal from
`HCN_JOBROLO_PRINCIPAL_EMAIL`. The request body contains only an opaque Jobrolo
session reference; the caller cannot select an email, JobNimbus owner, company
scope, or provider identity. Every request rechecks the configured HCN user and
the exact matching active JobNimbus employee before work begins.

The general fixed-principal adapter exposes only these `POST` routes:

- `/integrations/jobrolo/v1/status`
- `/integrations/jobrolo/v1/work-center`
- `/integrations/jobrolo/v1/file-review`
- `/integrations/jobrolo/v1/communication-sweep`
- `/integrations/jobrolo/v1/quo-phone-history`
- `/integrations/jobrolo/v1/management-sweep`
- `/integrations/jobrolo/v1/assistant/turn`
- `/integrations/jobrolo/v1/action-plans/prepare`
- `/integrations/jobrolo/v1/action-plans/execute`
- `/integrations/jobrolo/v1/action-receipts/detail`

The communication sweep remains bound to the fixed principal's active assigned
JobNimbus files, linked Gmail mailbox, and available Quo team lines. Proposed
matches are evidence candidates only and never authorize an action. The Quo
phone-history route reads available team lines only after the requested phone
resolves to exactly one fresh, active JobNimbus file assigned to that same
principal. The management sweep has a different, immutable server-side scope:
exactly the configured management adjusters and the six Estimating-board
statuses. It ranks complete JobNimbus activity reads only and explicitly does
not claim Gmail, Quo, or calendar coverage.

The general credential does not expose claim filing, Retell, team management,
connector mutations, legacy routes, arbitrary provider calls, or a general
bridge proxy. Claim filing, ordinary-chat note writeback, and import transport
use separate default-off credentials and disjoint route allowlists. The
service's full OpenAPI document catalogs the stable signed read routes for
deployment verification; the ChatGPT Actions OpenAPI intentionally excludes
every service-to-service route.

## Authentication contract

The exact request envelope is:

```json
{
  "schema": "jobrolo.hcn.request.v1",
  "requestId": "request_0123456789abcdef0123456789abcdef",
  "actor": {
    "sessionRef": "session_0123456789abcdef0123456789abcdef"
  },
  "input": {}
}
```

Objects are serialized as canonical JSON: keys are recursively sorted in
lexicographic order, arrays retain their order, standard JSON scalar encoding
is used, and no insignificant whitespace is emitted. The headers are:

- `Authorization: Jobrolo-HMAC <client-id>`
- `x-jobrolo-timestamp: <13-digit Unix milliseconds>`
- `x-jobrolo-nonce: nonce_<32 lowercase hex>`
- `x-jobrolo-content-sha256: <lowercase SHA-256 hex of canonical body>`
- `x-jobrolo-signature: <lowercase HMAC-SHA256 hex>`

The signature input is exactly:

```text
METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256
```

The cross-repository compatibility fixture uses the non-production secret
`fixture-jobrolo-hcn-shared-secret-0123456789`, client id
`jobrolo-contract-fixture`, path
`/integrations/jobrolo/v1/work-center`, timestamp `1800000000000`, and nonce
`nonce_0123456789abcdef0123456789abcdef`. Its canonical body is:

```json
{"actor":{"sessionRef":"session_0123456789abcdef0123456789abcdef"},"input":{"limit":10,"offset":0},"requestId":"request_0123456789abcdef0123456789abcdef","schema":"jobrolo.hcn.request.v1"}
```

The expected body hash is
`38b96e66f249afa1a907fe397aac62fcf561c20a1daabb20550a0f373c0f840a`
and the expected signature is
`282623fe3972377308c295c0b4dccd20e743b391c5228fcb4f4442663a3a2173`.
Both repositories pin this fixture byte-for-byte.

HCN enforces a five-minute clock window, bounded one-use nonce storage,
constant-time hash/signature comparisons, an exact route allowlist, JSON-only
requests, and a credential distinct from every legacy token, provider key,
model key, OAuth secret, and storage/encryption key.

## Read and assistant authority

Work-center and file-review calls reuse the current HCN assigned-file fresh
read boundary. Opaque HCN file references remain the selector and live provider
evidence wins. Assistant calls reuse the principal-scoped encrypted HCN
conversation store and the existing read-only Thresher runtime. Thresher can
read and explain; it cannot prepare, approve, or execute a mutation.

HCN derives an internal continuity binding from the authenticated tenant,
Jobrolo client, fixed HCN principal, and opaque Jobrolo session. It then derives
a second binding for the exact assistant scope: general chat or one opaque HCN
file reference. Repeated turns in the same Jobrolo session and exact scope reuse
one encrypted HCN conversation across process restarts. General chat, file A,
file B, and a different Jobrolo session remain separate, so moving among them
does not collide or mix histories. Neither binding nor any HCN conversation or
message reference is returned to Jobrolo, and bound conversations are excluded
from ordinary HCN conversation lists.

Bound conversations have a sliding 30-day idle lifetime. Resolution prunes
expired bindings atomically before reuse or creation. The pilot store permits
at most 128 live bound conversations globally and 128 for one principal, still
subject to the lower parent conversation-store limits if other history already
uses capacity. Capacity fails closed; it does not evict a live binding or reuse
another scope. Turns for one scoped binding are queued around both resolution
and append, so concurrent signed turns preserve order instead of racing on a
stale revision.

Jobrolo may display or retain the user-visible result needed for its own chat,
but it does not receive HCN provider credentials, private provider identifiers,
the HCN approval challenge, or unrestricted HCN storage access. There is no
database replication or shared backup relationship.

### Read-only JobNimbus import transport

The separate import-only credential exposes exactly these routes:

- `/integrations/jobrolo-import/v1/catalog`
- `/integrations/jobrolo-import/v1/snapshot`
- `/integrations/jobrolo-import/v1/document-content`

Catalog and snapshot reads remain restricted to the fixed principal's complete
active assigned-file index and return opaque references. The snapshot includes
bounded operational document and photo manifests but no document bytes. The
document-content route transfers one exact bounded document or photo only when
the opaque file reference, record reference, and signed manifest digest still
match fresh evidence. Its request signature binds the exact body bytes, method,
path, timestamp, and nonce; replay receipts use atomic durable storage. Response
signatures bind the request, manifest proof, response timestamp, content type,
length, and byte digest. The import client id and secret cannot match the
general adapter, note-writeback, claim-filing, provider, OAuth, model, storage,
or encryption credentials.

## Consequential actions

Preparation reuses the exact HCN browser action contract and creates the same
short-lived pending plan and private one-use HCN approval challenge. The public
plan includes its exact approval digest but never the challenge.

Execution requires all of the following:

1. a signed request on the dedicated route;
2. a current Jobrolo approval attestation naming the exact Jobrolo approval
   record, approving user, approval instant, HCN plan, and approval digest;
3. a digest equal to the still-pending HCN plan;
4. unchanged fresh assigned-file scope;
5. HCN's private, short-lived, one-use approval challenge;
6. a durable HCN `executing` receipt before the provider effect; and
7. the existing provider readback/reconciliation and terminal receipt.

Changed, stale, replayed, superseded, or mismatched material fails closed.
There is no automatic action, automatic retry, or model approval. Jobrolo
approval is an additional gate; it does not replace HCN's existing controls.

### Ordinary-chat one-note capability profile

The existing general Jobrolo/Thresher credential intentionally retains the
full reviewed action contract above. Ordinary Jobrolo chat does not receive
that credential for its initial JobNimbus writeback capability. It uses a
second, default-off HMAC client on the same action-plan and receipt paths.

The server assigns that client the immutable
`jobnimbus_note_writeback_v1` capability profile after authentication. The
profile can call only action-plan prepare, action-plan execute, and receipt
detail. Preparation requires exactly one `jobnimbus.create_note` operation.
Execution independently rechecks the stored pending plan contains exactly that
one operation before evaluating the approval attestation or entering the HCN
execution engine. A separate service-session hash domain, including the note
client id, prevents a caller-chosen session reference from colliding with a
general-adapter pending plan. The existing browser and general-adapter action
surfaces are unchanged.

The note profile requires four independent variables:

- `HCN_JOBROLO_NOTE_WRITEBACK_ENABLED=true`
- `HCN_JOBROLO_NOTE_WRITEBACK_CLIENT_ID`
- `HCN_JOBROLO_NOTE_WRITEBACK_SHARED_SECRET`
- `HCN_JOBROLO_NOTE_WRITEBACK_PRINCIPAL_EMAIL`

Partial configuration fails startup. For the owner pilot, the principal must
equal `CHANCE_GOOGLE_EMAIL`; the client id and secret must differ from the
general Jobrolo adapter, the import transport, and every provider, OAuth,
model, storage, and encryption credential.

## Configuration

HCN requires four dedicated variables:

- `HCN_JOBROLO_ADAPTER_ENABLED=true`
- `HCN_JOBROLO_CLIENT_ID`
- `HCN_JOBROLO_SHARED_SECRET`
- `HCN_JOBROLO_PRINCIPAL_EMAIL`

The independent import transport requires:

- `HCN_JOBROLO_IMPORT_TRANSPORT_ENABLED=true`
- `HCN_JOBROLO_IMPORT_CLIENT_ID`
- `HCN_JOBROLO_IMPORT_SHARED_SECRET`
- `HCN_JOBROLO_IMPORT_PRINCIPAL_EMAIL`
- `HCN_JOBROLO_IMPORT_CONNECTION_REF`

Its durable nonce store also requires the isolated `HCN_OPERATIONS_ROOT`.
Management-report readiness additionally requires the reviewed fixed-adjuster
configuration and the fresh HCN JobNimbus read foundation. Public metadata
reports the general adapter, each read capability, import transport, photo
manifest availability, and provider-credential boundary independently; route
presence alone is never reported as runtime readiness.

Partial, disabled-with-credentials, malformed, or reused-secret configuration
fails closed. Health metadata reports the boundary as connected only when this
configuration and the HCN fresh-read foundation are ready.

Continuity also requires `HCN_ASSISTANT_HISTORY_STORE_PATH` to be on the
dedicated persistent HCN disk and `HCN_ASSISTANT_HISTORY_KEY` to remain stable.
The repository Render blueprint mounts `hcn-operations-data` at
`/var/data/hcn-operations` and places the encrypted assistant store beneath
that mount. Startup/readiness checks authenticate the encrypted file and reject
wrong-key or tampered state, but an operator must still attest the actual Render
disk attachment and restart persistence; a syntactically correct path alone
cannot prove physical durability. Existing encrypted v1.0 history is accepted
and is rewritten as v1.1 on the next mutation.

## Consequences

Jobrolo can provide one Rolo/Thresher work surface while HCN remains the sole
authority for Home Claim Network connectivity, scope, action challenges,
receipts, and readback. A future multi-employee or company-wide integration
requires another reviewed decision; it cannot be enabled by adding identity
fields to this request contract.
