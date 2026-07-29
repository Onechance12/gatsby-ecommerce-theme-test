import { randomBytes as cryptographicRandomBytes } from "node:crypto";

const FILE_REF_PATTERN = /^subject_[a-f0-9]{32}$/;
const SESSION_BINDING_PATTERN = /^[a-f0-9]{64}$/;
const FILE_SCOPE_BINDING_PATTERN = /^[a-f0-9]{64}$/;
const APPROVAL_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const APPROVAL_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{40,100}$/;
const PLAN_ID_PATTERN = /^plan_[a-f0-9]{32}$/;
const MIN_OPERATIONS = 1;
const MAX_OPERATIONS = 12;
const DEFAULT_MAX_PLAN_BYTES = 256 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_MAX_PLANS_PER_SESSION = 24;
const DEFAULT_MAX_PLANS = 512;
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 60 * 1000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 20_000;
const MAX_RECEIPT_DEPTH = 6;
const MAX_RECEIPT_COLLECTION = 64;
const MAX_RECEIPT_STRING_BYTES = 2_048;
const MAX_DISPLAY_LABEL_CHARACTERS = 256;
const RANDOM_ATTEMPTS = 4;

const EXECUTION_TERMINAL_STATUSES = new Set([
  "executed",
  "completed_pending_verification",
  "partial_failure",
  "blocked_duplicate",
  "failed",
  "reconciliation_required"
]);
const TERMINAL_STATUSES = new Set([
  ...EXECUTION_TERMINAL_STATUSES,
  "superseded",
  "expired",
  "invalidated"
]);
const SENSITIVE_KEY_PATTERN =
  /^(?:approvalchallenge|filescopebinding|scopebinding|sessionbinding|session|sessionid|rawsession|rawsessionid|cookie|rawcookie|setcookie|credential|credentials|authorization|auth|bearer|token|accesstoken|refreshtoken|apikey|password|secret|clientsecret|csrf|csrftoken)$/i;
const SENSITIVE_SUFFIX_PATTERN =
  /(?:^|_)(?:access_token|refresh_token|api_key|client_secret|password|credential|credentials|cookie)$/i;
const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/**
 * Pure, process-local pending action-plan storage.
 *
 * The caller supplies an already prepared action-batch dry run. This store
 * never prepares actions or persists records. The approval challenge remains
 * private and is returned only by beginExecution after an atomic single-use
 * transition.
 */
