import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes as cryptographicRandomBytes,
  timingSafeEqual
} from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";

import {
  THRESHER_SCHEMA_VERSIONS,
  THRESHER_SYSTEM_ID,
  ThresherContractError,
  buildThresherRecord,
  buildThresherSnapshot,
  thresherRecordRef,
  validateThresherRecord
} from "./contracts.js";

const STORE_SCHEMA_VERSION = "hcn.thresher.store.v1";
const ENVELOPE_SCHEMA_VERSION = "hcn.thresher.store-envelope.v1";
const ENVELOPE_ALGORITHM = "A256GCM";
const ENVELOPE_KEY_DERIVATION = "HKDF-SHA256";
const KEY_DERIVATION_SALT = Buffer.from(
  "hcn-thresher-store:hkdf-salt:v1",
  "utf8"
);
const KEY_DERIVATION_INFO = Buffer.from(
  "hcn-thresher-store:aes-256-gcm-key:v1",
  "utf8"
);
const ENVELOPE_AAD = Buffer.from(
  JSON.stringify({
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    systemId: THRESHER_SYSTEM_ID,
    algorithm: ENVELOPE_ALGORITHM,
    keyDerivation: ENVELOPE_KEY_DERIVATION,
    purpose: "isolated-hcn-thresher-operational-brain"
  }),
  "utf8"
);
const TENANT_REF_PATTERN = /^tenant_[a-f0-9]{16}$/;
const FILE_REF_PATTERN = /^file_[a-f0-9]{32}$/;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const MIN_MASTER_KEY_BYTES = 32;
const MAX_MASTER_KEY_BYTES = 128;
const DEFAULT_MAX_RECORDS = 512;
const HARD_MAX_RECORDS = 512;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const HARD_MAX_FUTURE_SKEW_MS = 15 * 60 * 1000;
const MAX_SNAPSHOT_RECORDS = 512;
const TEMPORARY_NAME_ATTEMPTS = 4;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Create an isolated, encrypted HCN Thresher operational-brain store.
 *
 * `filePath` and `encryptionKey` are caller-injected. The intended deployment
 * contract is HCN_THRESHER_STORE_PATH plus a dedicated
 * HCN_THRESHER_STORE_KEY. This module never reads environment variables and
 * never loads provider, personal-memory, unrelated-product, or client-data
 * modules.
 *
 * Records are immutable by opaque record reference. Fresh evidence is
 * authoritative: a newer observation for the same coded source slot prevents
 * older or equally-timed conflicting evidence from entering the store, and
 * every derived rule/work/plan must depend on the current fresh evidence.
 */
export function createThresherStore({
  filePath,
  encryptionKey,
  tenantRef,
  now = Date.now,
  randomBytes = cryptographicRandomBytes,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFutureSkewMs = DEFAULT_MAX_FUTURE_SKEW_MS
} = {}) {
  const configuredPath = normalizeStorePath(filePath);
  const configuredTenantRef = requireTenantRef(tenantRef, "tenantRef");
  const derivedKey = deriveEncryptionKey(encryptionKey);
  assertFunction(now, "now");
  assertFunction(randomBytes, "randomBytes");
  assertBoundedInteger(maxRecords, 1, HARD_MAX_RECORDS, "maxRecords");
  assertBoundedInteger(
    maxFileBytes,
    1024,
    HARD_MAX_FILE_BYTES,
    "maxFileBytes"
  );
  assertBoundedInteger(
    maxFutureSkewMs,
    0,
    HARD_MAX_FUTURE_SKEW_MS,
    "maxFutureSkewMs"
  );

  let mutationQueue = Promise.resolve();
  let closed = false;

  async function put(value) {
    const records = await putMany([value]);
    return records[0];
  }

  async function putMany(values) {
    assertOpen();
    if (
      !Array.isArray(values)
      || values.length < 1
      || values.length > 64
    ) {
      invalidInput(
        "A Thresher atomic write must contain between 1 and 64 records."
      );
    }
    const records = values.map((value) => {
      try {
        return buildThresherRecord(value, {
          tenantRef: configuredTenantRef
        });
      } catch (error) {
        if (error instanceof ThresherContractError) {
          invalidInput(error.message);
        }
        throw error;
      }
    });
    const suppliedReferences = records.map(thresherRecordRef);
    if (new Set(suppliedReferences).size !== suppliedReferences.length) {
      invalidInput(
        "A Thresher atomic write cannot repeat a record reference."
      );
    }

    return enqueueMutation(async () => {
      assertOpen();
      const timestamp = readNow(now);
      records.forEach((record) =>
        assertRecordClock(record, timestamp, maxFutureSkewMs)
      );
      const document = await readEncryptedDocument({
        filePath: configuredPath,
        key: derivedKey,
        tenantRef: configuredTenantRef,
        maxRecords,
        maxFileBytes
      });
      let workingRecords = compactOperationalHistory(
        document.records,
        timestamp
      );
      let changed = workingRecords.length !== document.records.length;
      for (const record of records) {
        const reference = thresherRecordRef(record);
        const existing = workingRecords.find(
          (candidate) => thresherRecordRef(candidate) === reference
        );
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(record)) {
            conflict(
              "immutable_record_conflict",
              "A Thresher record reference cannot be reused for different state."
            );
          }
          continue;
        }

        enforceAuthoritativeWrite(workingRecords, record, timestamp);
        workingRecords.push(record);
        changed = true;
      }

      workingRecords = compactOperationalHistory(
        workingRecords,
        timestamp
      );
      if (workingRecords.length > maxRecords) {
        conflict(
          "capacity_exceeded",
          "The bounded Thresher store is at capacity."
        );
      }
      if (changed) {
        document.records = workingRecords.sort(comparePersistedRecords);
        await writeEncryptedDocument({
          filePath: configuredPath,
          key: derivedKey,
          document,
          randomBytes,
          maxRecords,
          maxFileBytes
        });
      }
      return Object.freeze([...records]);
    });
  }

  async function snapshot(input) {
    assertOpen();
    const fileRef = validateSnapshotInput(
      input,
      configuredTenantRef
    );
    const timestamp = readNow(now);
    const document = await readEncryptedDocument({
      filePath: configuredPath,
      key: derivedKey,
      tenantRef: configuredTenantRef,
      maxRecords,
      maxFileBytes
    });
    return projectSnapshot(
      document.records.filter(
        (record) => record.fileRef === fileRef
      ),
      configuredTenantRef,
      fileRef,
      timestamp
    );
  }

  function close() {
    if (!closed) {
      closed = true;
      derivedKey.fill(0);
    }
  }

  function enqueueMutation(operation) {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function assertOpen() {
    if (closed) {
      throw storeError(
        "store_closed",
        "The Thresher store has been closed.",
        503
      );
    }
  }

  return Object.freeze({
    put,
    putMany,
    snapshot,
    close
  });
}

