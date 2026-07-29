/**
 * Read-only HCN Work Center presentation core.
 *
 * The caller must resolve and freshly verify one exact Chance-assigned
 * JobNimbus file before invoking this module. Source access is injected; this
 * module has no persistence, memory, Chance Brain, Jobrolo, write, send, call,
 * or approval dependency.
 */

export const WORK_CENTER_SCHEMA_VERSION = "hcn.work-center.presentation.v1";
export const WORK_CENTER_API_VERSION = "v1";

export const WORK_CENTER_SOURCE_NAMES = Object.freeze([
  "jobnimbus",
  "gmail",
  "quo"
]);

export const WORK_CENTER_REASON_CODES = Object.freeze([
  "source_unavailable",
  "source_stale",
  "source_partial",
  "overdue_task",
  "task_due_today",
  "document_review_required",
  "awaiting_response"
]);

const SOURCE_LOADERS = Object.freeze({
  jobnimbus: "readJobNimbus",
  gmail: "readGmail",
  quo: "readQuo"
});

const SOURCE_FAILURE_CODES = new Set([
  "source_error",
  "invalid_source_envelope",
  "scope_mismatch",
  "missing_file"
]);
const TASK_STATUSES = new Set([
  "open",
  "in_progress",
  "blocked",
  "completed",
  "cancelled"
]);
const DOCUMENT_REVIEW_STATES = new Set([
  "needs_review",
  "in_review",
  "reviewed",
  "not_required"
]);
const COMMUNICATION_ACTION_STATES = new Set([
  "none",
  "needs_reply",
  "awaiting_response",
  "resolved"
]);
const DIRECTIONS = new Set(["inbound", "outbound", "internal", "unknown"]);
const ACTOR_ROLES = new Set([
  "chance",
  "homeowner",
  "adjuster",
  "carrier",
  "team",
  "system",
  "unknown"
]);
const QUO_CHANNELS = new Set(["call", "text", "voicemail"]);
const QUO_DISPOSITIONS = new Set([
  "answered",
  "missed",
  "voicemail",
  "delivered",
  "failed",
  "unknown"
]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const PRIORITY_RANK = Object.freeze({
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3
});

const SUBJECT_REF = /^subject_[a-f0-9]{32}$/;
const TENANT_ID = /^tenant_[a-f0-9]{16}$/;
const EVIDENCE_REF = /^ref_[a-f0-9]{16,64}$/;
const REQUEST_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const JOB_NUMBER = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
const SAFE_TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;
const SAFE_PROVIDER_ID = /^[^\s\x00-\x1f\x7f]{1,256}$/;
const SAFE_BUILD_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const SAFE_COMMIT = /^[a-f0-9]{7,64}$/i;
const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SCOPE_FIELDS = Object.freeze([
  "tenantId",
  "fileRef",
  "jobNimbusFileId",
  "jobNumber",
  "assignment"
]);
const ASSIGNMENT_FIELDS = Object.freeze([
  "state",
  "asOf",
  "checkedAt",
  "validUntil"
]);

/**
 * Create a read-only presenter with injected source readers and metadata hooks.
 */
export function createWorkCenterCore({
  readJobNimbus,
  readGmail,
  readQuo,
  now = () => new Date(),
  createRequestId,
  getBuildMetadata = () => ({})
} = {}) {
  assertFunction(readJobNimbus, "readJobNimbus");
  assertFunction(readGmail, "readGmail");
  assertFunction(readQuo, "readQuo");
  assertFunction(now, "now");
  assertFunction(createRequestId, "createRequestId");
  assertFunction(getBuildMetadata, "getBuildMetadata");

  const dependencies = {
    readJobNimbus,
    readGmail,
    readQuo
  };

  return Object.freeze({
    /**
     * Present one exact file. There are intentionally no mutation methods on
     * this object.
     */
    async presentFile({ scope } = {}) {
      const generatedAt = readNow(now);
      const normalizedScope = validateExactAssignedScope(scope, generatedAt);
      const requestId = readRequestId(createRequestId);
      const loaderScope = immutableCopy(normalizedScope);

      const settled = await Promise.all(
        WORK_CENTER_SOURCE_NAMES.map(async (source) => {
          const loader = dependencies[SOURCE_LOADERS[source]];
          try {
            return {
              source,
              result: await loader(loaderScope)
            };
          } catch {
            return {
              source,
              result: {
                status: "failed",
                checkedAt: generatedAt,
                failureCode: "source_error"
              }
            };
          }
        })
      );

      const sources = Object.fromEntries(
        settled.map(({ source, result }) => [source, result])
      );
      let buildMetadata = {};
      try {
        buildMetadata = await getBuildMetadata({
          requestId,
          generatedAt,
          schemaVersion: WORK_CENTER_SCHEMA_VERSION,
          apiVersion: WORK_CENTER_API_VERSION
        });
      } catch {
        // Build attestation is useful metadata, not permission to expose an
        // unvalidated exception or to fail open on operational evidence.
        buildMetadata = {};
      }

      return buildWorkCenterPresentation({
        scope: normalizedScope,
        sources,
        generatedAt,
        requestId,
        buildMetadata
      });
    }
  });
}

/**
 * Pure presentation function for already-fetched source envelopes.
 */
export function buildWorkCenterPresentation({
  scope,
  sources,
  generatedAt,
  requestId,
  buildMetadata = {}
} = {}) {
  const nowIso = normalizeRequiredTimestamp(generatedAt, "generatedAt");
  const normalizedScope = validateExactAssignedScope(scope, nowIso);
  const normalizedRequestId = normalizeRequestId(requestId);
  const sourceInput = isPlainObject(sources) ? sources : {};

  const jobNimbus = normalizeJobNimbusSource(
    sourceInput.jobnimbus,
    normalizedScope,
    nowIso
  );
  const gmail = normalizeGmailSource(
    sourceInput.gmail,
    normalizedScope,
    nowIso
  );
  const quo = normalizeQuoSource(sourceInput.quo, normalizedScope, nowIso);

  const normalizedSources = [jobNimbus, gmail, quo];
  const evidenceStatus = deriveEvidenceStatus(normalizedSources);
  const recent = {
    activities: jobNimbus.data?.activities ?? [],
    tasks: jobNimbus.data?.tasks ?? [],
    documents: jobNimbus.data?.documents ?? [],
    gmail: gmail.data?.communications ?? [],
    quo: quo.data?.communications ?? []
  };

  const result = {
    schema: {
      name: "hcn.work-center.presentation",
      version: WORK_CENTER_SCHEMA_VERSION
    },
    api: {
      version: WORK_CENTER_API_VERSION
    },
    request: {
      id: normalizedRequestId,
      generatedAt: nowIso
    },
    build: normalizeBuildMetadata(buildMetadata),
    authority: {
      mode: "read_only",
      canWrite: false,
      canSend: false,
      canCall: false,
      canApprove: false
    },
    evidenceStatus,
    file: buildFilePresentation(normalizedScope, jobNimbus),
    sources: normalizedSources.map(summarizeSource),
    lanes: buildLanes(normalizedSources, recent, nowIso),
    recent
  };

  return immutableCopy(result);
}

export class WorkCenterContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkCenterContractError";
  }
}