export function createHcnPendingActionPlanStore({
  now = Date.now,
  randomId = securePlanId,
  maxPlanBytes = DEFAULT_MAX_PLAN_BYTES,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  maxPlansPerSession = DEFAULT_MAX_PLANS_PER_SESSION,
  maxPlans = DEFAULT_MAX_PLANS,
  terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS
} = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof randomId !== "function") {
    throw new TypeError("randomId must be a function");
  }
  assertPositiveBound(maxPlanBytes, "maxPlanBytes", 16 * 1024 * 1024);
  assertPositiveBound(maxResultBytes, "maxResultBytes", 4 * 1024 * 1024);
  assertPositiveBound(maxPlansPerSession, "maxPlansPerSession", 10_000);
  assertPositiveBound(maxPlans, "maxPlans", 100_000);
  assertPositiveBound(
    terminalRetentionMs,
    "terminalRetentionMs",
    7 * 24 * 60 * 60 * 1000
  );
  if (maxPlansPerSession > maxPlans) {
    throw new TypeError("maxPlansPerSession must not exceed maxPlans");
  }

  const records = new Map();

  function create(input) {
    assertObject(input, "pending plan");
    const sessionBinding = assertSessionBinding(input.sessionBinding);
    const fileRef = assertFileRef(input.fileRef);
    const fileScopeBinding = assertFileScopeBinding(input.fileScopeBinding);
    const fileDisplayLabel = input.fileDisplayLabel === undefined
      ? ""
      : assertFileDisplayLabel(input.fileDisplayLabel);
    const operations = cloneOperations(input.operations, "operations");
    const dryRun = validateDryRun(input.dryRun, operations.length);
    assertNoPrivateValues(
      operations,
      [
        sessionBinding,
        fileScopeBinding,
        dryRun.approvalChallenge
      ],
      "operations"
    );
    assertSingleFileRef(operations, fileRef, "operations");
    assertSingleFileRef(
      dryRun.presentationOperations,
      fileRef,
      "dryRun.operations"
    );
    assertNoSensitiveFields(
      dryRun.presentationOperations,
      "dryRun.operations"
    );
    assertNoPrivateValues(
      dryRun.presentationOperations,
      [
        sessionBinding,
        fileScopeBinding,
        dryRun.approvalChallenge
      ],
      "dryRun.operations"
    );

    const timestamp = readNow(now);
    if (timestamp >= dryRun.expiresAtMs) {
      throw planError(
        "approval_expired",
        409,
        "The action approval has expired; prepare and review a fresh dry run"
      );
    }

    const serializedBytes = jsonBytes({
      fileRef,
      fileDisplayLabel,
      operations,
      approvalDigest: dryRun.approvalDigest,
      approvalExpiresAt: dryRun.approvalExpiresAt,
      presentationOperations: dryRun.presentationOperations
    }) + [
      sessionBinding,
      fileScopeBinding,
      dryRun.approvalChallenge
    ].reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
    if (serializedBytes > maxPlanBytes) {
      throw planError(
        "plan_too_large",
        413,
        "The pending action plan exceeds the bounded serialized size"
      );
    }

    cleanupAt(timestamp);
    const planId = allocatePlanId(randomId, records);
    for (const record of records.values()) {
      if (
        record.sessionBinding === sessionBinding
        && record.status === "pending"
      ) {
        transition(record, "superseded", timestamp);
      }
    }
    pruneForCapacity(sessionBinding);
    if (countForSession(sessionBinding) >= maxPlansPerSession) {
      throw planError(
        "session_capacity_exhausted",
        429,
        "Pending action-plan capacity is exhausted for this session"
      );
    }
    if (records.size >= maxPlans) {
      throw planError(
        "global_capacity_exhausted",
        429,
        "Global pending action-plan capacity is exhausted"
      );
    }

    const record = {
      planId,
      sessionBinding,
      fileRef,
      fileDisplayLabel,
      fileScopeBinding,
      operations,
      presentationOperations: dryRun.presentationOperations,
      approvalDigest: dryRun.approvalDigest,
      approvalChallenge: dryRun.approvalChallenge,
      approvalExpiresAt: dryRun.approvalExpiresAt,
      expiresAtMs: dryRun.expiresAtMs,
      serializedBytes,
      status: "pending",
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      terminalAtMs: null,
      publicResult: null
    };
    records.set(planId, record);
    return publicProjection(record);
  }

  function list(input) {
    const { sessionBinding, summary } = listArguments(input);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    const result = [];
    for (const record of records.values()) {
      if (record.sessionBinding !== sessionBinding) continue;
      expirePendingRecord(record, timestamp);
      result.push(publicProjection(record, { summary }));
    }
    result.sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt)
      || right.planId.localeCompare(left.planId)
    ));
    return Object.freeze(result);
  }

  function get(input, possiblePlanId) {
    const { sessionBinding, planId } = lookupArguments(
      input,
      possiblePlanId
    );
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    const record = locate(records, sessionBinding, planId);
    expirePendingRecord(record, timestamp);
    return publicProjection(record);
  }

  function beginExecution(input) {
    assertObject(input, "execution request");
    const sessionBinding = assertSessionBinding(input.sessionBinding);
    const planId = assertPlanId(input.planId);
    const fileScopeBinding = assertFileScopeBinding(input.fileScopeBinding);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    const record = locate(records, sessionBinding, planId);
    expirePendingRecord(record, timestamp);

    if (record.status !== "pending") {
      throw unavailableForExecution(record.status);
    }
    if (fileScopeBinding !== record.fileScopeBinding) {
      transition(record, "invalidated", timestamp);
      throw planError(
        "file_scope_changed",
        409,
        "The exact file scope changed after review; the plan was invalidated"
      );
    }
    if (
      typeof input.approvalDigest !== "string"
      || input.approvalDigest !== record.approvalDigest
    ) {
      transition(record, "invalidated", timestamp);
      throw planError(
        "approval_digest_mismatch",
        409,
        "The approval digest does not match the exact reviewed plan; the plan was invalidated"
      );
    }

    transition(record, "executing", timestamp);
    const result = {
      planId: record.planId,
      fileRef: record.fileRef,
      approvalDigest: record.approvalDigest,
      approvalExpiresAt: record.approvalExpiresAt,
      status: record.status,
      operationCount: record.operations.length,
      operations: immutableJsonCopy(record.operations)
    };
    definePrivate(result, "approvalChallenge", record.approvalChallenge);
    Object.defineProperty(result, "toJSON", {
      value() {
        return {
          planId: record.planId,
          fileRef: record.fileRef,
          approvalDigest: record.approvalDigest,
          approvalExpiresAt: record.approvalExpiresAt,
          status: record.status,
          operationCount: record.operations.length
        };
      },
      enumerable: false,
      configurable: false,
      writable: false
    });
    return Object.freeze(result);
  }

  function finishExecution(input) {
    assertObject(input, "execution result");
    const sessionBinding = assertSessionBinding(input.sessionBinding);
    const planId = assertPlanId(input.planId);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    const record = locate(records, sessionBinding, planId);
    if (record.status !== "executing") {
      throw planError(
        "execution_not_running",
        409,
        `The pending action plan is ${record.status} and cannot be finished`
      );
    }

    let status = terminalStatus(input.result);
    let publicResult;
    try {
      publicResult = projectExecutionResult(input.result, {
        maxResultBytes,
        secrets: [
          record.approvalChallenge,
          record.sessionBinding,
          record.fileScopeBinding
        ]
      });
    } catch {
      status = "reconciliation_required";
      publicResult = reconciliationProjection({
        maxResultBytes,
        reason:
          "The execution result could not be safely retained; reconcile against fresh source evidence",
        secrets: [
          record.approvalChallenge,
          record.sessionBinding,
          record.fileScopeBinding
        ]
      });
    }
    if (
      status === "reconciliation_required"
      && publicResult?.mode !== "reconciliation_required"
    ) {
      publicResult = reconciliationProjection({
        maxResultBytes,
        reason: publicResult?.reason,
        secrets: [
          record.approvalChallenge,
          record.sessionBinding,
          record.fileScopeBinding
        ]
      });
    }
    record.publicResult = publicResult;
    transition(record, status, timestamp);
    return publicProjection(record);
  }

  function recoverExecution(input) {
    assertObject(input, "execution recovery");
    const sessionBinding = assertSessionBinding(input.sessionBinding);
    const planId = assertPlanId(input.planId);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    const record = locate(records, sessionBinding, planId);
    if (record.status !== "executing") {
      throw planError(
        "execution_not_running",
        409,
        `The pending action plan is ${record.status} and cannot be recovered`
      );
    }

    record.publicResult = reconciliationProjection({
      maxResultBytes,
      reason: input.reason,
      secrets: [
        record.approvalChallenge,
        record.sessionBinding,
        record.fileScopeBinding
      ]
    });
    transition(record, "reconciliation_required", timestamp);
    return publicProjection(record);
  }

  function invalidate(input) {
    assertObject(input, "invalidation request");
    const sessionBinding = assertSessionBinding(input.sessionBinding);
    const planId = assertPlanId(input.planId);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    const record = locate(records, sessionBinding, planId);
    expirePendingRecord(record, timestamp);
    if (record.status !== "pending") {
      throw planError(
        "plan_not_pending",
        409,
        `The pending action plan is ${record.status} and cannot be invalidated`
      );
    }
    transition(record, "invalidated", timestamp);
    return publicProjection(record);
  }

  function expire(input) {
    assertObject(input, "expiration request");
    const sessionBinding = assertSessionBinding(input.sessionBinding);
    const planId = assertPlanId(input.planId);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    const record = locate(records, sessionBinding, planId);
    if (record.status !== "pending") {
      throw planError(
        "plan_not_pending",
        409,
        `The pending action plan is ${record.status} and cannot be expired`
      );
    }
    transition(record, "expired", timestamp);
    return publicProjection(record);
  }

  function invalidateSession(input) {
    const sessionBinding = bindingArgument(input);
    const timestamp = readNow(now);
    cleanupAt(timestamp);
    let invalidated = 0;
    let reconciliationRequired = 0;
    for (const record of records.values()) {
      if (record.sessionBinding !== sessionBinding) continue;
      if (record.status === "pending") {
        transition(record, "invalidated", timestamp);
        invalidated += 1;
      } else if (record.status === "executing") {
        record.publicResult = reconciliationProjection({
          maxResultBytes,
          reason:
            "The approving session ended during execution; reconcile against fresh source evidence",
          secrets: [
            record.approvalChallenge,
            record.sessionBinding,
            record.fileScopeBinding
          ]
        });
        transition(record, "reconciliation_required", timestamp);
        reconciliationRequired += 1;
      }
    }
    return Object.freeze({
      invalidated,
      reconciliationRequired
    });
  }

  function cleanup() {
    const timestamp = readNow(now);
    const removed = cleanupAt(timestamp);
    return Object.freeze({
      removed,
      plans: records.size
    });
  }

  function cleanupAt(timestamp) {
    let removed = 0;
    for (const record of records.values()) {
      expirePendingRecord(record, timestamp);
    }
    for (const [planId, record] of records) {
      if (
        TERMINAL_STATUSES.has(record.status)
        && Number.isSafeInteger(record.terminalAtMs)
        && timestamp - record.terminalAtMs >= terminalRetentionMs
      ) {
        records.delete(planId);
        removed += 1;
      }
    }
    return removed;
  }

  function pruneForCapacity(sessionBinding) {
    while (countForSession(sessionBinding) >= maxPlansPerSession) {
      const candidate = oldestTerminal(records, sessionBinding);
      if (!candidate) break;
      records.delete(candidate.planId);
    }
    while (records.size >= maxPlans) {
      const candidate = oldestTerminal(records);
      if (!candidate) break;
      records.delete(candidate.planId);
    }
  }

  function countForSession(sessionBinding) {
    let count = 0;
    for (const record of records.values()) {
      if (record.sessionBinding === sessionBinding) count += 1;
    }
    return count;
  }

  return Object.freeze({
    create,
    list,
    get,
    beginExecution,
    finishExecution,
    recoverExecution,
    invalidate,
    invalidateSession,
    expire,
    cleanup,
    stats() {
      cleanupAt(readNow(now));
      let pending = 0;
      let executing = 0;
      let terminal = 0;
      for (const record of records.values()) {
        if (record.status === "pending") pending += 1;
        else if (record.status === "executing") executing += 1;
        else terminal += 1;
      }
      return Object.freeze({
        plans: records.size,
        pending,
        executing,
        terminal,
        maxPlans,
        maxPlansPerSession
      });
    }
  });
}

