# JobNimbus ChatGPT Bridge

Authenticated bridge and HCN employee operating surface over JobNimbus, Gmail,
Google Calendar, Quo, calls, and document evidence. `/hcn/` is the primary
day-to-day interface for HCN employees, but it is not a replacement data store:
JobNimbus and each connected provider remain the systems of record. The console
organizes assigned work and includes Ask Thresher, a server-side AI assistant
that reads fresh, employee-scoped evidence and can propose next steps or
wording. It cannot prepare, approve, or execute an action plan; consequential
work remains in the separate exact-plan approval flow. A later system-of-record
migration remains a separate, measured product phase.

The bridge also supports a ChatGPT Custom GPT Action, verified PDF attachments,
durable private action receipts, an assigned-file-only employee
review/approval transaction, the three-adjuster JobNimbus activity-gap management sweep, and
the isolated HCN Operations v2 contract foundation. Legacy per-client snapshots
and operational advisories are read-only by default while the v2 operational
state layer is built.
Scanned or visually complex JobNimbus documents can be returned as native
ChatGPT conversation files so the GPT inspects the original pages instead of
guessing from a filename or relying only on server-side OCR.
It includes a handoff inbox so another ChatGPT chat with Gmail/Quo access can pass findings into this JobNimbus bridge.
It also includes an authenticated, non-executing patch mailbox so Claude and
Codex can exchange short-lived `.patch`/`.diff` packages when an agent's Git
transport is unavailable.

## Safety

- HCN Operations Brain and Jobrolo are permanently separate from Chance Brain.
  The HCN/JobNimbus surface has no Chance Brain route, capability, credential,
  import, fallback, or data flow. Existing legacy-v1 client-memory files remain
  untouched and quarantined; they are not readable or trusted by HCN,
  JobNimbus tools, Custom GPT actions, or local operators.
- Thresher's isolated HCN Operations Brain provides versioned contracts,
  deterministic rules, and an encrypted minimized operational-state lifecycle
  on the dedicated HCN service only when `HCN_THRESHER_ENABLED=true` exactly.
  It stores opaque coded review/work state plus plan/receipt metadata; it has
  no model tools, autonomous learning, action authority, or external-effect
  callback.
- Ask Thresher is a separate reasoning layer over those HCN boundaries. It
  uses a dedicated server-side Groq Responses API credential, serial
  allowlisted tools, no provider-side conversation state, bounded model replay,
  and the signed-in employee's scope. Employee-visible prompts and responses
  persist only in a dedicated encrypted, principal-scoped HCN conversation
  store. It can read Work Center/file evidence and run the management sweep
  only from an authorized sweep chat. It cannot prepare, execute, or approve an
  action plan. A file chat is locked to one freshly assigned JobNimbus file and
  cannot invoke broad or cross-file tools.
- HCN employee authority is identity-bound and least privilege. A verified
  Google email must exactly match one unique active JobNimbus employee, and
  new employees receive only their assigned JobNimbus scope by default.
  Gmail/Calendar grants and Quo lines are linked separately to that immutable
  employee identity. HCN never borrows another employee's connector or falls
  back to Chance's shared mailbox or Quo line.
- HCN is the operating surface, not the authoritative client database.
  JobNimbus remains the client system of record until a later migration has
  measured parity, reconciliation, audit, rollback, and cutover gates.
- HCN writes, sends, calendar changes, uploads, and calls remain exact-plan,
  explicit-approval operations behind their route capabilities and runtime
  effect gates. Each approved operating role can prepare and review actions
  only for files freshly proven assigned to that same signed-in employee.
  Execution requires that employee's unchanged plan plus both global runtime
  gates; no management role receives company-wide write scope.
- `GET /api/v1/meta` exposes privacy-safe build, runtime, release-gate drift,
  and boundary metadata. Only a full provider-owned `RENDER_GIT_COMMIT` is
  labeled attested; caller-declared commit values are never deployment proof.
- `GET /api/v1/session` exposes privacy-safe route authorization for a Google
  employee or dedicated Codex operator. The legacy wildcard bridge token is
  denied this scoped descriptor so its effective authority is never understated.
- Legacy client-memory data must remain byte-for-byte quarantined and
  unreachable. It may not be read, refreshed, reconciled, copied, indexed,
  embedded, or imported into Thresher. Inventory, migration, and purge are
  separate privacy-remediation projects requiring explicit review and
  action-time approval.
- Quarantined `src/memory/` code and legacy data remain preserved locally for
  that remediation process but are excluded from the production Docker image.
  They are not a supported package script or test dependency.