function validateExactAssignedScope(value, nowIso) {
  assertExactObject(value, SCOPE_FIELDS, "scope");
  if (!TENANT_ID.test(value.tenantId)) {
    fail("scope.tenantId must be an opaque HCN tenant identifier");
  }
  if (!SUBJECT_REF.test(value.fileRef)) {
    fail("scope.fileRef must be an opaque HCN file reference");
  }
  if (
    typeof value.jobNimbusFileId !== "string"
    || !SAFE_PROVIDER_ID.test(value.jobNimbusFileId)
  ) {
    fail("scope.jobNimbusFileId must identify one exact JobNimbus file");
  }
  if (typeof value.jobNumber !== "string" || !JOB_NUMBER.test(value.jobNumber)) {
    fail("scope.jobNumber must be a safe exact JobNimbus number");
  }

  assertExactObject(value.assignment, ASSIGNMENT_FIELDS, "scope.assignment");
  if (value.assignment.state !== "assigned_to_chance") {
    fail("scope must be freshly verified as assigned to Chance");
  }
  const assignmentTimes = normalizeFreshnessTimes(
    value.assignment,
    nowIso,
    "scope.assignment"
  );
  if (Date.parse(assignmentTimes.validUntil) < Date.parse(nowIso)) {
    fail("scope assignment verification is stale");
  }

  return {
    tenantId: value.tenantId,
    fileRef: value.fileRef,
    jobNimbusFileId: value.jobNimbusFileId,
    jobNumber: value.jobNumber,
    assignment: {
      state: "assigned_to_chance",
      ...assignmentTimes
    }
  };
}

