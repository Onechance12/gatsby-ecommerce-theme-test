/**
 * HCN Operations v2 minimized contracts.
 *
 * These contracts contain coded operational state and opaque references only.
 * They deliberately provide no free-text field for client content. The module
 * is dependency-free so the same fail-closed validation can run at API,
 * persistence, worker, and test boundaries.
 */

export const HCN_SYSTEM_ID = "hcn_operations";
export const HCN_API_VERSION = "v2";

export const HCN_SCHEMA_VERSIONS = Object.freeze({
  subjectRef: "hcn.subject-ref.v2",
  sourceObservation: "hcn.source-observation.v2",
  workItem: "hcn.work-item.v2",
  ruleEvaluation: "hcn.rule-evaluation.v2",
  apiEnvelope: "hcn.api-envelope.v2"
});

export const HCN_SUBJECT_TYPES = Object.freeze(["hcn_file"]);
export const HCN_SOURCE_SYSTEMS = Object.freeze([
  "jobnimbus",
  "gmail",
  "quo",
  "google_calendar",
  "retell",
  "hcn_rule_engine",
  "hcn_operator"
]);
export const HCN_FRESHNESS_STATUSES = Object.freeze([
  "fresh",
  "stale",
  "unavailable",
  "unknown"
]);
export const HCN_OBSERVATION_TYPES = Object.freeze([
  "source_reachable",
  "open_task_present",
  "inspection_scheduled",
  "homeowner_confirmation_present",
  "operational_document_present",
  "claim_path_evidence_present",
  "payment_follow_up_present",
  "approval_receipt_present"
]);
export const HCN_OBSERVATION_STATES = Object.freeze([
  "present",
  "absent",
  "unknown",
  "not_applicable"
]);
export const HCN_WORK_TYPES = Object.freeze([
  "client_follow_up",
  "document_review",
  "inspection_coordination",
  "claim_path_review",
  "payment_follow_up",
  "source_recovery",
  "approval_review",
  "reconciliation"
]);
export const HCN_WORK_STATUSES = Object.freeze([
  "open",
  "blocked",
  "awaiting_approval",
  "in_progress",
  "resolved",
  "dismissed"
]);
export const HCN_PRIORITIES = Object.freeze(["low", "normal", "high", "urgent"]);
export const HCN_REASON_CODES = Object.freeze([
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
export const HCN_NEXT_ACTION_CODES = Object.freeze([
  "refresh_sources",
  "review_evidence",
  "prepare_action_batch",
  "request_approval",
  "reconcile_execution",
  "manual_review",
  "none"
]);
export const HCN_RULE_IDS = Object.freeze([
  "appointment.homeowner_confirmation",
  "thresher.ready_for_pa_review",
  "documents.review_required",
  "payments.collection_follow_up",
  "sources.recovery_required",
  "execution.receipt_reconciliation",
  "claims.path_review"
]);
export const HCN_RULE_OUTCOMES = Object.freeze([
  "matched",
  "not_matched",
  "indeterminate",
  "suppressed"
]);
export const HCN_ENVELOPE_DATA_TYPES = Object.freeze([
  "subject_ref",
  "source_observation",
  "work_item",
  "rule_evaluation"
]);

const SUBJECT_FIELDS = Object.freeze([
  "schemaVersion",
  "systemId",
  "tenantId",
  "subjectType",
  "subjectId"
]);
const FRESHNESS_FIELDS = Object.freeze([
  "status",
  "asOf",
  "checkedAt",
  "validUntil"
]);
const PROVENANCE_FIELDS = Object.freeze([
  "systemId",
  "tenantId",
  "sourceSystem",
  "sourceRecordRef",
  "traceId",
  "evidenceDigest",
  "recordedAt"
]);
const OBSERVATION_FIELDS = Object.freeze([
  "schemaVersion",
  "systemId",
  "tenantId",
  "observationId",
  "subject",
  "observationType",
  "state",
  "provenance",
  "freshness"
]);
const WORK_ITEM_FIELDS = Object.freeze([
  "schemaVersion",
  "systemId",
  "tenantId",
  "workItemId",
  "subject",
  "workType",
  "status",
  "priority",
  "reasonCode",
  "nextActionCode",
  "observationIds",
  "ruleEvaluationIds",
  "dueAt",
  "createdAt",
  "updatedAt",
  "provenance",
  "freshness"
]);
const RULE_EVALUATION_FIELDS = Object.freeze([
  "schemaVersion",
  "systemId",
  "tenantId",
  "evaluationId",
  "subject",
  "ruleId",
  "ruleVersion",
  "outcome",
  "reasonCode",
  "nextActionCode",
  "observationIds",
  "evaluatedAt",
  "provenance",
  "freshness"
]);
const API_ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion",
  "systemId",
  "apiVersion",
  "tenantId",
  "requestId",
  "generatedAt",
  "dataType",
  "items",
  "provenance",
  "freshness"
]);

