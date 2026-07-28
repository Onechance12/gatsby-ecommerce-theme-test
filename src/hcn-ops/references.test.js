import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_API_VERSION,
  HCN_SCHEMA_VERSIONS,
  HCN_SYSTEM_ID,
  validateApiEnvelope,
  validateRuleEvaluation,
  validateSourceObservation,
  validateSubjectRef,
  validateWorkItem
} from "./contracts.js";
import {
  HcnReferenceError,
  createHcnReferenceFactory,
  createRandomTenantId
} from "./references.js";

const TENANT_A = "tenant_0123456789abcdef";
const TENANT_B = "tenant_fedcba9876543210";
const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);
const AT = "2026-07-28T12:00:00.000Z";
const VALID_UNTIL = "2026-07-28T12:05:00.000Z";

test("stable references are deterministic within the same key and tenant", () => {
  const first = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A
  });
  const second = createHcnReferenceFactory({
    hmacKey: Buffer.from(KEY_A),
    tenantId: TENANT_A
  });

  assert.equal(
    first.subjectId("jobnimbus", "provider-record-101"),
    second.subjectId("jobnimbus", "provider-record-101")
  );
  assert.equal(
    first.sourceRecordRef("jobnimbus", "provider-record-101"),
    second.sourceRecordRef("jobnimbus", "provider-record-101")
  );
});

test("stable references use key, tenant, source, and purpose domain separation", () => {
  const base = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A
  });
  const otherKey = createHcnReferenceFactory({
    hmacKey: KEY_B,
    tenantId: TENANT_A
  });
  const otherTenant = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_B
  });
  const providerRecordId = "provider-record-101";
  const subjectId = base.subjectId("jobnimbus", providerRecordId);

  assert.notEqual(
    subjectId,
    otherKey.subjectId("jobnimbus", providerRecordId)
  );
  assert.notEqual(
    subjectId,
    otherTenant.subjectId("jobnimbus", providerRecordId)
  );
  assert.notEqual(
    subjectId,
    base.subjectId("gmail", providerRecordId)
  );
  assert.notEqual(
    subjectId.slice("subject_".length),
    base
      .sourceRecordRef("jobnimbus", providerRecordId)
      .slice("ref_".length)
  );
});

test("stable references never emit raw provider record identifiers", () => {
  const references = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A
  });
  const rawProviderRecordId = "private-provider-record::JN-998877";
  const emitted = [
    references.subjectId("jobnimbus", rawProviderRecordId),
    references.sourceRecordRef("jobnimbus", rawProviderRecordId)
  ];

  assert.deepEqual(
    emitted.map((value) => value.includes(rawProviderRecordId)),
    [false, false]
  );
  assert.match(emitted[0], /^subject_[a-f0-9]{32}$/);
  assert.match(emitted[1], /^ref_[a-f0-9]{32}$/);
});

test("generated identifiers satisfy every existing HCN contract pattern", () => {
  const randomBytes = incrementingRandomBytes();
  const references = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A,
    randomBytes
  });
  const subject = {
    schemaVersion: HCN_SCHEMA_VERSIONS.subjectRef,
    systemId: HCN_SYSTEM_ID,
    tenantId: TENANT_A,
    subjectType: "hcn_file",
    subjectId: references.subjectId("jobnimbus", "provider-record-101")
  };
  const provenance = {
    systemId: HCN_SYSTEM_ID,
    tenantId: TENANT_A,
    sourceSystem: "jobnimbus",
    sourceRecordRef: references.sourceRecordRef(
      "jobnimbus",
      "provider-record-101"
    ),
    traceId: references.traceId(),
    evidenceDigest: `sha256:${"a".repeat(64)}`,
    recordedAt: AT
  };
  const freshness = {
    status: "fresh",
    asOf: AT,
    checkedAt: AT,
    validUntil: VALID_UNTIL
  };
  const observation = {
    schemaVersion: HCN_SCHEMA_VERSIONS.sourceObservation,
    systemId: HCN_SYSTEM_ID,
    tenantId: TENANT_A,
    observationId: references.observationId(),
    subject,
    observationType: "source_reachable",
    state: "present",
    provenance,
    freshness
  };
  const evaluation = {
    schemaVersion: HCN_SCHEMA_VERSIONS.ruleEvaluation,
    systemId: HCN_SYSTEM_ID,
    tenantId: TENANT_A,
    evaluationId: references.evaluationId(),
    subject,
    ruleId: "sources.recovery_required",
    ruleVersion: "1.0.0",
    outcome: "not_matched",
    reasonCode: "condition_not_satisfied",
    nextActionCode: "none",
    observationIds: [observation.observationId],
    evaluatedAt: AT,
    provenance,
    freshness
  };
  const workItem = {
    schemaVersion: HCN_SCHEMA_VERSIONS.workItem,
    systemId: HCN_SYSTEM_ID,
    tenantId: TENANT_A,
    workItemId: references.workItemId(),
    subject,
    workType: "source_recovery",
    status: "open",
    priority: "normal",
    reasonCode: "source_unavailable",
    nextActionCode: "refresh_sources",
    observationIds: [observation.observationId],
    ruleEvaluationIds: [evaluation.evaluationId],
    dueAt: null,
    createdAt: AT,
    updatedAt: AT,
    provenance,
    freshness
  };
  const envelope = {
    schemaVersion: HCN_SCHEMA_VERSIONS.apiEnvelope,
    systemId: HCN_SYSTEM_ID,
    apiVersion: HCN_API_VERSION,
    tenantId: TENANT_A,
    requestId: references.requestId(),
    generatedAt: AT,
    dataType: "subject_ref",
    items: [subject],
    provenance,
    freshness
  };

  assert.equal(validateSubjectRef(subject, { tenantId: TENANT_A }), true);
  assert.equal(
    validateSourceObservation(observation, { tenantId: TENANT_A }),
    true
  );
  assert.equal(
    validateRuleEvaluation(evaluation, { tenantId: TENANT_A }),
    true
  );
  assert.equal(validateWorkItem(workItem, { tenantId: TENANT_A }), true);
  assert.equal(validateApiEnvelope(envelope, { tenantId: TENANT_A }), true);
});

