/**
 * Pure JobNimbus fresh-read -> Jobrolo import snapshot adapter.
 *
 * This boundary accepts only the already-normalized, exact-file output of
 * mapJobNimbusFileEnvelope. Raw provider identifiers are used transiently to
 * obtain tenant-scoped opaque references, but never appear in the returned
 * snapshot. This module does not read configuration, credentials, databases,
 * files, or the network and does not execute an import.
 */

import { HCN_PROVIDER_MAPPER_LIMITS } from "../hcn-console/provider-mappers.js";

export const JOBROLO_JOBNIMBUS_IMPORT_SNAPSHOT_SCHEMA =
  "jobrolo.jobnimbus-import.snapshot.v1";
export const JOBROLO_JOBNIMBUS_DOCUMENT_MANIFEST_SCHEMA =
  "jobrolo.jobnimbus-import.document-manifest.v1";
export const JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_SCHEMA =
  "jobrolo.jobnimbus-import.normalized-email.v1";

export const JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS = Object.freeze({
  maximumCollectionItems: HCN_PROVIDER_MAPPER_LIMITS.maximumCollectionItems,
  maximumCanonicalSnapshotUtf8Bytes: 512 * 1024,
  maximumFreshnessWindowMs: 15 * 60_000,
  maximumClockSkewMs: 60_000,
  maximumCanonicalDepth: 24,
  maximumCanonicalNodes: 20_000
});

const CONNECTION_REF = /^connection_[a-f0-9]{32}$/;
const SOURCE_FILE_REF = /^subject_[a-f0-9]{32}$/;
const SOURCE_RECORD_REF = /^ref_[a-f0-9]{32}$/;
const PROVIDER_ID = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const SAFE_JOB_NUMBER = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
export const JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_PATTERN = /^(?=.{3,254}$)(?=.{1,64}@)[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

const ENVELOPE_FIELDS = Object.freeze([
  "status",
  "asOf",
  "checkedAt",
  "validUntil",
  "data"
]);
const DATA_FIELDS = Object.freeze([
  "file",
  "activities",
  "tasks",
  "documents",
  "collectionCoverage"
]);
const FILE_BASE_FIELDS = Object.freeze([
  "providerFileId",
  "jobNumber",
  "displayName",
  "statusCode",
  "stageCode",
  "fileTypeCode",
  "isInsuranceFile",
  "isActive",
  "updatedAt",
  "missingFacts",
  "nextAppointmentAt",
  "primaryEmail",
  "primaryPhone",
  "propertyAddress",
  "carrierName",
  "claimNumber",
  "policyNumber",
  "dateOfLoss",
  "damageFactsPresent",
  "adjusterName",
  "adjusterPhone",
  "adjusterEmail"
]);
const COVERAGE_FIELDS = Object.freeze([
  "completeness",
  "returnedItems",
  "duplicateItemsRemoved",
  "limitationCode"
]);
const ISSUED_REFERENCE_FIELDS = Object.freeze([
  "connectionRef",
  "sourceFileRef",
  "activities",
  "tasks",
  "documents"
]);

export class JobNimbusImportSnapshotAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JobNimbusImportSnapshotAdapterError";
    this.code = code;
  }
}

/**
 * Issue opaque references for one normalized provider envelope.
 *
 * referenceFactory must be an existing createHcnReferenceFactory result. The
 * connection reference is provisioned separately because it identifies the
 * authorized Jobrolo source connection, not a JobNimbus record.
 */
export function issueJobNimbusImportReferences(
  providerEnvelope,
  { connectionRef, referenceFactory } = {}
) {
  const normalized = normalizeProviderEnvelope(providerEnvelope);
  requirePattern(
    connectionRef,
    CONNECTION_REF,
    "invalid_opaque_references",
    "JobNimbus source connection reference is invalid."
  );
  if (
    !isPlainRecord(referenceFactory)
    || typeof referenceFactory.subjectId !== "function"
    || typeof referenceFactory.sourceRecordRef !== "function"
  ) {
    fail(
      "invalid_reference_factory",
      "A tenant-scoped HCN reference factory is required."
    );
  }

  let sourceFileRef;
  let activities;
  let tasks;
  let documents;
  try {
    sourceFileRef = referenceFactory.subjectId(
      "jobnimbus",
      normalized.file.providerFileId
    );
    activities = normalized.activities.map((item) =>
      referenceFactory.sourceRecordRef("jobnimbus", item.providerRecordId)
    );
    tasks = normalized.tasks.map((item) =>
      referenceFactory.sourceRecordRef("jobnimbus", item.providerRecordId)
    );
    documents = normalized.documents.map((item) =>
      referenceFactory.sourceRecordRef("jobnimbus", item.providerRecordId)
    );
  } catch {
    fail(
      "reference_issue_failed",
      "Opaque JobNimbus import references could not be issued."
    );
  }

  return normalizeIssuedReferences(
    { connectionRef, sourceFileRef, activities, tasks, documents },
    normalized
  );
}

