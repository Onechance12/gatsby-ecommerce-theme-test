import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mapJobNimbusFileEnvelope } from "../hcn-console/provider-mappers.js";
import { createHcnReferenceFactory } from "../hcn-ops/references.js";
import {
  JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_PATTERN,
  JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_SCHEMA,
  JobNimbusImportSnapshotAdapterError,
  adaptJobNimbusFileEnvelopeToImportSnapshot,
  issueJobNimbusImportReferences,
  projectJobNimbusDocumentManifest,
  projectJobNimbusFileEnvelopeToImportSnapshot
} from "./jobrolo-import-snapshot.js";
import { stableCanonicalJson } from "./jobrolo-service-auth.js";

const OWNER_ID = "private-assigned-owner-id";
const RAW_FILE_ID = "raw-jobnimbus-file-1";
const RAW_ACTIVITY_ID = "raw-jobnimbus-activity-1";
const RAW_TASK_ID = "raw-jobnimbus-task-1";
const RAW_DOCUMENT_ID = "raw-jobnimbus-document-1";

const CONNECTION_REF = "connection_cccccccccccccccccccccccccccccccc";
const FILE_REF = "subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTIVITY_REF = "ref_11111111111111111111111111111111";
const TASK_REF = "ref_22222222222222222222222222222222";
const DOCUMENT_REF = "ref_33333333333333333333333333333333";

// Literal compatibility vector duplicated intentionally from the Jobrolo
// jobrolo.jobnimbus-import.snapshot.v1 contract tests. Changing either side
// independently must break this gate.
const GOLDEN_JOBNIMBUS_SNAPSHOT_WIRE_V1 = '{"activities":{"completeness":"complete","duplicateItemsRemoved":0,"items":[{"actorRole":"employee","kind":"status_change","label":"Carrier review opened","occurredAt":"2026-08-08T14:30:00.000Z","sourceRecordRef":"ref_11111111111111111111111111111111","state":"complete"}],"limitationCode":null,"returnedItems":1},"asOf":"2026-08-08T15:00:00.000Z","checkedAt":"2026-08-08T15:01:00.000Z","documents":{"completeness":"complete","duplicateItemsRemoved":0,"items":[{"createdAt":"2026-08-08T14:45:00.000Z","fileName":"Carrier settlement estimate.pdf","kind":"settlement_estimate","reviewState":"needs_review","sourceRecordRef":"ref_33333333333333333333333333333333"}],"limitationCode":null,"returnedItems":1},"file":{"adjusterEmail":"adjuster@carrier.example","adjusterName":"Taylor Adjuster","adjusterPhone":"(555) 555-0130","assignmentVerified":true,"carrierName":"Example Carrier","claimNumber":"CLAIM-100","damageFactsPresent":true,"dateOfLoss":"2026-05-17","displayName":"Fixture Homeowner","fileTypeCode":"insurance","isActive":true,"isInsuranceFile":true,"jobNumber":"JN-2739","missingFacts":{"adjuster":false,"claimNumber":false,"dateOfLoss":false,"policyNumber":false},"nextAppointmentAt":"2026-08-09T14:00:00.000Z","policyNumber":"POLICY-100","primaryEmail":"owner@example.test","primaryPhone":"(555) 555-0101","propertyAddress":"100 Private Street, Example TX 75001","sourceFileRef":"subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","stageCode":"carrier_review","statusCode":"ready_for_review","updatedAt":"2026-08-08T14:58:00.000Z"},"schema":"jobrolo.jobnimbus-import.snapshot.v1","source":{"complete":true,"connectionRef":"connection_cccccccccccccccccccccccccccccccc","scope":"assigned","system":"jobnimbus"},"sourceFileRef":"subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tasks":{"completeness":"complete","duplicateItemsRemoved":0,"items":[{"assignedRole":"employee","dueAt":"2026-08-10T14:00:00.000Z","kind":"task","label":"Review settlement","priority":"urgent","sourceRecordRef":"ref_22222222222222222222222222222222","status":"open"}],"limitationCode":null,"returnedItems":1},"validUntil":"2026-08-08T15:11:00.000Z"}';
const GOLDEN_JOBNIMBUS_SNAPSHOT_SHA256_V1 =
  "042101b2a9f7e8a11c60f39c7db6319e888f031bc7e0ed3fc5a074a6678ef04d";

