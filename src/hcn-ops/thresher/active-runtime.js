import {
  createHmac,
  timingSafeEqual
} from "node:crypto";

import {
  THRESHER_SCHEMA_VERSIONS,
  THRESHER_SYSTEM_ID
} from "./contracts.js";

const TENANT_REF_PATTERN = /^tenant_[a-f0-9]{16}$/;
const PRINCIPAL_REF_PATTERN = /^principal_[a-f0-9]{64}$/;
const HCN_FILE_REF_PATTERN = /^subject_[a-f0-9]{32}$/;
const PLAN_ID_PATTERN = /^plan_[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MIN_KEY_BYTES = 32;
const MAX_KEY_BYTES = 128;
const MAX_OPERATION_TYPES = 12;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const OPERATION_CODE_BY_TYPE = Object.freeze({
  "jobnimbus.create_note": "jobnimbus_note",
  "jobnimbus.create_task": "jobnimbus_task",
  "jobnimbus.update_task": "jobnimbus_task",
  "jobnimbus.update_status": "jobnimbus_field_update",
  "jobnimbus.update_contact": "jobnimbus_field_update",
  "jobnimbus.create_calendar_event": "calendar_change",
  "jobnimbus.update_calendar_event": "calendar_change",
  "gmail.create_draft": "gmail_draft",
  "gmail.send": "gmail_send",
  "quo.send_text": "quo_message"
});

const SOURCE_CODE_BY_OPERATION = Object.freeze({
  jobnimbus_note: "jobnimbus",
  jobnimbus_task: "jobnimbus",
  jobnimbus_field_update: "jobnimbus",
  calendar_change: "jobnimbus",
  gmail_draft: "gmail",
  gmail_send: "gmail",
  quo_message: "quo"
});

/**
 * Active deterministic lifecycle adapter for the isolated Thresher store.
 *
 * This runtime has no provider, network, model, or action callback. It can
 * only minimize an already-authorized fresh review, persist coded plan/receipt
 * metadata, and return an opaque immutable snapshot.
 */
export function createActiveThresherRuntime({
  store,
  tenantRef,
  referenceKey,
  signingKey,
  now = Date.now
} = {}) {
  assertStore(store);
  requirePattern(tenantRef, TENANT_REF_PATTERN, "tenantRef");
  const referenceKeyBytes = decodeKey(referenceKey, "referenceKey");
  const signingKeyBytes = decodeKey(signingKey, "signingKey");
  if (equalBytes(referenceKeyBytes, signingKeyBytes)) {
    referenceKeyBytes.fill(0);
    signingKeyBytes.fill(0);
    configurationError(
      "referenceKey and signingKey must be independently generated."
    );
  }
  if (typeof now !== "function") {
    referenceKeyBytes.fill(0);
    signingKeyBytes.fill(0);
    throw new TypeError("now must be a function");
  }
  let closed = false;

  async function recordFileReview(input) {
    assertOpen();
    exactInput(input, ["principalRef", "fileRef", "review"], "file review");
    const scope = scopedFile(
      input.principalRef,
      input.fileRef
    );
    const timestamp = readNow(now);
    const minimized = minimizeFreshReview(
      input.review,
      scope,
      timestamp
    );
    const existing = await store.snapshot({
      tenantRef,
      fileRef: scope.fileRef
    });
    if (
      existing.authoritativeEvidence.some(
        (record) =>
          Date.parse(record.checkedAt)
          > Date.parse(minimized.checkedAt)
      )
    ) {
      staleError(
        "Older JobNimbus evidence cannot replace the active exact-file state."
      );
    }
    await store.putMany(minimized.records);
    return project(
      await store.snapshot({
        tenantRef,
        fileRef: scope.fileRef
      }),
      "file_review_recorded"
    );
  }

  async function recordActionPlan(input) {
    assertOpen();
    exactInput(
      input,
      [
        "principalRef",
        "fileRef",
        "planId",
        "approvalDigest",
        "approvalExpiresAt",
        "operationTypes",
        "stateCode",
        "createdAt"
      ],
      "action plan"
    );
    const scope = scopedFile(input.principalRef, input.fileRef);
    requirePattern(input.planId, PLAN_ID_PATTERN, "planId");
    requirePattern(input.approvalDigest, DIGEST_PATTERN, "approvalDigest");
    if (!["proposed", "approved"].includes(input.stateCode)) {
      inputError("stateCode must be proposed or approved.");
    }
    const createdAt = requireInstant(input.createdAt, "createdAt");
    const approvalExpiresAt = requireInstant(
      input.approvalExpiresAt,
      "approvalExpiresAt"
    );
    if (approvalExpiresAt <= createdAt) {
      inputError("approvalExpiresAt must follow createdAt.");
    }
    const timestamp = readNow(now);
    if (
      createdAt > timestamp + MAX_FUTURE_SKEW_MS
      || approvalExpiresAt <= timestamp
    ) {
      staleError("The exact action plan is not current.");
    }
    const operationCodes = operationCodesFromTypes(input.operationTypes);
    const snapshot = await store.snapshot({
      tenantRef,
      fileRef: scope.fileRef
    });
    if (snapshot.authoritativeEvidence.length < 1) {
      staleError(
        "Fresh exact-file evidence is required before an action plan can be recorded."
      );
    }
    const dependencyExpiry = [
      ...snapshot.authoritativeEvidence,
      ...snapshot.activeRuleStates
    ].reduce(
      (earliest, record) =>
        Math.min(earliest, Date.parse(record.validUntil)),
      approvalExpiresAt
    );
    if (dependencyExpiry <= timestamp) {
      staleError("The exact action plan dependencies are no longer current.");
    }
    const planRef = reference(
      "plan",
      "action-plan",
      scope.principalRef,
      input.fileRef,
      input.planId,
      input.stateCode
    );
    const record = {
      schemaVersion: THRESHER_SCHEMA_VERSIONS.plan,
      systemId: THRESHER_SYSTEM_ID,
      recordType: "plan",
      tenantRef,
      fileRef: scope.fileRef,
      planRef,
      planCode: "action_batch",
      stateCode: input.stateCode,
      operationCodes,
      evidenceRefs: snapshot.authoritativeEvidence.map(
        (evidence) => evidence.evidenceRef
      ),
      ruleRefs: snapshot.activeRuleStates.map(
        (rule) => rule.ruleRef
      ),
      approvalDigest: `sha256:${input.approvalDigest}`,
      createdAt: new Date(createdAt).toISOString(),
      validUntil: new Date(dependencyExpiry).toISOString(),
      recordedAt: new Date(createdAt).toISOString()
    };
    await store.put(record);
    return Object.freeze({
      systemId: THRESHER_SYSTEM_ID,
      status: "action_plan_recorded",
      planRef,
      stateCode: input.stateCode,
      persisted: true,
      authorizesAction: false
    });
  }

  async function recordActionReceipts(input) {
    assertOpen();
    exactInput(
      input,
      [
        "principalRef",
        "fileRef",
        "planId",
        "operationTypes",
        "outcomeCode",
        "startedAt",
        "completedAt"
      ],
      "action receipt"
    );
    const scope = scopedFile(input.principalRef, input.fileRef);
    requirePattern(input.planId, PLAN_ID_PATTERN, "planId");
    if (!["succeeded", "failed", "partial", "uncertain"].includes(
      input.outcomeCode
    )) {
      inputError("outcomeCode is not an allowed terminal outcome.");
    }
    const startedAt = requireInstant(input.startedAt, "startedAt");
    const completedAt = requireInstant(input.completedAt, "completedAt");
    if (completedAt < startedAt) {
      inputError("completedAt cannot precede startedAt.");
    }
    const timestamp = readNow(now);
    if (completedAt > timestamp + MAX_FUTURE_SKEW_MS) {
      inputError("completedAt is materially future-dated.");
    }
    const operationCodes = operationCodesFromTypes(input.operationTypes);
    const approvedPlanRef = reference(
      "plan",
      "action-plan",
      scope.principalRef,
      input.fileRef,
      input.planId,
      "approved"
    );
    const records = operationCodes.map((operationCode) => {
      const receiptRef = reference(
        "receipt",
        "action-receipt",
        approvedPlanRef,
        operationCode
      );
      const sourceCode = SOURCE_CODE_BY_OPERATION[operationCode];
      return {
        schemaVersion: THRESHER_SCHEMA_VERSIONS.receipt,
        systemId: THRESHER_SYSTEM_ID,
        recordType: "receipt",
        tenantRef,
        fileRef: scope.fileRef,
        receiptRef,
        planRef: approvedPlanRef,
        operationCode,
        outcomeCode: input.outcomeCode,
        sourceCode,
        sourceRecordRef: reference(
          "source",
          "receipt-source",
          approvedPlanRef,
          operationCode
        ),
        executionDigest: signedDigest({
          kind: "action_receipt",
          planRef: approvedPlanRef,
          operationCode,
          outcomeCode: input.outcomeCode,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date(completedAt).toISOString()
        }),
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        recordedAt: new Date(completedAt).toISOString()
      };
    });
    await store.putMany(records);
    return Object.freeze({
      systemId: THRESHER_SYSTEM_ID,
      status: "action_receipts_recorded",
      persisted: true,
      receiptCount: records.length,
      authorizesAction: false
    });
  }

  async function snapshot(input) {
    assertOpen();
    exactInput(input, ["principalRef", "fileRef"], "snapshot");
    const scope = scopedFile(input.principalRef, input.fileRef);
    return project(
      await store.snapshot({
        tenantRef,
        fileRef: scope.fileRef
      }),
      "active"
    );
  }

  function close() {
    if (closed) return;
    closed = true;
    referenceKeyBytes.fill(0);
    signingKeyBytes.fill(0);
    store.close();
  }

  function assertOpen() {
    if (closed) {
      throw new ActiveThresherRuntimeError(
        "closed",
        "The active Thresher runtime is closed."
      );
    }
  }

  function scopedFile(principalRef, publicFileRef) {
    requirePattern(
      principalRef,
      PRINCIPAL_REF_PATTERN,
      "principalRef"
    );
    requirePattern(publicFileRef, HCN_FILE_REF_PATTERN, "fileRef");
    return {
      principalRef,
      publicFileRef,
      fileRef: reference(
        "file",
        "principal-file",
        principalRef,
        publicFileRef
      )
    };
  }

  function minimizeFreshReview(review, scope, timestamp) {
    if (!isPlainObject(review)) inputError("review must be a plain object.");
    const generatedAt = requireInstant(review.generatedAt, "review.generatedAt");
    if (generatedAt > timestamp + MAX_FUTURE_SKEW_MS) {
      staleError("The fresh review is future-dated.");
    }
    if (review?.file?.fileRef === undefined) {
      inputError("review.file.fileRef is required.");
    }
    requirePattern(review.file.fileRef, HCN_FILE_REF_PATTERN, "review.file.fileRef");
    const publicFileRef = referenceInputFile(scope);
    if (review.file.fileRef !== publicFileRef) {
      inputError("The fresh review resolves to a different file.");
    }
    const source = requireFreshJobNimbusSource(
      review.sources?.jobnimbus,
      timestamp
    );
    const recent = isPlainObject(review.recent) ? review.recent : {};
    const tasks = Array.isArray(recent.tasks) ? recent.tasks : [];
    const documents = Array.isArray(recent.documents)
      ? recent.documents
      : [];
    const activities = Array.isArray(recent.activities)
      ? recent.activities
      : [];
    const missing = isPlainObject(review.file?.missing)
      ? review.file.missing
      : {};
    const hasMissingClaimFacts = [
      "claimNumber",
      "policyNumber",
      "dateOfLoss",
      "adjuster"
    ].some((key) => missing[key] === true);
    const hasOpenTask = tasks.some((task) =>
      ["open", "in_progress", "blocked"].includes(
        String(task?.status || "")
      )
    );
    const hasReviewDocument = documents.some((document) =>
      ["needs_review", "in_review", "unreviewed"].includes(
        String(document?.reviewState || "")
      )
    );
    const hasAppointment =
      typeof review.file?.nextAppointmentAt === "string";
    const evidenceSpecs = [
      ["source_reachable", "present"],
      ["recent_activity_present", activities.length ? "present" : "absent"],
      ["open_task_present", hasOpenTask ? "present" : "absent"],
      [
        "operational_document_present",
        hasReviewDocument ? "present" : "absent"
      ],
      [
        "inspection_scheduled",
        hasAppointment ? "present" : "absent"
      ],
      [
        "claim_path_evidence_present",
        hasMissingClaimFacts ? "absent" : "present"
      ]
    ];
    const recordedAt = new Date(generatedAt).toISOString();
    const evidenceRecords = evidenceSpecs.map(
      ([evidenceCode, stateCode]) => {
        const evidenceRef = reference(
          "evidence",
          "review-evidence",
          scope.fileRef,
          evidenceCode,
          source.checkedAt,
          stateCode
        );
        return {
          schemaVersion: THRESHER_SCHEMA_VERSIONS.evidence,
          systemId: THRESHER_SYSTEM_ID,
          recordType: "evidence",
          tenantRef,
          fileRef: scope.fileRef,
          evidenceRef,
          evidenceCode,
          stateCode,
          sourceCode: "jobnimbus",
          sourceRecordRef: reference(
            "source",
            "review-source",
            scope.fileRef,
            evidenceCode
          ),
          evidenceDigest: signedDigest({
            kind: "fresh_evidence",
            fileRef: scope.fileRef,
            evidenceCode,
            stateCode,
            asOf: source.asOf,
            checkedAt: source.checkedAt,
            validUntil: source.validUntil
          }),
          observedAt: source.asOf,
          checkedAt: source.checkedAt,
          validUntil: source.validUntil,
          recordedAt
        };
      }
    );
    const evidenceByCode = new Map(
      evidenceRecords.map((record) => [
        record.evidenceCode,
        record
      ])
    );
    const decision = reviewDecision({
      hasMissingClaimFacts,
      hasReviewDocument,
      hasOpenTask
    });
    const decisionEvidence = decision.evidenceCodes.map(
      (code) => evidenceByCode.get(code)
    );
    const ruleRef = reference(
      "rule",
      "review-rule",
      scope.fileRef,
      decision.ruleCode,
      source.checkedAt,
      decision.outcomeCode
    );
    const ruleRecord = {
      schemaVersion: THRESHER_SCHEMA_VERSIONS.ruleState,
      systemId: THRESHER_SYSTEM_ID,
      recordType: "rule_state",
      tenantRef,
      fileRef: scope.fileRef,
      ruleRef,
      ruleCode: decision.ruleCode,
      ruleVersion: "1.0.0",
      outcomeCode: decision.outcomeCode,
      reasonCode: decision.reasonCode,
      nextActionCode: decision.nextActionCode,
      evidenceRefs: decisionEvidence.map(
        (record) => record.evidenceRef
      ),
      decisionDigest: signedDigest({
        kind: "rule_state",
        fileRef: scope.fileRef,
        ruleCode: decision.ruleCode,
        outcomeCode: decision.outcomeCode,
        evidenceRefs: decisionEvidence.map(
          (record) => record.evidenceRef
        ),
        evaluatedAt: source.checkedAt
      }),
      evaluatedAt: source.checkedAt,
      validUntil: source.validUntil,
      recordedAt
    };
    const workRef = reference(
      "work",
      "review-work",
      scope.fileRef,
      decision.workCode,
      source.checkedAt,
      decision.workStateCode
    );
    const workRecord = {
      schemaVersion: THRESHER_SCHEMA_VERSIONS.workState,
      systemId: THRESHER_SYSTEM_ID,
      recordType: "work_state",
      tenantRef,
      fileRef: scope.fileRef,
      workRef,
      workCode: decision.workCode,
      stateCode: decision.workStateCode,
      priorityCode: decision.priorityCode,
      reasonCode: decision.reasonCode,
      nextActionCode: decision.nextActionCode,
      evidenceRefs: decisionEvidence.map(
        (record) => record.evidenceRef
      ),
      ruleRefs: [ruleRef],
      decisionDigest: signedDigest({
        kind: "work_state",
        fileRef: scope.fileRef,
        workCode: decision.workCode,
        stateCode: decision.workStateCode,
        ruleRef,
        updatedAt: source.checkedAt
      }),
      createdAt: source.checkedAt,
      updatedAt: source.checkedAt,
      validUntil: source.validUntil,
      recordedAt
    };
    return {
      checkedAt: source.checkedAt,
      records: [...evidenceRecords, ruleRecord, workRecord]
    };
  }

  function referenceInputFile(scope) {
    // The public file reference is deliberately not retained on the scope
    // object. Recovering it is impossible; compare it before scoping instead.
    return scope.publicFileRef;
  }

  function reference(prefix, domain, ...components) {
    const hmac = createHmac("sha256", referenceKeyBytes);
    updateLengthPrefixed(hmac, "hcn-thresher-reference:v1");
    updateLengthPrefixed(hmac, tenantRef);
    updateLengthPrefixed(hmac, domain);
    components.forEach((component) =>
      updateLengthPrefixed(hmac, String(component))
    );
    return `${prefix}_${hmac.digest("hex").slice(0, 32)}`;
  }

  function signedDigest(value) {
    const hmac = createHmac("sha256", signingKeyBytes);
    hmac.update("hcn-thresher-record-signature:v1", "utf8");
    hmac.update("\0", "utf8");
    hmac.update(canonicalJson(value), "utf8");
    return `sha256:${hmac.digest("hex")}`;
  }

  function project(snapshotValue, status) {
    return Object.freeze({
      systemId: THRESHER_SYSTEM_ID,
      productName: "Thresher AI",
      status,
      persistence: "active_encrypted_minimized",
      persisted: true,
      authority: Object.freeze({
        freshSourcesAuthoritative: true,
        authorizesAction: false,
        executesAction: false,
        modelCanExecute: false,
        autonomousLearning: false
      }),
      snapshot: snapshotValue
    });
  }

  return Object.freeze({
    recordFileReview,
    recordActionPlan,
    recordActionReceipts,
    snapshot,
    close
  });
}

export class ActiveThresherRuntimeError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.name = "ActiveThresherRuntimeError";
    this.code = `hcn_thresher_runtime_${code}`;
    this.statusCode = statusCode;
  }
}

