import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  THRESHER_SCHEMA_VERSIONS,
  THRESHER_SYSTEM_ID
} from "./contracts.js";
import {
  ThresherStoreError,
  createThresherStore
} from "./store.js";

const KEY = Buffer.alloc(32, 0x41).toString("base64url");
const OTHER_KEY = Buffer.alloc(32, 0x42).toString("base64url");
const refs = Object.freeze({
  tenant: "tenant_0123456789abcdef",
  otherTenant: "tenant_fedcba9876543210",
  file: `file_${"1".repeat(32)}`,
  otherFile: `file_${"2".repeat(32)}`,
  evidence: `evidence_${"3".repeat(32)}`,
  evidence2: `evidence_${"9".repeat(32)}`,
  rule: `rule_${"4".repeat(32)}`,
  work: `work_${"5".repeat(32)}`,
  plan: `plan_${"6".repeat(32)}`,
  receipt: `receipt_${"7".repeat(32)}`,
  source: `source_${"8".repeat(32)}`,
  source2: `source_${"a".repeat(32)}`
});
const START = Date.parse("2026-07-29T12:05:00.000Z");

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function evidence(overrides = {}) {
  return {
    schemaVersion: THRESHER_SCHEMA_VERSIONS.evidence,
    systemId: THRESHER_SYSTEM_ID,
    recordType: "evidence",
    tenantRef: refs.tenant,
    fileRef: refs.file,
    evidenceRef: refs.evidence,
    evidenceCode: "inspection_scheduled",
    stateCode: "present",
    sourceCode: "jobnimbus",
    sourceRecordRef: refs.source,
    evidenceDigest: digest("a"),
    observedAt: "2026-07-29T12:00:00.000Z",
    checkedAt: "2026-07-29T12:01:00.000Z",
    validUntil: "2026-07-29T12:10:00.000Z",
    recordedAt: "2026-07-29T12:05:00.000Z",
    ...overrides
  };
}

function rule(overrides = {}) {
  return {
    schemaVersion: THRESHER_SCHEMA_VERSIONS.ruleState,
    systemId: THRESHER_SYSTEM_ID,
    recordType: "rule_state",
    tenantRef: refs.tenant,
    fileRef: refs.file,
    ruleRef: refs.rule,
    ruleCode: "appointment.homeowner_confirmation",
    ruleVersion: "1.0.0",
    outcomeCode: "matched",
    reasonCode: "confirmation_missing",
    nextActionCode: "prepare_action_batch",
    evidenceRefs: [refs.evidence],
    decisionDigest: digest("b"),
    evaluatedAt: "2026-07-29T12:02:00.000Z",
    validUntil: "2026-07-29T12:10:00.000Z",
    recordedAt: "2026-07-29T12:05:00.000Z",
    ...overrides
  };
}

function work(overrides = {}) {
  return {
    schemaVersion: THRESHER_SCHEMA_VERSIONS.workState,
    systemId: THRESHER_SYSTEM_ID,
    recordType: "work_state",
    tenantRef: refs.tenant,
    fileRef: refs.file,
    workRef: refs.work,
    workCode: "inspection_coordination",
    stateCode: "open",
    priorityCode: "high",
    reasonCode: "confirmation_missing",
    nextActionCode: "prepare_action_batch",
    evidenceRefs: [refs.evidence],
    ruleRefs: [refs.rule],
    decisionDigest: digest("c"),
    createdAt: "2026-07-29T12:02:00.000Z",
    updatedAt: "2026-07-29T12:03:00.000Z",
    validUntil: "2026-07-29T12:10:00.000Z",
    recordedAt: "2026-07-29T12:05:00.000Z",
    ...overrides
  };
}

function plan(overrides = {}) {
  return {
    schemaVersion: THRESHER_SCHEMA_VERSIONS.plan,
    systemId: THRESHER_SYSTEM_ID,
    recordType: "plan",
    tenantRef: refs.tenant,
    fileRef: refs.file,
    planRef: refs.plan,
    planCode: "action_batch",
    stateCode: "approved",
    operationCodes: ["jobnimbus_note", "quo_message"],
    evidenceRefs: [refs.evidence],
    ruleRefs: [refs.rule],
    approvalDigest: digest("d"),
    createdAt: "2026-07-29T12:03:00.000Z",
    validUntil: "2026-07-29T12:10:00.000Z",
    recordedAt: "2026-07-29T12:05:00.000Z",
    ...overrides
  };
}

