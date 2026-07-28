import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_API_VERSION,
  HCN_SCHEMA_VERSIONS,
  HCN_SYSTEM_ID,
  HcnContractError,
  buildApiEnvelope,
  buildRuleEvaluation,
  buildSourceObservation,
  buildSubjectRef,
  buildWorkItem,
  validateApiEnvelope,
  validateRuleEvaluation,
  validateSourceObservation,
  validateSubjectRef,
  validateWorkItem
} from "./contracts.js";

const ids = Object.freeze({
  tenant: "tenant_aaaaaaaaaaaaaaaa",
  otherTenant: "tenant_bbbbbbbbbbbbbbbb",
  subject: "subject_11111111111111111111111111111111",
  observation: "obs_22222222222222222222222222222222",
  work: "work_33333333333333333333333333333333",
  evaluation: "eval_44444444444444444444444444444444",
  request: "request_55555555555555555555555555555555",
  trace: "trace_66666666666666666666666666666666",
  record: "ref_77777777777777777777777777777777"
});

const times = Object.freeze({
  asOf: "2026-07-28T12:00:00.000Z",
  checkedAt: "2026-07-28T12:01:00.000Z",
  validUntil: "2026-07-28T12:06:00.000Z"
});

function subject(overrides = {}) {
  return {
    schemaVersion: HCN_SCHEMA_VERSIONS.subjectRef,
    systemId: HCN_SYSTEM_ID,
    tenantId: ids.tenant,
    subjectType: "hcn_file",
    subjectId: ids.subject,
    ...overrides
  };
}

function freshness(overrides = {}) {
  return {
    status: "fresh",
    ...times,
    ...overrides
  };
}

function provenance(overrides = {}) {
  return {
    systemId: HCN_SYSTEM_ID,
    tenantId: ids.tenant,
    sourceSystem: "jobnimbus",
    sourceRecordRef: ids.record,
    traceId: ids.trace,
    evidenceDigest: `sha256:${"8".repeat(64)}`,
    recordedAt: times.checkedAt,
    ...overrides
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: HCN_SCHEMA_VERSIONS.sourceObservation,
    systemId: HCN_SYSTEM_ID,
    tenantId: ids.tenant,
    observationId: ids.observation,
    subject: subject(),
    observationType: "inspection_scheduled",
    state: "present",
    provenance: provenance(),
    freshness: freshness(),
    ...overrides
  };
}

function ruleEvaluation(overrides = {}) {
  return {
    schemaVersion: HCN_SCHEMA_VERSIONS.ruleEvaluation,
    systemId: HCN_SYSTEM_ID,
    tenantId: ids.tenant,
    evaluationId: ids.evaluation,
    subject: subject(),
    ruleId: "appointment.homeowner_confirmation",
    ruleVersion: "2.0.0",
    outcome: "matched",
    reasonCode: "confirmation_missing",
    nextActionCode: "prepare_action_batch",
    observationIds: [ids.observation],
    evaluatedAt: times.checkedAt,
    provenance: provenance({ sourceSystem: "hcn_rule_engine" }),
    freshness: freshness(),
    ...overrides
  };
}

function workItem(overrides = {}) {
  return {
    schemaVersion: HCN_SCHEMA_VERSIONS.workItem,
    systemId: HCN_SYSTEM_ID,
    tenantId: ids.tenant,
    workItemId: ids.work,
    subject: subject(),
    workType: "inspection_coordination",
    status: "open",
    priority: "high",
    reasonCode: "confirmation_missing",
    nextActionCode: "prepare_action_batch",
    observationIds: [ids.observation],
    ruleEvaluationIds: [ids.evaluation],
    dueAt: null,
    createdAt: times.checkedAt,
    updatedAt: times.checkedAt,
    provenance: provenance({ sourceSystem: "hcn_rule_engine" }),
    freshness: freshness(),
    ...overrides
  };
}

function envelope(dataType, items, overrides = {}) {
  return {
    schemaVersion: HCN_SCHEMA_VERSIONS.apiEnvelope,
    systemId: HCN_SYSTEM_ID,
    apiVersion: HCN_API_VERSION,
    tenantId: ids.tenant,
    requestId: ids.request,
    generatedAt: times.checkedAt,
    dataType,
    items,
    provenance: provenance({ sourceSystem: "hcn_operator" }),
    freshness: freshness(),
    ...overrides
  };
}