function rawProviderInput() {
  const scoped = (record) => ({
    ...record,
    primary: { id: RAW_FILE_ID }
  });
  return {
    asOf: "2026-08-08T15:00:00.000Z",
    checkedAt: "2026-08-08T15:01:00.000Z",
    validUntil: "2026-08-08T15:11:00.000Z",
    pagination: {
      activities: true,
      tasks: true,
      documents: true
    },
    contact: {
      jnid: RAW_FILE_ID,
      number: "JN-2739",
      record_type_name: "Insurance",
      owners: [{ id: OWNER_ID }],
      display_name: "Fixture Homeowner",
      status_name: "Ready for Review",
      stage_name: "Carrier Review",
      is_active: true,
      date_updated: "2026-08-08T14:58:00.000Z",
      next_appointment_at: "2026-08-09T14:00:00.000Z",
      email: "OWNER@EXAMPLE.TEST",
      mobile_phone: "(555) 555-0101",
      address_line1: "100 Private Street",
      city: "Example",
      state_text: "TX",
      zip: "75001",
      "Insurance Company": "Example Carrier",
      "Claim #": "CLAIM-100",
      "Policy #": "POLICY-100",
      "Date of Loss": "2026-05-17",
      "Damage Summary": "Roof and interior damage documented",
      "Carrier DA": "Taylor Adjuster",
      "Carrier DA Contact #": "(555) 555-0130",
      "Carrier DA Email": "ADJUSTER@CARRIER.EXAMPLE",
      rawContactSecret: "DO-NOT-EMIT-CONTACT"
    },
    activities: [scoped({
      jnid: RAW_ACTIVITY_ID,
      activity_type: "Status Change",
      status_name: "Complete",
      occurred_at: "2026-08-08T14:30:00.000Z",
      actor_role: "Employee",
      label: "Carrier review opened",
      body: "DO-NOT-EMIT-ACTIVITY"
    })],
    tasks: [scoped({
      jnid: RAW_TASK_ID,
      task_type: "Task",
      status_name: "Open",
      priority_name: "Urgent",
      due_at: "2026-08-10T14:00:00.000Z",
      assigned_role: "Employee",
      label: "Review settlement",
      body: "DO-NOT-EMIT-TASK"
    })],
    documents: [scoped({
      jnid: RAW_DOCUMENT_ID,
      filename: "Carrier settlement estimate.pdf",
      content_type: "application/pdf",
      status_name: "New",
      created_at: "2026-08-08T14:45:00.000Z",
      downloadUrl: "https://provider.invalid/private-download",
      bytes: "DO-NOT-EMIT-BYTES"
    })]
  };
}

function normalizedProviderEnvelope() {
  return mapJobNimbusFileEnvelope(rawProviderInput(), {
    assignedOwnerId: OWNER_ID,
    expectedProviderFileId: RAW_FILE_ID
  });
}

function goldenReferences() {
  return {
    connectionRef: CONNECTION_REF,
    sourceFileRef: FILE_REF,
    activities: [ACTIVITY_REF],
    tasks: [TASK_REF],
    documents: [DOCUMENT_REF]
  };
}

function adapterError(code) {
  return (error) => {
    assert.equal(error instanceof JobNimbusImportSnapshotAdapterError, true);
    assert.equal(error.code, code);
    return true;
  };
}

