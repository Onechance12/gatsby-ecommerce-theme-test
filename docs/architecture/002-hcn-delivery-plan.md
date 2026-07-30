# HCN Operations Platform Delivery Plan

- Status: Active
- Owner: Home Claim Network
- Started: 2026-07-28
- Production client system of record: JobNimbus
- Current employee operating surface: HCN Operations Console

## Product outcome

Home Claim Network will have one employee operating layer over JobNimbus,
Gmail, Quo, Google Calendar, Retell, and document evidence:

- a responsive HCN Operations Console for HP, Mac, and mobile;
- Codex operators with distinct, revocable device identities;
- a fresh-evidence Work Center and exact-file workspace;
- deterministic Thresher findings with explicit provenance and freshness;
- exact action plans, one-use approval, execution receipts, and readback
  reconciliation.

JobNimbus and the connected providers remain authoritative. The HCN layer
is the main surface employees use to organize work and safely coordinate
actions; it does not yet replace the CRM or copy its authoritative records.
Chance Brain and Jobrolo remain permanently disconnected as defined in
ADR 001.

Thresher's isolated HCN Operations Brain is currently a contract and
deterministic-rule foundation only. Dedicated operational persistence is a
later phase; it is not active and is not replaced by Chance Brain or legacy
client memory in the meantime.

## Current employee-platform tranche

This tranche changes HCN from a Chance-only console into the main HCN employee
operating surface without broadening provider authority:

- an enabled employee signs in with a verified `@wavepa.com` Google identity;
- first-use admission requires an exact active JobNimbus employee-email match;
- the immutable Google subject and JobNimbus owner are bound to the HCN
  principal and revalidated on every session request;
- auto-enrolled users default to role `employee` and JobNimbus scope
  `assigned`; company scope requires an explicit reviewed role configuration;
- Work Center and exact-file review use the signed-in employee's JobNimbus
  owner scope, not Chance's owner as a shared fallback;
- Gmail and read-only Calendar access are linked in a separate employee OAuth
  ceremony and stored as encrypted persistent grants keyed by an opaque
  reference derived from the immutable Google subject;
- Quo is linked separately by a six-digit SMS proof to the same immutable
  employee identity; a line cannot be shared across employees, and ordinary HCN
  sessions have no Chance-line fallback;
- missing, revoked, corrupt, or unavailable employee connectors fail closed;
- management sweep access remains a separate management capability; and
- HCN action-plan preparation, review, execution, invalidation, and receipts
  remain Chance-only. Every write, send, calendar change, upload, or call remains
  subject to exact-plan review, explicit action-time approval, route
  capability, and runtime effect gates.

This is not a data migration. JobNimbus remains the client system of record
until a later phase has objective parity measures, dual-read reconciliation,
audit and retention controls, rollback, and a separately approved cutover.

## Phase 0 — Boundary and runtime truth

Deliverables:

- HCN v2 minimized contracts and opaque references;
- build SHA and runtime attestation;
- versioned capability manifest and configuration-drift reporting;
- explicit runtime boundary metadata;
- no Chance Brain or legacy-memory route in the server surface, GPT schema, or
  advertised capability registry;
- legacy client-memory artifacts quarantined and unreachable without reading,
  migrating, or purging them;
- quarantined legacy-memory code and data excluded from the production Docker
  image and ordinary package scripts while remaining untouched locally;
- isolated HCN Operations Brain contracts and deterministic Thresher rules,
  with persistence explicitly pending.

Exit gate:

- contract and boundary tests pass;
- the deployed build can be identified without inference;
- route/schema/capability tests prove that no HCN, JobNimbus-tool, GPT, or local
  operator identity can reach Chance Brain or legacy client memory;
- seeded legacy canaries remain byte-for-byte and timestamp unchanged;
- runtime metadata reports Chance Brain as disconnected, legacy client memory
  as quarantined/unreachable, and HCN Operations Brain persistence as pending.