export class HcnPendingActionPlanError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = "HcnPendingActionPlanError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateDryRun(value, operationCount) {
  assertObject(value, "dryRun");
  if (value.mode !== undefined && value.mode !== "dry_run") {
    throw planError(
      "invalid_dry_run",
      400,
      "dryRun.mode must be dry_run"
    );
  }
  if (
    value.operationCount !== undefined
    && value.operationCount !== operationCount
  ) {
    throw planError(
      "invalid_dry_run",
      400,
      "dryRun.operationCount must match the exact operations"
    );
  }
  if (
    typeof value.approvalDigest !== "string"
    || !APPROVAL_DIGEST_PATTERN.test(value.approvalDigest)
  ) {
    throw planError(
      "invalid_dry_run",
      400,
      "dryRun.approvalDigest must be 64 lowercase hexadecimal characters"
    );
  }
  if (
    typeof value.approvalChallenge !== "string"
    || !APPROVAL_CHALLENGE_PATTERN.test(value.approvalChallenge)
  ) {
    throw planError(
      "invalid_dry_run",
      400,
      "dryRun.approvalChallenge must be a bounded base64url value"
    );
  }
  const expiresAtMs = parseIso(value.approvalExpiresAt);
  const presentationOperations = cloneOperations(
    value.operations,
    "dryRun.operations"
  );
  if (presentationOperations.length !== operationCount) {
    throw planError(
      "invalid_dry_run",
      400,
      "dryRun.operations must match the operation count"
    );
  }
  return {
    approvalDigest: value.approvalDigest,
    approvalChallenge: value.approvalChallenge,
    approvalExpiresAt: value.approvalExpiresAt,
    expiresAtMs,
    presentationOperations
  };
}