test("literal Jobrolo snapshot wire and SHA-256 match the cross-repo v1 golden", () => {
  const providerEnvelope = normalizedProviderEnvelope();
  const snapshot = projectJobNimbusFileEnvelopeToImportSnapshot(
    providerEnvelope,
    goldenReferences()
  );
  const wire = stableCanonicalJson(snapshot);
  const digest = createHash("sha256").update(wire, "utf8").digest("hex");

  assert.equal(wire, GOLDEN_JOBNIMBUS_SNAPSHOT_WIRE_V1);
  assert.equal(Buffer.byteLength(wire, "utf8"), 2_119);
  assert.equal(
    Buffer.byteLength(GOLDEN_JOBNIMBUS_SNAPSHOT_WIRE_V1, "utf8"),
    2_119
  );
  assert.equal(digest, GOLDEN_JOBNIMBUS_SNAPSHOT_SHA256_V1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.file), true);
  assert.equal(Object.isFrozen(snapshot.documents.items), true);
  assert.equal(snapshot.source.scope, "assigned");
  assert.equal(snapshot.source.complete, true);
  assert.equal(snapshot.file.assignmentVerified, true);

  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    OWNER_ID,
    RAW_FILE_ID,
    RAW_ACTIVITY_ID,
    RAW_TASK_ID,
    RAW_DOCUMENT_ID,
    "providerRecordId",
    "assignedToCurrentUser",
    "assignedToChance",
    "DO-NOT-EMIT",
    "provider.invalid",
    "downloadUrl",
    "content_type",
    "bytes",
    "thresher"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("provider label truncation cannot leave adapter-invalid edge whitespace", () => {
  const input = rawProviderInput();
  input.activities[0].label = `${"x".repeat(159)} trailing words`;

  const providerEnvelope = mapJobNimbusFileEnvelope(input, {
    assignedOwnerId: OWNER_ID,
    expectedProviderFileId: RAW_FILE_ID
  });
  const mappedLabel = providerEnvelope.data.activities[0].label;

  assert.equal(Array.from(mappedLabel).length <= 160, true);
  assert.equal(mappedLabel, "x".repeat(159));
  assert.equal(mappedLabel, mappedLabel.trim());

  const snapshot = projectJobNimbusFileEnvelopeToImportSnapshot(
    providerEnvelope,
    goldenReferences()
  );
  assert.equal(snapshot.activities.items[0].label, mappedLabel);
});

test("adapter mirrors the Jobrolo normalized ASCII email v1 language", () => {
  assert.equal(
    JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_SCHEMA,
    "jobrolo.jobnimbus-import.normalized-email.v1"
  );
  const accepted = [
    "a.b+tag@example-domain.co",
    "x@y.example",
    "claims_1@subdomain.example.test"
  ];
  const rejected = [
    ".foo@example.com",
    "foo.@example.com",
    "foo..bar@example.com",
    "Foo@example.com",
    "foo@example",
    "foo@-example.com",
    "foo@example-.com",
    "foo@example.c",
    "fóo@example.com",
    `${"a".repeat(65)}@example.com`,
    `a@${"b".repeat(64)}.example`,
    "a@example.123"
  ];

  for (const email of accepted) {
    assert.equal(JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_PATTERN.test(email), true);
    const providerEnvelope = structuredClone(normalizedProviderEnvelope());
    providerEnvelope.data.file.primaryEmail = email;
    assert.doesNotThrow(() =>
      projectJobNimbusFileEnvelopeToImportSnapshot(
        providerEnvelope,
        goldenReferences()
      )
    );
  }

  for (const email of rejected) {
    assert.equal(JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_PATTERN.test(email), false);
    const providerEnvelope = structuredClone(normalizedProviderEnvelope());
    providerEnvelope.data.file.primaryEmail = email;
    assert.throws(
      () => projectJobNimbusFileEnvelopeToImportSnapshot(
        providerEnvelope,
        goldenReferences()
      ),
      adapterError("invalid_provider_envelope")
    );
  }

  const permissiveProducerEnvelope = rawProviderInput();
  permissiveProducerEnvelope.contact.email = "foo..bar@example.com";
  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      mapJobNimbusFileEnvelope(permissiveProducerEnvelope, {
        assignedOwnerId: OWNER_ID,
        expectedProviderFileId: RAW_FILE_ID
      }),
      goldenReferences()
    ),
    adapterError("invalid_provider_envelope")
  );
});

