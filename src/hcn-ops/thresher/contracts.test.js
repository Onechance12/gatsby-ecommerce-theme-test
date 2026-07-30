import assert from "node:assert/strict";
import test from "node:test";

import {
  THRESHER_SCHEMA_VERSIONS,
  THRESHER_SYSTEM_ID,
  ThresherContractError,
  buildEvidenceRecord,
  buildPlanRecord,
  buildReceiptRecord,
  buildRuleStateRecord,
  buildThresherRecord,
  buildWorkStateRecord,
  thresherRecordRef,
  validateEvidenceRecord,
  validatePlanRecord,
  validateReceiptRecord,
  validateRuleStateRecord,
  validateThresherRecord,
  validateWorkStateRecord
} from "./contracts.js";

const refs = Object.freeze({
  tenant: "tenant_0123456789abcdef",
  otherTenant: "tenant_fedcba9876543210",
  file: `file_${"1".repeat(32)}`,
  otherFile: `file_${"2".repeat(32)}`,
  evidence: `evidence_${"3".repeat(32)}`,
  rule: `rule_${"4".repeat(32)}`,
  work: `work_${"5".repeat(32)}`,
  plan: `plan_${"6".repeat(32)}`,
  receipt: `receipt_${"7".repeat(32)}`,
  source: `source_${"8".repeat(32)}`
});

const times = Object.freeze({
  observed: "2026-07-29T12:00:00.000Z",
  checked: "2026-07-29T12:01:00.000Z",
  evaluated: "2026-07-29T12:02:00.000Z",
  created: "2026-07-29T12:03:00.000Z",
  completed: "2026-07-29T12:04:00.000Z",
  recorded: "2026-07-29T12:05:00.000Z",
  valid: "2026-07-29T12:10:00.000Z"
});

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
    observedAt: times.observed,
    checkedAt: times.checked,
    validUntil: times.valid,
    recordedAt: times.recorded,
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
    evaluatedAt: times.evaluated,
    validUntil: times.valid,
    recordedAt: times.recorded,
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
    createdAt: times.evaluated,
    updatedAt: times.created,
    validUntil: times.valid,
    recordedAt: times.recorded,
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
    createdAt: times.created,
    validUntil: times.valid,
    recordedAt: times.recorded,
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
    startedAt: times.created,
    completedAt: times.completed,
    recordedAt: times.recorded,
    ...overrides
  };
}

test("strict builders accept minimized coded records and return deep immutable copies", () => {
  const inputs = [
    [evidence(), buildEvidenceRecord],
    [rule(), buildRuleStateRecord],
    [work(), buildWorkStateRecord],
    [plan(), buildPlanRecord],
    [receipt(), buildReceiptRecord]
  ];

  for (const [input, builder] of inputs) {
    const result = builder(input, {
      tenantRef: refs.tenant,
      fileRef: refs.file
    });
    assert.notEqual(result, input);
    assert.equal(Object.isFrozen(result), true);
    for (const value of Object.values(result)) {
      if (Array.isArray(value)) assert.equal(Object.isFrozen(value), true);
    }
    assert.equal(
      thresherRecordRef(result),
      result[
        {
          evidence: "evidenceRef",
          rule_state: "ruleRef",
          work_state: "workRef",
          plan: "planRef",
          receipt: "receiptRef"
        }[result.recordType]
      ]
    );
  }
});

test("every exact validator accepts its documented record and generic dispatch is fail closed", () => {
  assert.equal(validateEvidenceRecord(evidence()), true);
  assert.equal(validateRuleStateRecord(rule()), true);
  assert.equal(validateWorkStateRecord(work()), true);
  assert.equal(validatePlanRecord(plan()), true);
  assert.equal(validateReceiptRecord(receipt()), true);
  for (const record of [evidence(), rule(), work(), plan(), receipt()]) {
    assert.equal(validateThresherRecord(record), true);
    assert.deepEqual(buildThresherRecord(record), record);
  }
  assert.throws(
    () => validateThresherRecord({ recordType: "unknown" }),
    ThresherContractError
  );
});

test("trusted tenant and file bindings prevent cross-scope records", () => {
  assert.throws(
    () =>
      buildEvidenceRecord(evidence(), {
        tenantRef: refs.otherTenant,
        fileRef: refs.file
      }),
    /trusted tenant/
  );
  assert.throws(
    () =>
      buildEvidenceRecord(evidence(), {
        tenantRef: refs.tenant,
        fileRef: refs.otherFile
      }),
    /trusted file/
  );
});

test("unknown and raw client-content fields are rejected at every boundary", () => {
  const cases = [
    [evidence({ homeownerName: "Synthetic Person" }), validateEvidenceRecord],
    [rule({ note: "free text" }), validateRuleStateRecord],
    [work({ address: "100 Example Street" }), validateWorkStateRecord],
    [plan({ email: "person@example.test" }), validatePlanRecord],
    [receipt({ transcript: "body" }), validateReceiptRecord]
  ];
  for (const [value, validator] of cases) {
    assert.throws(() => validator(value), /forbidden raw client-content field/);
  }
  assert.throws(
    () =>
      validateEvidenceRecord(
        evidence({ sourceRecordRef: "person@example.test" })
      ),
    /email address/
  );
  assert.throws(
    () =>
      validateEvidenceRecord(
        evidence({ sourceRecordRef: "555-555-0100" })
      ),
    /phone number/
  );
});

test("opaque references, enums, digests, arrays, and canonical timestamps are strict", () => {
  const invalid = [
    () => validateEvidenceRecord(evidence({ fileRef: "JN-123" })),
    () => validateEvidenceRecord(evidence({ stateCode: "maybe" })),
    () => validateEvidenceRecord(evidence({ evidenceDigest: digest("A") })),
    () => validateRuleStateRecord(rule({ ruleVersion: "v1" })),
    () =>
      validateRuleStateRecord(
        rule({ evidenceRefs: [refs.evidence, refs.evidence] })
      ),
    () => validateWorkStateRecord(work({ priorityCode: "critical" })),
    () => validatePlanRecord(plan({ operationCodes: ["send_everything"] })),
    () => validateReceiptRecord(receipt({ completedAt: times.observed })),
    () =>
      validateEvidenceRecord(
        evidence({ checkedAt: "2026-07-29T12:01:00Z" })
      )
  ];
  for (const operation of invalid) {
    assert.throws(operation, ThresherContractError);
  }
});

test("record chronology rejects impossible provenance and freshness timing", () => {
  assert.throws(
    () => validateEvidenceRecord(evidence({ observedAt: times.completed })),
    /checkedAt cannot precede/
  );
  assert.throws(
    () => validateRuleStateRecord(rule({ validUntil: times.observed })),
    /validUntil cannot precede/
  );
  assert.throws(
    () => validateWorkStateRecord(work({ updatedAt: times.observed })),
    /updatedAt cannot precede/
  );
  assert.throws(
    () => validatePlanRecord(plan({ recordedAt: times.observed })),
    /recordedAt cannot precede/
  );
  assert.throws(
    () => validateReceiptRecord(receipt({ recordedAt: times.created })),
    /recordedAt cannot precede/
  );
});
