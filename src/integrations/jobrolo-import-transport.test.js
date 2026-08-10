import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { mapJobNimbusFileEnvelope } from "../hcn-console/provider-mappers.js";
import {
  canonicalJson
} from "./jobrolo-import-service-auth.js";
import {
  createJobroloImportReadService,
  JOBROLO_IMPORT_CATALOG_SCHEMA
} from "./jobrolo-import-transport.js";

const OWNER_ID = "private-assigned-owner-id";
const RAW_FILE_ID = "raw-jobnimbus-file-1";
const RAW_ACTIVITY_ID = "raw-jobnimbus-activity-1";
const RAW_TASK_ID = "raw-jobnimbus-task-1";
const RAW_DOCUMENT_ID = "raw-jobnimbus-document-1";
const CONNECTION_REF = "connection_cccccccccccccccccccccccccccccccc";
const FILE_REF = "subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-08-08T15:02:00.000Z");
const GOLDEN_SNAPSHOT_SHA =
  "042101b2a9f7e8a11c60f39c7db6319e888f031bc7e0ed3fc5a074a6678ef04d";

// Cross-repository catalog vector. It is intentionally literal so a field,
// nullability, sorting, or schema change cannot silently drift either client.
const GOLDEN_CATALOG_WIRE_V1 = '{"asOf":"2026-08-08T15:00:00.000Z","checkedAt":"2026-08-08T15:01:00.000Z","items":[{"displayName":"Fixture Homeowner","jobNumber":"JN-2739","sourceFileRef":"subject_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","stageCode":"carrier_review","statusCode":"ready_for_review","updatedAt":"2026-08-08T14:58:00.000Z"}],"returnedItems":1,"schema":"jobrolo.jobnimbus-import.catalog.v1","source":{"complete":true,"connectionRef":"connection_cccccccccccccccccccccccccccccccc","scope":"assigned","system":"jobnimbus"},"validUntil":"2026-08-08T15:11:00.000Z"}';
const GOLDEN_CATALOG_SHA_V1 =
  "206a18ee8c97187b89204c5fbeb537a13ac90517c8d0ab73168b271673ead22e";

function indexEnvelope(overrides = {}) {
  const { data: dataOverrides = {}, ...envelopeOverrides } = overrides;
  return {
    status: "ok",
    asOf: "2026-08-08T15:00:00.000Z",
    checkedAt: "2026-08-08T15:01:00.000Z",
    validUntil: "2026-08-08T15:11:00.000Z",
    data: {
      complete: true,
      files: [{
        providerFileId: RAW_FILE_ID,
        jobNumber: "JN-2739",
        displayName: "Fixture Homeowner",
        statusCode: "ready_for_review",
        stageCode: "carrier_review",
        fileTypeCode: "insurance",
        isInsuranceFile: true,
        isActive: true,
        assignedToCurrentUser: true,
        updatedAt: "2026-08-08T14:58:00.000Z",
        missingFacts: {
          claimNumber: false,
          policyNumber: false,
          dateOfLoss: false,
          adjuster: false
        }
      }],
      ...dataOverrides
    },
    ...envelopeOverrides
  };
}

function rawFileEnvelope(dateOfLoss = "2026-05-17") {
  const primaryScoped = (record) => ({
    ...record,
    primary: { id: RAW_FILE_ID }
  });
  const relatedScoped = (record) => ({
    ...record,
    related: { id: RAW_FILE_ID }
  });
  return mapJobNimbusFileEnvelope({
    asOf: "2026-08-08T15:00:00.000Z",
    checkedAt: "2026-08-08T15:01:00.000Z",
    validUntil: "2026-08-08T15:11:00.000Z",
    activitiesComplete: true,
    tasksComplete: true,
    documentsComplete: true,
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
      email: "owner@example.test",
      mobile_phone: "(555) 555-0101",
      address_line1: "100 Private Street",
      city: "Example",
      state_text: "TX",
      zip: "75001",
      "Insurance Company": "Example Carrier",
      "Claim #": "CLAIM-100",
      "Policy #": "POLICY-100",
      "Date of Loss": dateOfLoss,
      "Damage Summary": "Roof and interior damage documented",
      "Carrier DA": "Taylor Adjuster",
      "Carrier DA Contact #": "(555) 555-0130",
      "Carrier DA Email": "adjuster@carrier.example"
    },
    activities: [primaryScoped({
      jnid: RAW_ACTIVITY_ID,
      activity_type: "Status Change",
      status_name: "Complete",
      occurred_at: "2026-08-08T14:30:00.000Z",
      actor_role: "Employee",
      label: "Carrier review opened"
    })],
    tasks: [relatedScoped({
      jnid: RAW_TASK_ID,
      task_type: "Task",
      status_name: "Open",
      priority_name: "Urgent",
      due_at: "2026-08-10T14:00:00.000Z",
      assigned_role: "Employee",
      label: "Review settlement"
    })],
    documents: [relatedScoped({
      jnid: RAW_DOCUMENT_ID,
      filename: "Carrier settlement estimate.pdf",
      content_type: "application/pdf",
      status_name: "New",
      created_at: "2026-08-08T14:45:00.000Z"
    })]
  }, {
    assignedOwnerId: OWNER_ID,
    expectedProviderFileId: RAW_FILE_ID,
    knownProviderFileIds: [RAW_FILE_ID]
  });
}

