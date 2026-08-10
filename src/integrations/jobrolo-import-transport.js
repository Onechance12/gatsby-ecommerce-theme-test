import {
  adaptJobNimbusFileEnvelopeToImportSnapshot,
  JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS
} from "./jobrolo-import-snapshot.js";
import {
  canonicalJson,
  JOBROLO_IMPORT_TRANSPORT_LIMITS
} from "./jobrolo-import-service-auth.js";

export const JOBROLO_IMPORT_CATALOG_SCHEMA =
  "jobrolo.jobnimbus-import.catalog.v1";

export const JOBROLO_IMPORT_READ_LIMITS = Object.freeze({
  maximumEligibleFiles: 500,
  maximumProviderIndexContacts: 5_000,
  maximumCollectionItems: 500,
  maximumFreshnessWindowMs: 15 * 60_000,
  maximumClockSkewMs: 60_000
});

const CONNECTION_REF = /^connection_[a-f0-9]{32}$/;
const SOURCE_FILE_REF = /^subject_[a-f0-9]{32}$/;
const PROVIDER_ID = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_JOB_NUMBER = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const INDEX_FIELDS = Object.freeze([
  "providerFileId",
  "jobNumber",
  "displayName",
  "statusCode",
  "stageCode",
  "fileTypeCode",
  "isInsuranceFile",
  "isActive",
  "assignedToCurrentUser",
  "updatedAt",
  "missingFacts"
]);

export function createJobroloImportReadService({
  connectionRef,
  referenceFactory,
  loadAssignedIndex,
  loadExactFile,
  now = Date.now
} = {}) {
  if (!CONNECTION_REF.test(String(connectionRef || ""))) {
    throw new TypeError("connectionRef is invalid");
  }
  if (
    !isPlainRecord(referenceFactory)
    || typeof referenceFactory.subjectId !== "function"
  ) {
    throw new TypeError("referenceFactory is invalid");
  }
  if (typeof loadAssignedIndex !== "function") {
    throw new TypeError("loadAssignedIndex is invalid");
  }
  if (typeof loadExactFile !== "function") {
    throw new TypeError("loadExactFile is invalid");
  }
  if (typeof now !== "function") throw new TypeError("now is invalid");

  const loadScope = async (requestedAt, currentMs) => {
    let loaded;
    try {
      loaded = await loadAssignedIndex({
        requestedAt,
        maximumContacts:
          JOBROLO_IMPORT_READ_LIMITS.maximumProviderIndexContacts,
        maximumEligibleFiles:
          JOBROLO_IMPORT_READ_LIMITS.maximumEligibleFiles
      });
    } catch {
      sourceUnavailable();
    }
    const index = normalizeAssignedIndex(loaded, currentMs);
    if (
      index.files.length
      > JOBROLO_IMPORT_READ_LIMITS.maximumEligibleFiles
    ) {
      boundsExceeded();
    }
    const files = index.files.map((file) => {
      let sourceFileRef;
      try {
        sourceFileRef = referenceFactory.subjectId(
          "jobnimbus",
          file.providerFileId
        );
      } catch {
        sourceUnavailable();
      }
      if (!SOURCE_FILE_REF.test(sourceFileRef)) sourceUnavailable();
      return { ...file, sourceFileRef };
    });
    if (new Set(files.map((file) => file.sourceFileRef)).size !== files.length) {
      sourceUnavailable();
    }
    files.sort((left, right) =>
      left.sourceFileRef.localeCompare(right.sourceFileRef)
    );
    return { ...index, files };
  };

  return Object.freeze({
    async readCatalog() {
      const currentMs = currentTime(now);
      const requestedAt = new Date(currentMs).toISOString();
      const scope = await loadScope(requestedAt, currentMs);
      assertFreshness(scope, currentTime(now));
      const catalog = deepFreeze({
        schema: JOBROLO_IMPORT_CATALOG_SCHEMA,
        source: {
          system: "jobnimbus",
          connectionRef,
          scope: "assigned",
          complete: true
        },
        asOf: scope.asOf,
        checkedAt: scope.checkedAt,
        validUntil: scope.validUntil,
        returnedItems: scope.files.length,
        items: scope.files.map((file) => ({
          sourceFileRef: file.sourceFileRef,
          jobNumber: file.jobNumber,
          displayName: file.displayName,
          statusCode: file.statusCode,
          stageCode: file.stageCode,
          updatedAt: file.updatedAt
        }))
      });
      if (
        Buffer.byteLength(canonicalJson(catalog), "utf8")
        > JOBROLO_IMPORT_TRANSPORT_LIMITS.maximumCatalogCanonicalUtf8Bytes
      ) boundsExceeded();
      return catalog;
    },

    async readSnapshot({ sourceFileRef } = {}) {
      if (!SOURCE_FILE_REF.test(String(sourceFileRef || ""))) {
        invalidRequest();
      }
      const currentMs = currentTime(now);
      const requestedAt = new Date(currentMs).toISOString();
      const scope = await loadScope(requestedAt, currentMs);
      const matches = scope.files.filter(
        (file) => file.sourceFileRef === sourceFileRef
      );
      if (matches.length !== 1) sourceNotFound();
      const selected = matches[0];

      let envelope;
      try {
        envelope = await loadExactFile({
          providerFileId: selected.providerFileId,
          knownProviderFileIds: scope.files.map(
            (file) => file.providerFileId
          ),
          requestedAt,
          maximumCollectionItems:
            JOBROLO_IMPORT_READ_LIMITS.maximumCollectionItems
        });
      } catch (error) {
        if (
          [
            "file_not_eligible",
            "assignment_not_verified",
            "scope_mismatch"
          ].includes(error?.code)
        ) sourceChanged();
        sourceUnavailable();
      }

      let snapshot;
      try {
        snapshot = adaptJobNimbusFileEnvelopeToImportSnapshot(envelope, {
          connectionRef,
          referenceFactory
        });
      } catch (error) {
        if (
          [
            "assignment_not_verified",
            "scope_mismatch",
            "invalid_source_scope"
          ].includes(error?.code)
        ) sourceChanged();
        sourceUnavailable();
      }
      if (
        snapshot.sourceFileRef !== sourceFileRef
        || snapshot.file.sourceFileRef !== sourceFileRef
        || snapshot.source.connectionRef !== connectionRef
        || snapshot.source.system !== "jobnimbus"
        || snapshot.source.scope !== "assigned"
        || snapshot.source.complete !== true
      ) sourceChanged();
      assertFreshness(snapshot, currentTime(now));
      if (
        Buffer.byteLength(canonicalJson(snapshot), "utf8")
        > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS
          .maximumCanonicalSnapshotUtf8Bytes
      ) boundsExceeded();
      return snapshot;
    }
  });
}

