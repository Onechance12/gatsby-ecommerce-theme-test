import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomBytes as cryptographicRandomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const SESSION_PRINCIPAL_REF_PATTERN = /^principal_[a-f0-9]{64}$/;
const FILE_REF_PATTERN = /^subject_[a-f0-9]{32}$/;
const PLAN_ID_PATTERN = /^plan_[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BATCH_REF_PATTERN = /^batch_[a-f0-9]{32}$/;
const OPERATION_KINDS = new Set([
  "hcn.action_batch",
  "jobnimbus.claim_filing_writeback",
  "retell.claim_filing_call"
]);
const DEFAULT_MAX_RECORDS = 2_000;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_LIST_LIMIT = DEFAULT_MAX_RECORDS;
const RANDOM_ATTEMPTS = 4;

const EXECUTING_STATUS = "executing";
const TERMINAL_STATUSES = new Set([
  "executed",
  "completed_pending_verification",
  "partial_failure",
  "blocked_duplicate",
  "failed",
  "reconciliation_required"
]);
const ALL_STATUSES = new Set([EXECUTING_STATUS, ...TERMINAL_STATUSES]);

const APPEND_KEYS = new Set([
  "sessionPrincipalRef",
  "fileRef",
  "planId",
  "digest",
  "operationCount",
  "operationKind"
]);
const TRANSITION_KEYS = new Set([
  "sessionPrincipalRef",
  "fileRef",
  "planId",
  "digest",
  "batchRef",
  "status",
  "succeededCount",
  "failedCount",
  "blockedCount",
  "unknownCount"
]);
const LOOKUP_KEYS = new Set(["sessionPrincipalRef", "planId"]);
const LIST_KEYS = new Set([
  "sessionPrincipalRef",
  "fileRef",
  "status",
  "operationKind",
  "limit"
]);
const RECORD_KEYS = new Set([
  "sessionPrincipalRef",
  "fileRef",
  "planId",
  "digest",
  "batchRef",
  "status",
  "operationCount",
  "succeededCount",
  "failedCount",
  "blockedCount",
  "unknownCount",
  "createdAt",
  "updatedAt",
  "executingAt",
  "terminalAt"
]);
const EXECUTING_RECORD_KEYS = new Set(
  [...RECORD_KEYS].filter((key) => key !== "terminalAt")
);

/**
 * Durable, metadata-only index for HCN action-batch receipts.
 *
 * appendExecuting() is the only append path. It durably records "executing"
 * before returning, so a caller may start effects only after it succeeds.
 * transition() is the only state change and permits executing -> terminal.
 *
 * This module intentionally knows nothing about Chance Brain, Jobrolo,
 * providers, client records, action bodies, approval challenges, or sessions.
 */
export function createHcnActionReceiptIndex({
  filePath,
  now = Date.now,
  randomBatchRef = secureBatchRef,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  retentionMs = DEFAULT_RETENTION_MS
} = {}) {
  const resolvedPath = validateFilePath(filePath);
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof randomBatchRef !== "function") {
    throw new TypeError("randomBatchRef must be a function");
  }
  assertPositiveBound(maxRecords, "maxRecords", 100_000);
  assertPositiveBound(maxFileBytes, "maxFileBytes", 64 * 1024 * 1024);
  assertPositiveBound(
    retentionMs,
    "retentionMs",
    10 * 365 * 24 * 60 * 60 * 1000
  );

  let records = loadRecords(resolvedPath, maxFileBytes);
  const startupTimestamp = readNow(now);
  const recovered = recoverInterrupted(records, startupTimestamp);
  const retained = pruneByRetention(
    recovered.records,
    startupTimestamp,
    retentionMs
  );
  const capacityNormalized = trimToLength(retained.records, maxRecords);
  if (capacityNormalized.records.length > maxRecords) {
    throw receiptError(
      "receipt_index_capacity_exceeded",
      500,
      "The stored action receipt index exceeds configured capacity"
    );
  }
  if (
    recovered.changed
    || retained.changed
    || capacityNormalized.changed
  ) {
    persistRecords(
      resolvedPath,
      capacityNormalized.records,
      maxFileBytes
    );
  }
  records = capacityNormalized.records;

  function appendExecuting(input) {
    assertExactObject(input, APPEND_KEYS, "receipt append", {
      optional: new Set(["operationKind"])
    });
    const sessionPrincipalRef = assertSessionPrincipalRef(
      input.sessionPrincipalRef
    );
    const fileRef = assertFileRef(input.fileRef);
    const planId = assertPlanId(input.planId);
    const digest = assertDigest(input.digest);
    const operationCount = assertOperationCount(input.operationCount);
    const operationKind = input.operationKind === undefined
      ? undefined
      : assertOperationKind(input.operationKind);
    const timestamp = readNow(now);

    let next = pruneByRetention(
      records,
      timestamp,
      retentionMs
    ).records;
    if (next.some((record) => record.planId === planId)) {
      throw receiptError(
        "receipt_already_exists",
        409,
        "An action receipt already exists for this plan"
      );
    }

    next = makeCapacity(next, maxRecords);
    if (next.length >= maxRecords) {
      throw receiptError(
        "receipt_capacity_exhausted",
        429,
        "Action receipt capacity is exhausted"
      );
    }
    const batchRef = allocateBatchRef(randomBatchRef, next);

    const at = iso(timestamp);
    const record = {
      sessionPrincipalRef,
      fileRef,
      planId,
      digest,
      batchRef,
      status: EXECUTING_STATUS,
      operationCount,
      succeededCount: 0,
      failedCount: 0,
      blockedCount: 0,
      unknownCount: operationCount,
      createdAt: at,
      updatedAt: at,
      executingAt: at
    };
    if (operationKind !== undefined) record.operationKind = operationKind;
    next = canonicalRecordOrder([...next, record]);
    persistRecords(resolvedPath, next, maxFileBytes);
    records = next;
    return projectRecord(record);
  }

  function transition(input) {
    assertExactObject(input, TRANSITION_KEYS, "receipt transition");
    const identity = {
      sessionPrincipalRef: assertSessionPrincipalRef(
        input.sessionPrincipalRef
      ),
      fileRef: assertFileRef(input.fileRef),
      planId: assertPlanId(input.planId),
      digest: assertDigest(input.digest),
      batchRef: assertBatchRef(input.batchRef)
    };
    const status = assertTerminalStatus(input.status);
    const counts = validateTerminalCounts({
      status,
      operationCount: undefined,
      succeededCount: input.succeededCount,
      failedCount: input.failedCount,
      blockedCount: input.blockedCount,
      unknownCount: input.unknownCount
    });
    const index = locateRecord(records, identity);
    const current = records[index];
    if (current.status !== EXECUTING_STATUS) {
      throw receiptError(
        "receipt_already_terminal",
        409,
        "The action receipt is already terminal"
      );
    }
    validateTerminalCounts({
      status,
      operationCount: current.operationCount,
      ...counts
    });

    const timestamp = Math.max(
      readNow(now),
      parseCanonicalIso(current.updatedAt)
    );
    const terminalAt = iso(timestamp);
    const updated = {
      ...current,
      status,
      ...counts,
      updatedAt: terminalAt,
      terminalAt
    };
    const next = records.slice();
    next[index] = updated;
    const ordered = canonicalRecordOrder(next);
    persistRecords(resolvedPath, ordered, maxFileBytes);
    records = ordered;
    return projectRecord(updated);
  }

  function get(input) {
    assertExactObject(input, LOOKUP_KEYS, "receipt lookup");
    maintain();
    const sessionPrincipalRef = assertSessionPrincipalRef(
      input.sessionPrincipalRef
    );
    const planId = assertPlanId(input.planId);
    const record = records.find((candidate) => (
      candidate.sessionPrincipalRef === sessionPrincipalRef
      && candidate.planId === planId
    ));
    if (!record) throw notFound();
    return projectRecord(record);
  }

  function list(input) {
    assertExactObject(input, LIST_KEYS, "receipt list", {
      optional: new Set([
        "fileRef",
        "status",
        "operationKind",
        "limit"
      ])
    });
    maintain();
    const sessionPrincipalRef = assertSessionPrincipalRef(
      input.sessionPrincipalRef
    );
    const fileRef = input.fileRef === undefined
      ? undefined
      : assertFileRef(input.fileRef);
    const status = input.status === undefined
      ? undefined
      : assertStatus(input.status);
    const operationKind = input.operationKind === undefined
      ? undefined
      : input.operationKind === null
        ? null
        : assertOperationKind(input.operationKind);
    const limit = input.limit === undefined
      ? 50
      : assertListLimit(input.limit);

    const result = records
      .filter((record) => (
        record.sessionPrincipalRef === sessionPrincipalRef
        && (fileRef === undefined || record.fileRef === fileRef)
        && (status === undefined || record.status === status)
        && (
          operationKind === undefined
          || (
            operationKind === null
              ? record.operationKind === undefined
              : record.operationKind === operationKind
          )
        )
      ))
      .sort(compareProjectionOrder)
      .slice(0, limit)
      .map(projectRecord);
    return Object.freeze(result);
  }

  function maintain() {
    const timestamp = readNow(now);
    const retained = pruneByRetention(records, timestamp, retentionMs);
    if (!retained.changed) return;
    persistRecords(resolvedPath, retained.records, maxFileBytes);
    records = retained.records;
  }

  return Object.freeze({
    appendExecuting,
    transition,
    get,
    list,
    stats() {
      maintain();
      const byStatus = {};
      for (const status of [...ALL_STATUSES].sort()) byStatus[status] = 0;
      for (const record of records) byStatus[record.status] += 1;
      return deepFreeze({
        records: records.length,
        maxRecords,
        byStatus
      });
    }
  });
}