- Keep `JOBNIMBUS_API_KEY` only in Render environment variables.
- Set `JOBNIMBUS_BRIDGE_TOKEN` and use it as the Custom GPT bearer token.
  This legacy GPT credential is not an HCN employee credential or fallback;
  HCN browser sessions always use the signed-in employee principal.
- Set `CODEX_OPERATOR_TOKEN` to a different strong random value for the
  dedicated Codex operator. This credential is a non-Google
  `codex_operator` identity, not an alias for the shared bridge token. It can
  read Chance-assigned JobNimbus client evidence and exact-file-correlated Gmail
  and Quo evidence, and use the consolidated action batch. Every operator Gmail
  and Quo read requires an exact Chance-assigned file; arbitrary mailbox queries,
  phone numbers, call IDs, and broad unmatched-communications sweeps fail closed.
  Resolver search and query-less indexes return only minimized identifying
  metadata. Gmail email correlation and Quo phone correlation fail closed when
  that identifier is shared by multiple Chance files.
- Set `CODEX_MAC_OPERATOR_TOKEN` to a separate strong random value for the
  dedicated Mac operator. Never copy the HP token to the Mac or reuse the
  shared bridge token. The Mac identity has the same least-privilege policy
  with an independent approval and audit subject.
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
  employee-to-line authorization and one-time challenge in one authenticated,
  encrypted HCN-only store. Actual texts remain exact-draft and
  approval-gated.
- The consolidated Custom GPT schema exposes one consequential action batch for
  JobNimbus writes, Gmail drafts/sends, and Quo sends. The assistant must show
  the exact one-client dry run and wait for Chance's approval. Execution also
  consumes the newest identity-bound, short-lived server challenge exactly once;
  review, Thresher closeout,
  document, and sweep endpoints never send messages.
- The legacy Chance/Custom GPT review path can scan matching communication
  across available company team lines and labels the source line. HCN employee
  sessions never inherit that scope: they read only the exact SMS-verified Quo
  line bound to their immutable employee identity. Outbound texts remain
  approval-gated.
- Changing one character, recipient, subject, or attachment invalidates the
  approval digest. Duplicate approved action batches are blocked by a persistent ledger.
- Legacy operator/Custom GPT write actions resolve only Chance
  Pearson-owned insurance files. HCN browser actions instead resolve only
  fresh active insurance files assigned to the same signed-in employee.
- Existing legacy client snapshots are quarantined historical artifacts, not
  continuity caches or operating authority. No HCN/JobNimbus route may render,
  return, or use them. Fresh JobNimbus/Gmail/Quo evidence is the only client
  evidence path.
- Legacy v1 snapshots can retain raw client and communications data. The Codex
  operator never reads or writes those snapshots, receipts, episodes, open
  loops, or model advisories. A future metadata-only inventory and any
  separately approved purge must not expose or migrate their contents.
