import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HCN_FILE_SCHEMA,
  HCN_WORK_CENTER_SCHEMA,
  HcnConsoleFreshReadError,
  createHcnConsoleFreshReadService
} from "./fresh-read.js";

const NOW = "2026-07-28T18:00:00.000Z";
const FRESH = Object.freeze({
  status: "ok",
  asOf: "2026-07-28T17:55:00.000Z",
  checkedAt: "2026-07-28T17:56:00.000Z",
  validUntil: "2026-07-28T18:06:00.000Z"
});
const TENANT_ID = `tenant_${"a".repeat(16)}`;

function hexFor(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function referenceFactory() {
  return {
    tenantId: TENANT_ID,
    subjectId(source, providerId) {
      assert.equal(source, "jobnimbus");
      return `subject_${hexFor(`file:${providerId}`)}`;
    },
    sourceRecordRef(source, providerId) {
      return `ref_${hexFor(`${source}:${providerId}`)}`;
    }
  };
}

function eligibleFile(overrides = {}) {
  return {
    providerFileId: "provider-file-1",
    jobNumber: "JN-1001",
    displayName: "Homeowner One",
    statusCode: "active",
    stageCode: "claim_review",
    fileTypeCode: "insurance_claim",
    isInsuranceFile: true,
    isActive: true,
    assignedToChance: true,
    updatedAt: "2026-07-28T17:50:00.000Z",
    ...overrides
  };
}

function fresh(data, overrides = {}) {
  return {
    ...FRESH,
    data,
    ...overrides
  };
}

function jobNimbusDetail(file = eligibleFile()) {
  return fresh({
    file: {
      ...file,
      displayName: "Homeowner One With A Current Exact Record",
      nextAppointmentAt: "2026-07-29T14:00:00.000Z",
      primaryEmail: "OWNER@EXAMPLE.COM",
      primaryPhone: "(555) 555-0101",
      propertyAddress: "100 Private Street, Example, TX 75001",
      carrierName: "Example Carrier",
      claimNumber: "CLAIM-PRIVATE-1",
       policyNumber: "POLICY-PRIVATE-1",
       dateOfLoss: "2026-05-17",
       damageFactsPresent: true,
       adjusterName: "Taylor Adjuster",
      adjusterEmail: "ADJUSTER@CARRIER.EXAMPLE",
      adjusterPhone: "(555) 555-0130",
      rawContact: {
        accessToken: "DO-NOT-LEAK-RAW-CONTACT"
      }
    },
    activities: [
      {
        providerRecordId: "activity-provider-id",
        kind: "status_change",
        state: "completed",
        occurredAt: "2026-07-28T17:40:00.000Z",
        actorRole: "team",
        label: `A${"x".repeat(300)}`,
        note: "DO-NOT-LEAK-ACTIVITY-NOTE"
      }
    ],
    tasks: [
      {
        providerRecordId: "task-provider-id",
        kind: "document_review",
        status: "open",
        priority: "high",
        dueAt: "2026-07-29T15:00:00.000Z",
        assignedRole: "chance",
        label: "Review settlement",
        body: "DO-NOT-LEAK-TASK-BODY"
      }
    ],
    documents: [
      {
        providerRecordId: "document-provider-id",
        kind: "settlement_estimate",
        reviewState: "needs_review",
        createdAt: "2026-07-28T17:30:00.000Z",
        fileName: `settlement-${"y".repeat(300)}.pdf`,
        downloadUrl: "https://provider.invalid/raw-secret"
      }
    ]
  });
}

function gmailSuccess() {
  return fresh({
    providerFileId: "provider-file-1",
    complete: true,
    items: [
      {
         providerRecordId: "gmail-provider-id",
         direction: "inbound",
         occurredAt: "2026-07-28T17:20:00.000Z",
         hasAttachment: true,
         deliveryState: "received",
         actionState: "needs_reply",
        subject: `Subject ${"s".repeat(300)}`,
        snippet: `Snippet ${"p".repeat(400)}`,
        body: "DO-NOT-LEAK-GMAIL-BODY"
      }
    ]
  });
}

function quoSuccess() {
  return fresh({
    providerFileId: "provider-file-1",
    complete: true,
    items: [
      {
        providerRecordId: "quo-provider-id",
        channel: "text",
        direction: "inbound",
        occurredAt: "2026-07-28T17:10:00.000Z",
        disposition: "delivered",
        actionState: "needs_reply",
        preview: `Preview ${"q".repeat(400)}`,
        transcript: "DO-NOT-LEAK-QUO-TRANSCRIPT"
      }
    ]
  });
}

function createService(overrides = {}) {
  const files = overrides.files ?? [eligibleFile()];
  return createHcnConsoleFreshReadService({
    referenceFactory: referenceFactory(),
    now: () => new Date(NOW),
    loadJobNimbusIndex: async () =>
      fresh({
        complete: true,
        files
      }),
    loadJobNimbusFile: async () => jobNimbusDetail(files[0]),
    loadGmailFile: async () => gmailSuccess(),
    loadQuoFile: async () => quoSuccess(),
    ...overrides.dependencies
  });
}

function fileRef(providerId = "provider-file-1") {
  return referenceFactory().subjectId("jobnimbus", providerId);
}

test("module has no persistence, memory, Brain, or Jobrolo import boundary", async () => {
  const source = await readFile(new URL("./fresh-read.js", import.meta.url), "utf8");
  const imports = [
    ...source.matchAll(
      /(?:import\s+[\s\S]*?\s+from\s+|import\s*)["']([^"']+)["']/g
    )
  ].map((match) => match[1].toLowerCase());

  assert.deepEqual(imports, []);
  for (const forbidden of ["memory", "brain", "jobrolo", "server.js"]) {
    assert.equal(
      imports.some((specifier) => specifier.includes(forbidden)),
      false
    );
  }
});

test("Work Center includes only active Chance-assigned insurance files", async () => {
  const files = [
    eligibleFile(),
    eligibleFile({
      providerFileId: "provider-file-not-chance",
      jobNumber: "JN-1002",
      assignedToChance: false
    }),
    eligibleFile({
      providerFileId: "provider-file-closed",
      jobNumber: "JN-1003",
      isActive: false
    }),
    eligibleFile({
      providerFileId: "provider-file-not-insurance",
      jobNumber: "JN-1004",
      isInsuranceFile: false
    }),
    eligibleFile({
      providerFileId: "provider-file-newer",
      jobNumber: "JN-1005",
      displayName: "Newest Eligible",
      updatedAt: "2026-07-28T17:59:00.000Z"
    }),
    eligibleFile({
      providerFileId: "provider-file-priority",
      jobNumber: "JN-1006",
      displayName: "Older Priority File",
      updatedAt: "2026-07-28T17:00:00.000Z",
      missingFacts: {
        claimNumber: true,
        policyNumber: false,
        dateOfLoss: false,
        adjuster: false
      }
    })
  ];
  const result = await createService({ files }).readWorkCenter({
    offset: 0,
    limit: 50
  });

  assert.equal(result.schema, HCN_WORK_CENTER_SCHEMA);
  assert.equal(result.ephemeral, true);
  assert.equal(result.cachePolicy, "no_store");
  assert.equal(result.authority.canWrite, false);
  assert.equal(result.page.total, 3);
  assert.deepEqual(
    result.files.map((file) => file.jobNumber),
    ["JN-1006", "JN-1005", "JN-1001"]
  );
  assert.equal(result.files[0].lane, "priority");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.files), true);
});