test("random references are unique, correctly shaped, and injectable", () => {
  const calls = [];
  const references = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A,
    randomBytes(size) {
      calls.push(size);
      return Buffer.alloc(size, calls.length);
    }
  });

  assert.equal(references.observationId(), `obs_${"01".repeat(16)}`);
  assert.equal(references.workItemId(), `work_${"02".repeat(16)}`);
  assert.equal(references.evaluationId(), `eval_${"03".repeat(16)}`);
  assert.equal(references.requestId(), `request_${"04".repeat(16)}`);
  assert.equal(references.traceId(), `trace_${"05".repeat(16)}`);
  assert.deepEqual(calls, [16, 16, 16, 16, 16]);

  const secureReferences = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A
  });
  assert.notEqual(
    secureReferences.observationId(),
    secureReferences.observationId()
  );
});

test("tenant IDs can be generated explicitly with an injected random source", () => {
  const tenantId = createRandomTenantId({
    randomBytes(size) {
      assert.equal(size, 8);
      return Buffer.from("0011223344556677", "hex");
    }
  });

  assert.equal(tenantId, "tenant_0011223344556677");
  const references = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId
  });
  assert.equal(references.tenantId, tenantId);
});

test("weak keys, malformed tenants, unknown systems, and bad records fail closed", () => {
  assert.throws(
    () => createHcnReferenceFactory({ tenantId: TENANT_A }),
    HcnReferenceError
  );
  assert.throws(
    () =>
      createHcnReferenceFactory({
        hmacKey: Buffer.alloc(31),
        tenantId: TENANT_A
      }),
    /at least 32 bytes/
  );
  assert.throws(
    () =>
      createHcnReferenceFactory({
        hmacKey: "not-byte-key-material",
        tenantId: TENANT_A
      }),
    /provided as bytes/
  );
  assert.throws(
    () =>
      createHcnReferenceFactory({
        hmacKey: KEY_A,
        tenantId: `${TENANT_A}-extra`
      }),
    /exact opaque HCN tenant/
  );

  const references = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A
  });
  assert.throws(
    () => references.subjectId("untrusted_crm", "record-1"),
    /not allowlisted/
  );
  assert.throws(
    () => references.subjectId("jobnimbus", ""),
    /must not be empty/
  );
  assert.throws(
    () => references.subjectId("jobnimbus", "   "),
    /must not be empty/
  );
  assert.throws(
    () => references.subjectId("jobnimbus", "\u00e9".repeat(513)),
    /must not exceed 1024 UTF-8 bytes/
  );
  assert.throws(
    () => references.subjectId("jobnimbus", 123),
    /must be a string/
  );
});

test("random source failures fail closed without producing malformed IDs", () => {
  assert.throws(
    () =>
      createHcnReferenceFactory({
        hmacKey: KEY_A,
        tenantId: TENANT_A,
        randomBytes: "not-a-function"
      }),
    /must be a function/
  );

  const short = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A,
    randomBytes: () => Buffer.alloc(15)
  });
  assert.throws(() => short.traceId(), /exactly 16 bytes/);

  const invalid = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A,
    randomBytes: () => "not-bytes"
  });
  assert.throws(() => invalid.requestId(), /must return bytes/);

  const broken = createHcnReferenceFactory({
    hmacKey: KEY_A,
    tenantId: TENANT_A,
    randomBytes() {
      throw new Error("provider internal detail");
    }
  });
  assert.throws(
    () => broken.observationId(),
    /failed to generate an opaque identifier/
  );
});

function incrementingRandomBytes() {
  let counter = 0;
  return (size) => Buffer.alloc(size, ++counter);
}