- HCN rules use minimized, tenant-bound observations with provenance and
  freshness; they cannot send, write, call, approve, or persist operational
  client state yet.
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
CODEX_MAC_OPERATOR_TOKEN=
HCN_THRESHER_AI_GROQ_API_KEY=
HCN_ASSISTANT_HISTORY_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
QUO_API_KEY=
```

Persistent and channel-control variables:

```text
HCN_OPERATIONS_ROOT=/var/data/hcn-operations
HCN_THRESHER_ENABLED=false
HCN_THRESHER_STORE_PATH=/var/data/hcn-operations/thresher/state.enc.json
HCN_THRESHER_STORE_KEY=
HCN_THRESHER_REFERENCE_KEY=
HCN_THRESHER_SIGNING_KEY=
HCN_THRESHER_AI_ENABLED=false
HCN_ASSISTANT_HISTORY_STORE_PATH=/var/data/hcn-operations/platform/assistant-conversations.enc.json
ALLOW_GMAIL_SEND=false
QUO_DEFAULT_FROM_NUMBER=
ALLOW_QUO_SEND=false
HANDOFF_STORE_PATH=/var/data/hcn-operations/platform/handoffs.json
HANDOFF_UPLOAD_DIR=/var/data/hcn-operations/platform/handoff-uploads
MAX_JSON_BODY_BYTES=12582912
MAX_CHATGPT_FILE_BYTES=8388608
ARTIFACT_STORE_PATH=/var/data/hcn-operations/platform/artifacts.json
ARTIFACT_UPLOAD_DIR=/var/data/hcn-operations/platform/artifact-uploads
ARTIFACT_FILE_DIR=/var/data/hcn-operations/platform/artifacts
MAX_ARTIFACT_BYTES=5242880
ARTIFACT_TTL_HOURS=72
CLAIM_CALL_STORE_PATH=/var/data/hcn-operations/platform/claim-call-ledger.json
ACTION_BATCH_STORE_PATH=/var/data/hcn-operations/platform/action-batches.json
ACTION_APPROVAL_STORE_PATH=/var/data/hcn-operations/platform/action-approvals.json
ACTION_APPROVAL_TTL_SECONDS=900
OUTBOUND_SEND_STORE_PATH=/var/data/hcn-operations/platform/outbound-sends.json
OPENAI_API_KEY=
```

`HCN_OPERATIONS_ROOT` is required for the HCN employee platform. It must be a
dedicated persistent directory that is not shared with Chance Brain, legacy
client memory, or Jobrolo. All bridge security ledgers, connector grants,
employee links, handoffs, and artifacts default beneath its `platform/`
subdirectory. Thresher's operational-state/rules layer remains deterministic
and non-executing. Ask Thresher's dedicated model runtime is configured
separately with `HCN_THRESHER_AI_*`; it never receives an execution tool.

`HCN_THRESHER_AI_GROQ_API_KEY` must belong to a dedicated HCN Groq project and
must not equal another product/provider key, the realtime voice key, an HCN
encryption key, an OAuth secret, or an operator credential. Provider, endpoint,
and model are fixed in source as Groq Responses API plus
`openai/gpt-oss-20b`; neither the browser nor an environment variable may
select a different model. Ask Thresher sends each turn's bounded conversation
and allowlisted fresh evidence without a provider conversation id. Groq's
Responses API does not accept a `store` request field, so the adapter omits it
and keeps bounded conversation replay inside the HCN process. Groq project data
controls and retention terms still apply.

`HCN_ASSISTANT_HISTORY_KEY` must be a separate canonical, unpadded base64url
encoding of 32-128 random bytes. It cannot reuse a provider, OAuth, Thresher,
connector, operator, Chance Brain, or Jobrolo secret.
`HCN_ASSISTANT_HISTORY_STORE_PATH` must be an absolute descendant of
`HCN_OPERATIONS_ROOT`, normally
`/var/data/hcn-operations/platform/assistant-conversations.enc.json`. The
atomic AES-256-GCM store contains only employee-visible prompts/responses and
bounded coded routing/source metadata. It does not store provider credentials,
tool payloads, documents, hidden prompts, provider response identifiers,
action plans, approvals, or HCN Operations Brain state. Full transcripts are
available to the owning employee in the UI; each model call replays only a
bounded recent window.

The reasoning router is fixed in server code, not selected by the browser or
environment variables. In Auto mode, narrow Work Center, exact-file status,
and authorized activity-gap reports use deterministic fresh reads with no
model call. Ordinary interpretation and drafting use Thresher AI's fixed Groq
`openai/gpt-oss-20b` runtime with medium reasoning. The explicit Deep Review
control and high-stakes settlement, policy, coverage, or claim-strategy work
use the same dedicated Thresher runtime with high reasoning.
Unsupported live
calls, uploads, deletions, financial actions, and legal actions fail closed to
the protected operator workflow.

The exact `HCN_THRESHER_ENABLED=true` gate activates the isolated Thresher
storage lifecycle only after every dedicated value validates.
`HCN_THRESHER_STORE_KEY` is the dedicated AEAD/HKDF master,
`HCN_THRESHER_REFERENCE_KEY` is separate opaque-reference material, and
`HCN_THRESHER_SIGNING_KEY` signs minimized evidence, rule, work, and receipt
digests. None may reuse another HCN, provider, Chance Brain, legacy-memory, or
Jobrolo secret. Configuring keys with the gate absent or false validates a
ready-but-inactive foundation. A missing, partial, malformed, reused, or
unsafe-path active configuration fails startup. Superseded unreferenced review
state is compacted deterministically; receipts and their complete
plan/rule/evidence audit graph are never compacted.

## HCN Operations Console

The HCN console is the responsive, installable employee operating surface at
`/hcn/`. Its primary view is Ask Thresher, with direct starter actions for
working files, finding a file, reviewing communications, checking neglected
files, and preparing follow-up work. Every enabled employee can work only the
JobNimbus files assigned to that employee by default. Connections links that
employee's Gmail/read-only Calendar grant and Quo line separately.
Ask Thresher supports multiple durable chats: general work chats, exact-file
client chats, and role-authorized management sweep chats. Employees can list,
open, rename, archive, restore, and start chats without exposing provider
identifiers. Starting a client chat is idempotent: it reopens that employee's
existing active chat for the exact file instead of creating a duplicate. After
that chat is archived, a new active chat may be created; an older archived chat
cannot be restored while another active chat exists for the same file. Every
list, read, and turn rechecks current role and file
assignment; a reassigned or inactive file chat is hidden and cannot be opened.
The application document at `/`, `/hcn`, or `/hcn/` is never served without a
current HCN employee cookie; unauthenticated navigation is redirected directly
to Google sign-in. The retirement service worker deletes every older HCN shell
cache and unregisters itself, so a signed-out or expired browser cannot reopen
an offline shell.
Exact-file review can combine current JobNimbus evidence with exactly
correlated Gmail and Quo evidence for the same employee; missing or unhealthy
employee connectors fail closed and never fall back to Chance's accounts.
The file view also shows coded, evidence-backed readiness for neglected files,
communications, claim filing, inspection scheduling, and follow-up. Its
plain-language next steps come from fresh provider evidence; drafts,
unverified delivery, missing contact channels, and unsupported damage facts
cannot be promoted into completed work.

The console is an orchestration and control layer. It does not copy JobNimbus
into a new CRM or become authoritative for client records. JobNimbus remains
the system of record, and provider readback remains the truth after an approved
effect. Current action-plan and receipt routes are identity-bound,
assigned-file-only capabilities. Employee Work Center access alone never
authorizes an effect: the exact plan must be reviewed and approved by that same
signed-in employee, and every relevant global effect gate must also be enabled.

The console is disabled by default. To enable it for one exact HTTPS origin,
configure:

```text
HCN_CONSOLE_ENABLED=true
HCN_CONSOLE_ORIGIN=https://hcn-operations-platform.onrender.com
PUBLIC_BASE_URL=https://hcn-operations-platform.onrender.com
ALLOW_GOOGLE_USER_AUTH=true
AUTO_ENROLL_WAVE_USERS=false
HCN_ALLOW_ACTIVE_JOBNIMBUS_GOOGLE_USERS=false
HCN_OPERATIONS_ROOT=/var/data/hcn-operations
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
HCN_GOOGLE_CLIENT_ID=
HCN_GOOGLE_CLIENT_SECRET=
CHANCE_GOOGLE_SUBJECT=
OAUTH_SESSION_SECRET=
HCN_TENANT_ID=
HCN_REFERENCE_KEY=
HCN_GOOGLE_GRANT_KEY=
HCN_GOOGLE_GRANT_STORE_PATH=/var/data/hcn-operations/platform/google-grants.enc.json
HCN_IDENTITY_PIN_STORE_PATH=/var/data/hcn-operations/platform/identity-pins.json
HCN_INVITATION_STORE_PATH=/var/data/hcn-operations/platform/employee-invitations.enc.json
HCN_MANAGEMENT_ADJUSTERS_JSON=
WAVE_AUTH_USERS_JSON=
```

`HCN_CONSOLE_ORIGIN` must exactly match the origin of `PUBLIC_BASE_URL`.
Sign-in reuses the existing Google redirect URI at
`/oauth/google/callback`; no second Google redirect URI is required. Public
self-registration and active-JobNimbus auto-enrollment are disabled.
Only Chance's signed-in HCN role can prepare and approve an invitation. The
invited Google email must then be verified by Google and exactly match one
unique active JobNimbus employee. The encrypted invitation registry pins the
accepted Google subject, exact email, JobNimbus owner, reviewed role, and
assigned-file scope, and the server revalidates that authorization on every
request. An invitation link is valid for at most 72 hours, carries its
one-time token only in the URL fragment, and is returned only once after
Chance approves creation. HCN does not automatically email the link.
During the invite-only cutover, an existing non-Chance employee keeps access
only when the authenticated identity-pin store already proves the exact email,
Google subject, JobNimbus owner, assigned-file scope, and role. These
temporarily compatible identities are shown to Chance in **Team** for explicit
migration into an invitation-managed account. The compatibility window cannot
create a new pin, change a role or owner, or admit an unknown user; all new
access remains invitation-only.

Console sign-in and Google provider linking are separate ceremonies on the
dedicated `HCN_GOOGLE_CLIENT_ID`/`HCN_GOOGLE_CLIENT_SECRET`. Sign-in requests
identity scopes only and creates a bounded opaque HCN browser session. Choosing
**Connect Google** separately requests Gmail modify and Calendar read-only
access plus identity scopes, then stores that employee's refresh grant on the
server, encrypted at rest under an opaque reference derived from the immutable
Google subject. The dedicated HCN client ID and secret must be different from
the legacy Custom GPT/HP Google client, and both flows register the same exact
HCN callback. Neither provider tokens nor the Google subject are exposed to
browser JavaScript.

`HCN_GOOGLE_GRANT_KEY` must be a dedicated canonical, unpadded base64url secret
encoding 32 to 128 random bytes. It must not reuse
`OAUTH_SESSION_SECRET`, a Google credential, the bridge token, a Chance Brain
key, or a Jobrolo key. `HCN_GOOGLE_GRANT_STORE_PATH` must resolve inside the
HCN bridge's persistent storage; its default is
`$HCN_OPERATIONS_ROOT/platform/google-grants.enc.json`. The file is an encrypted
server-side grant envelope, not a browser session store. Losing or changing the
key makes existing grants unreadable and requires a controlled relink; never
print the key or grant file contents.

Quo linking is another separate ceremony. The employee proves control of an
available company line with a six-digit SMS code. The resulting line assignment
is bound to the immutable employee identity, cannot be claimed by another
employee, and is rendered only in masked form. No HCN employee receives a
shared Chance-line fallback. Actual email, text, calendar, write, or call
effects still require their exact reviewed plan, explicit action-time approval,
route capability, and enabled runtime gates.

`HCN_QUO_LINE_STORE_PATH` points to the single encrypted authorization store.
`HCN_QUO_LINK_KEY` must be new canonical unpadded base64url encoding of 32 to
128 random bytes, distinct from every HCN, OAuth, provider, bridge, Thresher,
Chance Brain, and Jobrolo secret. HKDF derives separate encryption and
domain-separated OTP-MAC keys; plaintext line bindings and OTP hashes are not
used.

`HCN_TENANT_ID` is an HCN-only identifier in the form
`tenant_` followed by 16 lowercase hexadecimal characters.
`HCN_REFERENCE_KEY` is the canonical, unpadded base64url encoding of 32 to 128
random bytes. Generate both once with a cryptographically secure secret
generator and store them only in the production secret manager. They must not
be copied from Chance Brain, Jobrolo, a provider credential, or the shared
bridge token. The console fails closed when either value is missing or
malformed, and readiness responses never reveal either value.

Generate `OAUTH_SESSION_SECRET` from at least 32 random bytes and store its
base64url encoding. The bridge rejects weak values. This secret seals
short-lived OAuth/session state; it does not encrypt persistent Google grants
and must remain distinct from `HCN_GOOGLE_GRANT_KEY`. Credential-bearing
Google provider URLs are pinned to the reviewed Google HTTPS endpoints in
production, with redirects, oversized responses, and stalled requests rejected.

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

The browser uses two same-origin, assigned-employee JSON routes:

- `POST /hcn/api/v1/work-center` with exactly `offset` and `limit` returns a
  fresh ephemeral page of active insurance files assigned to the signed-in
  employee. It exposes HCN opaque references, safe display fields,
  missing-fact flags, attention codes, and source timing; it never exposes raw
  provider identifiers.
- `POST /hcn/api/v1/file-review` with exactly `fileRef` and `recentLimit`
  resolves the opaque reference against a new JobNimbus index read and returns
  one minimized file workspace within that employee's scope. JobNimbus is
  required. The employee's own Gmail and Quo failures remain visible as coded
  partial evidence instead of being silently treated as complete or replaced
  with a shared fallback.

Both routes require the secure HCN browser cookie, the exact configured origin,
the session CSRF value, and `application/json`; request bodies are limited to
4 KiB. Their responses are `no-store` and remain in memory/DOM only. An opaque
reference that no longer resolves to one current, active, employee-assigned file
returns `404`. The routes do not call Chance Brain, Jobrolo, legacy client
memory, model advisories, or any persistence layer.

### Three-adjuster JobNimbus activity-gap sweep

`POST /hcn/api/v1/management-sweep` returns a fresh, ephemeral report containing
up to ten active insurance files with the longest verified JobNimbus activity
gap for each of exactly three configured adjusters, plus a company-wide
ranking. Its request body may contain only:

```json
{
  "limitPerAdjuster": 10
}
```

`limitPerAdjuster` defaults to `10` and must be an integer from `1` through
`10`. Browser access requires an explicitly provisioned HCN management role
(`chance`, `administrator`, or `manager`), the exact console origin, the
session CSRF value, and the `hcn.management_sweep.read` capability. The
dedicated HP Codex operator is the only bearer-token exception: its immutable
`codex-hp-operator` identity must carry the separate
`management_sweep:read` scope. The Mac operator, shared bridge token, other
Codex identities, and general employee sessions remain denied. This exception
does not grant a general company index or any write, upload, send, call, or
action route. The console runs this high-cost report only after an authorized
manager presses
**Run fresh 10 × 3 sweep**; it does not auto-run on page load.

The report is ready only when JobNimbus, the HCN opaque-reference
configuration, and `HCN_MANAGEMENT_ADJUSTERS_JSON` are all ready. The JSON
allowlist must contain exactly three unique JobNimbus owner identifiers and
three unique display names. Each entry must contain only `ownerId` and
`displayName`. Configure the real owner identifiers only in the production
secret manager; do not commit them. The console reads this combined readiness
state and does not label the report ready from route authorization alone. This
synthetic example shows the exact shape:

```json
[
  {
    "ownerId": "jn-owner-id-a",
    "displayName": "Adjuster One"
  },
  {
    "ownerId": "jn-owner-id-b",
    "displayName": "Adjuster Two"
  },
  {
    "ownerId": "jn-owner-id-c",
    "displayName": "Adjuster Three"
  }
]
```

The bounded-read defaults are `HCN_MANAGEMENT_MAX_FILES=300`,
`HCN_MANAGEMENT_ACTIVITY_MAX_RECORDS=1000`, and
`HCN_MANAGEMENT_READ_CONCURRENCY=4`, with a shared
`HCN_MANAGEMENT_PROVIDER_REQUEST_BUDGET=750`. They are safety limits, not pagination
shortcuts: exceeding a bound fails the report instead of returning an
apparently complete ranking. Review and test any limit change as a release
change.

The ranking is deliberately an **activity-gap report**, not a complete
communication-gap report. It uses JobNimbus only. Gmail, Quo, and Google
Calendar are returned as `not_evaluated` because the current connections do
not prove company-wide, exact-file coverage. JobNimbus tasks, reminders,
drafts, and system/automation records do not reset the gap. The sweep also does
not inspect or infer the meaning of a note body; it ranks the latest eligible
JobNimbus activity metadata it can verify.

Only reviewed activity kind/state combinations are allowlisted. Unknown,
queued, draft, task-created, file-view, and other unsupported records never
reset a gap. Their bounded aggregate counts remain visible, and any unsupported
record makes the relevant file and the report explicitly partial even when all
provider pages were fetched. Event counts describe the complete fetched
history for that exact file; only the newest allowlisted event is retained for
ranking after each bounded worker completes.

Completeness is proven per eligible file. The bridge fully paginates both
`primary.id=<file>` and `related.id=<file>` JobNimbus activity queries,
validates that every page actually matches the exact field requested,
revalidates each activity against the complete management-eligible file set, and
deduplicates the two collections by activity identifier only when their
provider records are consistent. It fails closed for incomplete pagination,
wrong-field results, or inconsistent duplicate provenance. A reference to an
inactive, non-insurance, or unconfigured-owner contact does not make an
otherwise exact eligible-file activity ambiguous. An activity linked to more
than one management-eligible file is never assigned by inference: it is
conservatively excluded from every affected file's gap calculation and makes
the file and report explicitly partial. Files must be active insurance records
assigned to exactly one of the three configured owners. Inactive,
non-insurance, unconfigured-owner, and ambiguous-owner files are explicitly
excluded. The browser receives opaque HCN references rather than provider
identifiers.

The response includes canonical `asOf`, `checkedAt`, and `validUntil` values.
The server refuses to return an expired report. The browser rejects a response
that is already expired and purges the in-memory report at `validUntil`, on
logout, offline transition, session recheck, or visibility-time expiry check.

This route is read-only and `no-store`. It does not read or write Chance Brain,
HCN Operations Brain client state, Jobrolo, legacy snapshots, advisories,
receipts, or any client persistence. It cannot prepare or execute an action,
send an email or text, place a call, upload a file, create a note or task, or
change JobNimbus. Any future management-report delivery or file action requires
its own reviewed approval-gated contract; this read route must not be expanded
into one.

Focused local checks for this feature are:

```bash
node --check src/server.js
node --test src/hcn-console/management-config.test.js
node --test src/hcn-console/management-provider.test.js
node --test src/hcn-ops/management-sweep/core.test.js
node --test src/console/static.test.js
npm run check
```

Before a production release, run the repository readiness check from the HP
workspace:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-readiness.ps1
```