const FORBIDDEN_RAW_FIELD_NAMES = new Set([
  "name",
  "firstname",
  "lastname",
  "fullname",
  "displayname",
  "homeownername",
  "insuredname",
  "clientname",
  "customername",
  "contactname",
  "address",
  "street",
  "streetaddress",
  "city",
  "zipcode",
  "postalcode",
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "policy",
  "policynumber",
  "policyvalue",
  "claim",
  "claimnumber",
  "claimvalue",
  "message",
  "messagebody",
  "body",
  "snippet",
  "subjectline",
  "transcript",
  "document",
  "documents",
  "documentbody",
  "documentcontent",
  "attachment",
  "attachments",
  "content",
  "raw",
  "text",
  "note",
  "notes",
  "description",
  "summary"
]);

const OPAQUE_ID_PATTERNS = Object.freeze({
  tenantId: /^tenant_[a-f0-9]{16}$/,
  subjectId: /^subject_[a-f0-9]{32}$/,
  observationId: /^obs_[a-f0-9]{32}$/,
  workItemId: /^work_[a-f0-9]{32}$/,
  evaluationId: /^eval_[a-f0-9]{32}$/,
  requestId: /^request_[a-f0-9]{32}$/,
  traceId: /^trace_[a-f0-9]{32}$/,
  sourceRecordRef: /^ref_[a-f0-9]{32}$/
});

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]?\d{4}\b/;
const ADDRESS_PATTERN =
  /\b\d{1,6}\s+(?:[A-Za-z]+\s+){1,4}(?:st|street|dr|drive|ln|lane|ave|avenue|rd|road|ct|court|blvd|boulevard|way|cir|circle|pkwy|parkway|pl|place|trl|trail)\b\.?/i;

export function validateSubjectRef(value, options = {}) {
  assertNoRawClientData(value);
  assertExactObject(value, SUBJECT_FIELDS, "subject");
  assertSchema(value.schemaVersion, HCN_SCHEMA_VERSIONS.subjectRef, "subject");
  assertSystem(value.systemId, "subject");
  assertOpaqueId(value.tenantId, "tenantId", "subject.tenantId");
  assertExpectedTenant(value.tenantId, options.tenantId, "subject.tenantId");
  assertEnum(value.subjectType, HCN_SUBJECT_TYPES, "subject.subjectType");
  assertOpaqueId(value.subjectId, "subjectId", "subject.subjectId");
  return true;
}

export function buildSubjectRef(input, options = {}) {
  const tenantId = requireExpectedTenant(options, "buildSubjectRef");
  validateSubjectRef(input, { tenantId });
  return immutableCopy(input);
}

export function validateSourceObservation(value, options = {}) {
  assertNoRawClientData(value);
  assertExactObject(value, OBSERVATION_FIELDS, "sourceObservation");
  assertSchema(
    value.schemaVersion,
    HCN_SCHEMA_VERSIONS.sourceObservation,
    "sourceObservation"
  );
  assertSystem(value.systemId, "sourceObservation");
  assertOpaqueId(value.tenantId, "tenantId", "sourceObservation.tenantId");
  assertExpectedTenant(
    value.tenantId,
    options.tenantId,
    "sourceObservation.tenantId"
  );
  assertOpaqueId(
    value.observationId,
    "observationId",
    "sourceObservation.observationId"
  );
  validateSubjectRef(value.subject, { tenantId: value.tenantId });
  assertEnum(
    value.observationType,
    HCN_OBSERVATION_TYPES,
    "sourceObservation.observationType"
  );
  assertEnum(value.state, HCN_OBSERVATION_STATES, "sourceObservation.state");
  validateProvenance(value.provenance, value.tenantId, "sourceObservation.provenance");
  validateFreshness(value.freshness, "sourceObservation.freshness");
  validateEvidenceChronology(
    value.provenance,
    value.freshness,
    "sourceObservation"
  );
  return true;
}

