/**
 * Strict minimized contracts for the isolated HCN Thresher operational brain.
 *
 * This module is deliberately dependency-free. It accepts coded operational
 * state and opaque references only. It has no field capable of carrying a
 * client name, address, email, phone number, policy/claim value, free text,
 * message body, transcript, or document content.
 */

export const THRESHER_SYSTEM_ID = "hcn_operations";

export const THRESHER_SCHEMA_VERSIONS = Object.freeze({
  evidence: "hcn.thresher.evidence.v1",
  ruleState: "hcn.thresher.rule-state.v1",
  workState: "hcn.thresher.work-state.v1",
  plan: "hcn.thresher.plan.v1",
  receipt: "hcn.thresher.receipt.v1",
  snapshot: "hcn.thresher.snapshot.v1"
});

export const THRESHER_RECORD_TYPES = Object.freeze([
  "evidence",
  "rule_state",
  "work_state",
  "plan",
  "receipt"
]);

export const THRESHER_SOURCE_CODES = Object.freeze([
  "jobnimbus",
  "gmail",
  "quo",
  "google_calendar",
  "retell",
  "hcn_operator",
  "hcn_rule_engine"
]);

export const THRESHER_EVIDENCE_CODES = Object.freeze([
  "source_reachable",
  "open_task_present",
  "inspection_scheduled",
  "homeowner_confirmation_present",
  "operational_document_present",
  "claim_path_evidence_present",
  "payment_follow_up_present",
  "approval_receipt_present",
  "recent_activity_present",
  "communication_gap_detected"
]);

export const THRESHER_EVIDENCE_STATE_CODES = Object.freeze([
  "present",
  "absent",
  "unknown",
  "unavailable"
]);

export const THRESHER_RULE_CODES = Object.freeze([
  "appointment.homeowner_confirmation",
  "thresher.ready_for_pa_review",
  "documents.review_required",
  "payments.collection_follow_up",
  "sources.recovery_required",
  "execution.receipt_reconciliation",
  "claims.path_review",
  "files.communication_gap"
]);

export const THRESHER_RULE_OUTCOME_CODES = Object.freeze([
  "matched",
  "not_matched",
  "indeterminate",
  "suppressed"
]);

export const THRESHER_WORK_CODES = Object.freeze([
  "client_follow_up",
  "document_review",
  "inspection_coordination",
  "claim_path_review",
  "payment_follow_up",
  "source_recovery",
  "approval_review",
  "reconciliation"
]);

export const THRESHER_WORK_STATE_CODES = Object.freeze([
  "open",
  "blocked",
  "awaiting_approval",
  "in_progress",
  "resolved",
  "dismissed"
]);

export const THRESHER_PRIORITY_CODES = Object.freeze([
  "low",
  "normal",
  "high",
  "urgent"
]);

export const THRESHER_REASON_CODES = Object.freeze([
  "missing_fresh_evidence",
  "source_unavailable",
  "confirmation_missing",
  "review_required",
  "follow_up_due",
  "execution_unverified",
  "approval_required",
  "manual_decision_required",
  "condition_satisfied",
  "condition_not_satisfied"
]);

export const THRESHER_NEXT_ACTION_CODES = Object.freeze([
  "refresh_sources",
  "review_evidence",
  "prepare_action_batch",
  "request_approval",
  "reconcile_execution",
  "manual_review",
  "none"
]);

export const THRESHER_PLAN_CODES = Object.freeze(["action_batch"]);

export const THRESHER_PLAN_STATE_CODES = Object.freeze([
  "proposed",
  "approved",
  "rejected",
  "executed",
  "expired"
]);

export const THRESHER_OPERATION_CODES = Object.freeze([
  "jobnimbus_note",
  "jobnimbus_task",
  "jobnimbus_field_update",
  "gmail_draft",
  "gmail_send",
  "quo_message",
  "calendar_change",
  "claim_call",
  "document_upload"
]);