export class ThresherStoreError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "ThresherStoreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function enforceAuthoritativeWrite(records, record, timestamp) {
  switch (record.recordType) {
    case "evidence":
      enforceEvidenceWrite(records, record, timestamp);
      return;
    case "rule_state":
      enforceRuleWrite(records, record, timestamp);
      return;
    case "work_state":
      enforceWorkWrite(records, record, timestamp);
      return;
    case "plan":
      enforcePlanWrite(records, record, timestamp);
      return;
    case "receipt":
      enforceReceiptWrite(records, record);
      return;
    default:
      corruptStore("The Thresher record type is unsupported.");
  }
}

function enforceEvidenceWrite(records, record, timestamp) {
  if (!isFreshAt(record, timestamp)) {
    conflict(
      "stale_evidence",
      "Only currently fresh source evidence can enter Thresher."
    );
  }
  const sameSlot = records.filter(
    (candidate) =>
      candidate.recordType === "evidence"
      && sameScope(candidate, record)
      && candidate.sourceCode === record.sourceCode
      && candidate.evidenceCode === record.evidenceCode
  );
  if (sameSlot.length === 0) return;
  const newest = newestRecord(sameSlot, "checkedAt");
  const comparison =
    Date.parse(record.checkedAt) - Date.parse(newest.checkedAt);
  if (comparison < 0) {
    conflict(
      "superseded_evidence",
      "Older evidence cannot supersede a newer Thresher observation."
    );
  }
  if (comparison === 0) {
    conflict(
      "ambiguous_evidence",
      "Conflicting evidence with the same source freshness is not allowed."
    );
  }
}

function enforceRuleWrite(records, record, timestamp) {
  if (!isFreshAt(record, timestamp)) {
    conflict(
      "stale_rule_state",
      "A new rule state must be current when recorded."
    );
  }
  assertNotOlderCodedState(
    records,
    record,
    "rule_state",
    "ruleCode",
    "evaluatedAt"
  );
  const evidence = requireAuthoritativeEvidence(
    records,
    record,
    timestamp
  );
  requireDependencyLifetime(
    record.validUntil,
    evidence,
    "A rule state cannot outlive its fresh evidence."
  );
}

function enforceWorkWrite(records, record, timestamp) {
  if (!isFreshAt(record, timestamp)) {
    conflict(
      "stale_work_state",
      "A new work state must be current when recorded."
    );
  }
  assertNotOlderCodedState(
    records,
    record,
    "work_state",
    "workCode",
    "updatedAt"
  );
  const evidence = requireAuthoritativeEvidence(
    records,
    record,
    timestamp
  );
  const rules = requireActiveRules(records, record, timestamp);
  requireDependencyLifetime(
    record.validUntil,
    [...evidence, ...rules],
    "A work state cannot outlive its fresh dependencies."
  );
}