## Phase 1 — Secure console foundation

Deliverables:

- responsive installable console shell at `/hcn/`;
- exact-origin Google Workspace login with PKCE;
- opaque Secure, HttpOnly, host-only browser sessions;
- exact-origin and session-bound CSRF enforcement;
- production-pinned Google endpoints and bounded provider responses;
- pre-allocation login admission control;
- immutable Google account subject and active JobNimbus-owner binding for every
  admitted employee;
- assigned-only auto-enrollment for exact active `@wavepa.com` JobNimbus
  matches;
- separate per-employee Gmail/Calendar connection with encrypted persistent
  grants;
- separate Quo SMS-OTP line linking bound to immutable employee identity;
- shell-only service-worker caching with no client-data storage.

Exit gate:

- independent security review has no release blocker;
- employee GPT OAuth remains compatible;
- HCN sign-in alone grants no Gmail, Calendar, or Quo provider connection and
  never selects a shared Chance fallback;
- connector status exposes no token, immutable subject, full phone number, or
  provider record identifier;
- no send, write, call, upload, approval, or action authority is inferred from
  sign-in or connector linking;
- a restart safely signs out all sessions while the browser-session store is
  in-memory; encrypted employee grants remain in their separate persistent
  store.

### Employee connector rollout prerequisites

- Provision a new persistent HCN-only disk before enabling employee connectors.
  A different directory on a legacy/shared disk is not isolation. Set required
  `HCN_OPERATIONS_ROOT` to the new disk mount; it must not be shared with
  Chance Brain, legacy client memory, or Jobrolo.
  `HCN_GOOGLE_GRANT_STORE_PATH` must resolve to the reviewed encrypted grant
  file on that storage; the default is
  `$HCN_OPERATIONS_ROOT/platform/google-grants.enc.json`.
- Configure `HCN_GOOGLE_GRANT_KEY` only in the production secret manager. It is
  a dedicated canonical base64url value encoding 32 to 128 random bytes and
  may not reuse `OAUTH_SESSION_SECRET`, any Google/provider credential, the
  shared bridge token, a Chance Brain key, or a Jobrolo key.
- Configure the exact HTTPS HCN/public origin and a dedicated
  `HCN_GOOGLE_CLIENT_ID`/`HCN_GOOGLE_CLIENT_SECRET` for employee connector
  grants. It must be distinct from the login/Custom GPT Google client, request
  only Gmail read-only, Calendar read-only, and identity scopes, and register
  the same exact callback. Also configure the allowed `wavepa.com` Workspace
  domain, HCN tenant/reference secrets, and OAuth session secret. No credential
  value belongs in Git, documentation, logs, screenshots, or chat.
- Enable either reviewed explicit employees or
  `AUTO_ENROLL_WAVE_USERS=true`. Before admission, JobNimbus must return one
  active user with an exact unique matching employee email and stable owner
  identifier.
- Keep auto-enrollment and the single authenticated, encrypted Quo
  line-authorization store on private persistent paths. Use a dedicated
  `HCN_QUO_LINK_KEY`; configure it, Quo, and SMS provider credentials only in
  the secret manager.
- Pilot at least two employees. Prove assigned-file isolation, encrypted grant
  persistence/revocation across a controlled restart, masked-only Quo status,
  absence of cross-user or Chance fallback, management denial for an ordinary
  employee, and Chance-only HCN action denial for every other role.
- Keep effect gates disabled throughout identity/connector testing. Enabling
  any write, send, calendar, upload, or call gate is a later action-time
  approval, not a connector rollout step.
- Do not configure an operational LLM provider in this tranche. Thresher uses
  deterministic minimized contracts only; isolated model advisory and
  persistence integration are later reviewed phases.

## Phase 2 — Fresh read-only Work Center

Deliverables:

- an employee Work Center containing only active insurance files assigned to
  the signed-in employee's immutable JobNimbus owner;