function cloneOperations(value, label) {
  if (
    !Array.isArray(value)
    || value.length < MIN_OPERATIONS
    || value.length > MAX_OPERATIONS
  ) {
    throw planError(
      "invalid_operations",
      400,
      `${label} must contain 1-12 exact operations`
    );
  }
  const cloned = cloneJson(value, label);
  for (let index = 0; index < cloned.length; index += 1) {
    if (!isPlainObject(cloned[index])) {
      throw planError(
        "invalid_operations",
        400,
        `${label}[${index}] must be an object`
      );
    }
  }
  return deepFreeze(cloned);
}

function cloneJson(value, label) {
  const state = { nodes: 0 };
  try {
    return cloneJsonValue(value, 0, state);
  } catch (error) {
    if (error instanceof HcnPendingActionPlanError) throw error;
    throw planError(
      "invalid_json",
      400,
      `${label} must be bounded JSON data`
    );
  }
}

function cloneJsonValue(value, depth, state) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw planError(
      "invalid_json",
      400,
      "Action-plan JSON exceeds structural bounds"
    );
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw planError(
        "invalid_json",
        400,
        "Action-plan JSON numbers must be finite"
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item, depth + 1, state));
  }
  if (!isPlainObject(value)) {
    throw planError(
      "invalid_json",
      400,
      "Action-plan values must be plain JSON objects"
    );
  }
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw planError(
        "invalid_json",
        400,
        "Action-plan JSON may not contain symbol keys"
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw planError(
        "invalid_json",
        400,
        "Action-plan JSON may not contain accessors"
      );
    }
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw planError(
        "invalid_json",
        400,
        "Action-plan JSON contains an unsafe object key"
      );
    }
    result[key] = cloneJsonValue(descriptor.value, depth + 1, state);
  }
  return result;
}