Review the complete diff and confirm the deployment branch is based on the
current `origin/codex/hcn-platform-foundation`. Push, merge, deployment, the Render
`HCN_MANAGEMENT_ADJUSTERS_JSON` value, or any other Render environment change
each requires specific action-time approval. After deployment, verify the
attested build SHA, live capability manifest, assigned-file session
authorization for HCN actions, management-role authorization for the sweep,
connector health, `no-store` response behavior, and an exact three-adjuster
synthetic or approved production smoke test. Never place the management
allowlist's real owner identifiers in a test fixture, log, screenshot, chat,
or repository.

### Ask Thresher production cutover

Before cutover, confirm the full test and readiness suites pass, record the
exact candidate SHA, and obtain action-time approval for every external
change. Store a dedicated, funded HCN Groq project key directly in Render as
`HCN_THRESHER_AI_GROQ_API_KEY`; never reuse another product key or another HCN
secret. Add an independently generated `HCN_ASSISTANT_HISTORY_KEY` and confirm
the reviewed persistent history path before enabling the assistant. Confirm
the checked-in model, reasoning, and token settings, add the
exact Google Web OAuth redirect
`https://hcn-operations-platform.onrender.com/oauth/google/callback`, push the
candidate to `codex/hcn-platform-foundation`, and manually deploy that exact
SHA. Render auto-deploy is disabled.