export class HcnActionReceiptIndexError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = "HcnActionReceiptIndexError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function loadRecords(filePath, maxFileBytes) {
  let metadata;
  try {
    metadata = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw storageUnavailable();
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw corruptIndex();
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size > maxFileBytes) {
    throw corruptIndex();
  }

  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch {
    throw storageUnavailable();
  }
  if (bytes.length === 0 || bytes.length > maxFileBytes) {
    throw corruptIndex();
  }

  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw corruptIndex();
  }
  if (
    !isPlainObject(document)
    || !hasExactKeys(document, new Set(["schemaVersion", "records"]))
    || document.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(document.records)
  ) {
    throw corruptIndex();
  }
  const records = document.records.map(validateStoredRecord);
  if (records.length > DEFAULT_MAX_RECORDS * 50) {
    throw corruptIndex();
  }
  assertUniqueRecords(records);
  return canonicalRecordOrder(records);
}

function validateStoredRecord(value) {
  if (!isPlainObject(value)) throw corruptIndex();
  const status = assertStoredStatus(value.status);
  const baseExpectedKeys = status === EXECUTING_STATUS
    ? EXECUTING_RECORD_KEYS
    : RECORD_KEYS;
  const expectedKeys = Object.hasOwn(value, "operationKind")
    ? new Set([...baseExpectedKeys, "operationKind"])
    : baseExpectedKeys;
  if (!hasExactKeys(value, expectedKeys)) throw corruptIndex();

  const record = {
    sessionPrincipalRef: assertStored(
      () => assertSessionPrincipalRef(value.sessionPrincipalRef)
    ),
    fileRef: assertStored(() => assertFileRef(value.fileRef)),
    planId: assertStored(() => assertPlanId(value.planId)),
    digest: assertStored(() => assertDigest(value.digest)),
    batchRef: assertStored(() => assertBatchRef(value.batchRef)),
    status,
    operationCount: assertStored(
      () => assertOperationCount(value.operationCount)
    ),
    succeededCount: assertStored(
      () => assertCount(value.succeededCount, "succeededCount")
    ),
    failedCount: assertStored(
      () => assertCount(value.failedCount, "failedCount")
    ),
    blockedCount: assertStored(
      () => assertCount(value.blockedCount, "blockedCount")
    ),
    unknownCount: assertStored(
      () => assertCount(value.unknownCount, "unknownCount")
    ),
    createdAt: assertStored(() => canonicalIso(value.createdAt)),
    updatedAt: assertStored(() => canonicalIso(value.updatedAt)),
    executingAt: assertStored(() => canonicalIso(value.executingAt))
  };
  if (Object.hasOwn(value, "operationKind")) {
    record.operationKind = assertStored(
      () => assertOperationKind(value.operationKind)
    );
  }
  if (status !== EXECUTING_STATUS) {
    record.terminalAt = assertStored(() => canonicalIso(value.terminalAt));
  }

  const created = parseCanonicalIso(record.createdAt);
  const executing = parseCanonicalIso(record.executingAt);
  const updated = parseCanonicalIso(record.updatedAt);
  if (
    created !== executing
    || executing > updated
    || (
      record.status === EXECUTING_STATUS
      && updated !== executing
    )
    || (
      record.status !== EXECUTING_STATUS
      && (
        parseCanonicalIso(record.terminalAt) !== updated
        || updated < executing
      )
    )
  ) {
    throw corruptIndex();
  }

  if (record.status === EXECUTING_STATUS) {
    if (
      record.succeededCount !== 0
      || record.failedCount !== 0
      || record.blockedCount !== 0
      || record.unknownCount !== record.operationCount
    ) {
      throw corruptIndex();
    }
  } else {
    assertStored(() => validateTerminalCounts(record));
  }
  return Object.freeze(record);
}