function reviewDecision({
  hasMissingClaimFacts,
  hasReviewDocument,
  hasOpenTask
}) {
  if (hasMissingClaimFacts) {
    return {
      evidenceCodes: ["claim_path_evidence_present"],
      ruleCode: "claims.path_review",
      outcomeCode: "matched",
      workCode: "claim_path_review",
      workStateCode: "open",
      priorityCode: "high",
      reasonCode: "review_required",
      nextActionCode: "review_evidence"
    };
  }
  if (hasReviewDocument) {
    return {
      evidenceCodes: ["operational_document_present"],
      ruleCode: "documents.review_required",
      outcomeCode: "matched",
      workCode: "document_review",
      workStateCode: "open",
      priorityCode: "high",
      reasonCode: "review_required",
      nextActionCode: "review_evidence"
    };
  }
  if (hasOpenTask) {
    return {
      evidenceCodes: ["open_task_present"],
      ruleCode: "thresher.ready_for_pa_review",
      outcomeCode: "not_matched",
      workCode: "client_follow_up",
      workStateCode: "open",
      priorityCode: "normal",
      reasonCode: "follow_up_due",
      nextActionCode: "review_evidence"
    };
  }
  return {
    evidenceCodes: ["source_reachable"],
    ruleCode: "thresher.ready_for_pa_review",
    outcomeCode: "matched",
    workCode: "reconciliation",
    workStateCode: "resolved",
    priorityCode: "normal",
    reasonCode: "condition_satisfied",
    nextActionCode: "none"
  };
}

