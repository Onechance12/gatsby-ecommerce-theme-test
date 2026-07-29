# JobNimbus ChatGPT Bridge

Small authenticated bridge that lets a ChatGPT Custom GPT Action read and, when explicitly enabled, update JobNimbus.
It also supports Gmail search/thread/attachment review, verified PDF attachments,
Quo messages/calls/transcripts, durable private action receipts, a unified
Chance-only review/approval transaction, and the isolated HCN Operations v2
contract foundation. Legacy per-client snapshots and operational advisories are
read-only by default while the v2 operational state layer is built.
Scanned or visually complex JobNimbus documents can be returned as native
ChatGPT conversation files so the GPT inspects the original pages instead of
guessing from a filename or relying only on server-side OCR.
It includes a handoff inbox so another ChatGPT chat with Gmail/Quo access can pass findings into this JobNimbus bridge.
It also includes an authenticated, non-executing patch mailbox so Claude and
Codex can exchange short-lived `.patch`/`.diff` packages when an agent's Git
transport is unavailable.

## Safety

- HCN Operations Brain v2 and Jobrolo are permanently separate from Chance
  Brain. The v2 surface shares no storage, credentials, routes, imports,
  backups, or memory with either system. Existing non-operator legacy-v1
  compatibility paths still read old Chance Brain continuity data without
  writing it; platform metadata reports that transitional state explicitly
  until those paths are removed.
- `GET /api/v1/meta` exposes privacy-safe build, runtime, release-gate drift,
  and boundary metadata. Only a full provider-owned `RENDER_GIT_COMMIT` is
  labeled attested; caller-declared commit values are never deployment proof.
- `GET /api/v1/session` exposes privacy-safe route authorization for a Google
  employee or dedicated Codex operator. The legacy wildcard bridge token is
  denied this scoped descriptor so its effective authority is never understated.
- Keep `ALLOW_LEGACY_CLIENT_MEMORY_WRITES=false`. With this default, reviews
  may read existing legacy continuity but cannot refresh snapshots, reconcile
  legacy operational state, append receipts into snapshots, or create model
  advisories. Legacy removal remains a separately approved process.
- Keep `JOBNIMBUS_API_KEY` only in Render environment variables.
- Set `JOBNIMBUS_BRIDGE_TOKEN` and use it as the Custom GPT bearer token.
- Set `CODEX_OPERATOR_TOKEN` to a different strong random value for the
  dedicated Codex HP operator. This credential is a non-Google
  `codex_operator` identity, not an alias for the shared bridge token. It can
  read Chance-assigned JobNimbus client evidence and exact-file-correlated Gmail
  and Quo evidence, and use the consolidated action batch. Every operator Gmail
  and Quo read requires an exact Chance-assigned file; arbitrary mailbox queries,
  phone numbers, call IDs, and broad unmatched-communications sweeps fail closed.
  Resolver search and query-less indexes return only minimized identifying
  metadata. Gmail email correlation and Quo phone correlation fail closed when
  that identifier is shared by multiple Chance files.
  It cannot
  call direct JobNimbus write/upload, claim-filing, Retell/Twilio live-call,
  direct Gmail draft/send, direct Quo send, configuration, enrollment,
  artifact-mailbox, or other unrelated routes. Gmail attachment review is
  read-only for this identity.
- Leave `BRIDGE_ALLOW_WRITES=false` until you intentionally want approved write actions.
- Write endpoints are dry-run unless the request includes `execute:true` and Render has `BRIDGE_ALLOW_WRITES=true`.
- A live Gmail send requires `BRIDGE_ALLOW_WRITES=true`, `ALLOW_GMAIL_SEND=true`,
  `execute:true`, and the exact digest returned by the unchanged dry run.
- A live Quo send requires `BRIDGE_ALLOW_WRITES=true`, `ALLOW_QUO_SEND=true`,
  `execute:true`, and the exact digest returned by the unchanged dry run.
- An employee can link a company Quo line without exposing API credentials.
  The signed-in employee requests a six-digit SMS code through
  `linkAuthenticatedQuoLine`, verifies it in the GPT, and the bridge stores the
  employee-to-line mapping on Render's persistent disk. Actual texts remain
  exact-draft and approval-gated.
- The consolidated Custom GPT schema exposes one consequential action batch for
  JobNimbus writes, Gmail drafts/sends, and Quo sends. The assistant must show
  the exact one-client dry run and wait for Chance's approval. Execution also
  consumes the newest identity-bound, short-lived server challenge exactly once;
  review, memory closeout,
  document, and sweep endpoints never send messages.