After deployment, do not treat an overall `/health` `ok: true` as assistant
readiness: the service may remain healthy while `hcnAssistant.ready` is
`false`. Verify `/api/v1/meta` reports the candidate SHA as
`provider_attested`, then require `hcnAssistant.enabled`,
`hcnAssistant.configured`, `hcnAssistant.historyReady`, and
`hcnAssistant.ready` all to be `true`. Confirm the full OpenAPI and capability
manifest expose `hcn.assistant.turn`, `hcn.assistant.conversations.read`, and
`hcn.assistant.conversations.manage`; the Custom GPT schema must not expose the
browser conversation routes, and assistant HTTP responses remain `no-store`.
Create, reopen, rename, archive, and restore a disposable chat and verify its
transcript survives a new browser session. Complete
one controlled employee sign-in, assigned-work read, authorized management
sweep, and exact action-plan preparation. Do not execute the smoke-test plan;
verify JobNimbus, Gmail, Quo, and Calendar remain unchanged.

If readiness, scope, or model behavior fails, set
`HCN_THRESHER_AI_ENABLED=false` and restart the service. If the release affects
existing HCN operations, roll Render back to the previously verified attested
SHA. Revoke the assistant key only if exposure is suspected; do not rotate
unrelated HCN credentials.

## Fresh Review And Approval