export function buildSourceObservation(input, options = {}) {
  const tenantId = requireExpectedTenant(options, "buildSourceObservation");
  validateSourceObservation(input, { tenantId });
  return immutableCopy(input);
}

export function validateWorkItem(value, options = {}) {
  assertNoRawClientData(value);
  assertExactObject(value, WORK_ITEM_FIELDS, "workItem");
  assertSchema(value.schemaVersion, HCN_SCHEMA_VERSIONS.workItem, "workItem");
  assertSystem(value.systemId, "workItem");
  assertOpaqueId(value.tenantId, "tenantId", "workItem.tenantId");
  assertExpectedTenant(value.tenantId, options.tenantId, "workItem.tenantId");
  assertOpaqueId(value.workItemId, "workItemId", "workItem.workItemId");
  validateSubjectRef(value.subject, { tenantId: value.tenantId });
  assertEnum(value.workType, HCN_WORK_TYPES, "workItem.workType");
  assertEnum(value.status, HCN_WORK_STATUSES, "workItem.status");
  assertEnum(value.priority, HCN_PRIORITIES, "workItem.priority");
  assertEnum(value.reasonCode, HCN_REASON_CODES, "workItem.reasonCode");
  assertEnum(
    value.nextActionCode,
    HCN_NEXT_ACTION_CODES,
    "workItem.nextActionCode"
  );
  assertOpaqueIdArray(
    value.observationIds,
    "observationId",
    "workItem.observationIds",
    { min: 1, max: 64 }
  );
  assertOpaqueIdArray(
    value.ruleEvaluationIds,
    "evaluationId",
    "workItem.ruleEvaluationIds",
    { min: 0, max: 64 }
  );
  assertNullableTimestamp(value.dueAt, "workItem.dueAt");
  assertTimestamp(value.createdAt, "workItem.createdAt");
  assertTimestamp(value.updatedAt, "workItem.updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    fail("workItem.updatedAt cannot precede workItem.createdAt");
  }
  validateProvenance(value.provenance, value.tenantId, "workItem.provenance");
  validateFreshness(value.freshness, "workItem.freshness");
  validateEvidenceChronology(value.provenance, value.freshness, "workItem");
  return true;
}

export function buildWorkItem(input, options = {}) {
  const tenantId = requireExpectedTenant(options, "buildWorkItem");
  validateWorkItem(input, { tenantId });
  return immutableCopy(input);
}

export function validateRuleEvaluation(value, options = {}) {
  assertNoRawClientData(value);
  assertExactObject(value, RULE_EVALUATION_FIELDS, "ruleEvaluation");
  assertSchema(
    value.schemaVersion,
    HCN_SCHEMA_VERSIONS.ruleEvaluation,
    "ruleEvaluation"
  );
  assertSystem(value.systemId, "ruleEvaluation");
  assertOpaqueId(value.tenantId, "tenantId", "ruleEvaluation.tenantId");
  assertExpectedTenant(
    value.tenantId,
    options.tenantId,
    "ruleEvaluation.tenantId"
  );
  assertOpaqueId(
    value.evaluationId,
    "evaluationId",
    "ruleEvaluation.evaluationId"
  );
  validateSubjectRef(value.subject, { tenantId: value.tenantId });
  assertEnum(value.ruleId, HCN_RULE_IDS, "ruleEvaluation.ruleId");
  if (typeof value.ruleVersion !== "string" || !SEMVER_PATTERN.test(value.ruleVersion)) {
    fail("ruleEvaluation.ruleVersion must be a semantic version");
  }
  assertEnum(value.outcome, HCN_RULE_OUTCOMES, "ruleEvaluation.outcome");
  assertEnum(value.reasonCode, HCN_REASON_CODES, "ruleEvaluation.reasonCode");
  assertEnum(
    value.nextActionCode,
    HCN_NEXT_ACTION_CODES,
    "ruleEvaluation.nextActionCode"
  );
  assertOpaqueIdArray(
    value.observationIds,
    "observationId",
    "ruleEvaluation.observationIds",
    { min: 1, max: 64 }
  );
  assertTimestamp(value.evaluatedAt, "ruleEvaluation.evaluatedAt");
  validateProvenance(value.provenance, value.tenantId, "ruleEvaluation.provenance");
  validateFreshness(value.freshness, "ruleEvaluation.freshness");
  validateEvidenceChronology(
    value.provenance,
    value.freshness,
    "ruleEvaluation"
  );
  return true;
}