function requireFreshJobNimbusSource(value, timestamp) {
  if (
    !isPlainObject(value)
    || value.source !== "jobnimbus"
    || value.status !== "fresh"
    || !["complete", "partial"].includes(value.completeness)
  ) {
    staleError("Fresh JobNimbus evidence is required.");
  }
  const asOf = requireInstant(value.asOf, "jobnimbus.asOf");
  const checkedAt = requireInstant(value.checkedAt, "jobnimbus.checkedAt");
  const validUntil = requireInstant(
    value.validUntil,
    "jobnimbus.validUntil"
  );
  if (
    asOf > checkedAt
    || checkedAt > timestamp
    || validUntil <= timestamp
  ) {
    staleError("JobNimbus evidence is stale or has invalid chronology.");
  }
  return {
    asOf: new Date(asOf).toISOString(),
    checkedAt: new Date(checkedAt).toISOString(),
    validUntil: new Date(validUntil).toISOString()
  };
}

function operationCodesFromTypes(value) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_OPERATION_TYPES
  ) {
    inputError("operationTypes must contain between 1 and 12 action types.");
  }
  const codes = value.map((type) => {
    if (typeof type !== "string" || !OPERATION_CODE_BY_TYPE[type]) {
      inputError("operationTypes contains an unsupported action type.");
    }
    return OPERATION_CODE_BY_TYPE[type];
  });
  return [...new Set(codes)].sort();
}