test("v2 builders accept minimized synthetic contracts and return immutable copies", () => {
  const rawSubject = subject();
  const rawObservation = observation();
  const rawEvaluation = ruleEvaluation();
  const rawWorkItem = workItem();
  const rawEnvelope = envelope("work_item", [rawWorkItem]);

  const builtSubject = buildSubjectRef(rawSubject, { tenantId: ids.tenant });
  const builtObservation = buildSourceObservation(rawObservation, {
    tenantId: ids.tenant
  });
  const builtEvaluation = buildRuleEvaluation(rawEvaluation, {
    tenantId: ids.tenant
  });
  const builtWorkItem = buildWorkItem(rawWorkItem, { tenantId: ids.tenant });
  const builtEnvelope = buildApiEnvelope(rawEnvelope, { tenantId: ids.tenant });

  assert.notEqual(builtSubject, rawSubject);
  assert.notEqual(builtObservation.subject, rawObservation.subject);
  assert.equal(Object.isFrozen(builtSubject), true);
  assert.equal(Object.isFrozen(builtObservation.provenance), true);
  assert.equal(Object.isFrozen(builtEvaluation.observationIds), true);
  assert.equal(Object.isFrozen(builtWorkItem), true);
  assert.equal(Object.isFrozen(builtEnvelope.items), true);
});

test("persistence builders require an explicit trusted tenant binding", () => {
  for (const build of [
    () => buildSubjectRef(subject()),
    () => buildSourceObservation(observation()),
    () => buildRuleEvaluation(ruleEvaluation()),
    () => buildWorkItem(workItem()),
    () => buildApiEnvelope(envelope("work_item", [workItem()]))
  ]) {
    assert.throws(build, /options\.tenantId must be an opaque tenantId/);
  }

  assert.throws(
    () => buildSubjectRef(subject(), { tenantId: ids.otherTenant }),
    /does not match the expected HCN tenant/
  );
});

test("all validators accept their exact minimized v2 shape", () => {
  assert.equal(validateSubjectRef(subject()), true);
  assert.equal(validateSourceObservation(observation()), true);
  assert.equal(validateRuleEvaluation(ruleEvaluation()), true);
  assert.equal(validateWorkItem(workItem()), true);
  assert.equal(validateApiEnvelope(envelope("subject_ref", [subject()])), true);
  assert.equal(
    validateApiEnvelope(envelope("source_observation", [observation()])),
    true
  );
  assert.equal(
    validateApiEnvelope(envelope("rule_evaluation", [ruleEvaluation()])),
    true
  );
  assert.equal(validateApiEnvelope(envelope("work_item", [workItem()])), true);
});

test("unknown fields fail closed at every contract boundary", () => {
  assert.throws(
    () => validateSubjectRef(subject({ extra: true })),
    /extra is not allowed/
  );
  assert.throws(
    () => validateSourceObservation(observation({ extra: true })),
    /extra is not allowed/
  );
  assert.throws(
    () => validateRuleEvaluation(ruleEvaluation({ extra: true })),
    /extra is not allowed/
  );
  assert.throws(
    () => validateWorkItem(workItem({ extra: true })),
    /extra is not allowed/
  );
  assert.throws(
    () => validateApiEnvelope(envelope("work_item", [], { extra: true })),
    /extra is not allowed/
  );
  assert.throws(
    () =>
      validateSourceObservation(
        observation({ freshness: freshness({ cacheHint: "private" }) })
      ),
    /cacheHint is not allowed/
  );
});

test("raw PII and communication or document content fields are rejected recursively", () => {
  const forbiddenCases = [
    ["name", "Synthetic Person"],
    ["address", "100 Example Street"],
    ["email", "person@example.test"],
    ["phone", "555-555-0100"],
    ["policyNumber", "POLICY-EXAMPLE"],
    ["claimNumber", "CLAIM-EXAMPLE"],
    ["messageBody", "Synthetic message body"],
    ["snippet", "Synthetic snippet"],
    ["transcript", "Synthetic call transcript"],
    ["documentContent", "Synthetic document"]
  ];

  for (const [field, value] of forbiddenCases) {
    assert.throws(
      () =>
        validateSourceObservation(
          observation({
            provenance: {
              ...provenance(),
              [field]: value
            }
          })
        ),
      new RegExp(`${field} is a forbidden raw client-content field`)
    );
  }
});

test("PII-like strings cannot be smuggled through an otherwise allowed field", () => {
  assert.throws(
    () =>
      validateSourceObservation(
        observation({
          provenance: provenance({ sourceRecordRef: "person@example.test" })
        })
      ),
    /contains an email address/
  );
  assert.throws(
    () =>
      validateSourceObservation(
        observation({
          provenance: provenance({ sourceRecordRef: "555-555-0100" })
        })
      ),
    /contains a phone number/
  );
  assert.throws(
    () =>
      validateSourceObservation(
        observation({
          provenance: provenance({ sourceRecordRef: "100 Example Street" })
        })
      ),
    /contains a street address/
  );
});