function referenceFactory() {
  return {
    subjectId(system, id) {
      assert.equal(system, "jobnimbus");
      if (id !== RAW_FILE_ID) return `subject_${"b".repeat(32)}`;
      return FILE_REF;
    },
    sourceRecordRef(system, id) {
      assert.equal(system, "jobnimbus");
      return {
        [RAW_ACTIVITY_ID]: `ref_${"1".repeat(32)}`,
        [RAW_TASK_ID]: `ref_${"2".repeat(32)}`,
        [RAW_DOCUMENT_ID]: `ref_${"3".repeat(32)}`
      }[id];
    }
  };
}

function service(overrides = {}) {
  const calls = [];
  const readService = createJobroloImportReadService({
    connectionRef: CONNECTION_REF,
    referenceFactory: overrides.referenceFactory || referenceFactory(),
    now: overrides.now || (() => NOW),
    loadAssignedIndex: async (input) => {
      calls.push({ kind: "index", input });
      return overrides.index || indexEnvelope();
    },
    loadExactFile: async (input) => {
      calls.push({ kind: "file", input });
      if (overrides.fileError) throw overrides.fileError;
      return overrides.file || rawFileEnvelope();
    }
  });
  return { readService, calls };
}

test("catalog literal, SHA, completeness, and opaque projection are stable", async () => {
  const { readService, calls } = service();
  const catalog = await readService.readCatalog();
  const wire = canonicalJson(catalog);
  assert.equal(catalog.schema, JOBROLO_IMPORT_CATALOG_SCHEMA);
  assert.equal(wire, GOLDEN_CATALOG_WIRE_V1);
  assert.equal(
    createHash("sha256").update(wire, "utf8").digest("hex"),
    GOLDEN_CATALOG_SHA_V1
  );
  assert.equal(catalog.source.complete, true);
  assert.equal(catalog.source.scope, "assigned");
  assert.equal(catalog.returnedItems, 1);
  assert.equal(Object.isFrozen(catalog.items), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.maximumContacts, 5_000);
  assert.equal(calls[0].input.maximumEligibleFiles, 500);
  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /raw-jobnimbus|providerFileId|owner-id/);
});

test("selected opaque ref resolves only through a complete assigned catalog", async () => {
  const { readService, calls } = service();
  const snapshot = await readService.readSnapshot({ sourceFileRef: FILE_REF });
  const wire = canonicalJson(snapshot);
  assert.equal(Buffer.byteLength(wire, "utf8"), 2_119);
  assert.equal(
    createHash("sha256").update(wire, "utf8").digest("hex"),
    GOLDEN_SNAPSHOT_SHA
  );
  assert.equal(snapshot.sourceFileRef, FILE_REF);
  assert.equal(snapshot.source.connectionRef, CONNECTION_REF);
  assert.deepEqual(calls.map((call) => call.kind), ["index", "file"]);
  assert.equal(calls[1].input.providerFileId, RAW_FILE_ID);
  assert.equal(calls[1].input.maximumCollectionItems, 500);
  assert.deepEqual(calls[1].input.knownProviderFileIds, [RAW_FILE_ID]);
  for (const forbidden of [
    RAW_FILE_ID,
    RAW_ACTIVITY_ID,
    RAW_TASK_ID,
    RAW_DOCUMENT_ID,
    "providerFileId"
  ]) assert.equal(JSON.stringify(snapshot).includes(forbidden), false);
});

test("positive numeric loss dates keep the catalog and snapshot usable without inventing a civil date", async () => {
  const numericDateOfLoss = 1785261000;
  const base = indexEnvelope().data.files[0];
  const { readService } = service({
    index: indexEnvelope({
      data: {
        files: [{
          ...base,
          missingFacts: {
            ...base.missingFacts,
            dateOfLoss: true
          }
        }]
      }
    }),
    file: rawFileEnvelope(numericDateOfLoss)
  });

  const catalog = await readService.readCatalog();
  assert.equal(catalog.returnedItems, 1);
  assert.equal(catalog.items[0].sourceFileRef, FILE_REF);

  const snapshot = await readService.readSnapshot({ sourceFileRef: FILE_REF });
  assert.equal(snapshot.file.dateOfLoss, null);
  assert.equal(snapshot.file.missingFacts.dateOfLoss, true);
  assert.equal(canonicalJson(catalog).includes(String(numericDateOfLoss)), false);
  assert.equal(canonicalJson(snapshot).includes(String(numericDateOfLoss)), false);
  const shiftedUtcDate = new Date(numericDateOfLoss * 1000)
    .toISOString()
    .slice(0, 10);
  assert.equal(canonicalJson(snapshot).includes(shiftedUtcDate), false);
});