export const THRESHER_RECEIPT_OUTCOME_CODES = Object.freeze([
  "succeeded",
  "failed",
  "partial",
  "uncertain"
]);

const RECORD_FIELDS = Object.freeze({
  evidence: Object.freeze([
    "schemaVersion",
    "systemId",
    "recordType",
    "tenantRef",
    "fileRef",
    "evidenceRef",
    "evidenceCode",
    "stateCode",
    "sourceCode",
    "sourceRecordRef",
    "evidenceDigest",
    "observedAt",
    "checkedAt",
    "validUntil",
    "recordedAt"
  ]),
  rule_state: Object.freeze([
    "schemaVersion",
    "systemId",
    "recordType",
    "tenantRef",
    "fileRef",
    "ruleRef",
    "ruleCode",
    "ruleVersion",
    "outcomeCode",
    "reasonCode",
    "nextActionCode",
    "evidenceRefs",
    "decisionDigest",
    "evaluatedAt",
    "validUntil",
    "recordedAt"
  ]),
  work_state: Object.freeze([
    "schemaVersion",
    "systemId",
    "recordType",
    "tenantRef",
    "fileRef",
    "workRef",
    "workCode",
    "stateCode",
    "priorityCode",
    "reasonCode",
    "nextActionCode",
    "evidenceRefs",
    "ruleRefs",
    "decisionDigest",
    "createdAt",
    "updatedAt",
    "validUntil",
    "recordedAt"
  ]),
  plan: Object.freeze([
    "schemaVersion",
    "systemId",
    "recordType",
    "tenantRef",
    "fileRef",
    "planRef",
    "planCode",
    "stateCode",
    "operationCodes",
    "evidenceRefs",
    "ruleRefs",
    "approvalDigest",
    "createdAt",
    "validUntil",
    "recordedAt"
  ]),
  receipt: Object.freeze([
    "schemaVersion",
    "systemId",
    "recordType",
    "tenantRef",
    "fileRef",
    "receiptRef",
    "planRef",
    "operationCode",
    "outcomeCode",
    "sourceCode",
    "sourceRecordRef",
    "executionDigest",
    "startedAt",
    "completedAt",
    "recordedAt"
  ])
});

const SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion",
  "systemId",
  "tenantRef",
  "fileRef",
  "generatedAt",
  "authoritativeEvidence",
  "activeRuleStates",
  "activeWorkStates",
  "activePlans",
  "receipts"
]);

const REFERENCE_PATTERNS = Object.freeze({
  tenantRef: /^tenant_[a-f0-9]{16}$/,
  fileRef: /^file_[a-f0-9]{32}$/,
  evidenceRef: /^evidence_[a-f0-9]{32}$/,
  ruleRef: /^rule_[a-f0-9]{32}$/,
  workRef: /^work_[a-f0-9]{32}$/,
  planRef: /^plan_[a-f0-9]{32}$/,
  receiptRef: /^receipt_[a-f0-9]{32}$/,
  sourceRecordRef: /^source_[a-f0-9]{32}$/
});

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const MAX_REFERENCES = 64;
const MAX_OPERATIONS = 32;

export function validateEvidenceRecord(value, options = {}) {
  validateBase(value, "evidence", THRESHER_SCHEMA_VERSIONS.evidence, options);
  assertReference(value.evidenceRef, "evidenceRef", "evidence.evidenceRef");
  assertEnum(value.evidenceCode, THRESHER_EVIDENCE_CODES, "evidence.evidenceCode");
  assertEnum(
    value.stateCode,
    THRESHER_EVIDENCE_STATE_CODES,
    "evidence.stateCode"
  );
  assertEnum(value.sourceCode, THRESHER_SOURCE_CODES, "evidence.sourceCode");
  assertReference(
    value.sourceRecordRef,
    "sourceRecordRef",
    "evidence.sourceRecordRef"
  );
  assertDigest(value.evidenceDigest, "evidence.evidenceDigest");
  const observedAt = assertInstant(value.observedAt, "evidence.observedAt");
  const checkedAt = assertInstant(value.checkedAt, "evidence.checkedAt");
  const validUntil = assertInstant(value.validUntil, "evidence.validUntil");
  const recordedAt = assertInstant(value.recordedAt, "evidence.recordedAt");
  assertChronology(
    [
      [observedAt, checkedAt, "evidence.checkedAt cannot precede observedAt"],
      [checkedAt, validUntil, "evidence.validUntil cannot precede checkedAt"],
      [checkedAt, recordedAt, "evidence.recordedAt cannot precede checkedAt"]
    ]
  );
  return true;
}

