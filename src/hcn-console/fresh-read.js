/**
 * Ephemeral, read-only HCN console projections.
 *
 * Provider access and opaque-reference generation are injected. This module
 * does not read configuration, persist data, or expose provider identifiers.
 */

export const HCN_WORK_CENTER_SCHEMA = "hcn.console.work-center.v1";
export const HCN_FILE_SCHEMA = "hcn.console.file.v1";

export const HCN_WORK_CENTER_LIMITS = Object.freeze({
  minimumPageSize: 1,
  maximumPageSize: 50,
  maximumOffset: 5000,
  minimumRecentItems: 1,
  maximumRecentItems: 20,
  maximumIndexRecords: 5000
});

const WORK_CENTER_REQUEST_FIELDS = Object.freeze(["offset", "limit"]);
const FILE_REQUEST_FIELDS = Object.freeze(["fileRef", "recentLimit"]);
const TENANT_ID = /^tenant_[a-f0-9]{16}$/;
const FILE_REF = /^subject_[a-f0-9]{32}$/;
const EVIDENCE_REF = /^ref_[a-f0-9]{32}$/;
const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_PROVIDER_ID = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const SAFE_JOB_NUMBER = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_PROVIDER_ITEMS = 500;
const OPTIONAL_SOURCE_FAILURE_CODES = Object.freeze([
  "file_phone_missing",
  "google_not_linked",
  "phone_match_unverified",
  "provider_check_failed",
  "scope_check_failed",
  "work_line_not_linked"
]);
const WORK_CENTER_STATUS_WEIGHTS = Object.freeze({
  ready_for_pa_review: 200,
  photo_file_estimate_needed: 180,
  need_paperwork_info: 170,
  submitted_awaiting_confirmation: 150,
  hot_final_negotiation: 130,
  negotiating: 110,
});
const REVIEW_TODAY_STATUS_CODES = Object.freeze([
  "need_paperwork_info",
  "photo_file_estimate_needed",
  "ready_for_pa_review",
  "submitted_awaiting_confirmation"
]);

const AUTHORITY = Object.freeze({
  mode: "read_only",
  canWrite: false,
  canSend: false,
  canCall: false,
  canApprove: false
});

/**
 * Create the fresh-read boundary for the HCN browser console.
 *
 * Loader contracts:
 * - loadJobNimbusIndex({ scope, maxRecords, requestedAt })
 * - loadJobNimbusFile({ providerFileId, recentLimit, requestedAt })
 * - loadGmailFile({ providerFileId, recentLimit, requestedAt })
 * - loadQuoFile({ providerFileId, recentLimit, requestedAt })
 *
 * Every loader returns a fresh envelope:
 * { status: "ok", asOf, checkedAt, validUntil, data }.
 */