/**
 * Project one normalized provider envelope with already-issued opaque refs.
 * The result is the exact Jobrolo jobrolo.jobnimbus-import.snapshot.v1 wire
 * shape and contains metadata only (never document bytes or provider URLs).
 */
export function projectJobNimbusFileEnvelopeToImportSnapshot(
  providerEnvelope,
  issuedReferences
) {
  const normalized = normalizeProviderEnvelope(providerEnvelope);
  const references = normalizeIssuedReferences(issuedReferences, normalized);

  const snapshot = {
    schema: JOBROLO_JOBNIMBUS_IMPORT_SNAPSHOT_SCHEMA,
    source: {
      system: "jobnimbus",
      connectionRef: references.connectionRef,
      scope: "assigned",
      complete: true
    },
    sourceFileRef: references.sourceFileRef,
    asOf: normalized.asOf,
    checkedAt: normalized.checkedAt,
    validUntil: normalized.validUntil,
    file: {
      sourceFileRef: references.sourceFileRef,
      jobNumber: normalized.file.jobNumber,
      displayName: normalized.file.displayName,
      statusCode: normalized.file.statusCode,
      stageCode: normalized.file.stageCode,
      fileTypeCode: "insurance",
      isInsuranceFile: true,
      isActive: true,
      assignmentVerified: true,
      updatedAt: normalized.file.updatedAt,
      nextAppointmentAt: normalized.file.nextAppointmentAt,
      primaryEmail: normalized.file.primaryEmail,
      primaryPhone: normalized.file.primaryPhone,
      propertyAddress: normalized.file.propertyAddress,
      carrierName: normalized.file.carrierName,
      claimNumber: normalized.file.claimNumber,
      policyNumber: normalized.file.policyNumber,
      dateOfLoss: normalized.file.dateOfLoss,
      damageFactsPresent: normalized.file.damageFactsPresent,
      adjusterName: normalized.file.adjusterName,
      adjusterPhone: normalized.file.adjusterPhone,
      adjusterEmail: normalized.file.adjusterEmail,
      missingFacts: { ...normalized.file.missingFacts }
    },
    activities: projectCollection(
      normalized.activities,
      normalized.collectionCoverage.activities,
      references.activities,
      ["kind", "state", "occurredAt", "actorRole", "label"]
    ),
    tasks: projectCollection(
      normalized.tasks,
      normalized.collectionCoverage.tasks,
      references.tasks,
      ["kind", "status", "priority", "dueAt", "assignedRole", "label"]
    ),
    documents: projectCollection(
      normalized.documents,
      normalized.collectionCoverage.documents,
      references.documents,
      ["kind", "reviewState", "createdAt", "fileName"]
    )
  };

  const canonicalBytes = Buffer.byteLength(canonicalJson(snapshot), "utf8");
  if (
    canonicalBytes
    > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS
      .maximumCanonicalSnapshotUtf8Bytes
  ) {
    fail(
      "snapshot_bounds_exceeded",
      "Normalized JobNimbus import snapshot exceeds its canonical byte bound."
    );
  }
  return deepFreeze(snapshot);
}

/** Convenience composition for the normal HCN adapter path. */
export function adaptJobNimbusFileEnvelopeToImportSnapshot(
  providerEnvelope,
  options
) {
  return projectJobNimbusFileEnvelopeToImportSnapshot(
    providerEnvelope,
    issueJobNimbusImportReferences(providerEnvelope, options)
  );
}