export function validateRuleStateRecord(value, options = {}) {
  validateBase(
    value,
    "rule_state",
    THRESHER_SCHEMA_VERSIONS.ruleState,
    options
  );
  assertReference(value.ruleRef, "ruleRef", "ruleState.ruleRef");
  assertEnum(value.ruleCode, THRESHER_RULE_CODES, "ruleState.ruleCode");
  if (
    typeof value.ruleVersion !== "string"
    || !SEMVER_PATTERN.test(value.ruleVersion)
  ) {
    fail("ruleState.ruleVersion must be a semantic version");
  }
  assertEnum(
    value.outcomeCode,
    THRESHER_RULE_OUTCOME_CODES,
    "ruleState.outcomeCode"
  );
  assertEnum(value.reasonCode, THRESHER_REASON_CODES, "ruleState.reasonCode");
  assertEnum(
    value.nextActionCode,
    THRESHER_NEXT_ACTION_CODES,
    "ruleState.nextActionCode"
  );
  assertReferenceArray(
    value.evidenceRefs,
    "evidenceRef",
    "ruleState.evidenceRefs",
    1,
    MAX_REFERENCES
  );
  assertDigest(value.decisionDigest, "ruleState.decisionDigest");
  const evaluatedAt = assertInstant(value.evaluatedAt, "ruleState.evaluatedAt");
  const validUntil = assertInstant(value.validUntil, "ruleState.validUntil");
  const recordedAt = assertInstant(value.recordedAt, "ruleState.recordedAt");
  assertChronology([
    [evaluatedAt, validUntil, "ruleState.validUntil cannot precede evaluatedAt"],
    [evaluatedAt, recordedAt, "ruleState.recordedAt cannot precede evaluatedAt"]
  ]);
  return true;
}

export function validateWorkStateRecord(value, options = {}) {
  validateBase(
    value,
    "work_state",
    THRESHER_SCHEMA_VERSIONS.workState,
    options
  );
  assertReference(value.workRef, "workRef", "workState.workRef");
  assertEnum(value.workCode, THRESHER_WORK_CODES, "workState.workCode");
  assertEnum(
    value.stateCode,
    THRESHER_WORK_STATE_CODES,
    "workState.stateCode"
  );
  assertEnum(
    value.priorityCode,
    THRESHER_PRIORITY_CODES,
    "workState.priorityCode"
  );
  assertEnum(value.reasonCode, THRESHER_REASON_CODES, "workState.reasonCode");
  assertEnum(
    value.nextActionCode,
    THRESHER_NEXT_ACTION_CODES,
    "workState.nextActionCode"
  );
  assertReferenceArray(
    value.evidenceRefs,
    "evidenceRef",
    "workState.evidenceRefs",
    1,
    MAX_REFERENCES
  );
  assertReferenceArray(
    value.ruleRefs,
    "ruleRef",
    "workState.ruleRefs",
    0,
    MAX_REFERENCES
  );
  assertDigest(value.decisionDigest, "workState.decisionDigest");
  const createdAt = assertInstant(value.createdAt, "workState.createdAt");
  const updatedAt = assertInstant(value.updatedAt, "workState.updatedAt");
  const validUntil = assertInstant(value.validUntil, "workState.validUntil");
  const recordedAt = assertInstant(value.recordedAt, "workState.recordedAt");
  assertChronology([
    [createdAt, updatedAt, "workState.updatedAt cannot precede createdAt"],
    [updatedAt, validUntil, "workState.validUntil cannot precede updatedAt"],
    [updatedAt, recordedAt, "workState.recordedAt cannot precede updatedAt"]
  ]);
  return true;
}

