import {
  DOCUMENT_CODES,
  DOCUMENT_STATES,
  EVENT_ACTION_STATES,
  EVENT_CODES,
  FACT_CODES,
  FACT_STATES,
  FILE_STATUSES,
  ISO_UTC,
  LIMITS,
  OPAQUE_PATTERNS,
  PRIORITIES,
  PROMISE_CODES,
  PROMISE_STATES,
  REVIEW_STATES,
  SOURCE_COMPLETENESS,
  SOURCE_NAMES,
  SOURCE_STATUSES,
  STAGE_CODES,
  TASK_CODES,
  TASK_STATUSES
} from "./constants.js";

const TOP_LEVEL_FIELDS = Object.freeze([
  "generatedAt",
  "fileRef",
  "fileStatus",
  "activeSince",
  "activeSinceEvidenceRef",
  "ownerRef",
  "ownerEvidenceRef",
  "sources",
  "stages",
  "facts",
  "documents",
  "events",
  "tasks",
  "promises"
]);
const SOURCE_FIELDS = Object.freeze([
  "source",
  "status",
  "completeness",
  "asOf",
  "checkedAt",
  "validUntil"
]);
const STAGE_FIELDS = Object.freeze([
  "stageCode",
  "state",
  "source",
  "evidenceRef",
  "observedAt"
]);
const FACT_FIELDS = Object.freeze([
  "factCode",
  "state",
  "valueRef",
  "source",
  "evidenceRef",
  "observedAt"
]);
const DOCUMENT_FIELDS = Object.freeze([
  "documentCode",
  "state",
  "reviewState",
  "source",
  "evidenceRef",
  "observedAt"
]);
const EVENT_FIELDS = Object.freeze([
  "eventCode",
  "actionState",
  "source",
  "evidenceRef",
  "occurredAt",
  "actorRef"
]);
const TASK_FIELDS = Object.freeze([
  "taskCode",
  "status",
  "priority",
  "ownerRef",
  "dueAt",
  "source",
  "evidenceRef",
  "observedAt"
]);
const PROMISE_FIELDS = Object.freeze([
  "promiseCode",
  "state",
  "ownerRef",
  "madeAt",
  "dueAt",
  "source",
  "evidenceRef",
  "observedAt"
]);

const STAGE_STATES = Object.freeze(["current", "historical"]);
const VERIFIED_COMMUNICATION_EVENTS = new Set([
  "email_received",
  "email_sent_verified",
  "text_received",
  "text_delivered",
  "call_answered",
  "call_completed"
]);
const FAILED_COMMUNICATION_EVENTS = new Set([
  "email_send_failed",
  "text_failed",
  "outbound_call_failed"
]);
const UNVERIFIED_COMMUNICATION_EVENTS = new Set([
  "email_outbound_unverified",
  "text_sent_unconfirmed"
]);
const ATTEMPT_EVENTS = new Set([
  "call_no_answer",
  "call_missed",
  "voicemail_left"
]);
const DRAFT_EVENTS = new Set(["email_draft", "text_draft"]);

export class FileIntelligenceContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileIntelligenceContractError";
  }
}

/**
 * Validate and canonicalize already-normalized, coded provider evidence.
 *
 * No raw provider data is accepted. Invalid or over-limit inputs fail closed;
 * they are never truncated because silent truncation could change an
 * operational decision.
 */