function recoverInterrupted(records, timestamp) {
  let changed = false;
  const recovered = records.map((record) => {
    if (record.status !== EXECUTING_STATUS) return record;
    changed = true;
    const at = iso(Math.max(timestamp, parseCanonicalIso(record.updatedAt)));
    return Object.freeze({
      ...record,
      status: "reconciliation_required",
      updatedAt: at,
      terminalAt: at
    });
  });
  return {
    changed,
    records: canonicalRecordOrder(recovered)
  };
}

function pruneByRetention(records, timestamp, retentionMs) {
  const retained = records.filter((record) => (
    isProtectedClaimCallReceipt(record)
    || !TERMINAL_STATUSES.has(record.status)
    || timestamp - parseCanonicalIso(record.terminalAt) < retentionMs
  ));
  return {
    changed: retained.length !== records.length,
    records: canonicalRecordOrder(retained)
  };
}

function makeCapacity(records, maxRecords) {
  if (records.length < maxRecords) return records;
  return trimToLength(records, maxRecords - 1).records;
}

function trimToLength(records, targetLength) {
  if (records.length <= targetLength) {
    return { changed: false, records };
  }
  const terminal = records
    .filter((record) => (
      TERMINAL_STATUSES.has(record.status)
      && !isProtectedClaimCallReceipt(record)
    ))
    .sort((left, right) => (
      parseCanonicalIso(left.terminalAt) - parseCanonicalIso(right.terminalAt)
      || left.planId.localeCompare(right.planId)
    ));
  if (terminal.length === 0) {
    return { changed: false, records };
  }
  const removeCount = Math.min(
    terminal.length,
    records.length - targetLength
  );
  const removed = new Set(
    terminal.slice(0, removeCount).map((record) => record.planId)
  );
  return {
    changed: removeCount > 0,
    records: canonicalRecordOrder(
      records.filter((record) => !removed.has(record.planId))
    )
  };
}