/** Project one normalized non-photo document into its stable transfer proof. */
export function projectJobNimbusDocumentManifest(
  providerDocument,
  { sourceFileRef, referenceFactory } = {}
) {
  requirePattern(
    sourceFileRef,
    SOURCE_FILE_REF,
    "invalid_opaque_references",
    "JobNimbus source file reference is invalid."
  );
  if (
    !isPlainRecord(referenceFactory)
    || typeof referenceFactory.sourceRecordRef !== "function"
  ) {
    fail(
      "invalid_reference_factory",
      "A tenant-scoped HCN reference factory is required."
    );
  }
  const normalized = normalizeDocuments([providerDocument])[0];
  let sourceRecordRef;
  try {
    sourceRecordRef = referenceFactory.sourceRecordRef(
      "jobnimbus",
      normalized.providerRecordId
    );
  } catch {
    fail(
      "reference_issue_failed",
      "Opaque JobNimbus import references could not be issued."
    );
  }
  requirePattern(
    sourceRecordRef,
    SOURCE_RECORD_REF,
    "invalid_opaque_references",
    "JobNimbus source record reference is invalid."
  );
  return deepFreeze({
    schema: JOBROLO_JOBNIMBUS_DOCUMENT_MANIFEST_SCHEMA,
    sourceFileRef,
    document: {
      sourceRecordRef,
      kind: normalized.kind,
      reviewState: normalized.reviewState,
      createdAt: normalized.createdAt,
      fileName: normalized.fileName
    }
  });
}

function normalizeProviderEnvelope(value) {
  exactRecord(value, ENVELOPE_FIELDS, "provider envelope");
  requireLiteral(
    value.status,
    "ok",
    "invalid_provider_envelope",
    "Provider envelope status must be ok."
  );
  const asOf = requireIsoUtc(value.asOf, "provider envelope asOf");
  const checkedAt = requireIsoUtc(
    value.checkedAt,
    "provider envelope checkedAt"
  );
  const validUntil = requireIsoUtc(
    value.validUntil,
    "provider envelope validUntil"
  );
  const asOfMs = Date.parse(asOf);
  const checkedAtMs = Date.parse(checkedAt);
  const validUntilMs = Date.parse(validUntil);
  if (
    asOfMs > checkedAtMs
    || checkedAtMs > validUntilMs
    || checkedAtMs - asOfMs
      > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS.maximumFreshnessWindowMs
    || validUntilMs - checkedAtMs
      > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS.maximumFreshnessWindowMs
  ) {
    fail(
      "invalid_freshness",
      "Provider envelope freshness is inconsistent or over-broad."
    );
  }

  exactRecord(value.data, DATA_FIELDS, "provider envelope data");
  const file = normalizeFile(value.data.file);
  if (
    Date.parse(file.updatedAt)
    > asOfMs + JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS.maximumClockSkewMs
  ) {
    fail(
      "invalid_source_version",
      "Provider file version is newer than the observed snapshot."
    );
  }
  const activities = normalizeActivities(value.data.activities);
  const tasks = normalizeTasks(value.data.tasks);
  const documents = normalizeDocuments(value.data.documents);
  const collectionCoverage = normalizeCollectionCoverage(
    value.data.collectionCoverage,
    { activities, tasks, documents }
  );

  const rawProviderIds = [
    file.providerFileId,
    ...activities.map((item) => item.providerRecordId),
    ...tasks.map((item) => item.providerRecordId),
    ...documents.map((item) => item.providerRecordId)
  ];
  if (new Set(rawProviderIds).size !== rawProviderIds.length) {
    fail(
      "duplicate_provider_record",
      "Provider identifiers must be unique across the exact file snapshot."
    );
  }

  return deepFreeze({
    asOf,
    checkedAt,
    validUntil,
    file,
    activities,
    tasks,
    documents,
    collectionCoverage
  });
}