export function createHcnConsoleFreshReadService({
  referenceFactory,
  loadJobNimbusIndex,
  loadJobNimbusFile,
  loadGmailFile,
  loadQuoFile,
  now = () => new Date()
} = {}) {
  const references = validateReferenceFactory(referenceFactory);
  assertFunction(loadJobNimbusIndex, "loadJobNimbusIndex");
  assertFunction(loadJobNimbusFile, "loadJobNimbusFile");
  assertFunction(loadGmailFile, "loadGmailFile");
  assertFunction(loadQuoFile, "loadQuoFile");
  assertFunction(now, "now");

  async function readFreshIndex(generatedAt) {
    let envelope;
    try {
      envelope = await loadJobNimbusIndex(
        immutableCopy({
          scope: "active_authenticated_employee_assigned_insurance",
          maxRecords: HCN_WORK_CENTER_LIMITS.maximumIndexRecords,
          requestedAt: generatedAt
        })
      );
    } catch {
      throw requiredSourceUnavailable();
    }

    const fresh = requireFreshEnvelope(envelope, generatedAt);
    if (
      !isPlainObject(fresh.data)
      || fresh.data.complete !== true
      || !Array.isArray(fresh.data.files)
      || fresh.data.files.length > HCN_WORK_CENTER_LIMITS.maximumIndexRecords
    ) {
      throw requiredSourceUnavailable();
    }

    const files = [];
    const seenProviderIds = new Set();
    const seenFileRefs = new Set();
    for (const candidate of fresh.data.files) {
      if (!isEligible(candidate)) continue;
      const normalized = normalizeEligibleFile(candidate);
      if (!normalized) throw requiredSourceUnavailable();
      if (seenProviderIds.has(normalized.providerFileId)) {
        throw requiredSourceUnavailable();
      }
      seenProviderIds.add(normalized.providerFileId);

      const fileRef = createFileRef(references, normalized.providerFileId);
      if (seenFileRefs.has(fileRef)) throw requiredSourceUnavailable();
      seenFileRefs.add(fileRef);
      files.push({ ...normalized, fileRef });
    }

    files.sort((left, right) => compareIndexFiles(left, right, generatedAt));
    return {
      envelope: fresh,
      files
    };
  }

  async function readResolvedFile({
    resolved,
    recentLimit,
    generatedAt
  }) {
    let jobNimbusEnvelope;
    try {
      jobNimbusEnvelope = await loadJobNimbusFile(
        immutableCopy({
          providerFileId: resolved.providerFileId,
          recentLimit,
          requestedAt: generatedAt
        })
      );
    } catch {
      throw requiredSourceUnavailable();
    }

    const jobNimbus = normalizeJobNimbusDetail({
      envelope: jobNimbusEnvelope,
      generatedAt,
      resolved,
      references,
      recentLimit
    });

    const optionalRequest = immutableCopy({
      providerFileId: resolved.providerFileId,
      recentLimit,
      requestedAt: generatedAt
    });
    const [gmail, quo] = await Promise.all([
      readOptionalSource({
        source: "gmail",
        loader: loadGmailFile,
        request: optionalRequest,
        generatedAt,
        resolved,
        references,
        recentLimit,
        normalizeItem: normalizeGmailItem
      }),
      readOptionalSource({
        source: "quo",
        loader: loadQuoFile,
        request: optionalRequest,
        generatedAt,
        resolved,
        references,
        recentLimit,
        normalizeItem: normalizeQuoItem
      })
    ]);

    const sources = {
      jobnimbus: jobNimbus.source,
      gmail: gmail.source,
      quo: quo.source
    };
    const evidenceStatus = Object.values(sources).every(
      (source) =>
        source.status === "fresh" && source.completeness === "complete"
    )
      ? "complete"
      : "partial";
    const recent = {
      activities: jobNimbus.activities,
      tasks: jobNimbus.tasks,
      documents: jobNimbus.documents,
      gmail: gmail.items,
      quo: quo.items
    };

    return immutableCopy({
      schema: HCN_FILE_SCHEMA,
      generatedAt,
      ephemeral: true,
      cachePolicy: "no_store",
      authority: AUTHORITY,
      evidenceStatus,
      file: jobNimbus.file,
      sources,
      lanes: buildOperationalLanes({
        file: jobNimbus.file,
        sources,
        recent,
        generatedAt
      }),
      recent
    });
  }

  return Object.freeze({
    async readWorkCenter(request) {
      const normalizedRequest = validateWorkCenterRequest(request);
      const generatedAt = readNow(now);
      const index = await readFreshIndex(generatedAt);
      const { offset, limit } = normalizedRequest;
      const selected = index.files.slice(offset, offset + limit);

      return immutableCopy({
        schema: HCN_WORK_CENTER_SCHEMA,
        generatedAt,
        ephemeral: true,
        cachePolicy: "no_store",
        authority: AUTHORITY,
        source: summarizeFreshSource(
          "jobnimbus",
          index.envelope,
          index.files.length,
          0
        ),
        page: {
          offset,
          limit,
          total: index.files.length,
          hasMore: offset + selected.length < index.files.length
        },
        files: selected.map(projectIndexFile)
      });
    },

    async readFile(request) {
      const normalizedRequest = validateFileRequest(request);
      const generatedAt = readNow(now);
      const index = await readFreshIndex(generatedAt);
      const matches = index.files.filter(
        (candidate) => candidate.fileRef === normalizedRequest.fileRef
      );
      if (matches.length !== 1) throw fileNotFound();
      return readResolvedFile({
        resolved: matches[0],
        recentLimit: normalizedRequest.recentLimit,
        generatedAt
      });
    },

    async readFileByJobNumber(request) {
      const normalizedRequest =
        validateInternalJobNumberRequest(request);
      const generatedAt = readNow(now);
      const index = await readFreshIndex(generatedAt);
      const matches = index.files.filter(
        (candidate) =>
          candidate.jobNumber === normalizedRequest.jobNumber
      );
      if (matches.length !== 1) throw fileNotFound();
      return readResolvedFile({
        resolved: matches[0],
        recentLimit: normalizedRequest.recentLimit,
        generatedAt
      });
    }
  });
}