function isProtectedClaimCallReceipt(record) {
  return record.operationKind === "retell.claim_filing_call"
    && [
      EXECUTING_STATUS,
      "completed_pending_verification",
      "reconciliation_required"
    ].includes(record.status);
}

function persistRecords(filePath, records, maxFileBytes) {
  const document = {
    schemaVersion: SCHEMA_VERSION,
    records: canonicalRecordOrder(records).map((record) => ({ ...record }))
  };
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  if (bytes.length > maxFileBytes) {
    throw receiptError(
      "receipt_index_full",
      507,
      "The action receipt index exceeds its bounded storage size"
    );
  }

  const parent = dirname(filePath);
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch {
    throw storageUnavailable();
  }
  assertSafeExistingTarget(filePath);

  let tempPath;
  let descriptor;
  try {
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
      tempPath = `${filePath}.tmp-${cryptographicRandomBytes(12).toString("hex")}`;
      try {
        descriptor = openSync(
          tempPath,
          fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | fsConstants.O_WRONLY,
          0o600
        );
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (descriptor === undefined) throw new Error("temporary path exhausted");
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, filePath);
    tempPath = undefined;
    syncDirectoryBestEffort(parent);
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the primary storage failure.
      }
    }
    if (tempPath !== undefined) {
      try {
        unlinkSync(tempPath);
      } catch {
        // A failed temporary cleanup never mutates the committed index.
      }
    }
    throw storageUnavailable();
  }
}