function normalizeFile(value) {
  const currentUserFields = [...FILE_BASE_FIELDS, "assignedToCurrentUser"];
  const legacyFields = [...FILE_BASE_FIELDS, "assignedToChance"];
  const hasCurrentAssignment = hasExactFields(value, currentUserFields);
  const hasLegacyAssignment = hasExactFields(value, legacyFields);
  if (!hasCurrentAssignment && !hasLegacyAssignment) {
    fail(
      "invalid_provider_envelope",
      "Normalized provider file contains unsupported fields."
    );
  }
  const assignmentField = hasCurrentAssignment
    ? "assignedToCurrentUser"
    : "assignedToChance";
  requireLiteral(
    value[assignmentField],
    true,
    "assignment_not_verified",
    "Provider assignment must be verified."
  );

  const providerFileId = requireProviderId(value.providerFileId);
  const jobNumber = requirePattern(
    value.jobNumber,
    SAFE_JOB_NUMBER,
    "invalid_provider_envelope",
    "Normalized JobNimbus job number is invalid."
  );
  const displayName = requireSafeText(value.displayName, 120, 480);
  const statusCode = requireNullableCode(value.statusCode);
  const stageCode = requireNullableCode(value.stageCode);
  requireLiteral(
    value.fileTypeCode,
    "insurance",
    "ineligible_provider_file",
    "Only normalized insurance files may be imported."
  );
  requireLiteral(
    value.isInsuranceFile,
    true,
    "ineligible_provider_file",
    "Only normalized insurance files may be imported."
  );
  requireLiteral(
    value.isActive,
    true,
    "ineligible_provider_file",
    "Only active normalized files may be imported."
  );

  const updatedAt = requireIsoUtc(value.updatedAt, "provider file updatedAt");
  const nextAppointmentAt = requireNullableIsoUtc(
    value.nextAppointmentAt,
    "provider file nextAppointmentAt"
  );
  const primaryEmail = requireNullableNormalizedEmail(value.primaryEmail);
  const primaryPhone = requireNullableSafeText(value.primaryPhone, 40, 160);
  const propertyAddress = requireNullableSafeText(
    value.propertyAddress,
    180,
    720
  );
  const carrierName = requireNullableSafeText(value.carrierName, 120, 480);
  const claimNumber = requireNullableSafeText(value.claimNumber, 80, 320);
  const policyNumber = requireNullableSafeText(value.policyNumber, 80, 320);
  const dateOfLoss = requireNullableDateOnly(value.dateOfLoss);
  const damageFactsPresent = requireBoolean(
    value.damageFactsPresent,
    "provider file damageFactsPresent"
  );
  const adjusterName = requireNullableSafeText(value.adjusterName, 120, 480);
  const adjusterPhone = requireNullableSafeText(value.adjusterPhone, 40, 160);
  const adjusterEmail = requireNullableNormalizedEmail(value.adjusterEmail);
  const missingFacts = normalizeMissingFacts(value.missingFacts);
  const expectedMissingFacts = {
    claimNumber: claimNumber === null,
    policyNumber: policyNumber === null,
    dateOfLoss: dateOfLoss === null,
    adjuster: adjusterPhone === null && adjusterEmail === null
  };
  for (const key of Object.keys(expectedMissingFacts)) {
    if (missingFacts[key] !== expectedMissingFacts[key]) {
      fail(
        "inconsistent_provider_facts",
        "Provider missing-fact evidence is inconsistent."
      );
    }
  }

  return {
    providerFileId,
    jobNumber,
    displayName,
    statusCode,
    stageCode,
    updatedAt,
    nextAppointmentAt,
    primaryEmail,
    primaryPhone,
    propertyAddress,
    carrierName,
    claimNumber,
    policyNumber,
    dateOfLoss,
    damageFactsPresent,
    adjusterName,
    adjusterPhone,
    adjusterEmail,
    missingFacts
  };
}

function normalizeMissingFacts(value) {
  exactRecord(
    value,
    ["claimNumber", "policyNumber", "dateOfLoss", "adjuster"],
    "provider missing facts"
  );
  return {
    claimNumber: requireBoolean(value.claimNumber, "missing claim number"),
    policyNumber: requireBoolean(value.policyNumber, "missing policy number"),
    dateOfLoss: requireBoolean(value.dateOfLoss, "missing date of loss"),
    adjuster: requireBoolean(value.adjuster, "missing adjuster")
  };
}

function normalizeActivities(value) {
  return normalizeProviderCollection(
    value,
    [
      "providerRecordId",
      "kind",
      "state",
      "occurredAt",
      "actorRole",
      "label"
    ],
    (item) => ({
      providerRecordId: requireProviderId(item.providerRecordId),
      kind: requireCode(item.kind, "activity kind"),
      state: requireCode(item.state, "activity state"),
      occurredAt: requireIsoUtc(item.occurredAt, "activity occurredAt"),
      actorRole: requireCode(item.actorRole, "activity actorRole"),
      label: requireNullableSafeText(item.label, 160, 640)
    }),
    "activities"
  );
}