function enforcePlanWrite(records, record, timestamp) {
  if (!isFreshAt(record, timestamp)) {
    conflict(
      "stale_plan",
      "A new action plan must be current when recorded."
    );
  }
  const evidence = requireAuthoritativeEvidence(
    records,
    record,
    timestamp
  );
  const rules = requireActiveRules(records, record, timestamp);
  requireDependencyLifetime(
    record.validUntil,
    [...evidence, ...rules],
    "An action plan cannot outlive its fresh dependencies."
  );
}

function enforceReceiptWrite(records, record) {
  const plan = records.find(
    (candidate) =>
      candidate.recordType === "plan"
      && candidate.planRef === record.planRef
      && sameScope(candidate, record)
  );
  if (!plan) {
    conflict(
      "missing_plan",
      "A receipt must reference an existing same-file action plan."
    );
  }
  if (!["approved", "executed"].includes(plan.stateCode)) {
    conflict(
      "unapproved_plan",
      "A receipt cannot attach to a plan that was not approved."
    );
  }
  if (!plan.operationCodes.includes(record.operationCode)) {
    conflict(
      "operation_mismatch",
      "A receipt operation must exist in its approved plan."
    );
  }
  if (
    Date.parse(record.startedAt) < Date.parse(plan.createdAt)
    || Date.parse(record.startedAt) > Date.parse(plan.validUntil)
  ) {
    conflict(
      "plan_not_current",
      "A receipt must begin while its approved plan is current."
    );
  }
  const existingOperation = records.find(
    (candidate) =>
      candidate.recordType === "receipt"
      && candidate.planRef === record.planRef
      && candidate.operationCode === record.operationCode
      && sameScope(candidate, record)
  );
  if (existingOperation) {
    conflict(
      "duplicate_operation_receipt",
      "An approved plan operation accepts exactly one terminal receipt."
    );
  }
}

function assertNotOlderCodedState(
  records,
  record,
  recordType,
  codeField,
  timestampField
) {
  const sameCode = records.filter(
    (candidate) =>
      candidate.recordType === recordType
      && sameScope(candidate, record)
      && candidate[codeField] === record[codeField]
  );
  if (sameCode.length === 0) return;
  const newest = newestRecord(sameCode, timestampField);
  const comparison =
    Date.parse(record[timestampField])
    - Date.parse(newest[timestampField]);
  if (comparison < 0) {
    conflict(
      "superseded_state",
      "Older coded state cannot supersede a newer Thresher state."
    );
  }
  if (comparison === 0) {
    conflict(
      "ambiguous_state",
      "Conflicting coded state with the same evaluation time is not allowed."
    );
  }
}

function requireAuthoritativeEvidence(records, record, timestamp) {
  const authoritative = authoritativeEvidenceForScope(
    records,
    record.tenantRef,
    record.fileRef,
    timestamp
  );
  const byReference = new Map(
    authoritative.map((candidate) => [
      candidate.evidenceRef,
      candidate
    ])
  );
  const selected = [];
  for (const evidenceRef of record.evidenceRefs) {
    const evidence = byReference.get(evidenceRef);
    if (!evidence) {
      conflict(
        "missing_fresh_evidence",
        "Derived Thresher state must reference current authoritative evidence."
      );
    }
    selected.push(evidence);
  }
  return selected;
}

function requireActiveRules(records, record, timestamp) {
  if (record.ruleRefs.length === 0) return [];
  const active = activeRulesForScope(
    records,
    record.tenantRef,
    record.fileRef,
    timestamp
  );
  const byReference = new Map(
    active.map((candidate) => [candidate.ruleRef, candidate])
  );
  const selected = [];
  for (const ruleRef of record.ruleRefs) {
    const rule = byReference.get(ruleRef);
    if (!rule) {
      conflict(
        "missing_fresh_rule",
        "Derived Thresher state must reference a current rule evaluation."
      );
    }
    selected.push(rule);
  }
  return selected;
}

function requireDependencyLifetime(validUntil, dependencies, message) {
  const expiresAt = Date.parse(validUntil);
  if (
    dependencies.some(
      (dependency) => Date.parse(dependency.validUntil) < expiresAt
    )
  ) {
    conflict("dependency_expires_first", message);
  }
}