export function normalizeFileEvidence(input) {
  assertExactObject(input, TOP_LEVEL_FIELDS, "fileEvidence");
  const generatedAt = timestamp(input.generatedAt, "fileEvidence.generatedAt");
  const generatedAtMs = Date.parse(generatedAt);
  const fileRef = opaque(
    input.fileRef,
    OPAQUE_PATTERNS.fileRef,
    "fileEvidence.fileRef"
  );
  const fileStatus = enumeration(
    input.fileStatus,
    FILE_STATUSES,
    "fileEvidence.fileStatus"
  );
  const activeSince = nullableTimestamp(
    input.activeSince,
    "fileEvidence.activeSince"
  );
  const activeSinceEvidenceRef = nullableOpaque(
    input.activeSinceEvidenceRef,
    OPAQUE_PATTERNS.evidenceRef,
    "fileEvidence.activeSinceEvidenceRef"
  );
  if ((activeSince === null) !== (activeSinceEvidenceRef === null)) {
    fail(
      "fileEvidence.activeSince and activeSinceEvidenceRef must both be present or both be null"
    );
  }
  if (activeSince && Date.parse(activeSince) > generatedAtMs) {
    fail("fileEvidence.activeSince cannot be in the future");
  }
  const ownerRef = nullableOpaque(
    input.ownerRef,
    OPAQUE_PATTERNS.ownerRef,
    "fileEvidence.ownerRef"
  );
  const ownerEvidenceRef = nullableOpaque(
    input.ownerEvidenceRef,
    OPAQUE_PATTERNS.evidenceRef,
    "fileEvidence.ownerEvidenceRef"
  );
  if ((ownerRef === null) !== (ownerEvidenceRef === null)) {
    fail(
      "fileEvidence.ownerRef and ownerEvidenceRef must both be present or both be null"
    );
  }

  const sources = normalizeSources(input.sources, generatedAtMs);
  const sourceMap = new Map(sources.map((source) => [source.source, source]));

  const stages = normalizeArray(
    input.stages,
    LIMITS.stages,
    "fileEvidence.stages",
    (candidate, index) =>
      normalizeStage(candidate, index, sourceMap, generatedAtMs)
  );
  const facts = normalizeArray(
    input.facts,
    LIMITS.facts,
    "fileEvidence.facts",
    (candidate, index) =>
      normalizeFact(candidate, index, sourceMap, generatedAtMs)
  );
  const documents = normalizeArray(
    input.documents,
    LIMITS.documents,
    "fileEvidence.documents",
    (candidate, index) =>
      normalizeDocument(candidate, index, sourceMap, generatedAtMs)
  );
  const events = normalizeArray(
    input.events,
    LIMITS.events,
    "fileEvidence.events",
    (candidate, index) =>
      normalizeEvent(candidate, index, sourceMap, generatedAtMs)
  );
  const tasks = normalizeArray(
    input.tasks,
    LIMITS.tasks,
    "fileEvidence.tasks",
    (candidate, index) =>
      normalizeTask(candidate, index, sourceMap, generatedAtMs)
  );
  const promises = normalizeArray(
    input.promises,
    LIMITS.promises,
    "fileEvidence.promises",
    (candidate, index) =>
      normalizePromise(candidate, index, sourceMap, generatedAtMs)
  );

  return immutableCopy({
    generatedAt,
    fileRef,
    fileStatus,
    activeSince,
    activeSinceEvidenceRef,
    ownerRef,
    ownerEvidenceRef,
    sources,
    stages: stages.sort(compareEvidence),
    facts: facts.sort(compareEvidence),
    documents: documents.sort(compareEvidence),
    events: events.sort(compareEvents),
    tasks: tasks.sort(compareEvidence),
    promises: promises.sort(compareEvidence)
  });
}

function normalizeSources(value, generatedAtMs) {
  if (!Array.isArray(value) || value.length > LIMITS.sources) {
    fail(`fileEvidence.sources must contain at most ${LIMITS.sources} items`);
  }
  const seen = new Set();
  return value
    .map((candidate, index) => {
      const path = `fileEvidence.sources[${index}]`;
      assertExactObject(candidate, SOURCE_FIELDS, path);
      const source = enumeration(
        candidate.source,
        SOURCE_NAMES,
        `${path}.source`
      );
      if (seen.has(source)) fail("fileEvidence.sources cannot contain duplicates");
      seen.add(source);
      const declaredStatus = enumeration(
        candidate.status,
        SOURCE_STATUSES,
        `${path}.status`
      );
      const completeness = enumeration(
        candidate.completeness,
        SOURCE_COMPLETENESS,
        `${path}.completeness`
      );
      const asOf = nullableTimestamp(candidate.asOf, `${path}.asOf`);
      const checkedAt = timestamp(candidate.checkedAt, `${path}.checkedAt`);
      const validUntil = nullableTimestamp(
        candidate.validUntil,
        `${path}.validUntil`
      );
      if (Date.parse(checkedAt) > generatedAtMs) {
        fail(`${path}.checkedAt cannot be in the future`);
      }
      if (asOf && Date.parse(asOf) > Date.parse(checkedAt)) {
        fail(`${path}.asOf cannot follow checkedAt`);
      }
      if (validUntil && Date.parse(validUntil) < Date.parse(checkedAt)) {
        fail(`${path}.validUntil cannot precede checkedAt`);
      }
      if (
        declaredStatus === "fresh" &&
        (!asOf || !validUntil || completeness === "none")
      ) {
        fail(
          `${path} fresh sources require asOf, validUntil, and non-none completeness`
        );
      }
      if (
        ["unavailable", "unsupported", "unknown"].includes(declaredStatus) &&
        completeness !== "none"
      ) {
        fail(`${path}.${declaredStatus} sources must have none completeness`);
      }
      const effectiveStatus =
        declaredStatus === "fresh" &&
        Date.parse(validUntil) < generatedAtMs
          ? "stale"
          : declaredStatus;
      return {
        source,
        declaredStatus,
        status: effectiveStatus,
        completeness:
          effectiveStatus === "fresh" ? completeness : "none",
        asOf,
        checkedAt,
        validUntil,
        reasonCode:
          effectiveStatus !== declaredStatus
            ? "freshness_window_expired"
            : statusReason(effectiveStatus)
      };
    })
    .sort((left, right) => left.source.localeCompare(right.source));
}