- exact-file selection by opaque HCN reference rather than provider ID;
- bounded presentation DTOs for file facts, tasks, activities, documents,
  the same employee's Gmail evidence, and the same employee's Quo evidence;
- coded priority, today, waiting, source-failure, and missing-fact lanes;
- visible per-source freshness and incomplete states;
- no legacy-memory, Chance Brain, Jobrolo, advisory, or persistence path.

Exit gate:

- JobNimbus pagination proves completeness or fails closed;
- forged, inactive, unassigned, cross-employee, or ambiguous files disclose
  nothing;
- required JobNimbus failure returns a sanitized failure;
- optional Gmail or Quo failure returns an explicit incomplete state and no
  stale or shared-account fallback;
- no raw provider identifiers, tokens, provider errors, or `rawContact` cross
  the console API;
- seeded legacy canaries remain byte-for-byte and timestamp unchanged.

### Phase 2 management tranche — three-adjuster activity-gap sweep

This tranche adds Richard's management view without broadening the Work
Center's client-action scope. It is a capability-gated, read-only JobNimbus
report for explicitly provisioned HCN management roles, not a general employee
report and not a company-wide communications archive.

Deliverables:

- `POST /hcn/api/v1/management-sweep`, protected by an explicitly provisioned
  `chance`, `administrator`, or `manager` HCN browser session, exact-origin and
  CSRF checks, and
  `hcn.management_sweep.read`;
- an exact `HCN_MANAGEMENT_ADJUSTERS_JSON` allowlist containing three unique
  JobNimbus owner identifiers and display names, configured outside Git;
- a deterministic top-one-through-ten ranking per configured adjuster and a
  company-wide ranking of active insurance files by verified JobNimbus activity
  gap;
- complete per-file pagination for both JobNimbus `primary.id` and
  `related.id` activity references, exact requested-field validation,
  full-contact-index scope validation, and provenance-consistent cross-query
  deduplication;
- one shared bounded provider-request budget across the contact index and all
  per-file activity pages;
- explicit user-triggered execution rather than an automatic sweep on page
  load;
- a canonical response freshness deadline that purges the in-memory browser
  report when it expires;
- explicit exclusion counts for inactive, non-insurance, unconfigured-owner,
  and ambiguous-owner files;
- explicit `not_evaluated` source health for Gmail, Quo, and Google Calendar
  until those connectors can prove company-wide exact-file coverage;
- opaque HCN file and evidence references, ephemeral `no-store` responses, and
  no provider identifiers in the browser DTO.

The ranking is activity-only. JobNimbus tasks, reminders, drafts, and
system/automation activity are not touch evidence. The report does not inspect
note-body meaning and must never be described as a verified successful-client-
communication report. Only reviewed activity kind/state combinations reset a
gap. Unsupported records are counted, excluded from ranking, and make the
affected evidence and report visibly partial.

Exit gate:

- the configuration fails closed unless exactly three unique owners and three
  unique display names are present and both JobNimbus and HCN opaque references
  are ready;
- every eligible file has complete, validated primary-and-related JobNimbus
  activity reads, or the whole report fails closed;
- the configured eligible-file and per-file activity bounds cannot be exceeded
  silently;
- owner ambiguity is visible as a partial report and an explicit exclusion;
- unsupported activity semantics are visible as partial evidence rather than
  being promoted to a verified touch;
- no expired management report remains rendered in the browser;
- Chance Brain, HCN Operations Brain client state, Jobrolo, legacy snapshots,
  advisories, receipts, and all client persistence remain untouched;
- the route has no send, write, call, upload, action-plan, approval, or
  execution authority;
- server syntax, focused management/config/provider/core tests, console static
  tests, and the full `npm run check` suite pass;
- production release remains separately approved and verifies the reviewed
  SHA, live capability manifest, management-role route authorization,
  Chance-only HCN action authorization, JobNimbus readiness, and `no-store`
  behavior.

## Phase 3 — Approval control plane

