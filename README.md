# JobNimbus ChatGPT Bridge

Small authenticated bridge that lets a ChatGPT Custom GPT Action read and, when explicitly enabled, update JobNimbus.
It also supports Gmail search/thread review and dry-run email drafting/sending when Gmail OAuth credentials are configured.
It includes a handoff inbox so another ChatGPT chat with Gmail/Quo access can pass findings into this JobNimbus bridge.
It also includes an authenticated, non-executing patch mailbox so Claude and
Codex can exchange short-lived `.patch`/`.diff` packages when an agent's Git
transport is unavailable.

## Safety

- Keep `JOBNIMBUS_API_KEY` only in Render environment variables.
- Set `JOBNIMBUS_BRIDGE_TOKEN` and use it as the Custom GPT bearer token.
- Leave `BRIDGE_ALLOW_WRITES=false` until you intentionally want approved write actions.
- Write endpoints are dry-run unless the request includes `execute:true` and Render has `BRIDGE_ALLOW_WRITES=true`.
- Gmail draft/send endpoints are also dry-run unless `execute:true` and `BRIDGE_ALLOW_WRITES=true`.
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
```

Optional env vars:

```text
HANDOFF_STORE_PATH=/tmp/jobnimbus-chatgpt-handoffs.json
HANDOFF_UPLOAD_DIR=/tmp/jobnimbus-chatgpt-handoff-uploads
MAX_JSON_BODY_BYTES=12582912
ARTIFACT_STORE_PATH=/tmp/jobnimbus-chatgpt-artifacts.json
ARTIFACT_UPLOAD_DIR=/tmp/jobnimbus-chatgpt-artifact-uploads
ARTIFACT_FILE_DIR=/tmp/jobnimbus-chatgpt-artifacts
MAX_ARTIFACT_BYTES=5242880
ARTIFACT_TTL_HOURS=72
```

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

## Gmail OAuth

Create a Google OAuth client with Gmail API enabled, then run:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run gmail:oauth
```

Open the printed URL, approve access, and copy the printed refresh token into Render as `GOOGLE_REFRESH_TOKEN`.