function normalizeTasks(value) {
  return normalizeProviderCollection(
    value,
    [
      "providerRecordId",
      "kind",
      "status",
      "priority",
      "dueAt",
      "assignedRole",
      "label"
    ],
    (item) => ({
      providerRecordId: requireProviderId(item.providerRecordId),
      kind: requireCode(item.kind, "task kind"),
      status: requireCode(item.status, "task status"),
      priority: requireEnum(
        item.priority,
        ["low", "normal", "high", "urgent"],
        "task priority"
      ),
      dueAt: requireNullableIsoUtc(item.dueAt, "task dueAt"),
      assignedRole: requireCode(item.assignedRole, "task assignedRole"),
      label: requireNullableSafeText(item.label, 160, 640)
    }),
    "tasks"
  );
}

function normalizeDocuments(value) {
  return normalizeProviderCollection(
    value,
    [
      "providerRecordId",
      "kind",
      "reviewState",
      "createdAt",
      "fileName"
    ],
    (item) => ({
      providerRecordId: requireProviderId(item.providerRecordId),
      kind: requireCode(item.kind, "document kind"),
      reviewState: requireCode(item.reviewState, "document reviewState"),
      createdAt: requireIsoUtc(item.createdAt, "document createdAt"),
      fileName: requireNullableSafeText(item.fileName, 160, 640)
    }),
    "documents"
  );
}

function normalizeProviderCollection(value, fields, normalize, label) {
  if (!Array.isArray(value)) {
    fail("invalid_provider_envelope", `Provider ${label} must be an array.`);
  }
  if (
    value.length
    > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS.maximumCollectionItems
  ) {
    fail("provider_bounds_exceeded", `Provider ${label} exceed their bound.`);
  }
  return value.map((item) => {
    exactRecord(item, fields, `provider ${label} item`);
    return normalize(item);
  });
}

function normalizeCollectionCoverage(value, collections) {
  exactRecord(
    value,
    ["activities", "tasks", "documents"],
    "provider collection coverage"
  );
  return {
    activities: normalizeCoverage(
      value.activities,
      collections.activities.length,
      "activities"
    ),
    tasks: normalizeCoverage(value.tasks, collections.tasks.length, "tasks"),
    documents: normalizeCoverage(
      value.documents,
      collections.documents.length,
      "documents"
    )
  };
}

function normalizeCoverage(value, itemCount, label) {
  exactRecord(value, COVERAGE_FIELDS, `${label} coverage`);
  if (value.completeness !== "complete" || value.limitationCode !== null) {
    fail(
      "incomplete_provider_snapshot",
      `Provider ${label} pagination is not verified complete.`
    );
  }
  const returnedItems = requireBoundedCount(value.returnedItems, label);
  const duplicateItemsRemoved = requireBoundedCount(
    value.duplicateItemsRemoved,
    label
  );
  if (
    returnedItems !== itemCount
    || returnedItems + duplicateItemsRemoved
      > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS.maximumCollectionItems
  ) {
    fail(
      "inconsistent_collection_coverage",
      `Provider ${label} coverage is inconsistent.`
    );
  }
  return {
    completeness: "complete",
    returnedItems,
    duplicateItemsRemoved,
    limitationCode: null
  };
}

function normalizeIssuedReferences(value, normalized) {
  exactRecord(value, ISSUED_REFERENCE_FIELDS, "issued import references");
  const connectionRef = requirePattern(
    value.connectionRef,
    CONNECTION_REF,
    "invalid_opaque_references",
    "JobNimbus source connection reference is invalid."
  );
  const sourceFileRef = requirePattern(
    value.sourceFileRef,
    SOURCE_FILE_REF,
    "invalid_opaque_references",
    "JobNimbus source file reference is invalid."
  );
  const activities = normalizeReferenceCollection(
    value.activities,
    normalized.activities.length,
    "activities"
  );
  const tasks = normalizeReferenceCollection(
    value.tasks,
    normalized.tasks.length,
    "tasks"
  );
  const documents = normalizeReferenceCollection(
    value.documents,
    normalized.documents.length,
    "documents"
  );
  const allRecordRefs = [...activities, ...tasks, ...documents];
  if (new Set(allRecordRefs).size !== allRecordRefs.length) {
    fail(
      "duplicate_opaque_reference",
      "Opaque source record references must be globally unique."
    );
  }
  return deepFreeze({
    connectionRef,
    sourceFileRef,
    activities,
    tasks,
    documents
  });
}

function normalizeReferenceCollection(value, expectedItems, label) {
  if (!Array.isArray(value) || value.length !== expectedItems) {
    fail(
      "invalid_opaque_references",
      `Opaque ${label} references do not match the exact provider snapshot.`
    );
  }
  return value.map((item) => requirePattern(
    item,
    SOURCE_RECORD_REF,
    "invalid_opaque_references",
    `Opaque ${label} reference is invalid.`
  ));
}