export class HcnConsoleFreshReadError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = "HcnConsoleFreshReadError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function validateReferenceFactory(value) {
  if (
    !isPlainObject(value)
    || typeof value.tenantId !== "string"
    || !TENANT_ID.test(value.tenantId)
    || typeof value.subjectId !== "function"
    || typeof value.sourceRecordRef !== "function"
  ) {
    throw new HcnConsoleFreshReadError(
      "invalid_configuration",
      503,
      "HCN reference configuration is unavailable."
    );
  }
  return value;
}

function validateWorkCenterRequest(value) {
  assertExactRequest(value, WORK_CENTER_REQUEST_FIELDS);
  assertIntegerRange(
    value.offset,
    0,
    HCN_WORK_CENTER_LIMITS.maximumOffset,
    "offset"
  );
  assertIntegerRange(
    value.limit,
    HCN_WORK_CENTER_LIMITS.minimumPageSize,
    HCN_WORK_CENTER_LIMITS.maximumPageSize,
    "limit"
  );
  return {
    offset: value.offset,
    limit: value.limit
  };
}

function validateFileRequest(value) {
  assertExactRequest(value, FILE_REQUEST_FIELDS);
  if (typeof value.fileRef !== "string" || !FILE_REF.test(value.fileRef)) {
    invalidRequest("fileRef must be an opaque HCN file reference");
  }
  assertIntegerRange(
    value.recentLimit,
    HCN_WORK_CENTER_LIMITS.minimumRecentItems,
    HCN_WORK_CENTER_LIMITS.maximumRecentItems,
    "recentLimit"
  );
  return {
    fileRef: value.fileRef,
    recentLimit: value.recentLimit
  };
}

function validateInternalJobNumberRequest(value) {
  assertExactRequest(value, ["jobNumber", "recentLimit"]);
  if (
    typeof value.jobNumber !== "string"
    || !/^\d{2,12}$/.test(value.jobNumber)
  ) {
    invalidRequest("jobNumber must be an exact numeric JobNimbus number");
  }
  assertIntegerRange(
    value.recentLimit,
    HCN_WORK_CENTER_LIMITS.minimumRecentItems,
    HCN_WORK_CENTER_LIMITS.maximumRecentItems,
    "recentLimit"
  );
  return {
    jobNumber: value.jobNumber,
    recentLimit: value.recentLimit
  };
}

function assertExactRequest(value, fields) {
  if (!isPlainObject(value)) invalidRequest("request must be a plain object");
  const actual = Object.keys(value);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      invalidRequest(`${field} is required`);
    }
  }
  for (const field of actual) {
    if (!fields.includes(field)) invalidRequest(`${field} is not allowed`);
  }
}

function assertIntegerRange(value, minimum, maximum, field) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalidRequest(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    throw new HcnConsoleFreshReadError(
      "clock_unavailable",
      503,
      "Fresh evidence timing is unavailable."
    );
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HcnConsoleFreshReadError(
      "clock_unavailable",
      503,
      "Fresh evidence timing is unavailable."
    );
  }
  return parsed.toISOString();
}

