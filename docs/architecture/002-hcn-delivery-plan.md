# HCN Operations Platform Delivery Plan

- Status: Active
- Owner: Home Claim Network
- Started: 2026-07-28
- Production system of record: JobNimbus bridge

## Product outcome

Home Claim Network will have one operational layer over JobNimbus, Gmail, Quo,
Google Calendar, Retell, and document evidence:

- a responsive HCN Operations Console for HP, Mac, and mobile;
- Codex operators with distinct, revocable device identities;
- a fresh-evidence Work Center and exact-file workspace;
- deterministic Thresher findings with explicit provenance and freshness;
- exact action plans, one-use approval, execution receipts, and readback
  reconciliation.

JobNimbus and the connected providers remain authoritative. The HCN layer
organizes work and safely coordinates actions; it does not replace the CRM.
Chance Brain and Jobrolo remain permanently disconnected as defined in
ADR 001.

## Phase 0 — Boundary and runtime truth

Deliverables:

- HCN v2 minimized contracts and opaque references;
- build SHA and runtime attestation;
- versioned capability manifest and configuration-drift reporting;
- explicit runtime boundary metadata;
- legacy client-memory writes disabled by default.

Exit gate:

- contract and boundary tests pass;
- the deployed build can be identified without inference;
- runtime metadata never claims full legacy isolation while a legacy read path
  remains.

## Phase 1 — Secure console foundation

Deliverables:

- responsive installable console shell at `/hcn/`;
- exact-origin Google Workspace login with PKCE;
- opaque Secure, HttpOnly, host-only browser sessions;
- exact-origin and session-bound CSRF enforcement;
- production-pinned Google endpoints and bounded provider responses;
- pre-allocation login admission control;
- immutable Google account subject pin for Chance;
- shell-only service-worker caching with no client-data storage.

Exit gate:

- independent security review has no release blocker;
- employee GPT OAuth remains compatible;
- no JobNimbus, Gmail, Quo, send, write, call, upload, or action authority is
  available to the foundation session;
- a restart safely signs out all sessions while the store is in-memory.

## Phase 2 — Fresh read-only Work Center

Deliverables:

- a Chance-only Work Center containing active, Chance-assigned insurance files;
- exact-file selection by opaque HCN reference rather than provider ID;
- bounded presentation DTOs for file facts, tasks, activities, documents,
  Gmail evidence, and Quo evidence;
- coded priority, today, waiting, source-failure, and missing-fact lanes;
- visible per-source freshness and incomplete states;
- no legacy-memory, Chance Brain, Jobrolo, advisory, or persistence path.

Exit gate:

- JobNimbus pagination proves completeness or fails closed;
- forged, inactive, unassigned, or ambiguous files disclose nothing;
- required JobNimbus failure returns a sanitized failure;
- optional Gmail or Quo failure returns an explicit incomplete state and no
  stale fallback;
- no raw provider identifiers, tokens, provider errors, or `rawContact` cross
  the console API;
- seeded legacy canaries remain byte-for-byte and timestamp unchanged.

## Phase 3 — Approval control plane

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
  remain explicitly approved at action time.

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
- retention, backup, and recovery specific to HCN Operations.

Exit gate:

- proactive workers have no send, write, call, upload, approval, or financial
  authority;
- every finding links to fresh evidence and a versioned deterministic rule;
- raw message bodies, transcripts, documents, client PII, and provider
  credentials are absent from HCN Operations Brain;
- disabling HCN Operations leaves all provider systems intact.

## Release discipline

Each phase is developed and verified locally, committed separately, and
reviewed before production. Push, merge, deployment, credential creation,
Render environment changes, persistent-store provisioning, and legacy purge
are separate action-time approvals. A production release is not complete until
the deployed SHA, live capability manifest, authentication identity, connector
readiness, and exact release gates match the reviewed build.