`POST /ops/review-chance-files` gathers fresh JobNimbus fields, recent activity,
open tasks, non-photo operational documents, Gmail evidence, Quo evidence, and
private action receipts. It has no Chance Brain or legacy-client-memory path.
Live JobNimbus, Gmail, and Quo evidence is authoritative. Thresher may evaluate
minimized fresh observations through isolated deterministic contracts, but the
HCN Operations Brain never overrides a live source or authorizes an action.
On the explicitly gated HCN service, exact-file review/work state and coded
plan/receipt lifecycle metadata persist in its separate encrypted store.

The dedicated Codex operator never reads or
writes Chance Brain client snapshots, episodes, operational state, or action
receipts, and it cannot request a Chance Brain advisory. Exact-file reviews return
fresh source evidence plus ephemeral metadata only. Query-less indexes omit
contact details, claim/policy values, addresses, phone numbers, email addresses,
and adjuster details. Legacy client snapshots are outside every HCN/JobNimbus
tool path and must not be read, trusted, migrated, or purged without a separate
approved privacy-remediation workflow.

`POST /ops/action-batch` then provides the two-step execution flow:

1. Send exact operations with `execute:false` and show Chance the resulting plan.
2. After Chance approves, repeat the unchanged operations with `execute:true`
   and the returned `approvalDigest` plus the short-lived, single-use
   `approvalChallenge` before `approvalExpiresAt`.