export function validatePlanRecord(value, options = {}) {
  validateBase(value, "plan", THRESHER_SCHEMA_VERSIONS.plan, options);
  assertReference(value.planRef, "planRef", "plan.planRef");
  assertEnum(value.planCode, THRESHER_PLAN_CODES, "plan.planCode");
  assertEnum(value.stateCode, THRESHER_PLAN_STATE_CODES, "plan.stateCode");
  assertEnumArray(
    value.operationCodes,
    THRESHER_OPERATION_CODES,
    "plan.operationCodes",
    1,
    MAX_OPERATIONS
  );
  assertReferenceArray(
    value.evidenceRefs,
    "evidenceRef",
    "plan.evidenceRefs",
    1,
    MAX_REFERENCES
  );
  assertReferenceArray(
    value.ruleRefs,
    "ruleRef",
    "plan.ruleRefs",
    0,
    MAX_REFERENCES
  );
  assertDigest(value.approvalDigest, "plan.approvalDigest");
  const createdAt = assertInstant(value.createdAt, "plan.createdAt");
  const validUntil = assertInstant(value.validUntil, "plan.validUntil");
  const recordedAt = assertInstant(value.recordedAt, "plan.recordedAt");
  assertChronology([
    [createdAt, validUntil, "plan.validUntil cannot precede createdAt"],
    [createdAt, recordedAt, "plan.recordedAt cannot precede createdAt"]
  ]);
  return true;
}

export function validateReceiptRecord(value, options = {}) {
  validateBase(value, "receipt", THRESHER_SCHEMA_VERSIONS.receipt, options);
  assertReference(value.receiptRef, "receiptRef", "receipt.receiptRef");
  assertReference(value.planRef, "planRef", "receipt.planRef");
  assertEnum(
    value.operationCode,
    THRESHER_OPERATION_CODES,
    "receipt.operationCode"
  );
  assertEnum(
    value.outcomeCode,
    THRESHER_RECEIPT_OUTCOME_CODES,
    "receipt.outcomeCode"
  );
  assertEnum(value.sourceCode, THRESHER_SOURCE_CODES, "receipt.sourceCode");
  assertReference(
    value.sourceRecordRef,
    "sourceRecordRef",
    "receipt.sourceRecordRef"
  );
  assertDigest(value.executionDigest, "receipt.executionDigest");
  const startedAt = assertInstant(value.startedAt, "receipt.startedAt");
  const completedAt = assertInstant(value.completedAt, "receipt.completedAt");
  const recordedAt = assertInstant(value.recordedAt, "receipt.recordedAt");
  assertChronology([
    [startedAt, completedAt, "receipt.completedAt cannot precede startedAt"],
    [completedAt, recordedAt, "receipt.recordedAt cannot precede completedAt"]
  ]);
  return true;
}

export function validateThresherRecord(value, options = {}) {
  assertPlainObject(value, "record");
  switch (value.recordType) {
    case "evidence":
      return validateEvidenceRecord(value, options);
    case "rule_state":
      return validateRuleStateRecord(value, options);
    case "work_state":
      return validateWorkStateRecord(value, options);
    case "plan":
      return validatePlanRecord(value, options);
    case "receipt":
      return validateReceiptRecord(value, options);
    default:
      fail("record.recordType is not an allowed Thresher record type");
  }
}

export function buildEvidenceRecord(value, options = {}) {
  validateEvidenceRecord(value, options);
  return immutableCopy(value);
}