function normalizeStage(value, index, sourceMap, generatedAtMs) {
  const path = `fileEvidence.stages[${index}]`;
  assertExactObject(value, STAGE_FIELDS, path);
  return evidenceRecord(
    value,
    path,
    sourceMap,
    generatedAtMs,
    "observedAt",
    {
      stageCode: enumeration(value.stageCode, STAGE_CODES, `${path}.stageCode`),
      state: enumeration(value.state, STAGE_STATES, `${path}.state`)
    }
  );
}

function normalizeFact(value, index, sourceMap, generatedAtMs) {
  const path = `fileEvidence.facts[${index}]`;
  assertExactObject(value, FACT_FIELDS, path);
  const state = enumeration(value.state, FACT_STATES, `${path}.state`);
  const valueRef = nullableOpaque(
    value.valueRef,
    OPAQUE_PATTERNS.valueRef,
    `${path}.valueRef`
  );
  if (state === "confirmed" && valueRef === null) {
    fail(`${path}.valueRef is required for a confirmed fact`);
  }
  if (state !== "confirmed" && valueRef !== null) {
    fail(`${path}.valueRef must be null unless the fact is confirmed`);
  }
  return evidenceRecord(
    value,
    path,
    sourceMap,
    generatedAtMs,
    "observedAt",
    {
      factCode: enumeration(value.factCode, FACT_CODES, `${path}.factCode`),
      state,
      valueRef
    }
  );
}

function normalizeDocument(value, index, sourceMap, generatedAtMs) {
  const path = `fileEvidence.documents[${index}]`;
  assertExactObject(value, DOCUMENT_FIELDS, path);
  const state = enumeration(value.state, DOCUMENT_STATES, `${path}.state`);
  const reviewState = enumeration(
    value.reviewState,
    REVIEW_STATES,
    `${path}.reviewState`
  );
  if (
    state !== "present" &&
    !["not_required", "unknown"].includes(reviewState)
  ) {
    fail(`${path}.reviewState cannot imply review of a non-present document`);
  }
  return evidenceRecord(
    value,
    path,
    sourceMap,
    generatedAtMs,
    "observedAt",
    {
      documentCode: enumeration(
        value.documentCode,
        DOCUMENT_CODES,
        `${path}.documentCode`
      ),
      state,
      reviewState
    }
  );
}

function normalizeEvent(value, index, sourceMap, generatedAtMs) {
  const path = `fileEvidence.events[${index}]`;
  assertExactObject(value, EVENT_FIELDS, path);
  const event = evidenceRecord(
    value,
    path,
    sourceMap,
    generatedAtMs,
    "occurredAt",
    {
      eventCode: enumeration(
        value.eventCode,
        EVENT_CODES,
        `${path}.eventCode`
      ),
      actionState: enumeration(
        value.actionState,
        EVENT_ACTION_STATES,
        `${path}.actionState`
      ),
      actorRef: nullableOpaque(
        value.actorRef,
        OPAQUE_PATTERNS.ownerRef,
        `${path}.actorRef`
      )
    }
  );
  validateEventSemantics(event, path);
  return {
    ...event,
    occurredAt: event.observedAt
  };
}

function validateEventSemantics(event, path) {
  if (
    VERIFIED_COMMUNICATION_EVENTS.has(event.eventCode) &&
    !["none", "awaiting_response", "responded"].includes(event.actionState)
  ) {
    fail(`${path}.actionState contradicts verified communication`);
  }
  if (
    FAILED_COMMUNICATION_EVENTS.has(event.eventCode) &&
    event.actionState !== "failed"
  ) {
    fail(`${path}.actionState must be failed for this event`);
  }
  if (
    UNVERIFIED_COMMUNICATION_EVENTS.has(event.eventCode) &&
    event.actionState !== "unverified"
  ) {
    fail(`${path}.actionState must be unverified for this event`);
  }
  if (
    ATTEMPT_EVENTS.has(event.eventCode) &&
    event.actionState !== "none"
  ) {
    fail(`${path}.actionState must be none for this attempt event`);
  }
  if (
    DRAFT_EVENTS.has(event.eventCode) &&
    event.actionState !== "draft"
  ) {
    fail(`${path}.actionState must be draft for a draft event`);
  }
  if (
    !VERIFIED_COMMUNICATION_EVENTS.has(event.eventCode) &&
    !FAILED_COMMUNICATION_EVENTS.has(event.eventCode) &&
    !UNVERIFIED_COMMUNICATION_EVENTS.has(event.eventCode) &&
    !ATTEMPT_EVENTS.has(event.eventCode) &&
    !DRAFT_EVENTS.has(event.eventCode) &&
    !["none", "unknown"].includes(event.actionState)
  ) {
    fail(`${path}.actionState is incompatible with a non-communication event`);
  }
}