function assertNoSensitiveFields(value, label) {
  visitJson(value, (key) => {
    if (isSensitiveKey(key)) {
      throw planError(
        "sensitive_presentation_field",
        400,
        `${label} contains a field that may not enter a public projection`
      );
    }
  });
}

function assertSingleFileRef(value, fileRef, label) {
  visitJson(value, (_key, item) => {
    if (
      typeof item === "string"
      && FILE_REF_PATTERN.test(item)
      && item !== fileRef
    ) {
      throw planError(
        "mixed_file_scope",
        400,
        `${label} contains a different HCN file reference`
      );
    }
  });
}

function assertNoPrivateValues(value, secrets, label) {
  const exactSecrets = new Set(secrets.filter((secret) => (
    typeof secret === "string" && secret.length > 0
  )));
  visitJson(value, (_key, item) => {
    if (
      typeof item === "string"
      && [...exactSecrets].some((secret) => item.includes(secret))
    ) {
      throw planError(
        "sensitive_private_value",
        400,
        `${label} contains a private binding or challenge value`
      );
    }
  });
}

function visitJson(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, visitor);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    visitor(key, item);
    visitJson(item, visitor);
  }
}

function publicProjection(record, { summary = false } = {}) {
  const projection = {
    planId: record.planId,
    fileRef: record.fileRef,
    approvalDigest: record.approvalDigest,
    approvalExpiresAt: record.approvalExpiresAt,
    status: record.status,
    operationCount: record.presentationOperations.length
  };
  if (record.fileDisplayLabel) {
    projection.file = {
      reference: record.fileRef,
      displayLabel: record.fileDisplayLabel
    };
  }
  if (!summary) {
    projection.operations = cloneJson(
      record.presentationOperations,
      "stored operations"
    );
  }
  projection.createdAt = iso(record.createdAtMs);
  projection.updatedAt = iso(record.updatedAtMs);
  if (record.publicResult) {
    projection.result = cloneJson(record.publicResult, "stored result");
  }
  return deepFreeze(projection);
}