- Quo review scans matching communication across every available company team
  line, including Andrea's line, and labels the source line. That access is
  evidence-only. Outbound texts use the authenticated employee's configured or
  SMS-verified line and remain approval-gated.
- Changing one character, recipient, subject, or attachment invalidates the
  approval digest. Duplicate approved action batches are blocked by a persistent ledger.
- JobNimbus write actions resolve only Chance Pearson-owned insurance files.
- Existing legacy client snapshots are read-only continuity caches, not
  operating authority. A snapshot never authorizes a write, send, call, task,
  event, upload, or status change, and fresh JobNimbus/Gmail/Quo evidence wins.
- Legacy v1 snapshots can retain raw client and communications data. The Codex
  HP operator never reads or writes those snapshots, receipts, episodes, open
  loops, or model advisories. Brain client memory remains unavailable to that
  operator until a reviewed v2 migration and separately approved legacy purge.
- Legacy exact-file reconciliation and model-advisory writes remain disabled by
  the privacy gate. HCN v2 rules use minimized, tenant-bound observations with
  provenance and freshness; they cannot send, write, call, or approve.
- The handoff inbox allows public handoff creation so browser agents can submit Gmail/Quo findings. Listing/completing handoffs still requires the bridge bearer token.
- Artifact endpoints always require the bridge bearer token. They never apply,
  execute, commit, push, or deploy an uploaded patch.

## Render

Start command:

```bash
npm start
```

Health path:

```text
/health
```

Required private env vars:

```text
JOBNIMBUS_API_KEY=
JOBNIMBUS_BRIDGE_TOKEN=
CODEX_OPERATOR_TOKEN=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
QUO_API_KEY=
```

Persistent and channel-control variables:

```text
MEMORY_ROOT=/var/data
ALLOW_GMAIL_SEND=false
QUO_DEFAULT_FROM_NUMBER=
ALLOW_QUO_SEND=false
HANDOFF_STORE_PATH=/var/data/bridge/handoffs.json
HANDOFF_UPLOAD_DIR=/var/data/bridge/handoff-uploads
MAX_JSON_BODY_BYTES=12582912
MAX_CHATGPT_FILE_BYTES=8388608
ARTIFACT_STORE_PATH=/var/data/bridge/artifacts.json
ARTIFACT_UPLOAD_DIR=/var/data/bridge/artifact-uploads
ARTIFACT_FILE_DIR=/var/data/bridge/artifacts
MAX_ARTIFACT_BYTES=5242880
ARTIFACT_TTL_HOURS=72
CLAIM_CALL_STORE_PATH=/var/data/bridge/claim-call-ledger.json
ACTION_BATCH_STORE_PATH=/var/data/bridge/action-batches.json
ACTION_APPROVAL_STORE_PATH=/var/data/bridge/action-approvals.json
ACTION_APPROVAL_TTL_SECONDS=900
OUTBOUND_SEND_STORE_PATH=/var/data/bridge/outbound-sends.json
OPENAI_API_KEY=
OPENAI_OPERATIONAL_MODEL=gpt-5.6-luna
ZAI_API_KEY=
ZAI_OPERATIONAL_MODEL=glm-4.7-flash
OPERATIONAL_LLM_PROVIDER=zai
OPERATIONAL_LLM_FALLBACK_PROVIDER=
```

## HCN Operations Console

The HCN console is a responsive, installable operating surface at `/hcn/`. It
reports fresh bridge/build readiness, connector and release-gate status,
explicit Chance Brain/HCN Operations Brain/Jobrolo boundaries, and the signed-in
user's exact console capabilities. When the HCN reference configuration is
ready, Chance's pinned browser session can also open a fresh, read-only Work
Center and review one exact Chance-assigned insurance file. That read path can
use current JobNimbus evidence plus exactly correlated Gmail and Quo evidence.
It has no upload, write, send, call, approval, or action-batch authority.

The console is disabled by default. To enable it for one exact HTTPS origin,
configure:

```text
HCN_CONSOLE_ENABLED=true
HCN_CONSOLE_ORIGIN=https://jobnimbus-chatgpt-bridge.onrender.com
PUBLIC_BASE_URL=https://jobnimbus-chatgpt-bridge.onrender.com
ALLOW_GOOGLE_USER_AUTH=true
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
CHANCE_GOOGLE_SUBJECT=
OAUTH_SESSION_SECRET=
HCN_TENANT_ID=
HCN_REFERENCE_KEY=
WAVE_AUTH_USERS_JSON=
```