function projectCollection(items, coverage, references, fields) {
  const projectedItems = items.map((item, index) => {
    const projected = { sourceRecordRef: references[index] };
    for (const field of fields) projected[field] = item[field];
    return projected;
  });
  projectedItems.sort((left, right) =>
    left.sourceRecordRef < right.sourceRecordRef
      ? -1
      : left.sourceRecordRef > right.sourceRecordRef ? 1 : 0
  );
  return {
    completeness: "complete",
    returnedItems: coverage.returnedItems,
    duplicateItemsRemoved: coverage.duplicateItemsRemoved,
    limitationCode: null,
    items: projectedItems
  };
}

function requireProviderId(value) {
  return requirePattern(
    value,
    PROVIDER_ID,
    "invalid_provider_envelope",
    "Provider record identifier is invalid."
  );
}

function requireIsoUtc(value, label) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    fail("invalid_provider_envelope", `${label} is invalid.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("invalid_provider_envelope", `${label} is invalid.`);
  }
  return value;
}

function requireNullableIsoUtc(value, label) {
  return value === null ? null : requireIsoUtc(value, label);
}

function requireNullableDateOnly(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !DATE_ONLY.test(value)) {
    fail("invalid_provider_envelope", "Provider date of loss is invalid.");
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    fail("invalid_provider_envelope", "Provider date of loss is invalid.");
  }
  return value;
}

function requireCode(value, label) {
  return requirePattern(
    value,
    SAFE_CODE,
    "invalid_provider_envelope",
    `Provider ${label} is invalid.`
  );
}

function requireNullableCode(value) {
  return value === null ? null : requireCode(value, "code");
}

function requireSafeText(value, maximumCharacters, maximumBytes) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumCharacters
    || value !== value.trim()
    || CONTROL_CHARACTERS.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    fail("invalid_provider_envelope", "Provider text is invalid.");
  }
  return value;
}

function requireNullableSafeText(value, maximumCharacters, maximumBytes) {
  return value === null
    ? null
    : requireSafeText(value, maximumCharacters, maximumBytes);
}

function requireNullableNormalizedEmail(value) {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length > 254
    || value !== value.toLowerCase()
    || !JOBROLO_JOBNIMBUS_NORMALIZED_EMAIL_PATTERN.test(value)
  ) {
    fail("invalid_provider_envelope", "Provider email is invalid.");
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail("invalid_provider_envelope", `${label} must be a boolean.`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail("invalid_provider_envelope", `Provider ${label} is invalid.`);
  }
  return value;
}

function requireLiteral(value, expected, code, message) {
  if (value !== expected) fail(code, message);
  return value;
}

function requirePattern(value, pattern, code, message) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code, message);
  return value;
}

function requireBoundedCount(value, label) {
  if (
    !Number.isInteger(value)
    || value < 0
    || value
      > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS.maximumCollectionItems
  ) {
    fail(
      "invalid_provider_envelope",
      `Provider ${label} coverage count is invalid.`
    );
  }
  return value;
}

function hasExactFields(value, fields) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === fields.length
    && actual.every((field) => fields.includes(field))
  );
}

function exactRecord(value, fields, label) {
  if (!hasExactFields(value, fields)) {
    fail(
      "invalid_provider_envelope",
      `${label} contains unsupported fields.`
    );
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value) {
  return canonicalValue(value, 0, { nodes: 0 });
}

function canonicalValue(value, depth, state) {
  state.nodes += 1;
  if (
    depth > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS.maximumCanonicalDepth
    || state.nodes
      > JOBROLO_JOBNIMBUS_IMPORT_ADAPTER_LIMITS.maximumCanonicalNodes
  ) {
    fail(
      "snapshot_bounds_exceeded",
      "Normalized JobNimbus import snapshot exceeds its complexity bound."
    );
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid_provider_envelope", "Snapshot contains an invalid number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((child) =>
      canonicalValue(child, depth + 1, state)
    ).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    fail("invalid_provider_envelope", "Snapshot must contain plain JSON data.");
  }
  const keys = Object.keys(value).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(value[key], depth + 1, state)}`
  ).join(",")}}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fail(code, message) {
  throw new JobNimbusImportSnapshotAdapterError(code, message);
}
