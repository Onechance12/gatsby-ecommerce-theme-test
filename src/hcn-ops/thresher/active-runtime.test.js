import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ActiveThresherRuntimeError,
  createActiveThresherRuntime
} from "./active-runtime.js";
import { createThresherStore } from "./store.js";

const TENANT = "tenant_0123456789abcdef";
const PRINCIPAL_A = `principal_${"1".repeat(64)}`;
const PRINCIPAL_B = `principal_${"2".repeat(64)}`;
const FILE_A = `subject_${"a".repeat(32)}`;
const FILE_B = `subject_${"b".repeat(32)}`;
const PLAN = `plan_${"c".repeat(32)}`;
const STORE_KEY = Buffer.alloc(32, 0x41).toString("base64url");
const REFERENCE_KEY = Buffer.alloc(32, 0x42).toString("base64url");
const SIGNING_KEY = Buffer.alloc(32, 0x43).toString("base64url");
const START = Date.parse("2026-07-29T12:05:00.000Z");

async function fixture(t, options = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "hcn-thresher-active-")
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "private", "state.enc.json");
  let timestamp = START;
  const store = createThresherStore({
    filePath,
    encryptionKey: STORE_KEY,
    tenantRef: TENANT,
    now: () => timestamp,
    maxRecords: options.maxRecords
  });
  const runtime = createActiveThresherRuntime({
    store,
    tenantRef: TENANT,
    referenceKey: REFERENCE_KEY,
    signingKey: SIGNING_KEY,
    now: () => timestamp
  });
  t.after(() => runtime.close());
  return {
    filePath,
    runtime,
    setTime(value) {
      timestamp = value;
    }
  };
}

function review(fileRef = FILE_A, overrides = {}) {
  return {
    schema: "hcn.console.file.v1",
    generatedAt: "2026-07-29T12:05:00.000Z",
    ephemeral: true,
    cachePolicy: "no_store",
    authority: {
      mode: "read_only",
      canWrite: false,
      canSend: false,
      canCall: false,
      canApprove: false
    },
    evidenceStatus: "complete",
    file: {
      fileRef,
      jobNumber: "SENSITIVE-100",
      displayName: "Private Homeowner",
      statusCode: "active",
      stageCode: "claim",
      fileTypeCode: "insurance",
      updatedAt: "2026-07-29T12:00:00.000Z",
      nextAppointmentAt: null,
      client: {
        primaryEmail: "homeowner@example.test",
        primaryPhone: "214-555-1212"
      },
      property: {
        address: "100 Private Street"
      },
      insurance: {
        carrierName: "Private Carrier",
        claimNumber: "CLAIM-PRIVATE-100",
        policyNumber: "POLICY-PRIVATE-100"
      },
      missing: {
        claimNumber: true,
        policyNumber: false,
        dateOfLoss: false,
        adjuster: false
      }
    },
    sources: {
      jobnimbus: {
        source: "jobnimbus",
        status: "fresh",
        completeness: "complete",
        failureCode: null,
        asOf: "2026-07-29T12:00:00.000Z",
        checkedAt: "2026-07-29T12:01:00.000Z",
        validUntil: "2026-07-29T12:10:00.000Z",
        acceptedItems: 1,
        droppedItems: 0
      },
      gmail: {
        source: "gmail",
        status: "fresh",
        completeness: "complete",
        asOf: "2026-07-29T12:00:00.000Z",
        checkedAt: "2026-07-29T12:01:00.000Z",
        validUntil: "2026-07-29T12:10:00.000Z"
      },
      quo: {
        source: "quo",
        status: "fresh",
        completeness: "complete",
        asOf: "2026-07-29T12:00:00.000Z",
        checkedAt: "2026-07-29T12:01:00.000Z",
        validUntil: "2026-07-29T12:10:00.000Z"
      }
    },
    lanes: {
      priority: [],
      today: [],
      waiting: []
    },
    recent: {
      activities: [{
        reference: `ref_${"d".repeat(32)}`,
        occurredAt: "2026-07-29T12:00:00.000Z",
        label: "Private activity body"
      }],
      tasks: [],
      documents: [],
      gmail: [{
        reference: `ref_${"e".repeat(32)}`,
        subject: "Private email subject",
        snippet: "Private email body"
      }],
      quo: [{
        reference: `ref_${"f".repeat(32)}`,
        preview: "Private text body"
      }]
    },
    ...overrides
  };
}

function reviewInput(principalRef, fileRef, value = review(fileRef)) {
  return {
    principalRef,
    fileRef,
    review: value
  };
}