`HCN_CONSOLE_ORIGIN` must exactly match the origin of `PUBLIC_BASE_URL`.
Sign-in reuses the existing Google redirect URI at
`/oauth/google/callback`; no second Google redirect URI is required. Only
enabled employees in the bridge's approved-user registry can receive a console
session; `WAVE_AUTH_USERS_JSON` supplies explicit entries and role overrides.
Every console user must have an immutable Google `googleSubject` pin in that
registry (the default Chance entry reads `CHANCE_GOOGLE_SUBJECT`). The console
remains unavailable unless Chance's pin is configured, and the verified Google
subject must match it exactly. Each opaque server session privately retains
that binding and revalidates it on every request, so a changed pin invalidates
the old session without exposing the subject to the browser. The Custom GPT
flow remains compatible with unpinned approved users, but enforces the pin
whenever one is configured.
Provider access and refresh tokens are discarded after the callback; the
browser receives only host-only, Secure, HttpOnly opaque cookies plus a
session-scoped CSRF value.

`HCN_TENANT_ID` is an HCN-only identifier in the form
`tenant_` followed by 16 lowercase hexadecimal characters.
`HCN_REFERENCE_KEY` is the canonical, unpadded base64url encoding of 32 to 128
random bytes. Generate both once with a cryptographically secure secret
generator and store them only in the production secret manager. They must not
be copied from Chance Brain, Jobrolo, a provider credential, or the shared
bridge token. The console fails closed when either value is missing or
malformed, and readiness responses never reveal either value.

Generate `OAUTH_SESSION_SECRET` from at least 32 random bytes and store its
base64url encoding. The bridge rejects weak values. HCN state uses a dedicated,
purpose-derived authenticated-encryption key and envelope, so it is not
interchangeable with the Custom GPT token broker. Credential-bearing Google
provider URLs are pinned to the reviewed Google HTTPS endpoints in production,
with redirects, oversized responses, and stalled requests rejected.

The public login route is protected by bounded per-source and global admission
windows before any OAuth transaction is allocated. On Render, the limiter uses
the client address forwarded by Render; outside Render it uses the direct
socket peer. Denied requests receive `429` and a bounded `Retry-After` value.

Console login transactions and sessions are intentionally bounded and
in-memory. A restart or deployment signs everyone out, and horizontal instances
do not share sessions. Move those opaque,
short-lived records to a reviewed server-side shared session store before
scaling beyond one instance; never persist them in browser storage.

### Fresh Work Center contracts

The browser uses two same-origin, Chance-only JSON routes:

- `POST /hcn/api/v1/work-center` with exactly `offset` and `limit` returns a
  fresh ephemeral page of active Chance-assigned insurance files. It exposes
  HCN opaque references, safe display fields, missing-fact flags, attention
  codes, and source timing; it never exposes raw provider identifiers.
- `POST /hcn/api/v1/file-review` with exactly `fileRef` and `recentLimit`
  resolves the opaque reference against a new JobNimbus index read and returns
  one minimized file workspace. JobNimbus is required. Gmail and Quo failures
  remain visible as coded partial evidence instead of being silently treated as
  complete.

Both routes require the secure HCN browser cookie, the exact configured origin,
the session CSRF value, and `application/json`; request bodies are limited to
4 KiB. Their responses are `no-store` and remain in memory/DOM only. An opaque
reference that no longer resolves to one current, active, Chance-assigned file
returns `404`. The routes do not call Chance Brain, Jobrolo, legacy client
memory, model advisories, or any persistence layer.

## Fresh Review And Approval

`POST /ops/review-chance-files` gathers fresh JobNimbus fields, recent activity,
open tasks, non-photo operational documents, Gmail evidence, Quo evidence, and
private action receipts. With the production-default
`ALLOW_LEGACY_CLIENT_MEMORY_WRITES=false`, a review may read existing legacy
continuity for non-operator compatibility, but it does not refresh a client
snapshot, reconcile an operational ledger, or create a model advisory. Live
JobNimbus, Gmail, and Quo evidence is authoritative. The old refresh,
reconciliation, and bounded advisory behavior remains available only behind an
explicit legacy opt-in while HCN Operations Brain v2 is built from fresh
evidence in its own isolated domain.

The dedicated Codex HP operator is a stricter exception: it never reads or
writes Chance Brain client snapshots, episodes, operational state, or action
receipts, and it cannot request a model advisory. Exact-file reviews return
fresh source evidence plus ephemeral metadata only. Query-less indexes omit
contact details, claim/policy values, addresses, phone numbers, email addresses,
and adjuster details. Legacy Brain client snapshots remain outside this
operator path and must not be trusted or purged without a separate approved
schema-v2 migration.