test("unknown or malformed refs never trigger an exact-file read", async () => {
  for (const sourceFileRef of [
    `subject_${"f".repeat(32)}`,
    RAW_FILE_ID,
    "subject_short"
  ]) {
    const { readService, calls } = service();
    await assert.rejects(
      readService.readSnapshot({ sourceFileRef }),
      (error) => {
        assert.equal(
          error.code,
          sourceFileRef === `subject_${"f".repeat(32)}`
            ? "jobrolo_import_source_not_found"
            : "invalid_jobrolo_import_request"
        );
        return true;
      }
    );
    assert.equal(calls.some((call) => call.kind === "file"), false);
  }
});

test("incomplete, stale, over-broad, future-version, and ambiguous indexes fail closed", async () => {
  const cases = [
    indexEnvelope({ data: { complete: false, files: [] } }),
    indexEnvelope({ validUntil: "2026-08-08T15:02:00.000Z" }),
    indexEnvelope({ asOf: "2026-08-08T14:44:59.999Z" }),
    indexEnvelope({ validUntil: "2026-08-08T15:16:00.001Z" }),
    indexEnvelope({
      data: {
        files: [{
          ...indexEnvelope().data.files[0],
          updatedAt: "2026-08-08T15:01:00.001Z"
        }]
      }
    }),
    indexEnvelope({
      data: {
        files: [
          indexEnvelope().data.files[0],
          indexEnvelope().data.files[0]
        ]
      }
    })
  ];
  for (const index of cases) {
    const { readService } = service({ index });
    await assert.rejects(
      readService.readCatalog(),
      /Jobrolo import source is unavailable/
    );
  }
});

test("catalog rejects opaque-ref collisions and more than 500 eligible files", async () => {
  const base = indexEnvelope().data.files[0];
  const collision = indexEnvelope({
    data: {
      files: [base, { ...base, providerFileId: "raw-file-two" }]
    }
  });
  const { readService: collisionService } = service({
    index: collision,
    referenceFactory: {
      ...referenceFactory(),
      subjectId: () => FILE_REF
    }
  });
  await assert.rejects(collisionService.readCatalog());

  const excessive = indexEnvelope({
    data: {
      files: Array.from({ length: 501 }, (_, index) => ({
        ...base,
        providerFileId: `file-${index}`,
        jobNumber: `JN-${index}`
      }))
    }
  });
  const { readService: excessiveService } = service({ index: excessive });
  await assert.rejects(
    excessiveService.readCatalog(),
    (error) => error.code === "jobrolo_import_bounds_exceeded"
  );
});

test("catalog displayName exactly mirrors required snapshot text bounds", async () => {
  const exactMaximum = "A".repeat(120);
  const base = indexEnvelope().data.files[0];
  const { readService } = service({
    index: indexEnvelope({
      data: { files: [{ ...base, displayName: exactMaximum }] }
    })
  });
  assert.equal((await readService.readCatalog()).items[0].displayName,
    exactMaximum);
  for (const displayName of [null, "A".repeat(121), " padded ", "bad\nname"]) {
    const invalid = service({
      index: indexEnvelope({
        data: { files: [{ ...base, displayName }] }
      })
    }).readService;
    await assert.rejects(invalid.readCatalog());
  }
});

test("assignment or exact-scope changes block the selected snapshot", async () => {
  for (const code of ["file_not_eligible", "scope_mismatch"] ) {
    const fileError = new Error("raw provider detail must not escape");
    fileError.code = code;
    const { readService } = service({ fileError });
    await assert.rejects(
      readService.readSnapshot({ sourceFileRef: FILE_REF }),
      (error) => {
        assert.equal(error.code, "jobrolo_import_source_changed");
        assert.doesNotMatch(error.message, /provider detail/);
        return true;
      }
    );
  }
});

test("an unassigned foreign contact reference fails closed without leaking its row", async () => {
  const fileError = new Error(
    "unassigned-foreign-client PRIVATE FOREIGN CLIENT LABEL"
  );
  fileError.code = "scope_mismatch";
  const { readService } = service({ fileError });
  await assert.rejects(
    readService.readSnapshot({ sourceFileRef: FILE_REF }),
    (error) => {
      assert.equal(error.code, "jobrolo_import_source_changed");
      assert.doesNotMatch(
        `${error.message} ${JSON.stringify(error)}`,
        /unassigned-foreign-client|PRIVATE FOREIGN CLIENT LABEL/
      );
      return true;
    }
  );
});