The bridge records successful actions in its dedicated persistent security and
action ledgers and refuses to run the same approved batch twice. It never
appends those receipts to legacy client memory or refreshes a legacy snapshot
after an approved JobNimbus write.

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
Import `https://hcn-operations-platform.onrender.com/openapi-chatgpt.json`,
configure OAuth with the service's `/oauth/authorize` and `/oauth/token`
endpoints plus its dedicated `GPT_OAUTH_CLIENT_ID` and
`GPT_OAUTH_CLIENT_SECRET`, save/publish the GPT, and start a new chat after
schema changes. Arbitrary standard chats do not gain the HCN platform
automatically; the Action must be installed on that GPT. Do not reuse the
shared bridge token, Google client secret, local operator token, or any Chance
Brain credential for this OAuth client.

The GPT-facing schema is intentionally consolidated to a curated set of
high-level operations. Chance Brain and legacy-memory routes are not part of
that schema or the advertised capability registry.
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

## HCN Employee And Connector Rollout

Employee admission is invite-only. Keep `AUTO_ENROLL_WAVE_USERS=false` and
`HCN_ALLOW_ACTIVE_JOBNIMBUS_GOOGLE_USERS=false`. Chance opens **Team**,
prepares an exact employee invitation, reviews the email, role, assigned-file
scope, management visibility, and expiration, then approves the unchanged
short-lived dry run. The employee must sign in with the exact verified Google
email from that invitation, and that email must still resolve to one unique
active JobNimbus user. The accepted Google subject is immutably pinned inside
the encrypted invitation registry. No public registration or domain-wide
admission path exists.