test("fresh exact-file review persists only opaque coded state and no raw client content", async (t) => {
  const { filePath, runtime } = await fixture(t);
  const result = await runtime.recordFileReview(
    reviewInput(PRINCIPAL_A, FILE_A)
  );

  assert.equal(result.status, "file_review_recorded");
  assert.equal(result.persistence, "active_encrypted_minimized");
  assert.equal(result.authority.authorizesAction, false);
  assert.equal(result.authority.executesAction, false);
  assert.equal(result.snapshot.authoritativeEvidence.length, 6);
  assert.equal(result.snapshot.activeRuleStates.length, 1);
  assert.equal(result.snapshot.activeWorkStates.length, 1);
  assert.equal(
    result.snapshot.activeWorkStates[0].workCode,
    "claim_path_review"
  );
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    "Private Homeowner",
    "homeowner@example.test",
    "214-555-1212",
    "100 Private Street",
    "CLAIM-PRIVATE-100",
    "POLICY-PRIVATE-100",
    "Private email body",
    "Private text body"
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }

  const encrypted = await readFile(filePath, "utf8");
  assert.doesNotMatch(
    encrypted,
    /Private Homeowner|homeowner@example|214-555|Private Street|CLAIM-PRIVATE|POLICY-PRIVATE|email body|text body/
  );
});

test("the same public file is isolated per principal and different files cannot leak", async (t) => {
  const { runtime } = await fixture(t);
  const first = await runtime.recordFileReview(
    reviewInput(PRINCIPAL_A, FILE_A)
  );
  const second = await runtime.recordFileReview(
    reviewInput(
      PRINCIPAL_B,
      FILE_A,
      review(FILE_A, {
        file: {
          ...review(FILE_A).file,
          missing: {
            claimNumber: false,
            policyNumber: false,
            dateOfLoss: false,
            adjuster: false
          }
        }
      })
    )
  );
  await runtime.recordFileReview(
    reviewInput(PRINCIPAL_A, FILE_B, review(FILE_B))
  );

  assert.notEqual(
    first.snapshot.fileRef,
    second.snapshot.fileRef
  );
  const firstAgain = await runtime.snapshot({
    principalRef: PRINCIPAL_A,
    fileRef: FILE_A
  });
  const secondAgain = await runtime.snapshot({
    principalRef: PRINCIPAL_B,
    fileRef: FILE_A
  });
  const otherFile = await runtime.snapshot({
    principalRef: PRINCIPAL_A,
    fileRef: FILE_B
  });
  assert.equal(
    firstAgain.snapshot.activeWorkStates[0].workCode,
    "claim_path_review"
  );
  assert.equal(
    secondAgain.snapshot.activeWorkStates[0].workCode,
    "reconciliation"
  );
  assert.notEqual(firstAgain.snapshot.fileRef, otherFile.snapshot.fileRef);
  assert.deepEqual(
    new Set([
      firstAgain.snapshot.fileRef,
      secondAgain.snapshot.fileRef,
      otherFile.snapshot.fileRef
    ]).size,
    3
  );
});

test("new fresh JobNimbus evidence supersedes old state and stale input is rejected", async (t) => {
  const { runtime, setTime } = await fixture(t);
  await runtime.recordFileReview(
    reviewInput(PRINCIPAL_A, FILE_A)
  );
  setTime(Date.parse("2026-07-29T12:07:00.000Z"));
  const newer = review(FILE_A);
  newer.generatedAt = "2026-07-29T12:07:00.000Z";
  newer.sources.jobnimbus = {
    ...newer.sources.jobnimbus,
    asOf: "2026-07-29T12:06:00.000Z",
    checkedAt: "2026-07-29T12:07:00.000Z",
    validUntil: "2026-07-29T12:12:00.000Z"
  };
  newer.file.missing.claimNumber = false;
  const updated = await runtime.recordFileReview(
    reviewInput(PRINCIPAL_A, FILE_A, newer)
  );
  assert.equal(updated.snapshot.authoritativeEvidence.length, 6);
  assert.equal(
    updated.snapshot.activeWorkStates[0].workCode,
    "reconciliation"
  );

  await assert.rejects(
    runtime.recordFileReview(
      reviewInput(PRINCIPAL_A, FILE_A)
    ),
    (error) =>
      error instanceof ActiveThresherRuntimeError
      || error?.code === "superseded_evidence"
  );
  const afterRejected = await runtime.snapshot({
    principalRef: PRINCIPAL_A,
    fileRef: FILE_A
  });
  assert.equal(
    afterRejected.snapshot.activeWorkStates[0].workCode,
    "reconciliation"
  );
});