function normalizeAssignedIndex(value, currentMs) {
  exactRecord(value, ["status", "asOf", "checkedAt", "validUntil", "data"]);
  if (value.status !== "ok") sourceUnavailable();
  exactRecord(value.data, ["complete", "files"]);
  if (value.data.complete !== true || !Array.isArray(value.data.files)) {
    sourceUnavailable();
  }
  if (
    value.data.files.length
    > JOBROLO_IMPORT_READ_LIMITS.maximumEligibleFiles
  ) boundsExceeded();
  const freshness = assertFreshness(value, currentMs);
  const files = value.data.files.map((file) =>
    normalizeAssignedFile(file, freshness.asOfMs)
  );
  if (
    new Set(files.map((file) => file.providerFileId)).size !== files.length
  ) sourceUnavailable();
  return {
    asOf: value.asOf,
    checkedAt: value.checkedAt,
    validUntil: value.validUntil,
    files
  };
}

function normalizeAssignedFile(value, asOfMs) {
  exactRecord(value, INDEX_FIELDS);
  if (!PROVIDER_ID.test(value.providerFileId)) sourceUnavailable();
  if (!SAFE_JOB_NUMBER.test(value.jobNumber)) sourceUnavailable();
  const displayName = requiredSafeText(value.displayName, 120, 480);
  const statusCode = nullableCode(value.statusCode);
  const stageCode = nullableCode(value.stageCode);
  if (
    value.fileTypeCode !== "insurance"
    || value.isInsuranceFile !== true
    || value.isActive !== true
    || value.assignedToCurrentUser !== true
  ) sourceUnavailable();
  const updatedAtMs = parseIsoUtc(value.updatedAt);
  if (
    updatedAtMs === null
    || updatedAtMs
      > asOfMs + JOBROLO_IMPORT_READ_LIMITS.maximumClockSkewMs
  ) sourceUnavailable();
  exactRecord(value.missingFacts, [
    "claimNumber", "policyNumber", "dateOfLoss", "adjuster"
  ]);
  if (
    Object.values(value.missingFacts).some((item) => typeof item !== "boolean")
  ) sourceUnavailable();
  return {
    providerFileId: value.providerFileId,
    jobNumber: value.jobNumber,
    displayName,
    statusCode,
    stageCode,
    updatedAt: value.updatedAt
  };
}

function assertFreshness(value, currentMs) {
  const asOfMs = parseIsoUtc(value.asOf);
  const checkedAtMs = parseIsoUtc(value.checkedAt);
  const validUntilMs = parseIsoUtc(value.validUntil);
  if (
    asOfMs === null
    || checkedAtMs === null
    || validUntilMs === null
    || asOfMs > checkedAtMs
    || checkedAtMs > validUntilMs
    || checkedAtMs - asOfMs
      > JOBROLO_IMPORT_READ_LIMITS.maximumFreshnessWindowMs
    || validUntilMs - checkedAtMs
      > JOBROLO_IMPORT_READ_LIMITS.maximumFreshnessWindowMs
    || currentMs
      < checkedAtMs - JOBROLO_IMPORT_READ_LIMITS.maximumClockSkewMs
    || currentMs >= validUntilMs
  ) sourceUnavailable();
  return { asOfMs, checkedAtMs, validUntilMs };
}

function requiredSafeText(value, maximumCharacters, maximumBytes) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || CONTROL_CHARACTERS.test(value)
    || Array.from(value).length > maximumCharacters
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) sourceUnavailable();
  return value;
}

function nullableCode(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !SAFE_CODE.test(value)) sourceUnavailable();
  return value;
}

function currentTime(now) {
  const current = Number(now());
  if (!Number.isFinite(current)) throw new TypeError("now is invalid");
  return current;
}

function parseIsoUtc(value) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function exactRecord(value, keys) {
  if (!isPlainRecord(value)) sourceUnavailable();
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
  ) sourceUnavailable();
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isPlainRecord(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function failure(code, statusCode) {
  const error = new Error("Jobrolo import source is unavailable.");
  error.name = "JobroloImportReadError";
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function invalidRequest() {
  failure("invalid_jobrolo_import_request", 400);
}

function sourceNotFound() {
  failure("jobrolo_import_source_not_found", 404);
}

function sourceChanged() {
  failure("jobrolo_import_source_changed", 409);
}

function sourceUnavailable() {
  failure("jobrolo_import_source_unavailable", 503);
}

function boundsExceeded() {
  failure("jobrolo_import_bounds_exceeded", 503);
}