Existing authenticated identity pins are a temporary migration exception, not
self-registration. **Team** identifies each remaining legacy-pinned employee.
Chance must invite that exact email with its existing role; successful Google
acceptance converts the employee to invitation-managed authority and removes
the migration warning immediately. Remove the compatibility path in a later
reviewed release after the remaining count reaches zero.

The one-time invite URL is returned only by the approved create response and
puts the token in the fragment so it cannot enter HTTP request logs. HCN sends
no invitation email. While the Google OAuth app remains External/Testing,
each invited Google account must also be added as a Google OAuth test user;
an HCN invitation does not bypass that provider prerequisite.

After HCN sign-in, the employee separately links Gmail/Calendar through the
Connections view and separately links one company Quo line by SMS OTP. The
Google refresh grant is encrypted in the HCN grant store. The Quo link is bound
to the employee's immutable identity and cannot be reused by another employee.
Missing, revoked, corrupt, or unavailable connectors fail closed; HCN does not
substitute Chance's Gmail grant, mailbox, or Quo line.

Production rollout prerequisites:

1. Provision a new HCN-only persistent Render disk; do not reuse the legacy
   memory disk or treat a different folder on that disk as isolation. Set
   `HCN_OPERATIONS_ROOT`, `HCN_GOOGLE_GRANT_STORE_PATH`, and
   `HCN_QUO_LINE_STORE_PATH`, `HCN_IDENTITY_PIN_STORE_PATH`, and
   `HCN_INVITATION_STORE_PATH` to reviewed locations on the new disk. Keep
   the encrypted Quo authorization and employee invitation stores, plus the
   legacy authenticated identity-pin store, on that same
   HCN-only disk.
2. Add `HCN_GOOGLE_GRANT_KEY` through the Render secret UI. Use a dedicated
   canonical base64url value encoding 32 to 128 random bytes; never reuse or
   expose another system's secret.
3. Add `HCN_QUO_LINK_KEY` through the Render secret UI with the same
   dedicated-key and non-reuse requirements.
4. Configure the exact HTTPS console/public origin and the dedicated HCN Google
   connector client for Gmail modify and Calendar read-only scopes. Keep it distinct from
   the login/Custom GPT client while registering the same exact callback. Also
   configure the exact-invite/unique-active-JobNimbus login rule, HCN
   tenant/reference secrets, and strong OAuth-session secret. While an
   External Google app is in Testing, every invited account must be an OAuth
   test user; complete Google's required production verification before broad
   rollout.
5. Confirm the JobNimbus service account can enumerate active users and that
   each pilot employee's Google email is exact and unique in JobNimbus.
6. Configure the company Quo and SMS-verification providers and verify that
   each pilot line is available to only one immutable employee identity.
7. Configure three independently generated Thresher keys and the isolated
   HCN-only store path. Keep `HCN_THRESHER_ENABLED=false` outside the dedicated
   HCN service; use exact lowercase `true` only for its reviewed rollout.
8. Keep write/send/call gates disabled during identity and connector smoke
   tests. Verify two separate employee sessions see only their own assigned
   JobNimbus files and connector status, with no cross-user or Chance fallback.
9. Verify ordinary employees cannot access management routes, cannot prepare
   an action against another employee's file, and can access only their own
   session-scoped plans and stable principal receipts. Verify management roles
   separately and prove they still receive no company-wide write scope.
10. Verify repeated exact-file reviews compact only superseded transient state,
    receipt audit graphs survive restart, and a corrupted/unavailable Thresher
    store blocks execution before any provider mutation.
11. Record the reviewed SHA, run the full test/readiness suite, deploy only with
   action-time approval, and verify encrypted-grant persistence and revocation
   across a controlled restart before expanding the pilot.

The legacy `npm run gmail:oauth` helper is intentionally disabled: it accepted
a client secret through shell history and printed a refresh token. Provisioning
Google credentials is a separate, explicitly approved production step. Enter
secrets only through the Google and Render provider secret UIs; never paste,
print, log, download, or save them in a shell, chat, repository, or local file.
