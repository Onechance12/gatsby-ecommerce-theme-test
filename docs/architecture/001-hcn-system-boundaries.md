# ADR 001: Permanent HCN System Boundaries

- Status: Accepted and enforced on HCN operational surfaces; legacy-v1 storage
  quarantine remediation pending
- Decision date: 2026-07-28
- Applies to: Home Claim Network bridge, operator clients, Work Center,
  Thresher, and HCN Operations Brain

## Decision

Chance Brain, HCN Operations Brain, and Jobrolo are three independent systems.
This separation is permanent. They must never share:

- storage, databases, tables, object buckets, disks, or filesystem roots;
- credentials, signing keys, bearer tokens, OAuth grants, service accounts, or
  device identities;
- application routes, administrative routes, webhooks, queues, or workers;
- source imports, runtime modules, packages, schemas, or deployment artifacts;
- backups, snapshots, archives, exports, restore targets, or retention jobs;
- memories, embeddings, vector indexes, advisory context, episodes, receipts,
  client snapshots, or learned state.

There is no synchronization, federation, migration, fallback, or
"temporarily shared" path between the three systems.

## Current implementation state

The HCN/JobNimbus operational surface follows this decision now. Its route
registry, employee/operator capabilities, console, and GPT tool schema expose
no Chance Brain or legacy-client-memory operation. Reviews and sweeps begin
with fresh authorized provider evidence. There is no fallback to Chance Brain.

Legacy-v1 client-memory code and stored files may still exist as quarantined
historical artifacts pending a separately reviewed privacy-remediation
project. They are not runtime evidence, not migration input, and not reachable
through HCN, JobNimbus tools, Custom GPT actions, or local operators. This
boundary change does not inspect, alter, migrate, or purge those files.

The isolated HCN Operations Brain currently has minimized contracts, opaque
references, and deterministic Thresher rule foundations. Dedicated operational
persistence is not active yet. Runtime metadata and the console must say
`foundation_persistence_pending`; they must not represent the foundation as a
working persistent brain.

## System ownership

### Chance Brain

Chance Brain is private personal and cross-agent infrastructure. It is not an
HCN client system and is not an operational dependency of the bridge. The HCN
bridge and its HP or Mac operators may not read or write Chance Brain client
snapshots, episodes, receipts, operational state, advisory payloads, memories,
or credentials.

### HCN Operations Brain

HCN Operations Brain is the only permitted future operational state layer for
Home Claim Network. Its planned scope is deliberately narrow:

- coded Work Center state;
- versioned Thresher rule evaluations;
- opaque references to fresh source evidence;
- freshness, provenance, and reconciliation metadata;
- exact approval-plan and execution-receipt references.

It does not become a second CRM. JobNimbus, Gmail, Quo, Google Calendar, Retell,
and document providers remain authoritative for their live records. HCN
Operations Brain stores no raw email or text bodies, snippets, transcripts,
documents, client names, property addresses, phone numbers, email addresses,
policy values, or claim values.

Its future encrypted store, opaque references, and cross-process signatures
use separate `HCN_THRESHER_STORE_KEY`, `HCN_THRESHER_REFERENCE_KEY`, and
`HCN_THRESHER_SIGNING_KEY` material. Those keys cannot be reused from another
HCN subsystem, provider, Chance Brain, legacy memory, or Jobrolo. The server
validates this isolated path/key foundation and fails closed on partial,
malformed, escaped, or reused configuration. It does not activate Thresher
state reads or writes and therefore does not claim active persistence.

### Jobrolo

Jobrolo is a separate commercial CRM product. It is not an HCN bridge module,
data source, fallback, prototype database, or shared library. HCN code may not
import from Jobrolo, and Jobrolo code may not import from HCN. Similar business
concepts must be implemented independently behind each product's own contracts,
credentials, storage, tests, releases, and backups.

## Allowed HCN data flow

The only permitted HCN operational flow is below. Steps 1 through 4 exist in
the current read-only foundation. Steps 5 through 8 require the isolated
persistence and approval-control phases and are not current employee
capabilities:

1. A device-specific HCN operator identity requests fresh evidence.
2. The HCN bridge reads an authorized provider.
3. Provider data is minimized into a versioned HCN contract containing coded
   state, opaque references, provenance, and freshness.
4. Thresher evaluates only those minimized observations.
5. HCN Operations Brain records minimized work state and rule outcomes.
6. A consequential action is represented by an exact, approval-gated command.
7. The bridge executes through the authorized provider connector and records a
   minimized receipt reference.
8. Fresh provider readback reconciles the outcome.

Neither Chance Brain nor Jobrolo participates in this flow.

## Isolation invariants

The following invariants are release blockers:

1. Every HCN v2 record declares `systemId: "hcn_operations"` and an opaque HCN
   tenant identifier.
2. Nested subjects, provenance, observations, work items, rule evaluations, and
   API envelopes must have the same system and tenant.
3. Contracts reject unknown fields and raw personal or client content.
4. Facts without provenance and freshness are invalid.
5. Free-text summaries, notes, titles, explanations, prompts, message bodies,
   and document content are not part of persistent HCN v2 contracts.
6. Provider record identifiers are converted to opaque references before
   entering HCN Operations Brain.
7. Advisory models cannot execute actions or silently promote advice into fact.
8. Fresh source evidence wins over HCN state.
9. Provider credentials remain server-side. Each operator device receives its
   own revocable, least-privilege HCN credential.
10. Backups and disaster recovery remain system-specific and cannot restore
    into another system.

Automated contract tests must fail closed when an invariant is violated.

## Legacy v1 handling

Legacy v1 client snapshots are untrusted and unreachable. They are not a
migration source for HCN Operations Brain. Until a separately reviewed privacy
process exists:

- no legacy snapshot, receipt, operational-state, advisory, or context reads;
- no new legacy snapshot or advisory writes;
- no HCN employee, GPT, or local operator access to legacy contents;
- no copying, indexing, embedding, replaying, or importing legacy contents;
- metadata-only inventory may include path classification, counts, sizes, and
  timestamps, but no client content;
- HCN v2 starts from fresh provider evidence;
- quarantine and purge are separate consequential operations, each requiring
  exact targets, a dry run, and explicit action-time approval.

Approval, OAuth, action, claim, and receipt ledgers are not legacy client
snapshots and must never be included in a legacy purge.

## Enforcement

This decision must be enforced in several independent layers:

- repository and dependency checks prevent cross-system imports;
- production packaging excludes quarantined legacy-memory code and data while
  leaving the local artifacts untouched for a separately approved remediation;
- deployment configuration assigns a new HCN-only physical disk, backup
  boundary, and credentials; a different directory on a legacy/shared disk is
  not isolation;
- route authorization exposes only HCN capabilities to HCN identities;
- the advertised capability registry and GPT schema contain no Chance Brain or
  legacy-memory route;
- v2 contracts validate exact fields, safe enums, system identity, tenant
  consistency, opaque references, provenance, and freshness;
- logs and telemetry contain request IDs and coded outcomes, not raw client
  content;
- backup policy names an exact system-specific source and restore target;
- tests use synthetic identifiers and never live client data.

Any proposal to weaken an isolation invariant requires a new architecture
decision. Convenience, feature parity, incident response, or migration speed is
not sufficient justification for crossing the boundary.