function projectSnapshot(
  records,
  tenantRef,
  fileRef,
  timestamp
) {
  const authoritativeEvidence = authoritativeEvidenceForScope(
    records,
    tenantRef,
    fileRef,
    timestamp
  );
  const evidenceRefs = new Set(
    authoritativeEvidence.map((record) => record.evidenceRef)
  );
  const activeRuleStates = latestCodedRecords(
    records.filter(
      (record) =>
        record.recordType === "rule_state"
        && isFreshAt(record, timestamp)
    ),
    "ruleCode",
    "evaluatedAt"
  ).filter((record) =>
    record.evidenceRefs.every((reference) => evidenceRefs.has(reference))
  );
  const ruleRefs = new Set(
    activeRuleStates.map((record) => record.ruleRef)
  );
  const activeWorkStates = latestCodedRecords(
    records.filter(
      (record) =>
        record.recordType === "work_state"
        && isFreshAt(record, timestamp)
    ),
    "workCode",
    "updatedAt"
  ).filter(
    (record) =>
      record.evidenceRefs.every((reference) => evidenceRefs.has(reference))
      && record.ruleRefs.every((reference) => ruleRefs.has(reference))
  );
  const activePlans = records
    .filter(
      (record) =>
        record.recordType === "plan"
        && ["proposed", "approved"].includes(record.stateCode)
        && isFreshAt(record, timestamp)
        && record.evidenceRefs.every(
          (reference) => evidenceRefs.has(reference)
        )
        && record.ruleRefs.every((reference) => ruleRefs.has(reference))
    )
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.planRef.localeCompare(right.planRef)
        : left.createdAt.localeCompare(right.createdAt)
    )
    .slice(-MAX_SNAPSHOT_RECORDS)
    .sort((left, right) => left.planRef.localeCompare(right.planRef));
  const receipts = records
    .filter((record) => record.recordType === "receipt")
    .sort((left, right) =>
      left.completedAt === right.completedAt
        ? left.receiptRef.localeCompare(right.receiptRef)
        : left.completedAt.localeCompare(right.completedAt)
    )
    .slice(-MAX_SNAPSHOT_RECORDS);

  return buildThresherSnapshot(
    {
      schemaVersion: THRESHER_SCHEMA_VERSIONS.snapshot,
      systemId: THRESHER_SYSTEM_ID,
      tenantRef,
      fileRef,
      generatedAt: new Date(timestamp).toISOString(),
      authoritativeEvidence,
      activeRuleStates,
      activeWorkStates,
      activePlans,
      receipts
    },
    { tenantRef, fileRef }
  );
}

/**
 * Deterministically removes superseded transient state while preserving the
 * complete receipt audit graph. Receipts are never compacted. Every plan named
 * by a receipt, plus that plan's rule/evidence dependencies, is retained.
 * Current unreceipted plans and the newest coded state per file are retained;
 * only expired unreceipted plans and superseded unreferenced review state can
 * be removed.
 */
function compactOperationalHistory(records, timestamp) {
  const byReference = new Map(
    records.map((record) => [thresherRecordRef(record), record])
  );
  const retained = new Set();
  const retain = (record) => {
    if (record) retained.add(thresherRecordRef(record));
  };

  const receipts = records.filter(
    (record) => record.recordType === "receipt"
  );
  receipts.forEach(retain);
  const receiptedPlanRefs = new Set(
    receipts.map((record) => record.planRef)
  );
  records
    .filter(
      (record) =>
        record.recordType === "plan"
        && (
          receiptedPlanRefs.has(record.planRef)
          || (
            ["proposed", "approved"].includes(record.stateCode)
            && isFreshAt(record, timestamp)
          )
        )
    )
    .forEach(retain);

  newestPerOperationalSlot(
    records,
    "evidence",
    (record) =>
      `${record.tenantRef}\0${record.fileRef}\0${record.sourceCode}\0${record.evidenceCode}`,
    "checkedAt"
  ).forEach(retain);
  newestPerOperationalSlot(
    records,
    "rule_state",
    (record) =>
      `${record.tenantRef}\0${record.fileRef}\0${record.ruleCode}`,
    "evaluatedAt"
  ).forEach(retain);
  newestPerOperationalSlot(
    records,
    "work_state",
    (record) =>
      `${record.tenantRef}\0${record.fileRef}\0${record.workCode}`,
    "updatedAt"
  ).forEach(retain);

  let addedDependency = true;
  while (addedDependency) {
    addedDependency = false;
    for (const reference of [...retained]) {
      const record = byReference.get(reference);
      if (!record) continue;
      const dependencies =
        record.recordType === "receipt"
          ? [record.planRef]
          : record.recordType === "plan"
            ? [...record.evidenceRefs, ...record.ruleRefs]
            : record.recordType === "rule_state"
              ? record.evidenceRefs
              : record.recordType === "work_state"
                ? [...record.evidenceRefs, ...record.ruleRefs]
                : [];
      for (const dependency of dependencies) {
        if (!retained.has(dependency) && byReference.has(dependency)) {
          retained.add(dependency);
          addedDependency = true;
        }
      }
    }
  }

  return records.filter(
    (record) => retained.has(thresherRecordRef(record))
  );
}