test("existing HCN reference factory issues tenant-scoped refs without leaking raw ids", () => {
  const providerEnvelope = normalizedProviderEnvelope();
  const referenceFactory = createHcnReferenceFactory({
    hmacKey: Buffer.alloc(32, 0x4a),
    tenantId: "tenant_0123456789abcdef"
  });
  const options = {
    connectionRef: "connection_dddddddddddddddddddddddddddddddd",
    referenceFactory
  };
  const issued = issueJobNimbusImportReferences(providerEnvelope, options);
  const first = adaptJobNimbusFileEnvelopeToImportSnapshot(
    providerEnvelope,
    options
  );
  const second = adaptJobNimbusFileEnvelopeToImportSnapshot(
    structuredClone(providerEnvelope),
    options
  );

  assert.match(issued.sourceFileRef, /^subject_[a-f0-9]{32}$/);
  for (const ref of [
    ...issued.activities,
    ...issued.tasks,
    ...issued.documents
  ]) {
    assert.match(ref, /^ref_[a-f0-9]{32}$/);
  }
  assert.deepEqual(first, second);
  assert.equal(
    JSON.stringify({ issued, first }).includes(RAW_FILE_ID),
    false
  );
});

test("document manifest projection freezes exact metadata and opaque authority", () => {
  const providerEnvelope = normalizedProviderEnvelope();
  const referenceFactory = createHcnReferenceFactory({
    hmacKey: Buffer.alloc(32, 0x4a),
    tenantId: "tenant_0123456789abcdef"
  });
  const manifest = projectJobNimbusDocumentManifest(
    providerEnvelope.data.documents[0],
    { sourceFileRef: FILE_REF, referenceFactory }
  );
  assert.deepEqual(Object.keys(manifest), [
    "schema",
    "sourceFileRef",
    "document"
  ]);
  assert.equal(
    manifest.schema,
    "jobrolo.jobnimbus-import.document-manifest.v1"
  );
  assert.equal(manifest.sourceFileRef, FILE_REF);
  assert.match(manifest.document.sourceRecordRef, /^ref_[a-f0-9]{32}$/);
  assert.deepEqual(
    Object.keys(manifest.document),
    ["sourceRecordRef", "kind", "reviewState", "createdAt", "fileName"]
  );
  assert.equal(Object.isFrozen(manifest.document), true);
  const serialized = stableCanonicalJson(manifest);
  assert.doesNotMatch(serialized, /raw-jobnimbus|providerRecordId|downloadUrl/);
});

test("adapter rejects raw or unsupported fields at every normalized boundary", () => {
  const providerEnvelope = normalizedProviderEnvelope();
  const hostileCases = [
    (value) => { value.rawProviderPayload = {}; },
    (value) => { value.data.rawProviderPayload = {}; },
    (value) => { value.data.file.providerFileIdAlias = RAW_FILE_ID; },
    (value) => { value.data.activities[0].rawBody = "private"; },
    (value) => { value.data.tasks[0].customer = { id: RAW_FILE_ID }; },
    (value) => { value.data.documents[0].downloadUrl = "https://private"; },
    (value) => { value.data.documents[0].bytes = Buffer.from("private"); }
  ];

  for (const mutate of hostileCases) {
    const hostile = structuredClone(providerEnvelope);
    mutate(hostile);
    assert.throws(
      () => projectJobNimbusFileEnvelopeToImportSnapshot(
        hostile,
        goldenReferences()
      ),
      adapterError("invalid_provider_envelope")
    );
  }
});

test("adapter fails closed on partial coverage, unverified assignment, and bad refs", () => {
  const staleObservation = structuredClone(normalizedProviderEnvelope());
  staleObservation.asOf = "2026-08-08T14:45:59.999Z";
  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      staleObservation,
      goldenReferences()
    ),
    adapterError("invalid_freshness")
  );

  const futureVersion = structuredClone(normalizedProviderEnvelope());
  futureVersion.data.file.updatedAt = "2026-08-08T15:01:00.001Z";
  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      futureVersion,
      goldenReferences()
    ),
    adapterError("invalid_source_version")
  );

  const partial = structuredClone(normalizedProviderEnvelope());
  partial.data.collectionCoverage.activities.completeness = "partial";
  partial.data.collectionCoverage.activities.limitationCode =
    "incomplete_pagination";
  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      partial,
      goldenReferences()
    ),
    adapterError("incomplete_provider_snapshot")
  );

  const countMismatch = structuredClone(normalizedProviderEnvelope());
  countMismatch.data.collectionCoverage.tasks.returnedItems = 2;
  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      countMismatch,
      goldenReferences()
    ),
    adapterError("inconsistent_collection_coverage")
  );

  const unassigned = structuredClone(normalizedProviderEnvelope());
  unassigned.data.file.assignedToCurrentUser = false;
  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      unassigned,
      goldenReferences()
    ),
    adapterError("assignment_not_verified")
  );

  const rawRefs = {
    ...goldenReferences(),
    sourceFileRef: RAW_FILE_ID
  };
  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      normalizedProviderEnvelope(),
      rawRefs
    ),
    adapterError("invalid_opaque_references")
  );

  const duplicateRefs = {
    ...goldenReferences(),
    tasks: [ACTIVITY_REF]
  };
  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      normalizedProviderEnvelope(),
      duplicateRefs
    ),
    adapterError("duplicate_opaque_reference")
  );
});