`POST /ops/action-batch` then provides the two-step execution flow:

1. Send exact operations with `execute:false` and show Chance the resulting plan.
2. After Chance approves, repeat the unchanged operations with `execute:true`
   and the returned `approvalDigest` plus the short-lived, single-use
   `approvalChallenge` before `approvalExpiresAt`.

The bridge records successful actions in its dedicated persistent security and
action ledgers and refuses to run the same approved batch twice. With the
legacy-memory gate off, it does not append those receipts to a legacy client
snapshot or refresh that snapshot after an approved JobNimbus write.

Possession of `CODEX_OPERATOR_TOKEN` is not approval. For every consequential
batch, Codex must prepare the exact dry run, show the user the actions and
`approvalDigest`, and obtain the user's explicit approval at action time. Only
then may it repeat the unchanged batch with `execute:true`. The local operator
keeps the challenge out of model input and forwards it internally. Setup-time,
standing, inferred, or prior approval does not authorize a later batch. The
server still requires the exact digest, the current unconsumed challenge, and
`BRIDGE_ALLOW_WRITES=true`; channel send gates also remain in force.

## Custom ChatGPT

A normal ChatGPT experience can use this service through a Custom GPT Action.
Import `https://jobnimbus-chatgpt-bridge.onrender.com/openapi-chatgpt.json`, configure
HTTP bearer authentication with `JOBNIMBUS_BRIDGE_TOKEN`, save/publish the GPT,
and start a new chat after schema changes. Arbitrary standard chats do not gain
the bridge automatically; the Action must be installed on that GPT.

The GPT-facing schema is intentionally consolidated to 30 high-level operations.
Detailed bridge routes remain available to the server and local agents, while
routine JobNimbus edits, tasks, calendar changes, Gmail drafts/sends, and Quo
texts are prepared and executed through `processApprovedWaveActionBatch`.

Gmail review-first sends preserve one message identity. A successful
`gmail.create_draft` receipt returns the Gmail `draftId`. If Chance later says to
send that reviewed draft, use `gmail.send` with `{ query, draftId }`; the bridge
requires that the operator's draft has a matching bridge receipt on that exact
file, re-reads the current draft, rejects duplicate or unsupported delivery
headers, displays all delivery-relevant headers and attachment hashes, produces
a fresh exact approval digest, reconstructs only the reviewed immutable snapshot,
and sends it through Gmail's message-send endpoint. The source draft is retained;
deleting it is a separate approval-gated action. Unlisted original MIME headers
are not transmitted. Do not rebuild the same message as a raw send and do not
create another draft. The bridge also
detects a still-existing verified draft for the same Chance file and subject and
refuses duplicate draft creation/raw resend.

`source=standard_w9` is unavailable until the exact Gmail message id, attachment
id, and expected SHA-256 are pinned. Those nonsecret identifiers still require a
separate action-time-approved provider configuration step; the bridge never falls
back to mailbox search or trusts sender/filename text as document integrity.

For document review, call `reviewJobNimbusDocument` with either an exact
`documentQuery` or a natural-language `documentPurpose`. This is the canonical
one-call workflow: when extraction is missing, incomplete, truncated, or
contradicted by the page layout, the same response automatically returns the
exact original file through `openaiFileResponse`. Inspect that attached file and
all relevant pages with ChatGPT's native document tools before reaching a
conclusion. Never ask the user to retrieve or attach a JobNimbus document
manually. The attachment behavior is read-only, rejects ambiguous matches, and
caps returned files at 8 MB. If the user explicitly names a company file that is
not assigned to Chance, the read-only document actions may resolve it only by an
exact, unambiguous JobNimbus number, claim number, client name, or address. All
writes, uploads, calls, emails, and texts remain Chance-scoped and approval-gated.

When a current date of loss is missing or disputed, `researchPropertyHailDates`
provides a read-only property-weather check. It geocodes the exact JobNimbus
address, retrieves archived National Weather Service hail reports through the
Iowa Environmental Mesonet, calculates distance and hail size, and returns
ranked candidate dates. A candidate is not a confirmed date of loss: compare it
with policy coverage, declarations, prior claims, and carrier evidence, then get
Chance's approval before filing a claim or updating JobNimbus.

## Handoff Inbox

Human/agent paste-in page:

```text
/handoff
```

Action/API endpoints:

```text
POST /handoff          public create-only intake
POST /handoff/chunk    public chunked intake for large JSON/text handoffs
POST /handoff/pending
POST /handoff/get
POST /handoff/process
POST /handoff/complete
```

