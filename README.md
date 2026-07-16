# JobNimbus ChatGPT Bridge

Small authenticated bridge that lets a ChatGPT Custom GPT Action read and, when explicitly enabled, update JobNimbus.
It also supports Gmail search/thread/attachment review, verified PDF attachments,
Quo messages/calls/transcripts, durable private action receipts, and a unified
Chance-only review/approval transaction.
Scanned or visually complex JobNimbus documents can be returned as native
ChatGPT conversation files so the GPT inspects the original pages instead of
guessing from a filename or relying only on server-side OCR.
It includes a handoff inbox so another ChatGPT chat with Gmail/Quo access can pass findings into this JobNimbus bridge.
It also includes an authenticated, non-executing patch mailbox so Claude and
Codex can exchange short-lived `.patch`/`.diff` packages when an agent's Git
transport is unavailable.

## Safety

- Keep `JOBNIMBUS_API_KEY` only in Render environment variables.
- Set `JOBNIMBUS_BRIDGE_TOKEN` and use it as the Custom GPT bearer token.
- Leave `BRIDGE_ALLOW_WRITES=false` until you intentionally want approved write actions.
- Write endpoints are dry-run unless the request includes `execute:true` and Render has `BRIDGE_ALLOW_WRITES=true`.
- A live Gmail send requires `BRIDGE_ALLOW_WRITES=true`, `ALLOW_GMAIL_SEND=true`,
  `execute:true`, and the exact digest returned by the unchanged dry run.
- A live Quo send requires `BRIDGE_ALLOW_WRITES=true`, `ALLOW_QUO_SEND=true`,
  `execute:true`, and the exact digest returned by the unchanged dry run.
- The consolidated Custom GPT schema exposes one consequential action batch for
  JobNimbus writes, Gmail drafts/sends, and Quo sends. The assistant must show
  the exact dry run and wait for Chance's approval; review, memory closeout,
  document, and sweep endpoints never send messages.
- Quo review scans matching communication across every available company team
  line, including Andrea's line, and labels the source line. That access is
  evidence-only. Outbound texts use Chance's configured line and remain
  approval-gated.
- Changing one character, recipient, subject, or attachment invalidates the
  approval digest. Duplicate approved action batches are blocked by a persistent ledger.
- JobNimbus write actions resolve only Chance Pearson-owned insurance files.
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
OUTBOUND_SEND_STORE_PATH=/var/data/bridge/outbound-sends.json
```

## Fresh Review And Approval

`POST /ops/review-chance-files` gathers fresh JobNimbus fields, recent activity,
open tasks, non-photo operational documents, Gmail evidence, Quo evidence, and
private action receipts. It deliberately returns evidence rather than pretending
that fixed rules can replace assistant judgment.

`POST /ops/action-batch` then provides the two-step execution flow:

1. Send exact operations with `execute:false` and show Chance the resulting plan.
2. After Chance approves, repeat the unchanged operations with `execute:true`
   and the returned `approvalDigest`.

The bridge records successful actions on the persistent disk and refuses to run
the same approved batch twice.

## Custom ChatGPT

A normal ChatGPT experience can use this service through a Custom GPT Action.
Import `https://jobnimbus-chatgpt-bridge.onrender.com/openapi-chatgpt.json`, configure
HTTP bearer authentication with `JOBNIMBUS_BRIDGE_TOKEN`, save/publish the GPT,
and start a new chat after schema changes. Arbitrary standard chats do not gain
the bridge automatically; the Action must be installed on that GPT.

The GPT-facing schema is intentionally consolidated to 20 high-level operations.
Detailed bridge routes remain available to the server and local agents, while
routine JobNimbus edits, tasks, calendar changes, Gmail drafts/sends, and Quo
texts are prepared and executed through `processApprovedWaveActionBatch`.

For document review, call `reviewJobNimbusDocument` first. If text extraction is
missing, incomplete, or contradicted by the page layout, call
`attachJobNimbusDocumentToChat` with the exact Chance file and document. The
bridge returns the original file through `openaiFileResponse`; inspect that file
and all relevant pages with ChatGPT's native document tools before reaching a
conclusion. The attachment route is read-only, rejects ambiguous document names,
and caps returned files at 8 MB. If the user explicitly names a company file that
is not assigned to Chance, the three read-only document actions may resolve it
only by an exact, unambiguous JobNimbus number, claim number, client name, or
address. All writes, uploads, calls, emails, and texts remain Chance-scoped and
approval-gated.

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

Create a Google OAuth client with Gmail API enabled, then run:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run gmail:oauth
```

Open the printed URL, approve access, and copy the printed refresh token into Render as `GOOGLE_REFRESH_TOKEN`.