export function buildRuleStateRecord(value, options = {}) {
  validateRuleStateRecord(value, options);
  return immutableCopy(value);
}

export function buildWorkStateRecord(value, options = {}) {
  validateWorkStateRecord(value, options);
  return immutableCopy(value);
}

export function buildPlanRecord(value, options = {}) {
  validatePlanRecord(value, options);
  return immutableCopy(value);
}

export function buildReceiptRecord(value, options = {}) {
  validateReceiptRecord(value, options);
  return immutableCopy(value);
}

export function buildThresherRecord(value, options = {}) {
  validateThresherRecord(value, options);
  return immutableCopy(value);
}

export function buildThresherSnapshot(value, options = {}) {
  assertNoRawClientData(value);
  assertExactObject(value, SNAPSHOT_FIELDS, "snapshot");
  if (value.schemaVersion !== THRESHER_SCHEMA_VERSIONS.snapshot) {
    fail(
      `snapshot.schemaVersion must equal ${THRESHER_SCHEMA_VERSIONS.snapshot}`
    );
  }
  if (value.systemId !== THRESHER_SYSTEM_ID) {
    fail(`snapshot.systemId must equal ${THRESHER_SYSTEM_ID}`);
  }
  assertReference(value.tenantRef, "tenantRef", "snapshot.tenantRef");
  assertReference(value.fileRef, "fileRef", "snapshot.fileRef");
  assertExpectedScope(value, options, "snapshot");
  assertInstant(value.generatedAt, "snapshot.generatedAt");
  assertRecordArray(
    value.authoritativeEvidence,
    "evidence",
    value.tenantRef,
    value.fileRef,
    "snapshot.authoritativeEvidence"
  );
  assertRecordArray(
    value.activeRuleStates,
    "rule_state",
    value.tenantRef,
    value.fileRef,
    "snapshot.activeRuleStates"
  );
  assertRecordArray(
    value.activeWorkStates,
    "work_state",
    value.tenantRef,
    value.fileRef,
    "snapshot.activeWorkStates"
  );
  assertRecordArray(
    value.activePlans,
    "plan",
    value.tenantRef,
    value.fileRef,
    "snapshot.activePlans"
  );
  assertRecordArray(
    value.receipts,
    "receipt",
    value.tenantRef,
    value.fileRef,
    "snapshot.receipts"
  );
  return immutableCopy(value);
}

export function thresherRecordRef(value) {
  validateThresherRecord(value);
  switch (value.recordType) {
    case "evidence":
      return value.evidenceRef;
    case "rule_state":
      return value.ruleRef;
    case "work_state":
      return value.workRef;
    case "plan":
      return value.planRef;
    case "receipt":
      return value.receiptRef;
    default:
      fail("record.recordType is not an allowed Thresher record type");
  }
}

export class ThresherContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ThresherContractError";
  }
}

function validateBase(value, recordType, schemaVersion, options) {
  assertNoRawClientData(value);
  assertExactObject(value, RECORD_FIELDS[recordType], recordType);
  if (value.schemaVersion !== schemaVersion) {
    fail(`${recordType}.schemaVersion must equal ${schemaVersion}`);
  }
  if (value.systemId !== THRESHER_SYSTEM_ID) {
    fail(`${recordType}.systemId must equal ${THRESHER_SYSTEM_ID}`);
  }
  if (value.recordType !== recordType) {
    fail(`${recordType}.recordType must equal ${recordType}`);
  }
  assertReference(value.tenantRef, "tenantRef", `${recordType}.tenantRef`);
  assertReference(value.fileRef, "fileRef", `${recordType}.fileRef`);
  assertExpectedScope(value, options, recordType);
}

function assertExpectedScope(value, options, path) {
  if (options.tenantRef !== undefined && value.tenantRef !== options.tenantRef) {
    fail(`${path}.tenantRef does not match the trusted tenant`);
  }
  if (options.fileRef !== undefined && value.fileRef !== options.fileRef) {
    fail(`${path}.fileRef does not match the trusted file`);
  }
}