export function buildRuleEvaluation(input, options = {}) {
  const tenantId = requireExpectedTenant(options, "buildRuleEvaluation");
  validateRuleEvaluation(input, { tenantId });
  return immutableCopy(input);
}

export function validateApiEnvelope(value, options = {}) {
  assertNoRawClientData(value);
  assertExactObject(value, API_ENVELOPE_FIELDS, "apiEnvelope");
  assertSchema(value.schemaVersion, HCN_SCHEMA_VERSIONS.apiEnvelope, "apiEnvelope");
  assertSystem(value.systemId, "apiEnvelope");
  if (value.apiVersion !== HCN_API_VERSION) {
    fail(`apiEnvelope.apiVersion must equal ${HCN_API_VERSION}`);
  }
  assertOpaqueId(value.tenantId, "tenantId", "apiEnvelope.tenantId");
  assertExpectedTenant(value.tenantId, options.tenantId, "apiEnvelope.tenantId");
  assertOpaqueId(value.requestId, "requestId", "apiEnvelope.requestId");
  assertTimestamp(value.generatedAt, "apiEnvelope.generatedAt");
  assertEnum(
    value.dataType,
    HCN_ENVELOPE_DATA_TYPES,
    "apiEnvelope.dataType"
  );
  if (!Array.isArray(value.items) || value.items.length > 250) {
    fail("apiEnvelope.items must be an array with at most 250 items");
  }
  const validator = envelopeItemValidator(value.dataType);
  value.items.forEach((item, index) => {
    try {
      validator(item, { tenantId: value.tenantId });
    } catch (error) {
      throw new HcnContractError(`apiEnvelope.items[${index}]: ${error.message}`);
    }
  });
  validateProvenance(value.provenance, value.tenantId, "apiEnvelope.provenance");
  validateFreshness(value.freshness, "apiEnvelope.freshness");
  validateEvidenceChronology(value.provenance, value.freshness, "apiEnvelope");
  return true;
}

export function buildApiEnvelope(input, options = {}) {
  const tenantId = requireExpectedTenant(options, "buildApiEnvelope");
  validateApiEnvelope(input, { tenantId });
  return immutableCopy(input);
}

export class HcnContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "HcnContractError";
  }
}

function validateFreshness(value, path) {
  assertExactObject(value, FRESHNESS_FIELDS, path);
  assertEnum(value.status, HCN_FRESHNESS_STATUSES, `${path}.status`);
  assertTimestamp(value.asOf, `${path}.asOf`);
  assertTimestamp(value.checkedAt, `${path}.checkedAt`);
  assertTimestamp(value.validUntil, `${path}.validUntil`);
  if (Date.parse(value.checkedAt) < Date.parse(value.asOf)) {
    fail(`${path}.checkedAt cannot precede ${path}.asOf`);
  }
  if (Date.parse(value.validUntil) < Date.parse(value.checkedAt)) {
    fail(`${path}.validUntil cannot precede ${path}.checkedAt`);
  }
}