function assertFileDisplayLabel(value) {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length < 1
    || value.length > MAX_DISPLAY_LABEL_CHARACTERS
    || /[\r\n\x00-\x1f\x7f]/.test(value)
  ) {
    throw planError(
      "invalid_file_display_label",
      400,
      "fileDisplayLabel must be a bounded single-line display value"
    );
  }
  return value;
}

function terminalStatus(result) {
  const batchStatus = String(result?.batch?.status || "");
  if (batchStatus === "completed_pending_verification") {
    return "completed_pending_verification";
  }
  if (
    result
    && typeof result === "object"
    && EXECUTION_TERMINAL_STATUSES.has(result.mode)
  ) {
    return result.mode;
  }
  if (batchStatus === "completed") return "executed";
  if (batchStatus === "partial_failure") return "partial_failure";
  if (batchStatus === "failed") return "failed";
  return "reconciliation_required";
}

function projectExecutionResult(result, { maxResultBytes, secrets }) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("result must be an action-batch result object");
  }
  const mode = terminalStatus(result);
  const projected = { mode };
  const reason = safeReceiptString(result.reason, secrets);
  if (reason) projected.reason = reason;
  const error = safeReceiptString(
    result.error ?? result.batch?.error,
    secrets
  );
  if (error) projected.error = error;

  if (isPlainObject(result.batch)) {
    const batch = {};
    assignBoundedString(batch, "batchId", result.batch.id, secrets, 256);
    assignBoundedString(batch, "status", result.batch.status, secrets, 128);
    assignBoundedInteger(
      batch,
      "operationCount",
      result.batch.operationCount,
      0,
      MAX_OPERATIONS
    );
    assignBoundedInteger(
      batch,
      "failedAt",
      result.batch.failedAt,
      0,
      MAX_OPERATIONS - 1
    );
    assignIso(batch, "createdAt", result.batch.createdAt);
    assignIso(batch, "updatedAt", result.batch.updatedAt);
    assignIso(batch, "completedAt", result.batch.completedAt);
    if (Array.isArray(result.batch.completed)) {
      batch.completed = result.batch.completed
        .slice(0, MAX_OPERATIONS)
        .map((item) => projectCompletedReceipt(item, secrets));
    }
    if (Object.keys(batch).length > 0) projected.batch = batch;
  }

  const size = jsonBytes(projected);
  if (size > maxResultBytes) {
    throw new RangeError("projected execution result is too large");
  }
  return deepFreeze(projected);
}

function reconciliationProjection({
  maxResultBytes,
  reason,
  secrets
}) {
  const safeReason = safeReceiptString(reason, secrets);
  const detailed = safeReason
    ? { mode: "reconciliation_required", reason: safeReason }
    : {
        mode: "reconciliation_required",
        reason:
          "Execution outcome is uncertain; reconcile against fresh source evidence"
      };
  if (jsonBytes(detailed) <= maxResultBytes) return deepFreeze(detailed);
  const minimal = { mode: "reconciliation_required" };
  if (jsonBytes(minimal) <= maxResultBytes) return deepFreeze(minimal);
  return null;
}