function assertStore(value) {
  if (
    !value
    || typeof value.put !== "function"
    || typeof value.putMany !== "function"
    || typeof value.snapshot !== "function"
    || typeof value.close !== "function"
  ) {
    throw new TypeError("store must implement the isolated Thresher store API");
  }
}

function decodeKey(value, label) {
  if (
    typeof value !== "string"
    || !CANONICAL_BASE64URL_PATTERN.test(value)
  ) {
    configurationError(`${label} must be canonical base64url.`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (
    bytes.length < MIN_KEY_BYTES
    || bytes.length > MAX_KEY_BYTES
    || bytes.toString("base64url") !== value
  ) {
    bytes.fill(0);
    configurationError(`${label} must encode 32-128 bytes.`);
  }
  return bytes;
}

function equalBytes(left, right) {
  return (
    left.length === right.length
    && timingSafeEqual(left, right)
  );
}

function exactInput(value, fields, label) {
  if (!isPlainObject(value)) inputError(`${label} must be a plain object.`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || fields.some((field) => !keys.includes(field))
    || keys.some((key) => !fields.includes(key))
  ) {
    inputError(`${label} must contain only its documented exact fields.`);
  }
}

function requirePattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    inputError(`${label} is not an opaque reference.`);
  }
  return value;
}

function requireInstant(value, label) {
  if (
    typeof value !== "string"
    || !ISO_INSTANT_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    inputError(`${label} must be a canonical UTC timestamp.`);
  }
  return Date.parse(value);
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    staleError("The Thresher runtime clock is unavailable.");
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    staleError("The Thresher runtime clock is invalid.");
  }
  return timestamp;
}

function updateLengthPrefixed(hmac, value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hmac.update(length);
  hmac.update(bytes);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  );
}

function configurationError(message) {
  throw new ActiveThresherRuntimeError("invalid_configuration", message);
}

function inputError(message) {
  throw new ActiveThresherRuntimeError("invalid_input", message, 400);
}

function staleError(message) {
  throw new ActiveThresherRuntimeError("stale_evidence", message, 503);
}