function newestPerOperationalSlot(
  records,
  recordType,
  slotFor,
  timestampField
) {
  const newestBySlot = new Map();
  for (const record of records) {
    if (record.recordType !== recordType) continue;
    const slot = slotFor(record);
    const existing = newestBySlot.get(slot);
    if (
      !existing
      || Date.parse(record[timestampField])
        > Date.parse(existing[timestampField])
      || (
        record[timestampField] === existing[timestampField]
        && thresherRecordRef(record).localeCompare(
          thresherRecordRef(existing)
        ) > 0
      )
    ) {
      newestBySlot.set(slot, record);
    }
  }
  return [...newestBySlot.values()];
}

function authoritativeEvidenceForScope(
  records,
  tenantRef,
  fileRef,
  timestamp
) {
  const latestBySlot = new Map();
  for (const record of records) {
    if (
      record.recordType !== "evidence"
      || record.tenantRef !== tenantRef
      || record.fileRef !== fileRef
    ) {
      continue;
    }
    const slot = `${record.sourceCode}\0${record.evidenceCode}`;
    const existing = latestBySlot.get(slot);
    if (
      !existing
      || Date.parse(record.checkedAt) > Date.parse(existing.checkedAt)
    ) {
      latestBySlot.set(slot, record);
    }
  }
  return [...latestBySlot.values()]
    .filter((record) => isFreshAt(record, timestamp))
    .sort((left, right) =>
      left.evidenceRef.localeCompare(right.evidenceRef)
    );
}

function activeRulesForScope(
  records,
  tenantRef,
  fileRef,
  timestamp
) {
  const evidenceRefs = new Set(
    authoritativeEvidenceForScope(
      records,
      tenantRef,
      fileRef,
      timestamp
    ).map((record) => record.evidenceRef)
  );
  return latestCodedRecords(
    records.filter(
      (record) =>
        record.recordType === "rule_state"
        && record.tenantRef === tenantRef
        && record.fileRef === fileRef
        && isFreshAt(record, timestamp)
    ),
    "ruleCode",
    "evaluatedAt"
  ).filter((record) =>
    record.evidenceRefs.every((reference) => evidenceRefs.has(reference))
  );
}

function latestCodedRecords(records, codeField, timestampField) {
  const latest = new Map();
  for (const record of records) {
    const existing = latest.get(record[codeField]);
    if (
      !existing
      || Date.parse(record[timestampField])
        > Date.parse(existing[timestampField])
    ) {
      latest.set(record[codeField], record);
    }
  }
  return [...latest.values()].sort((left, right) =>
    thresherRecordRef(left).localeCompare(thresherRecordRef(right))
  );
}

function isFreshAt(record, timestamp) {
  const startField =
    record.recordType === "evidence"
      ? "checkedAt"
      : record.recordType === "rule_state"
        ? "evaluatedAt"
        : record.recordType === "work_state"
          ? "updatedAt"
          : record.recordType === "plan"
            ? "createdAt"
            : "";
  if (!startField || typeof record.validUntil !== "string") return false;
  return (
    Date.parse(record[startField]) <= timestamp
    && timestamp < Date.parse(record.validUntil)
  );
}

function sameScope(left, right) {
  return (
    left.tenantRef === right.tenantRef
    && left.fileRef === right.fileRef
  );
}

function newestRecord(records, timestampField) {
  return records.reduce((newest, candidate) =>
    Date.parse(candidate[timestampField])
      > Date.parse(newest[timestampField])
      ? candidate
      : newest
  );
}

function assertRecordClock(record, timestamp, maxFutureSkewMs) {
  const recordedAt = Date.parse(record.recordedAt);
  if (recordedAt > timestamp + maxFutureSkewMs) {
    conflict(
      "future_record",
      "A Thresher record cannot be materially future-dated."
    );
  }
}

function comparePersistedRecords(left, right) {
  if (left.tenantRef !== right.tenantRef) {
    return left.tenantRef.localeCompare(right.tenantRef);
  }
  if (left.fileRef !== right.fileRef) {
    return left.fileRef.localeCompare(right.fileRef);
  }
  if (left.recordType !== right.recordType) {
    return left.recordType.localeCompare(right.recordType);
  }
  return thresherRecordRef(left).localeCompare(thresherRecordRef(right));
}

