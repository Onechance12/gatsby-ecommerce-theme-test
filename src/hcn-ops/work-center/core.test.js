import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkCenterContractError,
  buildWorkCenterPresentation,
  createWorkCenterCore
} from "./core.js";

const NOW = "2026-07-28T17:00:00.000Z";
const FILE_REF = `subject_${"a".repeat(32)}`;
const OTHER_FILE_REF = `subject_${"b".repeat(32)}`;
const TENANT_ID = `tenant_${"c".repeat(16)}`;

function ref(character) {
  return `ref_${character.repeat(32)}`;
}

function scope(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    fileRef: FILE_REF,
    jobNimbusFileId: "provider-file-42",
    jobNumber: "JOB-1042",
    assignment: {
      state: "assigned_to_chance",
      asOf: "2026-07-28T16:55:00.000Z",
      checkedAt: "2026-07-28T16:56:00.000Z",
      validUntil: "2026-07-28T17:06:00.000Z"
    },
    ...overrides
  };
}

function fresh(data, overrides = {}) {
  return {
    status: "ok",
    asOf: "2026-07-28T16:55:00.000Z",
    checkedAt: "2026-07-28T16:56:00.000Z",
    validUntil: "2026-07-28T17:06:00.000Z",
    data,
    ...overrides
  };
}

function jobNimbusData(overrides = {}) {
  return {
    file: {
      fileRef: FILE_REF,
      jobNumber: "JOB-1042",
      statusCode: "active",
      stageCode: "claim_review",
      updatedAt: "2026-07-28T16:50:00.000Z",
      nextAppointmentAt: "2026-07-29T13:00:00.000Z"
    },
    activities: [
      {
        reference: ref("1"),
        kind: "status_change",
        state: "completed",
        occurredAt: "2026-07-28T16:45:00.000Z",
        actorRole: "team"
      }
    ],
    tasks: [
      {
        reference: ref("2"),
        kind: "collect_payment",
        status: "open",
        priority: "normal",
        dueAt: "2026-07-27T14:00:00.000Z",
        assignedRole: "chance"
      },
      {
        reference: ref("3"),
        kind: "confirm_inspection",
        status: "open",
        priority: "normal",
        dueAt: "2026-07-28T20:00:00.000Z",
        assignedRole: "team"
      }
    ],
    documents: [
      {
        reference: ref("4"),
        kind: "settlement_estimate",
        reviewState: "needs_review",
        createdAt: "2026-07-28T15:00:00.000Z"
      }
    ],
    ...overrides
  };
}

function gmailData(overrides = {}) {
  return {
    fileRef: FILE_REF,
    communications: [
      {
        reference: ref("5"),
        direction: "outbound",
        occurredAt: "2026-07-28T14:00:00.000Z",
        hasAttachment: false,
        actionState: "awaiting_response"
      }
    ],
    ...overrides
  };
}

function quoData(overrides = {}) {
  return {
    fileRef: FILE_REF,
    communications: [
      {
        reference: ref("6"),
        channel: "text",
        direction: "inbound",
        occurredAt: "2026-07-28T13:00:00.000Z",
        disposition: "delivered",
        actionState: "resolved"
      }
    ],
    ...overrides
  };
}

function completeSources() {
  return {
    jobnimbus: fresh(jobNimbusData()),
    gmail: fresh(gmailData()),
    quo: fresh(quoData())
  };
}

test("builds a deterministic, minimized exact-file presentation", () => {
  const sources = completeSources();
  sources.jobnimbus.data.file.homeownerName = "Sensitive Person";
  sources.jobnimbus.data.file.address = "100 Private Street";
  sources.jobnimbus.data.activities[0].note = "private carrier note";
  sources.gmail.data.communications[0].subject = "Policy for Sensitive Person";
  sources.gmail.data.communications[0].body = "sensitive@example.com";
  sources.quo.data.communications[0].transcript = "Call me at 555-555-5555";
  sources.gmail.oauthAccessToken = "secret-provider-token";

  const result = buildWorkCenterPresentation({
    scope: scope(),
    sources,
    generatedAt: NOW,
    requestId: "request_test_1",
    buildMetadata: {
      service: "jobnimbus-chatgpt-bridge",
      sourceCommit: "810802542c35625327662e97fd21f7208532b371",
      sourceCommitTrust: "provider_attested",
      buildId: "build-1",
      deployId: "deploy-1",
      attested: true,
      environment: process.env,
      secret: "must-not-pass"
    }
  });

  assert.equal(result.evidenceStatus, "complete");
  assert.equal(result.authority.mode, "read_only");
  assert.equal(result.authority.canWrite, false);
  assert.equal(result.file.fileRef, FILE_REF);
  assert.equal(result.file.jobNumber, "JOB-1042");
  assert.equal(result.file.operational.stageCode, "claim_review");
  assert.deepEqual(
    result.lanes.priority.map((item) => item.reasonCode),
    ["overdue_task", "document_review_required"]
  );
  assert.deepEqual(
    result.lanes.today.map((item) => item.reasonCode),
    ["task_due_today"]
  );
  assert.deepEqual(
    result.lanes.waiting.map((item) => item.reasonCode),
    ["awaiting_response"]
  );
  assert.equal(result.build.attested, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.recent.tasks), true);

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "Sensitive Person",
    "100 Private Street",
    "private carrier note",
    "sensitive@example.com",
    "555-555-5555",
    "secret-provider-token",
    "must-not-pass",
    "jobNimbusFileId",
    "provider-file-42"
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));
  }
});