test("reference issuer rejects hostile factories without reflecting private ids", () => {
  const providerEnvelope = normalizedProviderEnvelope();
  const rawReturningFactory = {
    subjectId: (_source, providerId) => providerId,
    sourceRecordRef: (_source, providerId) => providerId
  };
  assert.throws(
    () => issueJobNimbusImportReferences(providerEnvelope, {
      connectionRef: CONNECTION_REF,
      referenceFactory: rawReturningFactory
    }),
    adapterError("invalid_opaque_references")
  );

  const rawThrowingFactory = {
    subjectId: () => {
      throw new Error(`Private provider id: ${RAW_FILE_ID}`);
    },
    sourceRecordRef: () => ACTIVITY_REF
  };
  assert.throws(
    () => issueJobNimbusImportReferences(providerEnvelope, {
      connectionRef: CONNECTION_REF,
      referenceFactory: rawThrowingFactory
    }),
    (error) => {
      assert.equal(error.code, "reference_issue_failed");
      assert.equal(error.message.includes(RAW_FILE_ID), false);
      return true;
    }
  );
});

test("complete but oversized canonical snapshots are rejected", () => {
  const providerEnvelope = structuredClone(normalizedProviderEnvelope());
  const wideLabel = "\u0800".repeat(160);
  const refs = {
    connectionRef: CONNECTION_REF,
    sourceFileRef: FILE_REF,
    activities: [],
    tasks: [],
    documents: []
  };

  providerEnvelope.data.activities = Array.from({ length: 500 }, (_, index) => {
    refs.activities.push(`ref_${index.toString(16).padStart(32, "0")}`);
    return {
      ...providerEnvelope.data.activities[0],
      providerRecordId: `activity-${index}`,
      label: wideLabel
    };
  });
  providerEnvelope.data.tasks = Array.from({ length: 500 }, (_, index) => {
    refs.tasks.push(`ref_${(index + 500).toString(16).padStart(32, "0")}`);
    return {
      ...providerEnvelope.data.tasks[0],
      providerRecordId: `task-${index}`,
      label: wideLabel
    };
  });
  providerEnvelope.data.documents = Array.from(
    { length: 500 },
    (_, index) => {
      refs.documents.push(
        `ref_${(index + 1000).toString(16).padStart(32, "0")}`
      );
      return {
        ...providerEnvelope.data.documents[0],
        providerRecordId: `document-${index}`,
        fileName: `${"\u0800".repeat(150)}-${index}.pdf`
      };
    }
  );
  for (const collection of ["activities", "tasks", "documents"]) {
    providerEnvelope.data.collectionCoverage[collection] = {
      completeness: "complete",
      returnedItems: 500,
      duplicateItemsRemoved: 0,
      limitationCode: null
    };
  }

  assert.throws(
    () => projectJobNimbusFileEnvelopeToImportSnapshot(
      providerEnvelope,
      refs
    ),
    adapterError("snapshot_bounds_exceeded")
  );
});

test("adapter source remains pure and offline", async () => {
  const source = await readFile(
    new URL("./jobrolo-import-snapshot.js", import.meta.url),
    "utf8"
  );
  for (const forbidden of [
    /process\.env/,
    /\bfetch\s*\(/,
    /\bserver\b.*from/,
    /\bdatabase\b.*from/,
    /\bprisma\b/i,
    /downloadUrl\s*:/,
    /documentBytes\s*:/,
    /thresher/i
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