function projectCompletedReceipt(value, secrets) {
  if (!isPlainObject(value)) return Object.freeze({});
  const item = {};
  assignBoundedInteger(item, "index", value.index, 0, MAX_OPERATIONS - 1);
  assignBoundedString(item, "type", value.type, secrets, 128);
  assignBoundedString(item, "status", value.status, secrets, 128);
  if (isPlainObject(value.receipt)) {
    item.receipt = sanitizeReceiptValue(
      value.receipt,
      0,
      { nodes: 0 },
      secrets
    );
  }
  return deepFreeze(item);
}

function sanitizeReceiptValue(value, depth, state, secrets) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_RECEIPT_DEPTH) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    return safeReceiptString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_RECEIPT_COLLECTION)
      .map((item) => sanitizeReceiptValue(
        item,
        depth + 1,
        state,
        secrets
      ));
  }
  if (!isPlainObject(value)) return null;
  const result = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_RECEIPT_COLLECTION) break;
    if (
      isSensitiveKey(key)
      || ["approvalId", "approvalDigest"].includes(key)
    ) {
      continue;
    }
    result[key] = sanitizeReceiptValue(
      item,
      depth + 1,
      state,
      secrets
    );
    count += 1;
  }
  return result;
}

function safeReceiptString(value, secrets) {
  if (typeof value !== "string") return "";
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  result = result.replace(BEARER_VALUE_PATTERN, "[REDACTED]");
  return truncateUtf8(result, MAX_RECEIPT_STRING_BYTES);
}

function assignBoundedString(target, key, value, secrets, maxBytes) {
  if (typeof value !== "string" || value.length === 0) return;
  target[key] = truncateUtf8(
    safeReceiptString(value, secrets),
    maxBytes
  );
}

function assignBoundedInteger(target, key, value, min, max) {
  if (Number.isSafeInteger(value) && value >= min && value <= max) {
    target[key] = value;
  }
}