function syncDirectoryBestEffort(parent) {
  let descriptor;
  try {
    descriptor = openSync(parent, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // The data file itself was fsynced before its atomic rename. Some
    // platforms/filesystems do not support directory fsync.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // There is no safe rollback after the atomic rename.
      }
    }
  }
}

function assertSafeExistingTarget(filePath) {
  if (!existsSync(filePath)) return;
  let metadata;
  try {
    metadata = lstatSync(filePath);
  } catch {
    throw storageUnavailable();
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw corruptIndex();
  }
}

function locateRecord(records, identity) {
  const byPlan = records.findIndex(
    (record) => record.planId === identity.planId
  );
  if (byPlan < 0) throw notFound();
  const record = records[byPlan];
  if (
    record.sessionPrincipalRef !== identity.sessionPrincipalRef
    || record.fileRef !== identity.fileRef
    || record.digest !== identity.digest
    || record.batchRef !== identity.batchRef
  ) {
    throw notFound();
  }
  return byPlan;
}

function validateTerminalCounts(value) {
  const status = assertTerminalStatus(value.status);
  const counts = {
    succeededCount: assertCount(value.succeededCount, "succeededCount"),
    failedCount: assertCount(value.failedCount, "failedCount"),
    blockedCount: assertCount(value.blockedCount, "blockedCount"),
    unknownCount: assertCount(value.unknownCount, "unknownCount")
  };
  if (value.operationCount === undefined) return counts;
  const operationCount = assertOperationCount(value.operationCount);
  const total = Object.values(counts).reduce(
    (sum, count) => sum + count,
    0
  );
  if (total !== operationCount) {
    throw receiptError(
      "invalid_operation_counts",
      400,
      "Terminal operation counts must equal the operation count"
    );
  }
  const valid = (
    (
      ["executed", "completed_pending_verification"].includes(status)
      && counts.succeededCount === operationCount
      && counts.failedCount === 0
      && counts.blockedCount === 0
      && counts.unknownCount === 0
    )
    || (
      status === "partial_failure"
      && counts.succeededCount > 0
      && counts.failedCount + counts.blockedCount > 0
      && counts.unknownCount === 0
    )
    || (
      status === "blocked_duplicate"
      && counts.succeededCount === 0
      && counts.failedCount === 0
      && counts.blockedCount === operationCount
      && counts.unknownCount === 0
    )
    || (
      status === "failed"
      && counts.succeededCount === 0
      && counts.failedCount > 0
      && counts.failedCount + counts.blockedCount === operationCount
      && counts.unknownCount === 0
    )
    || status === "reconciliation_required"
  );
  if (!valid) {
    throw receiptError(
      "invalid_operation_counts",
      400,
      "Terminal operation counts do not match the receipt status"
    );
  }
  return counts;
}