function receipt(overrides = {}) {
  return {
    schemaVersion: THRESHER_SCHEMA_VERSIONS.receipt,
    systemId: THRESHER_SYSTEM_ID,
    recordType: "receipt",
    tenantRef: refs.tenant,
    fileRef: refs.file,
    receiptRef: refs.receipt,
    planRef: refs.plan,
    operationCode: "jobnimbus_note",
    outcomeCode: "succeeded",
    sourceCode: "jobnimbus",
    sourceRecordRef: refs.source,
    executionDigest: digest("e"),
    startedAt: "2026-07-29T12:03:00.000Z",
    completedAt: "2026-07-29T12:04:00.000Z",
    recordedAt: "2026-07-29T12:05:00.000Z",
    ...overrides
  };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hcn-thresher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "private", "thresher-store.json");
  let timestamp = options.timestamp ?? START;
  const store = createThresherStore({
    filePath,
    encryptionKey: options.encryptionKey || KEY,
    tenantRef: refs.tenant,
    now: () => timestamp,
    maxRecords: options.maxRecords,
    maxFileBytes: options.maxFileBytes
  });
  t.after(() => store.close());
  return {
    filePath,
    root,
    store,
    setTime(value) {
      timestamp = value;
    }
  };
}

function scope(fileRef = refs.file) {
  return {
    tenantRef: refs.tenant,
    fileRef
  };
}

function assertStoreError(error, code) {
  assert.ok(error instanceof ThresherStoreError);
  assert.equal(error.code, code);
  return true;
}

test("requires a dedicated canonical key, absolute path, and opaque tenant", () => {
  const filePath = path.join(os.tmpdir(), "thresher-store-key-test.json");
  for (const encryptionKey of [
    "",
    "not base64url",
    Buffer.alloc(31).toString("base64url"),
    Buffer.alloc(129).toString("base64url"),
    `${KEY}=`
  ]) {
    assert.throws(
      () =>
        createThresherStore({
          filePath,
          encryptionKey,
          tenantRef: refs.tenant
        }),
      (error) => assertStoreError(error, "invalid_configuration")
    );
  }
  assert.throws(
    () =>
      createThresherStore({
        filePath: "relative/store.json",
        encryptionKey: KEY,
        tenantRef: refs.tenant
      }),
    (error) => assertStoreError(error, "invalid_configuration")
  );
  assert.throws(
    () =>
      createThresherStore({
        filePath,
        encryptionKey: KEY,
        tenantRef: "chance-personal"
      }),
    (error) => assertStoreError(error, "invalid_configuration")
  );
});

test("missing store returns an exact empty immutable projection without writing", async (t) => {
  const { filePath, store } = await fixture(t);
  const snapshot = await store.snapshot(scope());
  assert.deepEqual(snapshot, {
    schemaVersion: THRESHER_SCHEMA_VERSIONS.snapshot,
    systemId: THRESHER_SYSTEM_ID,
    tenantRef: refs.tenant,
    fileRef: refs.file,
    generatedAt: "2026-07-29T12:05:00.000Z",
    authoritativeEvidence: [],
    activeRuleStates: [],
    activeWorkStates: [],
    activePlans: [],
    receipts: []
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.authoritativeEvidence), true);
  await assert.rejects(lstat(filePath), { code: "ENOENT" });
});