async function readEncryptedDocument({
  filePath,
  key,
  tenantRef,
  maxRecords,
  maxFileBytes
}) {
  const parentState = await inspectParentDirectory(
    path.dirname(filePath),
    false
  );
  if (parentState === "missing") {
    return emptyDocument(tenantRef);
  }
  const metadata = await safeLstat(filePath);
  if (!metadata) return emptyDocument(tenantRef);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    unsafePath("The Thresher store path is not a regular file.");
  }
  if (metadata.size < 1 || metadata.size > maxFileBytes) {
    corruptStore("The encrypted Thresher store has an invalid size.");
  }
  await assertCanonicalRealPath(filePath);

  let handle;
  try {
    const noFollow = Number(filesystemConstants.O_NOFOLLOW || 0);
    handle = await open(
      filePath,
      Number(filesystemConstants.O_RDONLY) | noFollow
    );
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size || bytes.length > maxFileBytes) {
      corruptStore("The encrypted Thresher store changed while being read.");
    }
    return decryptDocument(bytes, key, tenantRef, maxRecords);
  } catch (error) {
    if (error instanceof ThresherStoreError) throw error;
    throw storeError(
      "store_read_failed",
      "The encrypted Thresher store could not be read.",
      503
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeEncryptedDocument({
  filePath,
  key,
  document,
  randomBytes,
  maxRecords,
  maxFileBytes
}) {
  validateDocument(document, document.tenantRef, maxRecords);
  const parent = path.dirname(filePath);
  await inspectParentDirectory(parent, true);
  const existing = await safeLstat(filePath);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      unsafePath("The Thresher store target is unsafe.");
    }
    await assertCanonicalRealPath(filePath);
  }

  const output = encryptDocument(document, key, randomBytes);
  if (output.length > maxFileBytes) {
    conflict(
      "store_oversize",
      "The encrypted Thresher store exceeds its size limit."
    );
  }

  let temporaryPath = "";
  let handle;
  let renamed = false;
  try {
    temporaryPath = await uniqueTemporaryPath(filePath, randomBytes);
    handle = await open(
      temporaryPath,
      Number(filesystemConstants.O_WRONLY)
        | Number(filesystemConstants.O_CREAT)
        | Number(filesystemConstants.O_EXCL),
      PRIVATE_FILE_MODE
    );
    await handle.writeFile(output);
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;

    const temporaryMetadata = await lstat(temporaryPath);
    if (
      temporaryMetadata.isSymbolicLink()
      || !temporaryMetadata.isFile()
      || temporaryMetadata.size !== output.length
    ) {
      unsafePath("The temporary Thresher store path is unsafe.");
    }
    await rename(temporaryPath, filePath);
    renamed = true;
    await chmod(filePath, PRIVATE_FILE_MODE);
    const finalMetadata = await lstat(filePath);
    if (
      finalMetadata.isSymbolicLink()
      || !finalMetadata.isFile()
      || finalMetadata.size !== output.length
    ) {
      unsafePath("The Thresher store was not written safely.");
    }
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof ThresherStoreError) throw error;
    throw storeError(
      "store_write_failed",
      "The encrypted Thresher store could not be written.",
      503
    );
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryPath && !renamed) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

function encryptDocument(document, key, randomBytes) {
  const nonce = secureRandomBytes(randomBytes, NONCE_BYTES, "nonce");
  const plaintext = Buffer.from(canonicalJson(document), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    cipher.setAAD(ENVELOPE_AAD, {
      plaintextLength: plaintext.length
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    const envelope = {
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      systemId: THRESHER_SYSTEM_ID,
      algorithm: ENVELOPE_ALGORITHM,
      keyDerivation: ENVELOPE_KEY_DERIVATION,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url")
    };
    return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  } finally {
    plaintext.fill(0);
  }
}

function decryptDocument(bytes, key, tenantRef, maxRecords) {
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    corruptStore("The encrypted Thresher envelope is invalid JSON.");
  }
  exactObject(
    envelope,
    [
      "schemaVersion",
      "systemId",
      "algorithm",
      "keyDerivation",
      "nonce",
      "ciphertext",
      "tag"
    ],
    "encrypted envelope",
    true
  );
  if (
    envelope.schemaVersion !== ENVELOPE_SCHEMA_VERSION
    || envelope.systemId !== THRESHER_SYSTEM_ID
    || envelope.algorithm !== ENVELOPE_ALGORITHM
    || envelope.keyDerivation !== ENVELOPE_KEY_DERIVATION
  ) {
    corruptStore("The encrypted Thresher envelope is unsupported.");
  }
  const nonce = canonicalBase64UrlBytes(
    envelope.nonce,
    "nonce",
    NONCE_BYTES
  );
  const tag = canonicalBase64UrlBytes(
    envelope.tag,
    "tag",
    AUTH_TAG_BYTES
  );
  const ciphertext = canonicalBase64UrlBytes(
    envelope.ciphertext,
    "ciphertext"
  );
  if (ciphertext.length < 1) {
    corruptStore("The encrypted Thresher ciphertext is empty.");
  }

  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES
    });
    decipher.setAAD(ENVELOPE_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    const document = JSON.parse(plaintext.toString("utf8"));
    validateDocument(document, tenantRef, maxRecords);
    return document;
  } catch (error) {
    if (error instanceof ThresherStoreError) throw error;
    corruptStore(
      "The encrypted Thresher ciphertext could not be authenticated."
    );
  } finally {
    plaintext?.fill(0);
  }
}