function normalizeJobNimbusSource(value, scope, nowIso) {
  const envelope = normalizeSourceEnvelope(value, "jobnimbus", nowIso);
  if (envelope.status !== "fresh") return envelope;

  const raw = envelope.rawData;
  if (!isPlainObject(raw) || !isPlainObject(raw.file)) {
    return failedSource(envelope, "missing_file");
  }
  if (
    raw.file.fileRef !== scope.fileRef
    || raw.file.jobNumber !== scope.jobNumber
  ) {
    return failedSource(envelope, "scope_mismatch");
  }

  const file = normalizeFile(raw.file);
  if (!file) return failedSource(envelope, "missing_file");

  const activities = normalizeArray(
    raw.activities,
    normalizeActivity,
    compareRecent
  );
  const tasks = normalizeArray(raw.tasks, normalizeTask, compareTasks);
  const documents = normalizeArray(
    raw.documents,
    normalizeDocument,
    compareRecent
  );
  const droppedItems =
    activities.droppedItems + tasks.droppedItems + documents.droppedItems;
  const missingCollections = ["activities", "tasks", "documents"].filter(
    (field) => !Array.isArray(raw[field])
  ).length;

  return withFreshData(
    envelope,
    {
      file,
      activities: activities.items,
      tasks: tasks.items,
      documents: documents.items
    },
    droppedItems + missingCollections
  );
}

function normalizeGmailSource(value, scope, nowIso) {
  const envelope = normalizeSourceEnvelope(value, "gmail", nowIso);
  if (envelope.status !== "fresh") return envelope;
  if (!isPlainObject(envelope.rawData)) {
    return failedSource(envelope, "invalid_source_envelope");
  }
  if (envelope.rawData.fileRef !== scope.fileRef) {
    return failedSource(envelope, "scope_mismatch");
  }
  const communications = normalizeArray(
    envelope.rawData.communications,
    normalizeGmailCommunication,
    compareCommunications
  );
  const missing = Array.isArray(envelope.rawData.communications) ? 0 : 1;
  return withFreshData(
    envelope,
    { communications: communications.items },
    communications.droppedItems + missing
  );
}

function normalizeQuoSource(value, scope, nowIso) {
  const envelope = normalizeSourceEnvelope(value, "quo", nowIso);
  if (envelope.status !== "fresh") return envelope;
  if (!isPlainObject(envelope.rawData)) {
    return failedSource(envelope, "invalid_source_envelope");
  }
  if (envelope.rawData.fileRef !== scope.fileRef) {
    return failedSource(envelope, "scope_mismatch");
  }
  const communications = normalizeArray(
    envelope.rawData.communications,
    normalizeQuoCommunication,
    compareCommunications
  );
  const missing = Array.isArray(envelope.rawData.communications) ? 0 : 1;
  return withFreshData(
    envelope,
    { communications: communications.items },
    communications.droppedItems + missing
  );
}