test("persists only an authenticated encrypted envelope and survives restart", async (t) => {
  const { filePath, store } = await fixture(t);
  for (const record of [
    evidence(),
    rule(),
    work(),
    plan(),
    receipt()
  ]) {
    assert.deepEqual(await store.put(record), record);
  }

  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(
    raw,
    /tenant_0123|file_1111|evidence_3333|rule_4444|plan_6666|receipt_7777/
  );
  const envelope = JSON.parse(raw);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "algorithm",
    "ciphertext",
    "keyDerivation",
    "nonce",
    "schemaVersion",
    "systemId",
    "tag"
  ]);
  assert.equal(envelope.schemaVersion, "hcn.thresher.store-envelope.v1");
  assert.equal(envelope.systemId, THRESHER_SYSTEM_ID);
  assert.equal(envelope.algorithm, "A256GCM");
  assert.equal(envelope.keyDerivation, "HKDF-SHA256");

  if (process.platform !== "win32") {
    const metadata = await lstat(filePath);
    assert.equal(metadata.mode & 0o077, 0);
  }

  store.close();
  const reopened = createThresherStore({
    filePath,
    encryptionKey: KEY,
    tenantRef: refs.tenant,
    now: () => START
  });
  t.after(() => reopened.close());
  const snapshot = await reopened.snapshot(scope());
  assert.equal(snapshot.authoritativeEvidence.length, 1);
  assert.equal(snapshot.activeRuleStates.length, 1);
  assert.equal(snapshot.activeWorkStates.length, 1);
  assert.equal(snapshot.activePlans.length, 1);
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(Object.isFrozen(snapshot.activePlans[0]), true);
});

test("records are immutable by reference and exact replays are idempotent", async (t) => {
  const { store } = await fixture(t);
  const record = evidence();
  await store.put(record);
  assert.deepEqual(await store.put(record), record);
  await assert.rejects(
    store.put(evidence({ stateCode: "absent" })),
    (error) => assertStoreError(error, "immutable_record_conflict")
  );
});

test("newer fresh evidence becomes authoritative and older evidence cannot race backward", async (t) => {
  const { store, setTime } = await fixture(t);
  await store.put(evidence());
  await store.put(rule());
  await store.put(work());
  await store.put(plan());

  setTime(Date.parse("2026-07-29T12:06:00.000Z"));
  const newer = evidence({
    evidenceRef: refs.evidence2,
    sourceRecordRef: refs.source2,
    evidenceDigest: digest("f"),
    stateCode: "absent",
    observedAt: "2026-07-29T12:05:00.000Z",
    checkedAt: "2026-07-29T12:06:00.000Z",
    validUntil: "2026-07-29T12:12:00.000Z",
    recordedAt: "2026-07-29T12:06:00.000Z"
  });
  await store.put(newer);

  const projected = await store.snapshot(scope());
  assert.deepEqual(
    projected.authoritativeEvidence.map((item) => item.evidenceRef),
    [refs.evidence2]
  );
  assert.equal(projected.activeRuleStates.length, 0);
  assert.equal(projected.activeWorkStates.length, 0);
  assert.equal(projected.activePlans.length, 0);

  await assert.rejects(
    store.put(
      evidence({
        evidenceRef: `evidence_${"b".repeat(32)}`,
        evidenceDigest: digest("1"),
        observedAt: "2026-07-29T12:03:00.000Z",
        checkedAt: "2026-07-29T12:04:00.000Z",
        validUntil: "2026-07-29T12:09:00.000Z",
        recordedAt: "2026-07-29T12:06:00.000Z"
      })
    ),
    (error) => assertStoreError(error, "superseded_evidence")
  );

  setTime(Date.parse("2026-07-29T12:12:00.000Z"));
  const expired = await store.snapshot(scope());
  assert.equal(expired.authoritativeEvidence.length, 0);
});

test("derived state requires current same-file authoritative dependencies", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.put(rule()),
    (error) => assertStoreError(error, "missing_fresh_evidence")
  );
  await store.put(evidence());
  await assert.rejects(
    store.put(
      rule({
        ruleRef: `rule_${"a".repeat(32)}`,
        evidenceRefs: [`evidence_${"b".repeat(32)}`]
      })
    ),
    (error) => assertStoreError(error, "missing_fresh_evidence")
  );
  await store.put(rule());
  await assert.rejects(
    store.put(
      plan({
        planRef: `plan_${"b".repeat(32)}`,
        validUntil: "2026-07-29T12:11:00.000Z"
      })
    ),
    (error) => assertStoreError(error, "dependency_expires_first")
  );
  await assert.rejects(
    store.put(
      work({
        workRef: `work_${"a".repeat(32)}`,
        fileRef: refs.otherFile
      })
    ),
    (error) => assertStoreError(error, "missing_fresh_evidence")
  );
});