function projectRecord(record) {
  const projection = {
    fileRef: record.fileRef,
    planId: record.planId,
    digest: record.digest,
    batchRef: record.batchRef,
    status: record.status,
    operationCount: record.operationCount,
    succeededCount: record.succeededCount,
    failedCount: record.failedCount,
    blockedCount: record.blockedCount,
    unknownCount: record.unknownCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    executingAt: record.executingAt
  };
  if (record.terminalAt !== undefined) {
    projection.terminalAt = record.terminalAt;
  }
  if (record.operationKind !== undefined) {
    projection.operationKind = record.operationKind;
  }
  return deepFreeze(projection);
}

function canonicalRecordOrder(records) {
  return records.slice().sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.planId.localeCompare(right.planId)
  ));
}

function compareProjectionOrder(left, right) {
  return (
    right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || left.planId.localeCompare(right.planId)
  );
}

function assertUniqueRecords(records) {
  const plans = new Set();
  const batches = new Set();
  for (const record of records) {
    if (plans.has(record.planId) || batches.has(record.batchRef)) {
      throw corruptIndex();
    }
    plans.add(record.planId);
    batches.add(record.batchRef);
  }
}

function allocateBatchRef(randomBatchRef, records) {
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
    let value;
    try {
      value = randomBatchRef();
    } catch {
      throw receiptError(
        "batch_ref_failed",
        500,
        "Secure receipt reference generation failed"
      );
    }
    if (typeof value !== "string" || !BATCH_REF_PATTERN.test(value)) {
      throw receiptError(
        "batch_ref_failed",
        500,
        "randomBatchRef must return an opaque batch reference"
      );
    }
    if (!records.some((record) => record.batchRef === value)) return value;
  }
  throw receiptError(
    "batch_ref_failed",
    500,
    "Unable to allocate a unique receipt reference"
  );
}

function secureBatchRef() {
  return `batch_${cryptographicRandomBytes(16).toString("hex")}`;
}

function validateFilePath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || value.includes("\0")
  ) {
    throw new TypeError("filePath must be a bounded filesystem path");
  }
  const resolved = resolve(value);
  if (!isAbsolute(resolved)) {
    throw new TypeError("filePath must resolve to an absolute path");
  }
  return resolved;
}

function assertSessionPrincipalRef(value) {
  if (
    typeof value !== "string"
    || !SESSION_PRINCIPAL_REF_PATTERN.test(value)
  ) {
    throw receiptError(
      "invalid_session_principal_ref",
      400,
      "sessionPrincipalRef must be an opaque HCN principal reference"
    );
  }
  return value;
}

function assertFileRef(value) {
  if (typeof value !== "string" || !FILE_REF_PATTERN.test(value)) {
    throw receiptError(
      "invalid_file_ref",
      400,
      "fileRef must be one exact opaque HCN subject reference"
    );
  }
  return value;
}

function assertPlanId(value) {
  if (typeof value !== "string" || !PLAN_ID_PATTERN.test(value)) {
    throw receiptError(
      "receipt_not_found",
      404,
      "Action receipt not found"
    );
  }
  return value;
}

function assertDigest(value) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw receiptError(
      "invalid_digest",
      400,
      "digest must be a lowercase SHA-256 approval digest"
    );
  }
  return value;
}

function assertBatchRef(value) {
  if (typeof value !== "string" || !BATCH_REF_PATTERN.test(value)) {
    throw receiptError(
      "receipt_not_found",
      404,
      "Action receipt not found"
    );
  }
  return value;
}

function assertOperationCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 12) {
    throw receiptError(
      "invalid_operation_count",
      400,
      "operationCount must be an integer from 1 through 12"
    );
  }
  return value;
}

function assertOperationKind(value) {
  if (typeof value !== "string" || !OPERATION_KINDS.has(value)) {
    throw receiptError(
      "invalid_operation_kind",
      400,
      "operationKind must identify a supported HCN operation family"
    );
  }
  return value;
}

function assertCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 12) {
    throw receiptError(
      "invalid_operation_counts",
      400,
      `${name} must be an integer from 0 through 12`
    );
  }
  return value;
}

function assertTerminalStatus(value) {
  if (typeof value !== "string" || !TERMINAL_STATUSES.has(value)) {
    throw receiptError(
      "invalid_receipt_status",
      400,
      "Receipt transition status must be terminal"
    );
  }
  return value;
}

function assertStatus(value) {
  if (typeof value !== "string" || !ALL_STATUSES.has(value)) {
    throw receiptError(
      "invalid_receipt_status",
      400,
      "Receipt status is not supported"
    );
  }
  return value;
}

function assertStoredStatus(value) {
  try {
    return assertStatus(value);
  } catch {
    throw corruptIndex();
  }
}

function assertListLimit(value) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_LIST_LIMIT
  ) {
    throw receiptError(
      "invalid_list_limit",
      400,
      `limit must be an integer from 1 through ${MAX_LIST_LIMIT}`
    );
  }
  return value;
}

function canonicalIso(value) {
  const timestamp = parseCanonicalIso(value);
  return iso(timestamp);
}

function parseCanonicalIso(value) {
  if (
    typeof value !== "string"
    || value.length !== 24
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw receiptError(
      "invalid_timestamp",
      400,
      "Receipt timestamps must be canonical UTC ISO timestamps"
    );
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isSafeInteger(timestamp)
    || timestamp < 0
    || iso(timestamp) !== value
  ) {
    throw receiptError(
      "invalid_timestamp",
      400,
      "Receipt timestamps must be canonical UTC ISO timestamps"
    );
  }
  return timestamp;
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw receiptError("clock_failed", 500, "Receipt clock failed");
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw receiptError(
      "clock_failed",
      500,
      "Receipt clock must return a non-negative millisecond timestamp"
    );
  }
  return timestamp;
}

function assertExactObject(value, allowed, label, { optional = new Set() } = {}) {
  if (!isPlainObject(value)) {
    throw receiptError(
      "invalid_receipt_request",
      400,
      `${label} must be an object`
    );
  }
  if (!hasExactKeys(value, new Set([
    ...[...allowed].filter((key) => !optional.has(key)),
    ...Object.keys(value).filter((key) => optional.has(key))
  ]))) {
    throw receiptError(
      "invalid_receipt_request",
      400,
      `${label} contains missing or unsupported fields`
    );
  }
}

function hasExactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => (
      typeof key === "string"
      && expected.has(key)
      && Object.prototype.propertyIsEnumerable.call(value, key)
      && Object.hasOwn(
        Object.getOwnPropertyDescriptor(value, key) || {},
        "value"
      )
    ))
    && keys.length === expected.size
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertStored(callback) {
  try {
    return callback();
  } catch {
    throw corruptIndex();
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
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

function notFound() {
  return receiptError(
    "receipt_not_found",
    404,
    "Action receipt not found"
  );
}

function corruptIndex() {
  return receiptError(
    "receipt_index_corrupt",
    500,
    "The action receipt index is unavailable because its contents are invalid"
  );
}

function storageUnavailable() {
  return receiptError(
    "receipt_index_unavailable",
    503,
    "The action receipt index could not be durably accessed"
  );
}

function receiptError(code, statusCode, message) {
  return new HcnActionReceiptIndexError(code, statusCode, message);
}