function validateProvenance(value, tenantId, path) {
  assertExactObject(value, PROVENANCE_FIELDS, path);
  assertSystem(value.systemId, path);
  assertOpaqueId(value.tenantId, "tenantId", `${path}.tenantId`);
  assertExpectedTenant(value.tenantId, tenantId, `${path}.tenantId`);
  assertEnum(value.sourceSystem, HCN_SOURCE_SYSTEMS, `${path}.sourceSystem`);
  assertOpaqueId(
    value.sourceRecordRef,
    "sourceRecordRef",
    `${path}.sourceRecordRef`
  );
  assertOpaqueId(value.traceId, "traceId", `${path}.traceId`);
  if (
    typeof value.evidenceDigest !== "string" ||
    !SHA256_PATTERN.test(value.evidenceDigest)
  ) {
    fail(`${path}.evidenceDigest must be a lowercase SHA-256 digest`);
  }
  assertTimestamp(value.recordedAt, `${path}.recordedAt`);
}

function validateEvidenceChronology(provenance, freshness, path) {
  if (Date.parse(provenance.recordedAt) < Date.parse(freshness.asOf)) {
    fail(`${path}.provenance.recordedAt cannot precede ${path}.freshness.asOf`);
  }
}

function envelopeItemValidator(dataType) {
  switch (dataType) {
    case "subject_ref":
      return validateSubjectRef;
    case "source_observation":
      return validateSourceObservation;
    case "work_item":
      return validateWorkItem;
    case "rule_evaluation":
      return validateRuleEvaluation;
    default:
      fail(`unsupported apiEnvelope.dataType: ${dataType}`);
  }
}

function assertNoRawClientData(value, path = "contract", seen = new Set()) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (EMAIL_PATTERN.test(value)) fail(`${path} contains an email address`);
    if (PHONE_PATTERN.test(value)) fail(`${path} contains a phone number`);
    if (ADDRESS_PATTERN.test(value)) fail(`${path} contains a street address`);
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
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (FORBIDDEN_RAW_FIELD_NAMES.has(normalizedKey)) {
        fail(`${path}.${key} is a forbidden raw client-content field`);
      }
      assertNoRawClientData(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertExactObject(value, allowedFields, path) {
  if (!isPlainObject(value)) fail(`${path} must be a plain object`);
  const actual = Object.keys(value);
  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      fail(`${path}.${field} is required`);
    }
  }
  for (const field of actual) {
    if (!allowedFields.includes(field)) {
      fail(`${path}.${field} is not allowed`);
    }
  }
}

function assertSchema(actual, expected, path) {
  if (actual !== expected) fail(`${path}.schemaVersion must equal ${expected}`);
}

function assertSystem(actual, path) {
  if (actual !== HCN_SYSTEM_ID) {
    fail(`${path}.systemId must equal ${HCN_SYSTEM_ID}`);
  }
}

function assertExpectedTenant(actual, expected, path) {
  if (expected !== undefined && actual !== expected) {
    fail(`${path} does not match the expected HCN tenant`);
  }
}

function requireExpectedTenant(options, path) {
  const candidate = isPlainObject(options) ? options.tenantId : undefined;
  assertOpaqueId(candidate, "tenantId", `${path}.options.tenantId`);
  return candidate;
}

function assertOpaqueId(value, type, path) {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERNS[type]?.test(value)) {
    fail(`${path} must be an opaque ${type}`);
  }
}

function assertOpaqueIdArray(value, type, path, { min, max }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${path} must contain between ${min} and ${max} opaque references`);
  }
  const unique = new Set(value);
  if (unique.size !== value.length) fail(`${path} cannot contain duplicates`);
  value.forEach((item, index) => assertOpaqueId(item, type, `${path}[${index}]`));
}

function assertEnum(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(`${path} must be one of ${allowed.join("/")}`);
  }
}

function assertTimestamp(value, path) {
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (
    typeof value !== "string"
    || !ISO_UTC_PATTERN.test(value)
    || !parsed
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString() !== value
  ) {
    fail(`${path} must be an ISO-8601 UTC timestamp with milliseconds`);
  }
}

function assertNullableTimestamp(value, path) {
  if (value !== null) assertTimestamp(value, path);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutableCopy(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutableCopy(item)));
  }
  if (isPlainObject(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutableCopy(item)])
      )
    );
  }
  return value;
}

function fail(message) {
  throw new HcnContractError(message);
}