function assignIso(target, key, value) {
  if (typeof value !== "string") return;
  try {
    parseIso(value);
    target[key] = value;
  } catch {
    // An invalid provider timestamp is omitted from the bounded projection.
  }
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (
    end > 0
    && Buffer.byteLength(`${value.slice(0, end)}…`, "utf8") > maxBytes
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function locate(records, sessionBinding, planId) {
  const record = records.get(planId);
  if (!record || record.sessionBinding !== sessionBinding) {
    throw planError(
      "plan_not_found",
      404,
      "Pending action plan not found"
    );
  }
  return record;
}

function transition(record, status, timestamp) {
  record.status = status;
  record.updatedAtMs = timestamp;
  if (TERMINAL_STATUSES.has(status)) {
    record.terminalAtMs = timestamp;
    record.approvalChallenge = null;
    record.fileScopeBinding = null;
  }
}

function expirePendingRecord(record, timestamp) {
  if (record.status === "pending" && timestamp >= record.expiresAtMs) {
    transition(record, "expired", timestamp);
  }
}

function unavailableForExecution(status) {
  const code = {
    expired: "approval_expired",
    superseded: "plan_superseded",
    executing: "execution_already_running",
    invalidated: "plan_invalidated"
  }[status] || "plan_already_terminal";
  return planError(
    code,
    409,
    `The pending action plan is ${status} and cannot be executed`
  );
}

function oldestTerminal(records, sessionBinding) {
  let candidate = null;
  for (const record of records.values()) {
    if (
      !TERMINAL_STATUSES.has(record.status)
      || (
        sessionBinding !== undefined
        && record.sessionBinding !== sessionBinding
      )
    ) {
      continue;
    }
    if (
      !candidate
      || record.terminalAtMs < candidate.terminalAtMs
      || (
        record.terminalAtMs === candidate.terminalAtMs
        && record.createdAtMs < candidate.createdAtMs
      )
    ) {
      candidate = record;
    }
  }
  return candidate;
}

function bindingArgument(input) {
  if (typeof input === "string") return assertSessionBinding(input);
  assertObject(input, "list request");
  return assertSessionBinding(input.sessionBinding);
}

function listArguments(input) {
  if (typeof input === "string") {
    return {
      sessionBinding: assertSessionBinding(input),
      summary: false
    };
  }
  assertObject(input, "list request");
  if (input.summary !== undefined && typeof input.summary !== "boolean") {
    throw planError(
      "invalid_request",
      400,
      "list summary must be a boolean"
    );
  }
  return {
    sessionBinding: assertSessionBinding(input.sessionBinding),
    summary: input.summary === true
  };
}

function lookupArguments(input, possiblePlanId) {
  if (typeof input === "string") {
    return {
      sessionBinding: assertSessionBinding(input),
      planId: assertPlanId(possiblePlanId)
    };
  }
  assertObject(input, "lookup request");
  return {
    sessionBinding: assertSessionBinding(input.sessionBinding),
    planId: assertPlanId(input.planId)
  };
}

function assertSessionBinding(value) {
  if (
    typeof value !== "string"
    || !SESSION_BINDING_PATTERN.test(value)
  ) {
    throw planError(
      "invalid_session_binding",
      400,
      "sessionBinding must be a non-secret SHA-256 hash"
    );
  }
  return value;
}

function assertFileRef(value) {
  if (typeof value !== "string" || !FILE_REF_PATTERN.test(value)) {
    throw planError(
      "invalid_file_ref",
      400,
      "fileRef must be one exact opaque HCN subject reference"
    );
  }
  return value;
}

function assertFileScopeBinding(value) {
  if (
    typeof value !== "string"
    || !FILE_SCOPE_BINDING_PATTERN.test(value)
  ) {
    throw planError(
      "invalid_file_scope_binding",
      400,
      "fileScopeBinding must be a non-secret SHA-256 hash"
    );
  }
  return value;
}

function assertPlanId(value) {
  if (typeof value !== "string" || !PLAN_ID_PATTERN.test(value)) {
    throw planError(
      "plan_not_found",
      404,
      "Pending action plan not found"
    );
  }
  return value;
}

function parseIso(value) {
  if (
    typeof value !== "string"
    || value.length < 20
    || value.length > 35
    || !/^\d{4}-\d{2}-\d{2}T/.test(value)
  ) {
    throw planError(
      "invalid_dry_run",
      400,
      "approvalExpiresAt must be an ISO timestamp"
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw planError(
      "invalid_dry_run",
      400,
      "approvalExpiresAt must be an ISO timestamp"
    );
  }
  return timestamp;
}

function allocatePlanId(randomId, records) {
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
    let planId;
    try {
      planId = randomId();
    } catch {
      throw planError(
        "random_id_failed",
        500,
        "Secure pending-plan identifier generation failed"
      );
    }
    if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) {
      throw planError(
        "random_id_failed",
        500,
        "randomId must return an opaque plan identifier"
      );
    }
    if (!records.has(planId)) return planId;
  }
  throw planError(
    "random_id_failed",
    500,
    "Unable to allocate a unique pending-plan identifier"
  );
}

function securePlanId() {
  return `plan_${cryptographicRandomBytes(16).toString("hex")}`;
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw planError("clock_failed", 500, "Pending-plan clock failed");
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw planError(
      "clock_failed",
      500,
      "Pending-plan clock must return a non-negative millisecond timestamp"
    );
  }
  return timestamp;
}

function immutableJsonCopy(value) {
  return deepFreeze(cloneJson(value, "stored JSON"));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function definePrivate(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: false,
    configurable: false,
    writable: false
  });
}

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[-\s]/g, "");
  return (
    SENSITIVE_KEY_PATTERN.test(normalized)
    || SENSITIVE_SUFFIX_PATTERN.test(String(key))
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) {
    throw planError(
      "invalid_request",
      400,
      `${label} must be an object`
    );
  }
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function assertPositiveBound(value, name, maximum) {
  if (
    !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum
  ) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than ${maximum}`
    );
  }
}

function planError(code, statusCode, message) {
  return new HcnPendingActionPlanError(code, statusCode, message);
}