test("Work Center list minimizes PII and never emits raw provider data", async () => {
  const result = await createService({
    files: [
      eligibleFile({
        email: "private@example.com",
        phone: "555-555-0199",
        propertyAddress: "100 Private Street",
        claimNumber: "CLAIM-SECRET",
        policyNumber: "POLICY-SECRET",
        missingFacts: {
          claimNumber: true,
          policyNumber: false,
          dateOfLoss: true,
          adjuster: false
        },
        rawContact: {
          providerToken: "PROVIDER-TOKEN-SECRET"
        }
      })
    ]
  }).readWorkCenter({ offset: 0, limit: 10 });

  assert.deepEqual(Object.keys(result.files[0]), [
    "fileRef",
    "jobNumber",
    "displayName",
    "statusCode",
    "stageCode",
    "fileTypeCode",
    "updatedAt",
    "lane",
    "attentionCodes",
    "missing"
  ]);
  assert.equal(result.files[0].lane, "priority");
  assert.deepEqual(result.files[0].attentionCodes, [
    "missing_claim_number",
    "missing_date_of_loss"
  ]);
  assert.deepEqual(result.files[0].missing, {
    claimNumber: true,
    policyNumber: false,
    dateOfLoss: true,
    adjuster: false
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "provider-file-1",
    "private@example.com",
    "555-555-0199",
    "100 Private Street",
    "CLAIM-SECRET",
    "POLICY-SECRET",
    "PROVIDER-TOKEN-SECRET",
    "rawContact"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("requests reject unknown, missing, malformed, and out-of-range fields", async () => {
  const service = createService();
  const badRequests = [
    () => service.readWorkCenter({ offset: 0, limit: 10, query: "client" }),
    () => service.readWorkCenter({ offset: 0 }),
    () => service.readWorkCenter({ offset: -1, limit: 10 }),
    () => service.readWorkCenter({ offset: 0, limit: 51 }),
    () => service.readFile({ fileRef: "provider-file-1", recentLimit: 10 }),
    () => service.readFile({ fileRef: fileRef(), recentLimit: 0 }),
    () =>
      service.readFile({
        fileRef: fileRef(),
        recentLimit: 10,
        jobNumber: "JN-1001"
      })
  ];

  for (const execute of badRequests) {
    await assert.rejects(execute, (error) => {
      assert.equal(error instanceof HcnConsoleFreshReadError, true);
      assert.equal(error.code, "invalid_request");
      assert.equal(error.statusCode, 400);
      return true;
    });
  }
});

test("exact file lookup accepts only a current opaque ref and blocks forged refs", async () => {
  let detailReads = 0;
  const service = createService({
    dependencies: {
      loadJobNimbusFile: async () => {
        detailReads += 1;
        return jobNimbusDetail();
      }
    }
  });

  await assert.rejects(
    () =>
      service.readFile({
        fileRef: `subject_${"f".repeat(32)}`,
        recentLimit: 10
      }),
    (error) => {
      assert.equal(error.code, "file_not_found");
      assert.equal(error.statusCode, 404);
      assert.equal(error.message.includes("provider"), false);
      return true;
    }
  );
  assert.equal(detailReads, 0);

  const inactiveOnly = createService({
    files: [eligibleFile({ isActive: false })]
  });
  await assert.rejects(
    () =>
      inactiveOnly.readFile({
        fileRef: fileRef(),
        recentLimit: 10
      }),
    { code: "file_not_found" }
  );
});

test("internal deterministic lookup resolves one exact assigned numeric job number", async () => {
  const file = eligibleFile({ jobNumber: "2862" });
  const result = await createService({
    files: [file],
    dependencies: {
      loadJobNimbusFile: async () => jobNimbusDetail(file)
    }
  }).readFileByJobNumber({
    jobNumber: "2862",
    recentLimit: 10
  });

  assert.equal(result.file.jobNumber, "2862");
  assert.equal(result.file.fileRef, fileRef());
  assert.equal(result.evidenceStatus, "complete");

  await assert.rejects(
    () =>
      createService({ files: [file] }).readFileByJobNumber({
        jobNumber: "JN-2862",
        recentLimit: 10
      }),
    { code: "invalid_request", statusCode: 400 }
  );
});

test("exact file response is bounded, ephemeral, and strips provider extras", async () => {
  const result = await createService().readFile({
    fileRef: fileRef(),
    recentLimit: 10
  });

  assert.equal(result.schema, HCN_FILE_SCHEMA);
  assert.equal(result.evidenceStatus, "complete");
  assert.equal(result.file.fileRef, fileRef());
  assert.equal(result.file.client.primaryEmail, "owner@example.com");
  assert.equal(result.file.property.address, "100 Private Street, Example, TX 75001");
  assert.equal(result.file.insurance.dateOfLoss, "2026-05-17");
  assert.deepEqual(result.file.adjuster, {
    name: "Taylor Adjuster",
    email: "adjuster@carrier.example",
    phone: "(555) 555-0130"
  });
  assert.equal(Array.from(result.recent.activities[0].label).length, 160);
  assert.equal(Array.from(result.recent.documents[0].fileName).length, 160);
  assert.equal(Array.from(result.recent.gmail[0].subject).length, 160);
  assert.equal(Array.from(result.recent.gmail[0].snippet).length, 240);
  assert.equal(Array.from(result.recent.quo[0].preview).length, 240);
  assert.equal(
    result.lanes.priority.some(
      (item) => item.reasonCode === "document_review_required"
    ),
    true
  );
  assert.equal(
    result.lanes.priority.some(
      (item) => item.reasonCode === "reply_required"
    ),
    true
  );
  assert.equal(Object.isFrozen(result.recent), true);

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "provider-file-1",
    "activity-provider-id",
    "task-provider-id",
    "document-provider-id",
    "gmail-provider-id",
    "quo-provider-id",
    "DO-NOT-LEAK",
    "rawContact",
    "downloadUrl",
    "provider.invalid"
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("recent projections enforce the requested maximum and mark partial evidence", async () => {
  const details = jobNimbusDetail();
  details.data.activities = Array.from({ length: 25 }, (_, index) => ({
    providerRecordId: `activity-${index}`,
    kind: "status_change",
    state: "completed",
    occurredAt: `2026-07-28T17:${String(index).padStart(2, "0")}:00.000Z`,
    actorRole: "team",
    label: `Activity ${index}`
  }));
  const result = await createService({
    dependencies: {
      loadJobNimbusFile: async () => details
    }
  }).readFile({
    fileRef: fileRef(),
    recentLimit: 5
  });

  assert.equal(result.recent.activities.length, 5);
  assert.equal(result.sources.jobnimbus.completeness, "partial");
  assert.equal(result.sources.jobnimbus.failureCode, "source_partial");
  assert.equal(result.evidenceStatus, "partial");
});

test("JobNimbus loader errors and invalid envelopes fail with a sanitized error", async () => {
  const failures = [
    async () => {
      throw new Error(
        "PROVIDER-SECRET private@example.com raw body and provider id"
      );
    },
    async () => ({
      status: "failed",
      error: "PROVIDER-SECRET",
      data: { rawContact: "PRIVATE" }
    }),
    async () =>
      fresh({
        complete: false,
        files: [eligibleFile()]
      })
  ];

  for (const loadJobNimbusIndex of failures) {
    const service = createService({
      dependencies: { loadJobNimbusIndex }
    });
    await assert.rejects(
      () => service.readWorkCenter({ offset: 0, limit: 10 }),
      (error) => {
        assert.equal(error.code, "source_unavailable");
        assert.equal(error.statusCode, 502);
        assert.equal(error.message, "Fresh JobNimbus evidence is unavailable.");
        assert.equal(error.message.includes("PROVIDER-SECRET"), false);
        return true;
      }
    );
  }
});

test("a required exact JobNimbus mismatch fails closed without optional reads", async () => {
  let optionalReads = 0;
  const service = createService({
    dependencies: {
      loadJobNimbusFile: async () =>
        jobNimbusDetail(
          eligibleFile({
            providerFileId: "wrong-provider-file",
            jobNumber: "JN-WRONG"
          })
        ),
      loadGmailFile: async () => {
        optionalReads += 1;
        return gmailSuccess();
      },
      loadQuoFile: async () => {
        optionalReads += 1;
        return quoSuccess();
      }
    }
  });

  await assert.rejects(
    () =>
      service.readFile({
        fileRef: fileRef(),
        recentLimit: 10
      }),
    { code: "source_unavailable", statusCode: 502 }
  );
  assert.equal(optionalReads, 0);
});

test("Gmail and Quo failures become coded incomplete empty sources", async () => {
  const service = createService({
    dependencies: {
      loadGmailFile: async () => {
        throw new Error("GMAIL-SECRET provider response");
      },
      loadQuoFile: async () =>
        fresh(
          {
            providerFileId: "provider-file-1",
            items: [{ transcript: "QUO-SECRET" }]
          },
          {
            validUntil: "2026-07-28T17:59:59.999Z",
            error: "QUO-PROVIDER-ERROR"
          }
        )
    }
  });
  const result = await service.readFile({
    fileRef: fileRef(),
    recentLimit: 10
  });

  assert.equal(result.evidenceStatus, "partial");
  assert.deepEqual(result.recent.gmail, []);
  assert.deepEqual(result.recent.quo, []);
  assert.deepEqual(result.sources.gmail, {
    source: "gmail",
    status: "incomplete",
    completeness: "none",
    failureCode: "source_unavailable",
    asOf: null,
    checkedAt: NOW,
    validUntil: null,
    acceptedItems: 0,
    droppedItems: 0
  });
  assert.equal(result.sources.quo.failureCode, "source_stale");
  assert.equal(result.sources.quo.status, "incomplete");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("GMAIL-SECRET"), false);
  assert.equal(serialized.includes("QUO-SECRET"), false);
  assert.equal(serialized.includes("QUO-PROVIDER-ERROR"), false);
});

test("proved exact optional evidence remains visible when provider pagination is partial", async () => {
  const partial = gmailSuccess();
  partial.data.complete = false;
  const result = await createService({
    dependencies: {
      loadGmailFile: async () => partial
    }
  }).readFile({
    fileRef: fileRef(),
    recentLimit: 10
  });

  assert.equal(result.sources.gmail.status, "fresh");
  assert.equal(result.sources.gmail.completeness, "partial");
  assert.equal(result.sources.gmail.failureCode, "source_partial");
  assert.equal(result.recent.gmail.length, 1);
  assert.equal(result.evidenceStatus, "partial");
});

test("optional scope mismatch is incomplete and does not expose the mismatch", async () => {
  const service = createService({
    dependencies: {
      loadGmailFile: async () =>
        fresh({
          providerFileId: "another-private-provider-file",
          items: []
        })
    }
  });
  const result = await service.readFile({
    fileRef: fileRef(),
    recentLimit: 10
  });

  assert.equal(result.sources.gmail.status, "incomplete");
  assert.equal(result.sources.gmail.failureCode, "source_unavailable");
  assert.deepEqual(result.recent.gmail, []);
  assert.equal(
    JSON.stringify(result).includes("another-private-provider-file"),
    false
  );
});