Use this when a separate ChatGPT chat has Gmail/Quo context and needs to pass structured findings to the JobNimbus assistant. The bridge stores handoffs in a small JSON file, intended as a lightweight queue rather than permanent records.
Use `/handoff/chunk` when the payload is too large for one browser/GPT action request. Send `index`, `total`, `chunk`, and reuse the returned `uploadId` for remaining chunks.
`/handoff/process` dry-runs by default and executes only when `execute: true` is provided and bridge writes are enabled.

## Claude/Codex Patch Mailbox

The mailbox is a transport fallback, not a watcher. Chance starts each agent
manually. GitHub remains the final source of truth after Codex reviews and
publishes an approved package.

Endpoints, all bearer-authenticated:

```text
POST /artifacts/chunk
POST /artifacts/list
POST /artifacts/get
POST /artifacts/complete
```

Claude creates and hashes a package:

```bash
git format-patch --stdout <base-sha>..HEAD > claude-codex-handoff.patch
shasum -a 256 claude-codex-handoff.patch
```

Send chunk zero first with `filename`, `baseCommit`, `sha256`, `index`, `total`,
and `chunk`. Reuse the returned `uploadId` for later chunks. The final response
returns an `artifact.id` for Codex. The bridge accepts UTF-8 `.patch` and `.diff`
files only, rejects protected runtime-data/secret paths and common token/private-
key material, verifies SHA-256, limits package size, and expires packages.

Codex retrieves the package with `/artifacts/get`, checks it in an isolated
worktree, reviews the diff, scans for secrets/PII, runs tests, and asks Chance
before publishing. `/artifacts/complete` records that the review is finished;
it does not run the patch.

The default `/tmp` storage is ephemeral. Configure the artifact paths on a
Render persistent disk if packages must survive a restart or deployment.

## Bundled JobNimbus Updates

Use `POST /jobnimbus/process-update` when one workflow should update fields, move status, and add a note together.

Example:

```json
{
  "query": "1634",
  "fields": {
    "Claim Number": "0000222459"
  },
  "status": "Submitted Awaiting Confirmation",
  "note": "Claim filed and updated with claim #0000222459. Waiting for carrier to assign an adjuster.",
  "execute": false
}
```

Set `execute:true` only after approval and only when `BRIDGE_ALLOW_WRITES=true`.

## Approval-Gated Claim Filing

Carrier claim filing uses Retell so the agent can navigate IVR menus with DTMF.
It is restricted to JobNimbus insurance files assigned to Chance Pearson.

```text
POST /claim-filing/prepare
POST /claim-filing/call
POST /claim-filing/result
POST /claim-filing/writeback
```

The workflow is intentionally split:

1. `prepare` pulls fresh JobNimbus fields, activity, tasks, and document metadata,
   builds the call packet, and returns a `planDigest` without placing a call.
2. `call` repeats the live read. It rejects a stale digest and only calls when
   `execute:true` and `ALLOW_RETELL_CALLS=true` are both present.
3. `result` reads the Retell transcript and post-call analysis. Structured facts
   are proposed for JobNimbus; transcript guesses remain visibly unverified.
4. `writeback` repeats the live checks and requires the exact approved
   `writebackDigest`. It writes only with `execute:true` and
   `BRIDGE_ALLOW_WRITES=true`.

Both calls and writebacks have a small idempotency ledger to prevent accidental
duplicates. Point `CLAIM_CALL_STORE_PATH` at persistent storage if the ledger
must survive Render restarts.

Required private claim-filing variables:

```text
RETELL_API_KEY=
RETELL_AGENT_ID=
RETELL_FROM_NUMBER=
```

Keep `ALLOW_RETELL_CALLS=false` until the deployment and first controlled call
are explicitly approved.

## Gmail OAuth

First-use employee enrollment can be enabled with `AUTO_ENROLL_WAVE_USERS=true`. A new employee must sign in with a verified `@wavepa.com` Google account that exactly matches an active JobNimbus user. The employee initially receives onboarding-only access, verifies a company-owned Quo line by SMS code, and then receives full company operational access. Missing JobNimbus or Quo verification fails closed. Explicit `WAVE_AUTH_USERS_JSON` entries remain available for role overrides and disabling access.

The legacy `npm run gmail:oauth` helper is intentionally disabled: it accepted
a client secret through shell history and printed a refresh token. Provisioning
Google credentials is a separate, explicitly approved production step. Enter
secrets only through the Google and Render provider secret UIs; never paste,
print, log, download, or save them in a shell, chat, repository, or local file.