function requireFreshEnvelope(value, generatedAt) {
  if (!isPlainObject(value) || value.status !== "ok") {
    throw requiredSourceUnavailable();
  }
  const asOf = normalizeTimestamp(value.asOf);
  const checkedAt = normalizeTimestamp(value.checkedAt);
  const validUntil = normalizeTimestamp(value.validUntil);
  if (
    !asOf
    || !checkedAt
    || !validUntil
    || Date.parse(asOf) > Date.parse(checkedAt)
    || Date.parse(checkedAt) > Date.parse(generatedAt)
    || Date.parse(validUntil) < Date.parse(checkedAt)
    || Date.parse(validUntil) < Date.parse(generatedAt)
  ) {
    throw requiredSourceUnavailable();
  }
  return {
    asOf,
    checkedAt,
    validUntil,
    data: value.data
  };
}

function isEligible(value) {
  return (
    isPlainObject(value)
    && value.isInsuranceFile === true
    && value.isActive === true
    && (
      value.assignedToCurrentUser === true
      || value.assignedToChance === true
    )
  );
}

function normalizeEligibleFile(value) {
  const providerFileId = normalizeProviderId(value.providerFileId);
  const jobNumber =
    typeof value.jobNumber === "string" && SAFE_JOB_NUMBER.test(value.jobNumber)
      ? value.jobNumber
      : null;
  const updatedAt = normalizeTimestamp(value.updatedAt);
  if (!providerFileId || !jobNumber || !updatedAt) return null;

  return {
    providerFileId,
    jobNumber,
    displayName: boundedText(value.displayName, 80),
    statusCode: boundedCode(value.statusCode),
    stageCode: boundedCode(value.stageCode),
    fileTypeCode: boundedCode(value.fileTypeCode),
    updatedAt,
    missingFacts: normalizeMissingFacts(value.missingFacts)
  };
}

function normalizeMissingFacts(value) {
  const source = isPlainObject(value) ? value : {};
  return {
    claimNumber: source.claimNumber === true,
    policyNumber: source.policyNumber === true,
    dateOfLoss: source.dateOfLoss === true,
    adjuster: source.adjuster === true
  };
}

function missingFactCodes(value) {
  const codes = [];
  if (value.claimNumber) codes.push("missing_claim_number");
  if (value.policyNumber) codes.push("missing_policy_number");
  if (value.dateOfLoss) codes.push("missing_date_of_loss");
  if (value.adjuster) codes.push("missing_adjuster");
  return codes;
}

function createFileRef(references, providerFileId) {
  let value;
  try {
    value = references.subjectId("jobnimbus", providerFileId);
  } catch {
    throw requiredSourceUnavailable();
  }
  if (
    typeof value !== "string"
    || !FILE_REF.test(value)
    || value === providerFileId
  ) {
    throw requiredSourceUnavailable();
  }
  return value;
}

function createEvidenceRef(references, source, providerRecordId) {
  let value;
  try {
    value = references.sourceRecordRef(source, providerRecordId);
  } catch {
    return null;
  }
  if (
    typeof value !== "string"
    || !EVIDENCE_REF.test(value)
    || value === providerRecordId
  ) {
    return null;
  }
  return value;
}

function compareIndexFiles(left, right, generatedAt) {
  const byAttention = workCenterAttentionScore(right, generatedAt)
    - workCenterAttentionScore(left, generatedAt);
  if (byAttention !== 0) return byAttention;
  const byUpdatedAt = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  if (byUpdatedAt !== 0) return byUpdatedAt;
  return left.jobNumber.localeCompare(right.jobNumber);
}