function normalizeSourceEnvelope(value, source, nowIso) {
  if (!isPlainObject(value)) {
    return emptySource(source, "failed", "invalid_source_envelope", nowIso);
  }
  if (value.status === "failed") {
    const checkedAt = normalizeOptionalTimestamp(value.checkedAt) ?? nowIso;
    const failureCode = SOURCE_FAILURE_CODES.has(value.failureCode)
      ? value.failureCode
      : "source_error";
    return emptySource(source, "failed", failureCode, checkedAt);
  }
  if (value.status !== "ok") {
    return emptySource(source, "failed", "invalid_source_envelope", nowIso);
  }

  let freshness;
  try {
    freshness = normalizeFreshnessTimes(value, nowIso, `${source} source`);
  } catch {
    return emptySource(source, "failed", "invalid_source_envelope", nowIso);
  }
  const status =
    Date.parse(freshness.validUntil) < Date.parse(nowIso) ? "stale" : "fresh";

  return {
    source,
    status,
    completeness: status === "fresh" ? "complete" : "none",
    asOf: freshness.asOf,
    checkedAt: freshness.checkedAt,
    validUntil: freshness.validUntil,
    failureCode: status === "stale" ? "source_stale" : null,
    acceptedItems: 0,
    droppedItems: 0,
    rawData: value.data
  };
}

function normalizeFreshnessTimes(value, nowIso, path) {
  const asOf = normalizeRequiredTimestamp(value.asOf, `${path}.asOf`);
  const checkedAt = normalizeRequiredTimestamp(
    value.checkedAt,
    `${path}.checkedAt`
  );
  const validUntil = normalizeRequiredTimestamp(
    value.validUntil,
    `${path}.validUntil`
  );
  if (Date.parse(asOf) > Date.parse(checkedAt)) {
    fail(`${path}.asOf cannot follow checkedAt`);
  }
  if (Date.parse(checkedAt) > Date.parse(nowIso)) {
    fail(`${path}.checkedAt cannot be in the future`);
  }
  if (Date.parse(validUntil) < Date.parse(checkedAt)) {
    fail(`${path}.validUntil cannot precede checkedAt`);
  }
  return { asOf, checkedAt, validUntil };
}

function withFreshData(envelope, data, droppedItems) {
  const acceptedItems = Object.values(data).reduce(
    (total, value) => total + (Array.isArray(value) ? value.length : 0),
    0
  );
  return {
    source: envelope.source,
    status: "fresh",
    completeness: droppedItems > 0 ? "partial" : "complete",
    asOf: envelope.asOf,
    checkedAt: envelope.checkedAt,
    validUntil: envelope.validUntil,
    failureCode: droppedItems > 0 ? "source_partial" : null,
    acceptedItems,
    droppedItems,
    data
  };
}

function failedSource(envelope, failureCode) {
  return {
    source: envelope.source,
    status: "failed",
    completeness: "none",
    asOf: envelope.asOf,
    checkedAt: envelope.checkedAt,
    validUntil: envelope.validUntil,
    failureCode,
    acceptedItems: 0,
    droppedItems: 0
  };
}

function emptySource(source, status, failureCode, checkedAt) {
  return {
    source,
    status,
    completeness: "none",
    asOf: null,
    checkedAt,
    validUntil: null,
    failureCode,
    acceptedItems: 0,
    droppedItems: 0
  };
}

function normalizeFile(value) {
  const statusCode = normalizeToken(value.statusCode);
  const stageCode = normalizeToken(value.stageCode);
  const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
  const nextAppointmentAt =
    value.nextAppointmentAt === null
      ? null
      : normalizeOptionalTimestamp(value.nextAppointmentAt);
  if (!statusCode || !stageCode || !updatedAt) return null;
  if (value.nextAppointmentAt !== null && !nextAppointmentAt) return null;
  return {
    statusCode,
    stageCode,
    updatedAt,
    nextAppointmentAt
  };
}