function normalizeTask(value, index, sourceMap, generatedAtMs) {
  const path = `fileEvidence.tasks[${index}]`;
  assertExactObject(value, TASK_FIELDS, path);
  const dueAt = nullableTimestamp(value.dueAt, `${path}.dueAt`);
  return evidenceRecord(
    value,
    path,
    sourceMap,
    generatedAtMs,
    "observedAt",
    {
      taskCode: enumeration(value.taskCode, TASK_CODES, `${path}.taskCode`),
      status: enumeration(value.status, TASK_STATUSES, `${path}.status`),
      priority: enumeration(value.priority, PRIORITIES, `${path}.priority`),
      ownerRef: nullableOpaque(
        value.ownerRef,
        OPAQUE_PATTERNS.ownerRef,
        `${path}.ownerRef`
      ),
      dueAt
    }
  );
}

function normalizePromise(value, index, sourceMap, generatedAtMs) {
  const path = `fileEvidence.promises[${index}]`;
  assertExactObject(value, PROMISE_FIELDS, path);
  const madeAt = timestamp(value.madeAt, `${path}.madeAt`);
  const dueAt = nullableTimestamp(value.dueAt, `${path}.dueAt`);
  if (Date.parse(madeAt) > generatedAtMs) {
    fail(`${path}.madeAt cannot be in the future`);
  }
  if (dueAt && Date.parse(dueAt) < Date.parse(madeAt)) {
    fail(`${path}.dueAt cannot precede madeAt`);
  }
  return evidenceRecord(
    value,
    path,
    sourceMap,
    generatedAtMs,
    "observedAt",
    {
      promiseCode: enumeration(
        value.promiseCode,
        PROMISE_CODES,
        `${path}.promiseCode`
      ),
      state: enumeration(value.state, PROMISE_STATES, `${path}.state`),
      ownerRef: nullableOpaque(
        value.ownerRef,
        OPAQUE_PATTERNS.ownerRef,
        `${path}.ownerRef`
      ),
      madeAt,
      dueAt
    }
  );
}

function evidenceRecord(
  value,
  path,
  sourceMap,
  generatedAtMs,
  timestampField,
  fields
) {
  const source = enumeration(value.source, SOURCE_NAMES, `${path}.source`);
  if (!sourceMap.has(source)) {
    fail(`${path}.source requires a matching source state`);
  }
  const evidenceRef = opaque(
    value.evidenceRef,
    OPAQUE_PATTERNS.evidenceRef,
    `${path}.evidenceRef`
  );
  const observedAt = timestamp(value[timestampField], `${path}.${timestampField}`);
  if (Date.parse(observedAt) > generatedAtMs) {
    fail(`${path}.${timestampField} cannot be in the future`);
  }
  return {
    ...fields,
    source,
    evidenceRef,
    observedAt,
    usable: sourceMap.get(source).status === "fresh"
  };
}

function normalizeArray(value, max, path, normalizer) {
  if (!Array.isArray(value) || value.length > max) {
    fail(`${path} must be an array with at most ${max} items`);
  }
  return value.map(normalizer);
}

function compareEvidence(left, right) {
  return (
    right.observedAt.localeCompare(left.observedAt) ||
    left.evidenceRef.localeCompare(right.evidenceRef)
  );
}

function compareEvents(left, right) {
  return (
    right.occurredAt.localeCompare(left.occurredAt) ||
    left.evidenceRef.localeCompare(right.evidenceRef)
  );
}

function statusReason(status) {
  switch (status) {
    case "stale":
      return "source_stale";
    case "unavailable":
      return "source_unavailable";
    case "unsupported":
      return "source_unsupported";
    case "unknown":
      return "source_unknown";
    default:
      return null;
  }
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

function enumeration(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(`${path} must be one of ${allowed.join("/")}`);
  }
  return value;
}

function opaque(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${path} must be an opaque reference`);
  }
  return value;
}

function nullableOpaque(value, pattern, path) {
  return value === null ? null : opaque(value, pattern, path);
}

function timestamp(value, path) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    fail(`${path} must be an ISO-8601 UTC timestamp with milliseconds`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${path} must be a valid canonical UTC timestamp`);
  }
  return value;
}

function nullableTimestamp(value, path) {
  return value === null ? null : timestamp(value, path);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function immutableCopy(value) {
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
  throw new FileIntelligenceContractError(message);
}