function workCenterAttentionScore(file, generatedAt) {
  const statusWeight = WORK_CENTER_STATUS_WEIGHTS[file.statusCode] || 0;
  const ageDays = Math.max(
    0,
    Math.min(
      120,
      Math.floor((Date.parse(generatedAt) - Date.parse(file.updatedAt)) / 86_400_000),
    ),
  );
  const missing = file.missingFacts;
  let score = statusWeight + ageDays;
  if (missing.claimNumber && file.statusCode === "ready_for_pa_review") score += 45;
  if (missing.policyNumber) score += 20;
  if (missing.dateOfLoss) score += 20;
  if (
    missing.adjuster
    && file.statusCode === "submitted_awaiting_confirmation"
  ) score += 40;
  return score;
}

function projectIndexFile(value) {
  const attentionCodes = missingFactCodes(value.missingFacts);
  return {
    fileRef: value.fileRef,
    jobNumber: value.jobNumber,
    displayName: value.displayName,
    statusCode: value.statusCode,
    stageCode: value.stageCode,
    fileTypeCode: value.fileTypeCode,
    updatedAt: value.updatedAt,
    lane: attentionCodes.length ? "priority" : "active",
    attentionCodes,
    missing: value.missingFacts
  };
}

function normalizeJobNimbusDetail({
  envelope,
  generatedAt,
  resolved,
  references,
  recentLimit
}) {
  const fresh = requireFreshEnvelope(envelope, generatedAt);
  if (!isPlainObject(fresh.data) || !isPlainObject(fresh.data.file)) {
    throw requiredSourceUnavailable();
  }
  const normalized = isEligible(fresh.data.file)
    ? normalizeEligibleFile(fresh.data.file)
    : null;
  if (
    !normalized
    || normalized.providerFileId !== resolved.providerFileId
    || normalized.jobNumber !== resolved.jobNumber
    || createFileRef(references, normalized.providerFileId) !== resolved.fileRef
  ) {
    throw requiredSourceUnavailable();
  }

  const activities = normalizeItems({
    source: "jobnimbus",
    value: fresh.data.activities,
    references,
    recentLimit,
    normalizeItem: normalizeActivity,
    timestampField: "occurredAt"
  });
  const tasks = normalizeItems({
    source: "jobnimbus",
    value: fresh.data.tasks,
    references,
    recentLimit,
    normalizeItem: normalizeTask,
    timestampField: "dueAt"
  });
  const documents = normalizeItems({
    source: "jobnimbus",
    value: fresh.data.documents,
    references,
    recentLimit,
    normalizeItem: normalizeDocument,
    timestampField: "createdAt"
  });
  const droppedItems =
    activities.droppedItems + tasks.droppedItems + documents.droppedItems;
  const acceptedItems =
    activities.items.length + tasks.items.length + documents.items.length;

  return {
    source: summarizeFreshSource(
      "jobnimbus",
      fresh,
      acceptedItems,
      droppedItems
    ),
    file: {
      fileRef: resolved.fileRef,
      jobNumber: normalized.jobNumber,
      displayName: boundedText(fresh.data.file.displayName, 120),
      statusCode: normalized.statusCode,
      stageCode: normalized.stageCode,
      fileTypeCode: normalized.fileTypeCode,
      updatedAt: normalized.updatedAt,
      nextAppointmentAt: normalizeNullableTimestamp(
        fresh.data.file.nextAppointmentAt
      ),
      client: {
        primaryEmail: boundedEmail(fresh.data.file.primaryEmail),
        primaryPhone: boundedPhone(fresh.data.file.primaryPhone)
      },
      property: {
        address: boundedText(fresh.data.file.propertyAddress, 180)
      },
      insurance: {
        carrierName: boundedText(fresh.data.file.carrierName, 120),
        claimNumber: boundedText(fresh.data.file.claimNumber, 80),
        policyNumber: boundedText(fresh.data.file.policyNumber, 80),
        dateOfLoss: boundedDate(fresh.data.file.dateOfLoss),
        damageFactsPresent:
          fresh.data.file.damageFactsPresent === true
      },
      adjuster: {
        name: boundedText(fresh.data.file.adjusterName, 120),
        email: boundedEmail(fresh.data.file.adjusterEmail),
        phone: boundedPhone(fresh.data.file.adjusterPhone)
      },
      missing: normalized.missingFacts
    },
    activities: activities.items,
    tasks: tasks.items,
    documents: documents.items
  };
}