Current scope: these HCN action and receipt routes remain available only to
Chance's pinned HCN principal. Multi-employee reads and connector links do not
broaden this authority.

Deliverables:

- server-side pending action plans bound to one session and one exact file;
- Approval Inbox showing every material recipient, field, status, note, date,
  body, and attachment before execution;
- one-use approve-and-execute flow over the existing action-batch engine;
- durable metadata-only receipts bound to Chance's pinned Google subject so
  reconciliation survives browser-session expiry, logout, and bridge restart;
- fresh-provider readback with explicit pending-verification outcomes;
- reconciliation workflow for partial or uncertain outcomes.

Exit gate:

- changing any material payload invalidates the plan and approval;
- challenges and provider credentials never enter browser JavaScript;
- an `executing` receipt is durably recorded before any provider effect, and
  internal receipt-principal bindings never enter browser responses;
- expired, consumed, partial, stale, and uncertain executions cannot be blindly
  retried;
- all sends, writes, calendar changes, uploads, calls, and financial actions
  remain explicitly approved at action time;
- no non-Chance HCN role can prepare, list, read, invalidate, execute, or read
  receipts for an HCN action plan.

## Phase 4 — Device and agent operations

Deliverables:

- separate HP and Mac operator identities;
- Windows DPAPI and macOS Keychain credential storage;
- owner-approved device pairing and immediate revocation;
- agent proposal inbox in which Codex can prepare but cannot self-approve;
- capability and plugin-version parity reporting per device.

Exit gate:

- no shared bridge token is used for routine operation;
- revoking one device does not affect another;
- every proposal and execution identifies its originating device and approving
  session without exposing credential material.

## Phase 5 — Proactive operations

Deliverables:

- background read-only refresh and stale-source detection;
- safe alerts for missing facts, follow-up due, source failure, and
  reconciliation required;
- independent HCN Operations Brain storage for coded work state only;
- an encrypted store under `HCN_THRESHER_STORE_PATH` using a dedicated
  `HCN_THRESHER_STORE_KEY`, a distinct `HCN_THRESHER_REFERENCE_KEY`, and a
  separately reserved `HCN_THRESHER_SIGNING_KEY`;
- retention, backup, and recovery specific to HCN Operations.

Exit gate:

- proactive workers have no send, write, call, upload, approval, or financial
  authority;
- every finding links to fresh evidence and a versioned deterministic rule;
- raw message bodies, transcripts, documents, client PII, and provider
  credentials are absent from HCN Operations Brain;
- startup fails closed if any Thresher key is missing, malformed, or reused
  from another HCN/provider/system credential;
- disabling HCN Operations leaves all provider systems intact.

## Future phase — Measured system-of-record migration

This phase is not implemented or authorized. HCN may replace JobNimbus as the
client system of record only after all of the following exist and pass a
separately approved pilot:

- a reviewed HCN client-data model, retention policy, backup, restore, export,
  deletion, and legal/audit controls;
- measured feature and data coverage for every production workflow being
  migrated;
- deterministic import with field-level provenance and rejection reporting;
- a dual-read comparison period against fresh JobNimbus records with explicit
  mismatch thresholds;
- a controlled dual-write or event-reconciliation plan that cannot silently
  diverge;
- user acceptance, performance, availability, support, and disaster-recovery
  evidence;
- a documented rollback that restores JobNimbus authority without data loss;
  and
- separate approvals for migration scope, production credentials, data copy,
  cutover, and retirement.

Until that exit gate is met, HCN remains the main employee interface while
JobNimbus remains authoritative. Interface adoption is not proof of database
parity and must never be treated as permission to stop JobNimbus readback or
retention.

## Release discipline

Each phase is developed and verified locally, committed separately, and
reviewed before production. Push, merge, deployment, credential creation,
Render environment changes, persistent-store provisioning, and legacy purge
are separate action-time approvals. A production release is not complete until
the deployed SHA, live capability manifest, authentication identity, connector
readiness, and exact release gates match the reviewed build.