test("facts, work, rules, and envelopes require both provenance and freshness", () => {
  for (const fixture of [observation(), workItem(), ruleEvaluation()]) {
    const withoutProvenance = { ...fixture };
    delete withoutProvenance.provenance;
    const withoutFreshness = { ...fixture };
    delete withoutFreshness.freshness;

    const validator =
      fixture.schemaVersion === HCN_SCHEMA_VERSIONS.sourceObservation
        ? validateSourceObservation
        : fixture.schemaVersion === HCN_SCHEMA_VERSIONS.workItem
          ? validateWorkItem
          : validateRuleEvaluation;

    assert.throws(() => validator(withoutProvenance), /provenance is required/);
    assert.throws(() => validator(withoutFreshness), /freshness is required/);
  }

  const withoutProvenance = envelope("work_item", []);
  delete withoutProvenance.provenance;
  const withoutFreshness = envelope("work_item", []);
  delete withoutFreshness.freshness;
  assert.throws(
    () => validateApiEnvelope(withoutProvenance),
    /provenance is required/
  );
  assert.throws(
    () => validateApiEnvelope(withoutFreshness),
    /freshness is required/
  );
});

test("nested tenant mismatches are rejected for subjects and provenance", () => {
  assert.throws(
    () =>
      validateSourceObservation(
        observation({ subject: subject({ tenantId: ids.otherTenant }) })
      ),
    /does not match the expected HCN tenant/
  );
  assert.throws(
    () =>
      validateWorkItem(
        workItem({
          provenance: provenance({ tenantId: ids.otherTenant })
        })
      ),
    /does not match the expected HCN tenant/
  );
  assert.throws(
    () =>
      validateRuleEvaluation(ruleEvaluation(), {
        tenantId: ids.otherTenant
      }),
    /does not match the expected HCN tenant/
  );
});

test("API envelopes reject cross-tenant items and mismatched item types", () => {
  assert.throws(
    () =>
      validateApiEnvelope(
        envelope("work_item", [
          workItem({
            tenantId: ids.otherTenant,
            subject: subject({ tenantId: ids.otherTenant }),
            provenance: provenance({ tenantId: ids.otherTenant })
          })
        ])
      ),
    /items\[0\].*expected HCN tenant/
  );
  assert.throws(
    () => validateApiEnvelope(envelope("work_item", [observation()])),
    /items\[0\].*workItemId is required/
  );
});

test("contracts cannot be relabeled as Chance Brain or Jobrolo records", () => {
  for (const systemId of ["chance_brain", "jobrolo"]) {
    assert.throws(
      () => validateSubjectRef(subject({ systemId })),
      new RegExp(`systemId must equal ${HCN_SYSTEM_ID}`)
    );
    assert.throws(
      () => validateSourceObservation(observation({ systemId })),
      new RegExp(`systemId must equal ${HCN_SYSTEM_ID}`)
    );
  }
});

test("only safe enum values and versioned rule identifiers are accepted", () => {
  assert.throws(
    () => validateSourceObservation(observation({ state: "probably" })),
    /sourceObservation.state must be one of/
  );
  assert.throws(
    () => validateWorkItem(workItem({ priority: "whenever" })),
    /workItem.priority must be one of/
  );
  assert.throws(
    () =>
      validateRuleEvaluation(
        ruleEvaluation({
          ruleId: "custom.client_specific_rule",
          ruleVersion: "latest"
        })
      ),
    /ruleEvaluation.ruleId must be one of/
  );
  assert.throws(
    () => validateRuleEvaluation(ruleEvaluation({ ruleVersion: "latest" })),
    /semantic version/
  );
});

test("opaque references, digests, timestamps, chronology, and duplicate refs fail closed", () => {
  assert.throws(
    () => validateSubjectRef(subject({ subjectId: "fixture-client-1" })),
    /opaque subjectId/
  );
  assert.throws(
    () =>
      validateSourceObservation(
        observation({
          provenance: provenance({ evidenceDigest: "sha256:not-a-digest" })
        })
      ),
    /lowercase SHA-256 digest/
  );
  assert.throws(
    () =>
      validateSourceObservation(
        observation({
          freshness: freshness({ validUntil: times.asOf })
        })
      ),
    /validUntil cannot precede/
  );
  assert.throws(
    () =>
      validateWorkItem(
        workItem({ observationIds: [ids.observation, ids.observation] })
      ),
    /cannot contain duplicates/
  );
  assert.throws(
    () =>
      validateWorkItem(
        workItem({
          createdAt: times.checkedAt,
          updatedAt: times.asOf
        })
      ),
    /updatedAt cannot precede/
  );
  assert.throws(
    () =>
      validateSourceObservation(
        observation({
          freshness: freshness({ checkedAt: "2026-02-31T12:01:00.000Z" })
        })
      ),
    /ISO-8601 UTC timestamp/
  );
  assert.throws(
    () =>
      validateSourceObservation(
        observation({
          provenance: provenance({ recordedAt: "2026-07-28T11:59:59.000Z" })
        })
      ),
    /recordedAt cannot precede.*freshness\.asOf/
  );
});

test("contract violations use a stable error type", () => {
  assert.throws(
    () => validateSubjectRef({}),
    (error) =>
      error instanceof HcnContractError &&
      error.name === "HcnContractError" &&
      /schemaVersion is required/.test(error.message)
  );
});