function buildOperationalLanes({
  file,
  sources,
  recent,
  generatedAt
}) {
  const priority = [];
  const today = [];
  const waiting = [];

  for (const reasonCode of missingFactCodes(file.missing)) {
    priority.push({
      reasonCode,
      source: "jobnimbus",
      reference: file.fileRef,
      at: file.updatedAt
    });
  }

  for (const source of Object.values(sources)) {
    if (source.completeness === "complete") continue;
    priority.push({
      reasonCode:
        source.failureCode === "source_partial"
          ? "source_partial"
          : "source_unavailable",
      source: source.source,
      reference: null,
      at: source.checkedAt
    });
  }

  const currentCentralDate = centralDateKey(generatedAt);
  for (const task of recent.tasks) {
    if (!["open", "in_progress", "blocked"].includes(task.status)) {
      continue;
    }
    if (!task.dueAt) continue;
    const dueCentralDate = centralDateKey(task.dueAt);
    if (dueCentralDate < currentCentralDate) {
      priority.push({
        reasonCode: "overdue_task",
        source: "jobnimbus",
        reference: task.reference,
        at: task.dueAt
      });
    } else if (dueCentralDate === currentCentralDate) {
      today.push({
        reasonCode: "task_due_today",
        source: "jobnimbus",
        reference: task.reference,
        at: task.dueAt
      });
    }
  }

  for (const document of recent.documents) {
    if (!["needs_review", "in_review", "unreviewed"].includes(
      document.reviewState
    )) {
      continue;
    }
    priority.push({
      reasonCode: "document_review_required",
      source: "jobnimbus",
      reference: document.reference,
      at: document.createdAt
    });
  }

  for (const source of ["gmail", "quo"]) {
    for (const item of recent[source]) {
      if (item.actionState === "needs_reply") {
        priority.push({
          reasonCode: "reply_required",
          source,
          reference: item.reference,
          at: item.occurredAt
        });
      }
      if (item.actionState === "awaiting_response") {
        waiting.push({
          reasonCode: "awaiting_response",
          source,
          reference: item.reference,
          at: item.occurredAt
        });
      }
    }
  }

  // "Today" means a fresh, actionable review condition. Neglect and activity
  // gaps are separate reports and are never inferred from this lane.
  const hasActionableJobNimbusReview = priority.some((item) =>
    item.source === "jobnimbus"
    && !["source_partial", "source_stale", "source_unavailable"].includes(
      item.reasonCode
    )
  );
  if (
    today.length === 0
    && REVIEW_TODAY_STATUS_CODES.includes(file.statusCode)
    && hasActionableJobNimbusReview
  ) {
    today.push({
      reasonCode: "file_review_today",
      source: "jobnimbus",
      reference: file.fileRef,
      at: generatedAt
    });
  }

  const compare = (left, right) =>
    String(right.at || "").localeCompare(String(left.at || ""))
      || left.reasonCode.localeCompare(right.reasonCode)
      || String(left.reference || "").localeCompare(
        String(right.reference || "")
      );
  priority.sort(compare);
  today.sort(compare);
  waiting.sort(compare);
  return {
    priority: priority.slice(0, 20),
    today: today.slice(0, 20),
    waiting: waiting.slice(0, 20)
  };
}

function centralDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const fields = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function readOptionalSource({
  source,
  loader,
  request,
  generatedAt,
  resolved,
  references,
  recentLimit,
  normalizeItem
}) {
  let envelope;
  try {
    envelope = await loader(request);
  } catch (error) {
    const safeFailureCode = OPTIONAL_SOURCE_FAILURE_CODES.includes(
      error?.hcnSourceFailureCode
    )
      ? error.hcnSourceFailureCode
      : "source_unavailable";
    return optionalUnavailable(source, generatedAt, safeFailureCode);
  }

  let fresh;
  try {
    fresh = requireFreshEnvelope(envelope, generatedAt);
  } catch {
    const failureCode =
      isPlainObject(envelope)
      && normalizeTimestamp(envelope.validUntil)
      && Date.parse(envelope.validUntil) < Date.parse(generatedAt)
        ? "source_stale"
        : "source_unavailable";
    return optionalUnavailable(source, generatedAt, failureCode);
  }

  if (
    !isPlainObject(fresh.data)
    || fresh.data.providerFileId !== resolved.providerFileId
    || typeof fresh.data.complete !== "boolean"
    || !Array.isArray(fresh.data.items)
  ) {
    return optionalUnavailable(source, generatedAt, "source_unavailable");
  }

  const normalized = normalizeItems({
    source,
    value: fresh.data.items,
    references,
    recentLimit,
    normalizeItem,
    timestampField: "occurredAt"
  });
  const sourceSummary = summarizeFreshSource(
    source,
    fresh,
    normalized.items.length,
    normalized.droppedItems
  );
  return {
    source: fresh.data.complete
      ? sourceSummary
      : {
          ...sourceSummary,
          completeness: "partial",
          failureCode: "source_partial"
        },
    items: normalized.items
  };
}

function optionalUnavailable(source, checkedAt, failureCode) {
  return {
    source: {
      source,
      status: "incomplete",
      completeness: "none",
      failureCode,
      asOf: null,
      checkedAt,
      validUntil: null,
      acceptedItems: 0,
      droppedItems: 0
    },
    items: []
  };
}

function normalizeItems({
  source,
  value,
  references,
  recentLimit,
  normalizeItem,
  timestampField
}) {
  if (!Array.isArray(value)) {
    return { items: [], droppedItems: 1, omittedItems: 0 };
  }
  let droppedItems = Math.max(0, value.length - MAX_PROVIDER_ITEMS);
  const items = [];
  for (const candidate of value.slice(0, MAX_PROVIDER_ITEMS)) {
    const providerRecordId = normalizeProviderId(candidate?.providerRecordId);
    const reference = providerRecordId
      ? createEvidenceRef(references, source, providerRecordId)
      : null;
    const item = reference
      ? normalizeItem(candidate, reference)
      : null;
    if (item) items.push(item);
    else droppedItems += 1;
  }
  items.sort((left, right) => {
    const leftValue = left[timestampField];
    const rightValue = right[timestampField];
    if (leftValue === null && rightValue === null) {
      return left.reference.localeCompare(right.reference);
    }
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    const byTime = Date.parse(rightValue) - Date.parse(leftValue);
    return byTime || left.reference.localeCompare(right.reference);
  });
  // `recentLimit` bounds only the presentation returned to the employee. A
  // valid older record omitted from that view is not rejected evidence and
  // must not make an otherwise complete provider read look partial.
  const omittedItems = Math.max(0, items.length - recentLimit);
  return {
    items: items.slice(0, recentLimit),
    droppedItems,
    omittedItems
  };
}

function normalizeActivity(value, reference) {
  if (!isPlainObject(value)) return null;
  const kind = boundedCode(value.kind);
  const state = boundedCode(value.state);
  const occurredAt = normalizeTimestamp(value.occurredAt);
  const actorRole = boundedCode(value.actorRole);
  if (!kind || !state || !occurredAt || !actorRole) return null;
  return {
    reference,
    kind,
    state,
    occurredAt,
    actorRole,
    label: boundedText(value.label, 160)
  };
}

function normalizeTask(value, reference) {
  if (!isPlainObject(value)) return null;
  const kind = boundedCode(value.kind);
  const status = boundedCode(value.status);
  const priority = boundedCode(value.priority);
  const dueAt = normalizeNullableTimestamp(value.dueAt);
  const assignedRole = boundedCode(value.assignedRole);
  if (
    !kind
    || !status
    || !priority
    || !assignedRole
    || (value.dueAt !== null && !dueAt)
  ) {
    return null;
  }
  return {
    reference,
    kind,
    status,
    priority,
    dueAt,
    assignedRole,
    label: boundedText(value.label, 160)
  };
}