test("stale sources cannot contribute evidence and are explicit partial state", () => {
  const sources = completeSources();
  sources.gmail = fresh(gmailData(), {
    validUntil: "2026-07-28T16:59:59.999Z"
  });

  const result = buildWorkCenterPresentation({
    scope: scope(),
    sources,
    generatedAt: NOW,
    requestId: "request_test_2"
  });

  assert.equal(result.evidenceStatus, "partial");
  assert.deepEqual(result.recent.gmail, []);
  assert.deepEqual(result.lanes.waiting, []);
  assert.deepEqual(
    result.sources.find((source) => source.source === "gmail"),
    {
      source: "gmail",
      status: "stale",
      completeness: "none",
      asOf: "2026-07-28T16:55:00.000Z",
      checkedAt: "2026-07-28T16:56:00.000Z",
      validUntil: "2026-07-28T16:59:59.999Z",
      failureCode: "source_stale",
      acceptedItems: 0,
      droppedItems: 0
    }
  );
  assert.equal(
    result.lanes.priority.some(
      (item) => item.source === "gmail" && item.reasonCode === "source_stale"
    ),
    true
  );
});

test("a JobNimbus failure fails the presentation closed", async () => {
  const core = createWorkCenterCore({
    now: () => new Date(NOW),
    createRequestId: () => "request_test_3",
    getBuildMetadata: () => {
      throw new Error("secret build failure");
    },
    readJobNimbus: async () => {
      throw new Error("provider exception with client data");
    },
    readGmail: async () => fresh(gmailData()),
    readQuo: async () => fresh(quoData())
  });
  assert.deepEqual(Object.keys(core), ["presentFile"]);

  const result = await core.presentFile({ scope: scope() });

  assert.equal(result.evidenceStatus, "failed");
  assert.equal(result.file.operational, null);
  assert.deepEqual(result.recent.activities, []);
  assert.deepEqual(result.recent.tasks, []);
  assert.deepEqual(result.recent.documents, []);
  assert.equal(result.sources[0].failureCode, "source_error");
  assert.equal(result.lanes.priority[0].reasonCode, "source_unavailable");
  assert.equal(result.build.sourceCommitTrust, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /provider exception|client data|secret/i);
});

test("rejects stale or non-Chance assignment before any source reader runs", async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return fresh({});
  };
  const core = createWorkCenterCore({
    now: () => new Date(NOW),
    createRequestId: () => "request_test_4",
    readJobNimbus: loader,
    readGmail: loader,
    readQuo: loader
  });
  const staleScope = scope({
    assignment: {
      ...scope().assignment,
      validUntil: "2026-07-28T16:59:00.000Z"
    }
  });

  await assert.rejects(
    () => core.presentFile({ scope: staleScope }),
    (error) =>
      error instanceof WorkCenterContractError
      && /assignment verification is stale/.test(error.message)
  );
  assert.equal(calls, 0);

  assert.throws(
    () =>
      buildWorkCenterPresentation({
        scope: scope({
          assignment: {
            ...scope().assignment,
            state: "assigned_to_someone_else"
          }
        }),
        sources: completeSources(),
        generatedAt: NOW,
        requestId: "request_test_4b"
      }),
    /assigned to Chance/
  );
});

test("rejects unexpected scope fields and fails cross-file evidence closed", () => {
  assert.throws(
    () =>
      buildWorkCenterPresentation({
        scope: { ...scope(), rawContact: { phone: "555-555-5555" } },
        sources: completeSources(),
        generatedAt: NOW,
        requestId: "request_test_5a"
      }),
    /scope\.rawContact is not allowed/
  );

  const sources = completeSources();
  sources.jobnimbus.data.file.fileRef = OTHER_FILE_REF;
  sources.gmail.data.fileRef = OTHER_FILE_REF;
  const result = buildWorkCenterPresentation({
    scope: scope(),
    sources,
    generatedAt: NOW,
    requestId: "request_test_5b"
  });

  assert.equal(result.evidenceStatus, "failed");
  assert.equal(result.file.operational, null);
  assert.deepEqual(result.recent.gmail, []);
  assert.equal(result.sources[0].failureCode, "scope_mismatch");
  assert.equal(result.sources[1].failureCode, "scope_mismatch");
});

test("drops malformed source items and reports partial completeness", () => {
  const sources = completeSources();
  sources.jobnimbus.data.tasks.push({
    reference: "provider-task-id",
    kind: "bad task with spaces",
    status: "open",
    priority: "urgent",
    dueAt: "not-a-date",
    assignedRole: "SensitivePerson",
    raw: { email: "sensitive@example.com" }
  });

  const result = buildWorkCenterPresentation({
    scope: scope(),
    sources,
    generatedAt: NOW,
    requestId: "request_test_6"
  });
  const jobNimbus = result.sources.find(
    (source) => source.source === "jobnimbus"
  );

  assert.equal(result.evidenceStatus, "partial");
  assert.equal(jobNimbus.status, "fresh");
  assert.equal(jobNimbus.completeness, "partial");
  assert.equal(jobNimbus.failureCode, "source_partial");
  assert.equal(jobNimbus.droppedItems, 1);
  assert.equal(result.recent.tasks.length, 2);
  assert.equal(result.lanes.priority[0].reasonCode, "overdue_task");
  assert.equal(
    result.lanes.priority.some(
      (item) =>
        item.source === "jobnimbus" && item.reasonCode === "source_partial"
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify(result), /SensitivePerson|sensitive@example/i);
});