function normalizeActivity(value) {
  if (!isPlainObject(value)) return null;
  const reference = normalizeEvidenceRef(value.reference);
  const kind = normalizeToken(value.kind);
  const state = normalizeToken(value.state);
  const occurredAt = normalizeOptionalTimestamp(value.occurredAt);
  const actorRole = ACTOR_ROLES.has(value.actorRole) ? value.actorRole : null;
  if (!reference || !kind || !state || !occurredAt || !actorRole) return null;
  return { reference, kind, state, occurredAt, actorRole };
}

function normalizeTask(value) {
  if (!isPlainObject(value)) return null;
  const reference = normalizeEvidenceRef(value.reference);
  const kind = normalizeToken(value.kind);
  const status = TASK_STATUSES.has(value.status) ? value.status : null;
  const priority = PRIORITIES.has(value.priority) ? value.priority : "normal";
  const dueAt =
    value.dueAt === null ? null : normalizeOptionalTimestamp(value.dueAt);
  const assignedRole = ACTOR_ROLES.has(value.assignedRole)
    ? value.assignedRole
    : null;
  if (
    !reference
    || !kind
    || !status
    || (value.dueAt !== null && !dueAt)
    || !assignedRole
  ) {
    return null;
  }
  return { reference, kind, status, priority, dueAt, assignedRole };
}

function normalizeDocument(value) {
  if (!isPlainObject(value)) return null;
  const reference = normalizeEvidenceRef(value.reference);
  const kind = normalizeToken(value.kind);
  const reviewState = DOCUMENT_REVIEW_STATES.has(value.reviewState)
    ? value.reviewState
    : null;
  const createdAt = normalizeOptionalTimestamp(value.createdAt);
  if (!reference || !kind || !reviewState || !createdAt) return null;
  return { reference, kind, reviewState, createdAt };
}

function normalizeGmailCommunication(value) {
  if (!isPlainObject(value)) return null;
  const reference = normalizeEvidenceRef(value.reference);
  const direction = DIRECTIONS.has(value.direction) ? value.direction : null;
  const occurredAt = normalizeOptionalTimestamp(value.occurredAt);
  const actionState = COMMUNICATION_ACTION_STATES.has(value.actionState)
    ? value.actionState
    : null;
  if (
    !reference
    || !direction
    || !occurredAt
    || typeof value.hasAttachment !== "boolean"
    || !actionState
  ) {
    return null;
  }
  return {
    reference,
    direction,
    occurredAt,
    hasAttachment: value.hasAttachment,
    actionState
  };
}

function normalizeQuoCommunication(value) {
  if (!isPlainObject(value)) return null;
  const reference = normalizeEvidenceRef(value.reference);
  const channel = QUO_CHANNELS.has(value.channel) ? value.channel : null;
  const direction = DIRECTIONS.has(value.direction) ? value.direction : null;
  const occurredAt = normalizeOptionalTimestamp(value.occurredAt);
  const disposition = QUO_DISPOSITIONS.has(value.disposition)
    ? value.disposition
    : null;
  const actionState = COMMUNICATION_ACTION_STATES.has(value.actionState)
    ? value.actionState
    : null;
  if (
    !reference
    || !channel
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
    actionState
  };
}

function normalizeArray(value, normalizer, comparator) {
  if (!Array.isArray(value)) return { items: [], droppedItems: 0 };
  let droppedItems = Math.max(0, value.length - 50);
  const items = [];
  for (const candidate of value.slice(0, 50)) {
    const normalized = normalizer(candidate);
    if (normalized) items.push(normalized);
    else droppedItems += 1;
  }
  items.sort(comparator);
  return {
    items: items.slice(0, 20),
    droppedItems: droppedItems + Math.max(0, items.length - 20)
  };
}

function buildFilePresentation(scope, jobNimbus) {
  return {
    tenantId: scope.tenantId,
    fileRef: scope.fileRef,
    jobNumber: scope.jobNumber,
    assignment: {
      state: scope.assignment.state,
      verifiedAt: scope.assignment.checkedAt,
      validUntil: scope.assignment.validUntil
    },
    operational:
      jobNimbus.status === "fresh" && jobNimbus.data
        ? jobNimbus.data.file
        : null
  };
}