function validateDocument(value, tenantRef, maxRecords) {
  exactObject(
    value,
    ["schemaVersion", "systemId", "tenantRef", "records"],
    "store document",
    true
  );
  if (
    value.schemaVersion !== STORE_SCHEMA_VERSION
    || value.systemId !== THRESHER_SYSTEM_ID
    || value.tenantRef !== tenantRef
    || !Array.isArray(value.records)
    || value.records.length > maxRecords
  ) {
    corruptStore("The Thresher store document is invalid.");
  }

  const references = new Set();
  const evidenceSlots = new Map();
  const stateSlots = new Map();
  for (const record of value.records) {
    try {
      validateThresherRecord(record, { tenantRef });
    } catch (error) {
      if (error instanceof ThresherContractError) {
        corruptStore(`A persisted Thresher record is invalid: ${error.message}`);
      }
      throw error;
    }
    const reference = thresherRecordRef(record);
    if (references.has(reference)) {
      corruptStore("The Thresher store contains duplicate record references.");
    }
    references.add(reference);

    if (record.recordType === "evidence") {
      const slot =
        `${record.fileRef}\0${record.sourceCode}\0${record.evidenceCode}`;
      const current = evidenceSlots.get(slot);
      if (
        current
        && current.checkedAt === record.checkedAt
      ) {
        corruptStore("The Thresher store contains ambiguous source evidence.");
      }
      if (!current || current.checkedAt < record.checkedAt) {
        evidenceSlots.set(slot, record);
      }
    }
    if (record.recordType === "rule_state") {
      validatePersistedCodedSlot(
        stateSlots,
        record,
        "ruleCode",
        "evaluatedAt"
      );
    }
    if (record.recordType === "work_state") {
      validatePersistedCodedSlot(
        stateSlots,
        record,
        "workCode",
        "updatedAt"
      );
    }
  }
}

function validatePersistedCodedSlot(
  slots,
  record,
  codeField,
  timestampField
) {
  const slot =
    `${record.recordType}\0${record.fileRef}\0${record[codeField]}`;
  const current = slots.get(slot);
  if (current && current[timestampField] === record[timestampField]) {
    corruptStore("The Thresher store contains ambiguous coded state.");
  }
  if (!current || current[timestampField] < record[timestampField]) {
    slots.set(slot, record);
  }
}

function emptyDocument(tenantRef) {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    systemId: THRESHER_SYSTEM_ID,
    tenantRef,
    records: []
  };
}

function validateSnapshotInput(value, tenantRef) {
  exactObject(
    value,
    ["tenantRef", "fileRef"],
    "snapshot input",
    false
  );
  requireTenantRef(value.tenantRef, "snapshot input.tenantRef");
  if (value.tenantRef !== tenantRef) {
    invalidInput("snapshot input.tenantRef does not match the configured tenant.");
  }
  if (typeof value.fileRef !== "string" || !FILE_REF_PATTERN.test(value.fileRef)) {
    invalidInput("snapshot input.fileRef must be an opaque fileRef.");
  }
  return value.fileRef;
}

function deriveEncryptionKey(value) {
  const master = canonicalEncryptionKey(value);
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        master,
        KEY_DERIVATION_SALT,
        KEY_DERIVATION_INFO,
        DERIVED_KEY_BYTES
      )
    );
  } finally {
    master.fill(0);
  }
}

function canonicalEncryptionKey(value) {
  if (
    typeof value !== "string"
    || !CANONICAL_BASE64URL_PATTERN.test(value)
  ) {
    throw storeError(
      "invalid_configuration",
      "The dedicated Thresher store key must be canonical base64url.",
      500
    );
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (
    bytes.length < MIN_MASTER_KEY_BYTES
    || bytes.length > MAX_MASTER_KEY_BYTES
    || bytes.toString("base64url") !== value
  ) {
    bytes.fill(0);
    throw storeError(
      "invalid_configuration",
      "The dedicated Thresher store key must encode 32-128 bytes.",
      500
    );
  }
  return bytes;
}

function canonicalBase64UrlBytes(value, label, exactBytes = null) {
  if (
    typeof value !== "string"
    || !CANONICAL_BASE64URL_PATTERN.test(value)
  ) {
    corruptStore(`The encrypted ${label} is invalid.`);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    bytes = Buffer.alloc(0);
  }
  const canonical = bytes.toString("base64url");
  const supplied = Buffer.from(value, "utf8");
  const rebuilt = Buffer.from(canonical, "utf8");
  const canonicalMatch =
    supplied.length === rebuilt.length
    && timingSafeEqual(supplied, rebuilt);
  if (
    !canonicalMatch
    || (exactBytes !== null && bytes.length !== exactBytes)
  ) {
    corruptStore(`The encrypted ${label} is invalid.`);
  }
  return bytes;
}

async function inspectParentDirectory(directory, create) {
  let metadata = await safeLstat(directory);
  if (!metadata && create) {
    try {
      await mkdir(directory, {
        recursive: true,
        mode: 0o700
      });
    } catch {
      unsafePath("The Thresher store directory could not be created.");
    }
    metadata = await safeLstat(directory);
  }
  if (!metadata) return "missing";
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    unsafePath("The Thresher store directory is not a regular directory.");
  }
  await assertCanonicalRealPath(directory);
  return "ready";
}