function normalizeDocument(value, reference) {
  if (!isPlainObject(value)) return null;
  const kind = boundedCode(value.kind);
  const reviewState = boundedCode(value.reviewState);
  const createdAt = normalizeTimestamp(value.createdAt);
  if (!kind || !reviewState || !createdAt) return null;
  return {
    reference,
    kind,
    reviewState,
    createdAt,
    fileName: boundedText(value.fileName, 160)
  };
}

function normalizeGmailItem(value, reference) {
  if (!isPlainObject(value)) return null;
  const direction = boundedCode(value.direction);
  const occurredAt = normalizeTimestamp(value.occurredAt);
  const deliveryState = boundedCode(value.deliveryState);
  const actionState = boundedCode(value.actionState);
  if (
    !direction
    || !occurredAt
    || !deliveryState
    || !actionState
    || typeof value.hasAttachment !== "boolean"
  ) {
    return null;
  }
  return {
    reference,
    direction,
    occurredAt,
    hasAttachment: value.hasAttachment,
    deliveryState,
    actionState,
    subject: boundedText(value.subject, 160),
    snippet: boundedText(value.snippet, 240)
  };
}

function normalizeQuoItem(value, reference) {
  if (!isPlainObject(value)) return null;
  const channel = boundedCode(value.channel);
  const direction = boundedCode(value.direction);
  const occurredAt = normalizeTimestamp(value.occurredAt);
  const disposition = boundedCode(value.disposition);
  const actionState = boundedCode(value.actionState);
  if (
    !channel
    || !direction
    || !occurredAt
    || !disposition
    || !actionState
  ) {
    return null;
  }
  return {
    reference,
    channel,
    direction,
    occurredAt,
    disposition,
    actionState,
    preview: boundedText(value.preview, 240)
  };
}

function summarizeFreshSource(
  source,
  envelope,
  acceptedItems,
  droppedItems
) {
  return {
    source,
    status: "fresh",
    completeness: droppedItems > 0 ? "partial" : "complete",
    failureCode: droppedItems > 0 ? "source_partial" : null,
    asOf: envelope.asOf,
    checkedAt: envelope.checkedAt,
    validUntil: envelope.validUntil,
    acceptedItems,
    droppedItems
  };
}

function normalizeProviderId(value) {
  return typeof value === "string" && SAFE_PROVIDER_ID.test(value)
    ? value
    : null;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function normalizeNullableTimestamp(value) {
  return value === null || value === undefined
    ? null
    : normalizeTimestamp(value);
}

function boundedDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function boundedText(value, maximumCharacters) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, maximumCharacters).join("");
}

function boundedCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return SAFE_CODE.test(normalized) ? normalized : null;
}

function boundedEmail(value) {
  const normalized = boundedText(value, 254);
  if (
    !normalized
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized.toLowerCase();
}

function boundedPhone(value) {
  const normalized = boundedText(value, 32);
  return normalized && /^[+()\d.\-\s]{7,32}$/.test(normalized)
    ? normalized
    : null;
}

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new HcnConsoleFreshReadError(
      "invalid_configuration",
      500,
      `${name} is not configured.`
    );
  }
}

function requiredSourceUnavailable() {
  return new HcnConsoleFreshReadError(
    "source_unavailable",
    502,
    "Fresh JobNimbus evidence is unavailable."
  );
}

function fileNotFound() {
  return new HcnConsoleFreshReadError(
    "file_not_found",
    404,
    "The requested HCN file is not available."
  );
}

function invalidRequest(message) {
  throw new HcnConsoleFreshReadError("invalid_request", 400, message);
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
        Object.entries(value).map(([key, item]) => [
          key,
          immutableCopy(item)
        ])
      )
    );
  }
  return value;
}