test("receipts require an approved current plan, exact operation, and one terminal result", async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.put(receipt()),
    (error) => assertStoreError(error, "missing_plan")
  );
  await store.put(evidence());
  await store.put(rule());
  await store.put(plan());
  await assert.rejects(
    store.put(
      receipt({
        receiptRef: `receipt_${"a".repeat(32)}`,
        operationCode: "gmail_send"
      })
    ),
    (error) => assertStoreError(error, "operation_mismatch")
  );
  await store.put(receipt());
  await assert.rejects(
    store.put(
      receipt({
        receiptRef: `receipt_${"b".repeat(32)}`,
        executionDigest: digest("f")
      })
    ),
    (error) => assertStoreError(error, "duplicate_operation_receipt")
  );
});

test("wrong key, ciphertext tampering, malformed envelope, and oversize files fail closed", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.put(evidence());

  const wrongKey = createThresherStore({
    filePath,
    encryptionKey: OTHER_KEY,
    tenantRef: refs.tenant
  });
  t.after(() => wrongKey.close());
  await assert.rejects(
    wrongKey.snapshot(scope()),
    (error) => assertStoreError(error, "store_corrupt")
  );

  const original = JSON.parse(await readFile(filePath, "utf8"));
  const tampered = {
    ...original,
    ciphertext:
      (original.ciphertext[0] === "A" ? "B" : "A")
      + original.ciphertext.slice(1)
  };
  await writeFile(filePath, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(
    store.snapshot(scope()),
    (error) => assertStoreError(error, "store_corrupt")
  );

  await writeFile(
    filePath,
    `${JSON.stringify({ ...original, extra: true })}\n`
  );
  await assert.rejects(
    store.snapshot(scope()),
    (error) => assertStoreError(error, "store_corrupt")
  );

  await writeFile(filePath, Buffer.alloc(2048, 0x61));
  const bounded = createThresherStore({
    filePath,
    encryptionKey: KEY,
    tenantRef: refs.tenant,
    maxFileBytes: 1024
  });
  t.after(() => bounded.close());
  await assert.rejects(
    bounded.snapshot(scope()),
    (error) => assertStoreError(error, "store_corrupt")
  );
});

test("capacity is bounded and closed stores erase their usable key state", async (t) => {
  const { store } = await fixture(t, { maxRecords: 1 });
  await store.put(evidence());
  await assert.rejects(
    store.put(
      evidence({
        fileRef: refs.otherFile,
        evidenceRef: refs.evidence2
      })
    ),
    (error) => assertStoreError(error, "capacity_exceeded")
  );
  store.close();
  await assert.rejects(
    store.snapshot(scope()),
    (error) => assertStoreError(error, "store_closed")
  );
});

test("malformed inputs and cross-tenant access fail without allocating state", async (t) => {
  const { filePath, store } = await fixture(t);
  await assert.rejects(
    store.put(evidence({ note: "raw body" })),
    (error) => assertStoreError(error, "invalid_input")
  );
  await assert.rejects(
    store.put(evidence({ tenantRef: refs.otherTenant })),
    (error) => assertStoreError(error, "invalid_input")
  );
  await assert.rejects(
    store.snapshot({
      tenantRef: refs.otherTenant,
      fileRef: refs.file
    }),
    (error) => assertStoreError(error, "invalid_input")
  );
  await assert.rejects(lstat(filePath), { code: "ENOENT" });
});

test("cryptographic randomness is used for independent atomic temp files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hcn-thresher-rng-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const store = createThresherStore({
    filePath: path.join(root, "private", "store.json"),
    encryptionKey: randomBytes(32).toString("base64url"),
    tenantRef: refs.tenant,
    now: () => START,
    randomBytes(size) {
      calls.push(size);
      return Buffer.alloc(size, calls.length);
    }
  });
  t.after(() => store.close());
  await store.put(evidence());
  assert.deepEqual(calls, [12, 16]);
});