async function assertCanonicalRealPath(target) {
  let actual;
  try {
    actual = await realpath(target);
  } catch {
    unsafePath("The Thresher store path could not be resolved safely.");
  }
  if (canonicalPath(actual) !== canonicalPath(path.resolve(target))) {
    unsafePath("Symbolic or redirected Thresher store paths are not allowed.");
  }
}

function canonicalPath(value) {
  const normalized = path.normalize(String(value || ""));
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

async function safeLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    unsafePath("The Thresher store path could not be inspected safely.");
  }
}

async function uniqueTemporaryPath(filePath, randomBytes) {
  for (
    let attempt = 0;
    attempt < TEMPORARY_NAME_ATTEMPTS;
    attempt += 1
  ) {
    const suffix = secureRandomBytes(
      randomBytes,
      16,
      "temporary filename"
    ).toString("hex");
    const candidate = `${filePath}.tmp-${suffix}`;
    if (!(await safeLstat(candidate))) return candidate;
  }
  throw storeError(
    "store_write_failed",
    "A unique temporary Thresher store file could not be allocated.",
    503
  );
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, Number(filesystemConstants.O_RDONLY));
    await handle.sync();
  } catch (error) {
    if (
      !["EINVAL", "EPERM", "EISDIR", "EBADF", "ENOTSUP"].includes(error?.code)
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

function secureRandomBytes(randomBytes, size, label) {
  let result;
  try {
    result = randomBytes(size);
  } catch {
    throw storeError(
      "randomness_unavailable",
      `Cryptographic ${label} generation failed.`,
      503
    );
  }
  if (
    (!Buffer.isBuffer(result) && !(result instanceof Uint8Array))
    || result.byteLength !== size
  ) {
    throw storeError(
      "randomness_unavailable",
      `Cryptographic ${label} generation returned an invalid value.`,
      503
    );
  }
  return Buffer.from(result);
}

function normalizeStorePath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || !path.isAbsolute(value)
  ) {
    throw storeError(
      "invalid_configuration",
      "The Thresher store requires an absolute file path.",
      500
    );
  }
  const resolved = path.resolve(value);
  if (path.dirname(resolved) === resolved) {
    throw storeError(
      "invalid_configuration",
      "The Thresher store path must identify a file.",
      500
    );
  }
  return resolved;
}

function requireTenantRef(value, label) {
  if (typeof value !== "string" || !TENANT_REF_PATTERN.test(value)) {
    throw storeError(
      "invalid_configuration",
      `${label} must be an opaque HCN tenant reference.`,
      500
    );
  }
  return value;
}

function exactObject(value, fields, label, persisted) {
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    if (persisted) corruptStore(`The ${label} is invalid.`);
    invalidInput(`${label} must be a plain object.`);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string")
    || fields.some((field) => !keys.includes(field))
    || keys.some((key) => !fields.includes(key))
  ) {
    if (persisted) corruptStore(`The ${label} has an invalid exact schema.`);
    invalidInput(`${label} must contain only its documented exact fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      if (persisted) corruptStore(`The ${label} is invalid.`);
      invalidInput(`${label} must contain plain enumerable fields.`);
    }
  }
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw storeError(
      "clock_unavailable",
      "The Thresher store clock is unavailable.",
      503
    );
  }
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw storeError(
      "clock_unavailable",
      "The Thresher store clock returned an invalid value.",
      503
    );
  }
  return timestamp;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
}

function assertBoundedInteger(value, min, max, label) {
  if (
    !Number.isSafeInteger(value)
    || value < min
    || value > max
  ) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  }
}

function invalidInput(message) {
  throw storeError("invalid_input", message, 400);
}

function conflict(code, message) {
  throw storeError(code, message, 409);
}

function corruptStore(message) {
  throw storeError("store_corrupt", message, 503);
}

function unsafePath(message) {
  throw storeError("unsafe_store_path", message, 503);
}

function storeError(code, message, statusCode) {
  return new ThresherStoreError(code, message, statusCode);
}