function deriveEvidenceStatus(sources) {
  const jobNimbus = sources.find((source) => source.source === "jobnimbus");
  if (!jobNimbus || jobNimbus.status !== "fresh") return "failed";
  if (
    sources.some(
      (source) =>
        source.status !== "fresh" || source.completeness !== "complete"
    )
  ) {
    return "partial";
  }
  return "complete";
}

function summarizeSource(source) {
  return {
    source: source.source,
    status: source.status,
    completeness: source.completeness,
    asOf: source.asOf,
    checkedAt: source.checkedAt,
    validUntil: source.validUntil,
    failureCode: source.failureCode,
    acceptedItems: source.acceptedItems,
    droppedItems: source.droppedItems
  };
}

function buildLanes(sources, recent, nowIso) {
  const priority = [];
  const today = [];
  const waiting = [];

  for (const source of sources) {
    if (source.status === "failed" || source.status === "stale") {
      priority.push(
        buildLaneItem({
          source: source.source,
          reference: null,
          itemType: "source",
          priority: "high",
          reasonCode:
            source.status === "stale" ? "source_stale" : "source_unavailable",
          actionCode: "refresh_source",
          dueAt: null,
          occurredAt: source.checkedAt
        })
      );
    } else if (source.completeness === "partial") {
      priority.push(
        buildLaneItem({
          source: source.source,
          reference: null,
          itemType: "source",
          priority: "high",
          reasonCode: "source_partial",
          actionCode: "review_source",
          dueAt: null,
          occurredAt: source.checkedAt
        })
      );
    }
  }

  const todayKey = nowIso.slice(0, 10);
  for (const task of recent.tasks) {
    if (task.status === "completed" || task.status === "cancelled") continue;
    if (task.dueAt && Date.parse(task.dueAt) < startOfUtcDay(nowIso)) {
      priority.push(
        buildLaneItem({
          source: "jobnimbus",
          reference: task.reference,
          itemType: "task",
          priority: "urgent",
          reasonCode: "overdue_task",
          actionCode: "review_task",
          dueAt: task.dueAt,
          occurredAt: null
        })
      );
    } else if (task.dueAt?.slice(0, 10) === todayKey) {
      today.push(
        buildLaneItem({
          source: "jobnimbus",
          reference: task.reference,
          itemType: "task",
          priority: task.priority === "urgent" ? "urgent" : "high",
          reasonCode: "task_due_today",
          actionCode: "review_task",
          dueAt: task.dueAt,
          occurredAt: null
        })
      );
    }
  }

  for (const document of recent.documents) {
    if (
      document.reviewState !== "needs_review"
      && document.reviewState !== "in_review"
    ) {
      continue;
    }
    priority.push(
      buildLaneItem({
        source: "jobnimbus",
        reference: document.reference,
        itemType: "document",
        priority: "high",
        reasonCode: "document_review_required",
        actionCode: "review_document",
        dueAt: null,
        occurredAt: document.createdAt
      })
    );
  }

  for (const [source, communications] of [
    ["gmail", recent.gmail],
    ["quo", recent.quo]
  ]) {
    for (const communication of communications) {
      if (communication.actionState !== "awaiting_response") continue;
      waiting.push(
        buildLaneItem({
          source,
          reference: communication.reference,
          itemType: "communication",
          priority: "normal",
          reasonCode: "awaiting_response",
          actionCode: "monitor_response",
          dueAt: null,
          occurredAt: communication.occurredAt
        })
      );
    }
  }

  const sortLane = (items) =>
    items
      .sort(compareLaneItems)
      .filter(
        (item, index, all) =>
          all.findIndex((candidate) => candidate.key === item.key) === index
      )
      .slice(0, 50);

  return {
    priority: sortLane(priority),
    today: sortLane(today),
    waiting: sortLane(waiting)
  };
}