function assertRecordArray(value, recordType, tenantRef, fileRef, path) {
  if (!Array.isArray(value) || value.length > 512) {
    fail(`${path} must be an array with at most 512 records`);
  }
  const references = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const record = value[index];
    validateThresherRecord(record, { tenantRef, fileRef });
    if (record.recordType !== recordType) {
      fail(`${path}[${index}] must be a ${recordType} record`);
    }
    const reference = thresherRecordRef(record);
    if (references.has(reference)) {
      fail(`${path} cannot contain duplicate record references`);
    }
    references.add(reference);
  }
}

function assertNoRawClientData(value, path = "record", seen = new Set()) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(value)) {
      fail(`${path} contains an email address`);
    }
    if (/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]?\d{4}\b/.test(value)) {
      fail(`${path} contains a phone number`);
    }
    if (
      /\b\d{1,6}\s+(?:[A-Za-z]+\s+){1,4}(?:st|street|dr|drive|ln|lane|ave|avenue|rd|road|ct|court|blvd|boulevard|way|cir|circle|pkwy|parkway|pl|place|trl|trail)\b\.?/i.test(
        value
      )
    ) {
      fail(`${path} contains a street address`);
    }
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) fail(`${path} contains a cyclic value`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoRawClientData(item, `${path}[${index}]`, seen)
    );
  } else {
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        /^(?:name|firstname|lastname|fullname|displayname|homeownername|insuredname|clientname|customername|contactname|address|street|streetaddress|city|zipcode|postalcode|email|emailaddress|phone|phonenumber|policy|policynumber|policyvalue|claim|claimnumber|claimvalue|message|messagebody|body|snippet|subjectline|transcript|document|documents|documentbody|documentcontent|attachment|attachments|content|raw|text|note|notes|description|summary)$/.test(
          normalized
        )
      ) {
        fail(`${path}.${key} is a forbidden raw client-content field`);
      }
      assertNoRawClientData(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertExactObject(value, fields, path) {
  const keys = assertPlainObject(value, path);
  if (
    fields.some((field) => !keys.includes(field))
    || keys.some((field) => !fields.includes(field))
  ) {
    fail(`${path} must contain only its documented exact fields`);
  }
}

function assertPlainObject(value, path) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    fail(`${path} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail(`${path} must contain string keys only`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      fail(`${path} must contain plain enumerable fields`);
    }
  }
  return keys;
}

function assertReference(value, type, path) {
  if (typeof value !== "string" || !REFERENCE_PATTERNS[type]?.test(value)) {
    fail(`${path} must be an opaque ${type}`);
  }
}

function assertReferenceArray(value, type, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${path} must contain between ${min} and ${max} opaque references`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${path} cannot contain duplicate references`);
  }
  value.forEach((item, index) =>
    assertReference(item, type, `${path}[${index}]`)
  );
}

function assertEnumArray(value, allowed, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${path} must contain between ${min} and ${max} coded values`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${path} cannot contain duplicates`);
  }
  value.forEach((item, index) => assertEnum(item, allowed, `${path}[${index}]`));
}

function assertEnum(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(`${path} must be one of ${allowed.join("/")}`);
  }
}

function assertDigest(value, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(`${path} must be a lowercase SHA-256 digest`);
  }
}

function assertInstant(value, path) {
  if (
    typeof value !== "string"
    || !ISO_INSTANT_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail(`${path} must be a canonical UTC timestamp`);
  }
  return Date.parse(value);
}

function assertChronology(checks) {
  for (const [earlier, later, message] of checks) {
    if (later < earlier) fail(message);
  }
}

function immutableCopy(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableCopy(item)));
  }
  if (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
  ) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutableCopy(item)])
      )
    );
  }
  return value;
}

function fail(message) {
  throw new ThresherContractError(message);
}