test("repeated fresh reviews compact superseded state without exhausting the bounded store", async (t) => {
  const { filePath, runtime, setTime } = await fixture(
    t,
    { maxRecords: 8 }
  );
  const validUntil = "2026-07-29T14:00:00.000Z";
  let latest;
  for (let index = 0; index < 80; index += 1) {
    const timestamp = START + (index * 1000);
    const instant = new Date(timestamp).toISOString();
    setTime(timestamp);
    const current = review(FILE_A);
    current.generatedAt = instant;
    current.sources.jobnimbus = {
      ...current.sources.jobnimbus,
      asOf: instant,
      checkedAt: instant,
      validUntil
    };
    latest = await runtime.recordFileReview(
      reviewInput(PRINCIPAL_A, FILE_A, current)
    );
  }

  assert.equal(latest.snapshot.authoritativeEvidence.length, 6);
  assert.equal(latest.snapshot.activeRuleStates.length, 1);
  assert.equal(latest.snapshot.activeWorkStates.length, 1);
  assert.equal(latest.snapshot.receipts.length, 0);

  const internalFileRef = latest.snapshot.fileRef;
  runtime.close();
  const reopened = createThresherStore({
    filePath,
    encryptionKey: STORE_KEY,
    tenantRef: TENANT,
    now: () => START + (79 * 1000),
    maxRecords: 8
  });
  t.after(() => reopened.close());
  const durable = await reopened.snapshot({
    tenantRef: TENANT,
    fileRef: internalFileRef
  });
  assert.equal(durable.authoritativeEvidence.length, 6);
  assert.equal(durable.activeRuleStates.length, 1);
  assert.equal(durable.activeWorkStates.length, 1);
});

test("exact proposed and approved plans plus terminal receipts retain metadata only", async (t) => {
  const { runtime, setTime } = await fixture(t);
  await runtime.recordFileReview(
    reviewInput(PRINCIPAL_A, FILE_A)
  );
  const basePlan = {
    principalRef: PRINCIPAL_A,
    fileRef: FILE_A,
    planId: PLAN,
    approvalDigest: "d".repeat(64),
    approvalExpiresAt: "2026-07-29T12:09:00.000Z",
    operationTypes: [
      "jobnimbus.create_note",
      "gmail.create_draft",
      "gmail.create_draft"
    ],
    stateCode: "proposed",
    createdAt: "2026-07-29T12:05:00.000Z"
  };
  const proposed = await runtime.recordActionPlan(basePlan);
  const approved = await runtime.recordActionPlan({
    ...basePlan,
    stateCode: "approved"
  });
  assert.notEqual(proposed.planRef, approved.planRef);
  assert.equal(approved.authorizesAction, false);

  setTime(Date.parse("2026-07-29T12:06:00.000Z"));
  const closeout = await runtime.recordActionReceipts({
    principalRef: PRINCIPAL_A,
    fileRef: FILE_A,
    planId: PLAN,
    operationTypes: basePlan.operationTypes,
    outcomeCode: "succeeded",
    startedAt: "2026-07-29T12:05:00.000Z",
    completedAt: "2026-07-29T12:06:00.000Z"
  });
  assert.equal(closeout.receiptCount, 2);
  assert.equal(closeout.authorizesAction, false);

  const state = await runtime.snapshot({
    principalRef: PRINCIPAL_A,
    fileRef: FILE_A
  });
  assert.equal(state.snapshot.receipts.length, 2);
  assert.deepEqual(
    state.snapshot.receipts.map((item) => item.operationCode).sort(),
    ["gmail_draft", "jobnimbus_note"]
  );
});

test("runtime exposes no model/provider/action authority and persistence failure invokes no effect callback", async () => {
  let providerMutationCount = 0;
  const failingStore = {
    async put() {
      throw new Error("disk unavailable");
    },
    async putMany() {
      throw new Error("disk unavailable");
    },
    async snapshot() {
      return {
        authoritativeEvidence: []
      };
    },
    close() {}
  };
  const runtime = createActiveThresherRuntime({
    store: failingStore,
    tenantRef: TENANT,
    referenceKey: REFERENCE_KEY,
    signingKey: SIGNING_KEY,
    now: () => START
  });
  assert.deepEqual(Object.keys(runtime), [
    "recordFileReview",
    "recordActionPlan",
    "recordActionReceipts",
    "snapshot",
    "close"
  ]);
  assert.equal("execute" in runtime, false);
  assert.equal("send" in runtime, false);
  assert.equal("call" in runtime, false);

  await assert.rejects(
    runtime.recordFileReview({
      ...reviewInput(PRINCIPAL_A, FILE_A),
      providerMutation() {
        providerMutationCount += 1;
      }
    }),
    /documented exact fields/
  );
  await assert.rejects(
    runtime.recordFileReview(
      reviewInput(PRINCIPAL_A, FILE_A)
    ),
    /disk unavailable/
  );
  assert.equal(providerMutationCount, 0);
  runtime.close();
});

test("corrupt durable state fails closed without creating an external-action path", async (t) => {
  const { filePath, runtime } = await fixture(t);
  await runtime.recordFileReview(
    reviewInput(PRINCIPAL_A, FILE_A)
  );
  await writeFile(filePath, "corrupt");
  let externalEffects = 0;
  await assert.rejects(
    runtime.recordActionPlan({
      principalRef: PRINCIPAL_A,
      fileRef: FILE_A,
      planId: PLAN,
      approvalDigest: "d".repeat(64),
      approvalExpiresAt: "2026-07-29T12:09:00.000Z",
      operationTypes: ["jobnimbus.create_note"],
      stateCode: "approved",
      createdAt: "2026-07-29T12:05:00.000Z"
    }),
    /Thresher|encrypted|store|JSON|authenticated/i
  );
  assert.equal(externalEffects, 0);
});