function buildLaneItem({
  source,
  reference,
  itemType,
  priority,
  reasonCode,
  actionCode,
  dueAt,
  occurredAt
}) {
  return {
    key: `${source}:${reference ?? "source"}:${reasonCode}`,
    source,
    reference,
    itemType,
    priority,
    reasonCode,
    actionCode,
    dueAt,
    occurredAt
  };
}

function normalizeBuildMetadata(value) {
  const candidate = isPlainObject(value) ? value : {};
  const trust = [
    "provider_attested",
    "declared",
    "invalid",
    "unavailable"
  ].includes(candidate.sourceCommitTrust)
    ? candidate.sourceCommitTrust
    : "unavailable";
  const sourceCommit =
    typeof candidate.sourceCommit === "string"
    && SAFE_COMMIT.test(candidate.sourceCommit)
      ? candidate.sourceCommit.toLowerCase()
      : null;
  return {
    service:
      typeof candidate.service === "string"
      && SAFE_BUILD_ID.test(candidate.service)
        ? candidate.service
        : null,
    sourceCommit,
    sourceCommitTrust: trust,
    buildId:
      typeof candidate.buildId === "string"
      && SAFE_BUILD_ID.test(candidate.buildId)
        ? candidate.buildId
        : null,
    deployId:
      typeof candidate.deployId === "string"
      && SAFE_BUILD_ID.test(candidate.deployId)
        ? candidate.deployId
        : null,
    attested:
      candidate.attested === true
      && trust === "provider_attested"
      && sourceCommit !== null
  };
}

function compareRecent(left, right) {
  const leftAt = left.occurredAt ?? left.createdAt ?? "";
  const rightAt = right.occurredAt ?? right.createdAt ?? "";
  return rightAt.localeCompare(leftAt) || left.reference.localeCompare(right.reference);
}

function compareTasks(left, right) {
  if (left.dueAt === null && right.dueAt !== null) return 1;
  if (left.dueAt !== null && right.dueAt === null) return -1;
  return (
    String(left.dueAt).localeCompare(String(right.dueAt))
    || left.reference.localeCompare(right.reference)
  );
}

function compareCommunications(left, right) {
  return (
    right.occurredAt.localeCompare(left.occurredAt)
    || left.reference.localeCompare(right.reference)
  );
}

function compareLaneItems(left, right) {
  return (
    PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
    || String(left.dueAt ?? "").localeCompare(String(right.dueAt ?? ""))
    || String(right.occurredAt ?? "").localeCompare(
      String(left.occurredAt ?? "")
    )
    || left.key.localeCompare(right.key)
  );
}

function startOfUtcDay(iso) {
  return Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
}

function normalizeRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    fail("requestId must be a safe opaque request identifier");
  }
  return value;
}

function readRequestId(createRequestId) {
  let value;
  try {
    value = createRequestId();
  } catch {
    fail("createRequestId failed");
  }
  return normalizeRequestId(value);
}

function readNow(now) {
  let value;
  try {
    value = now();
  } catch {
    fail("now failed");
  }
  const date = value instanceof Date ? value : null;
  if (!date || Number.isNaN(date.getTime())) {
    fail("now must return a valid Date");
  }
  return date.toISOString();
}

function normalizeRequiredTimestamp(value, path) {
  const normalized = normalizeOptionalTimestamp(value);
  if (!normalized) fail(`${path} must be an ISO-8601 UTC timestamp`);
  return normalized;
}

function normalizeOptionalTimestamp(value) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return null;
  }
  return value;
}

function normalizeEvidenceRef(value) {
  return typeof value === "string" && EVIDENCE_REF.test(value) ? value : null;
}

function normalizeToken(value) {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}

function assertExactObject(value, fields, path) {
  if (!isPlainObject(value)) fail(`${path} must be a plain object`);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      fail(`${path}.${field} is required`);
    }
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) fail(`${path}.${field} is not allowed`);
  }
}

function assertFunction(value, name) {
  if (typeof value !== "function") fail(`${name} must be a function`);
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
  throw new WorkCenterContractError(message);
}
