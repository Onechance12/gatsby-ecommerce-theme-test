/**
 * Pure JobNimbus projections for Richard's company management sweep.
 *
 * This module accepts completely paginated provider collections and emits a
 * bounded ephemeral projection. It never performs network I/O, persists data,
 * reads a Brain, or emits raw notes/tasks.
 */

export const HCN_MANAGEMENT_PROVIDER_LIMITS = Object.freeze({
  maximumContacts: 5000,
  maximumActivities: 5000,
  maximumTasks: 5000
});

export const HCN_MANAGEMENT_ESTIMATING_STATUS_CODES = Object.freeze([
  "photo_file_estimate_needed",
  "ready_for_pa_review",
  "submitted_awaiting_confirmation",
  "submitted",
  "hot_final_negotiation",
  "estimating_finalized_awaiting_acv"
]);

const PROVIDER_ID = /^[^\s\x00-\x1f\x7f]{1,512}$/;
const SAFE_JOB_NUMBER = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERIFIED_COMMUNICATION_KINDS = new Set([
  "call",
  "email",
  "message",
  "phone_call",
  "sms",
  "text",
  "text_message",
  "voicemail"
]);
const VERIFIED_COMMUNICATION_SUCCESS_STATES = new Set([
  "answered",
  "completed",
  "connected",
  "delivered",
  "received",
  "replied",
  "response_received",
  "sent",
  "successful"
]);
const VERIFIED_COMMUNICATION_ATTEMPT_STATES = new Set([
  "attempted",
  "failed",
  "left_message",
  "missed",
  "no_answer",
  "undeliverable",
  "voicemail"
]);
const VERIFIED_OPERATIONAL_KINDS = new Set([
  "appointment_completed",
  "appointment_rescheduled",
  "appointment_scheduled",
  "carrier_document",
  "claim_filed",
  "claim_result",
  "claim_update",
  "document_received",
  "document_uploaded",
  "estimate_revised",
  "inspection_completed",
  "inspection_rescheduled",
  "inspection_scheduled",
  "note",
  "note_added",
  "payment_follow_up",
  "settlement_received",
  "status_change",
  "status_update",
  "supplement_submitted",
  "workflow_status_change"
]);
const VERIFIED_OPERATIONAL_KIND_STATES = new Set([
  "appointment:completed",
  "appointment:rescheduled",
  "appointment:scheduled",
  "claim:filed",
  "claim:updated",
  "document:received",
  "document:uploaded",
  "estimate:revised",
  "inspection:completed",
  "inspection:rescheduled",
  "inspection:scheduled",
  "payment:follow_up",
  "settlement:received",
  "supplement:submitted"
]);
const EXPLICIT_NOISE_KINDS = new Set([
  "audit",
  "automation",
  "automated",
  "import",
  "integration",
  "reminder",
  "sync",
  "system",
  "system_sync"
]);
const EXPLICIT_NOISE_STATES = new Set([
  "automated",
  "automation",
  "system_generated"
]);
const UNSUPPORTED_ACTIVITY_STATES = new Set([
  "created",
  "draft",
  "opened",
  "pending",
  "queued",
  "scheduled",
  "viewed"
]);
const ESTIMATING_STATUS_CODES = new Set(
  HCN_MANAGEMENT_ESTIMATING_STATUS_CODES
);
const WORKFLOW_SCOPES = new Set(["all_active", "estimating_board"]);

export function mapManagementJobNimbusEnvelope(input, {
  adjusters,
  workflowScope = "all_active"
} = {}) {
  const configured = normalizeAdjusters(adjusters);
  const normalizedWorkflowScope = normalizeWorkflowScope(workflowScope);
  const freshness = normalizeFreshness(input);
  requireComplete(input, "contacts");
  requireComplete(input, "activities");
  requireComplete(input, "tasks");

  const contacts = boundedArray(
    input?.contacts,
    "contacts",
    HCN_MANAGEMENT_PROVIDER_LIMITS.maximumContacts
  );
  const activities = boundedArray(
    input?.activities,
    "activities",
    HCN_MANAGEMENT_PROVIDER_LIMITS.maximumActivities
  );
  const tasks = boundedArray(
    input?.tasks,
    "tasks",
    HCN_MANAGEMENT_PROVIDER_LIMITS.maximumTasks
  );

  const files = [];
  const providerIds = new Set();
  const excluded = {
    inactive: 0,
    nonInsurance: 0,
    unconfiguredOwner: 0,
    ambiguousOwner: 0,
    outsideWorkflowStatus: 0
  };

  for (const contact of contacts) {
    if (!isPlainObject(contact)) fail("invalid JobNimbus contact");
    if (!isInsuranceFile(contact)) {
      excluded.nonInsurance += 1;
      continue;
    }
    if (!isActiveFile(contact)) {
      excluded.inactive += 1;
      continue;
    }
    const matchingOwners = configured.filter((adjuster) =>
      assignmentOwnerIds(contact).includes(adjuster.ownerId)
    );
    if (matchingOwners.length === 0) {
      excluded.unconfiguredOwner += 1;
      continue;
    }
    if (matchingOwners.length !== 1) {
      excluded.ambiguousOwner += 1;
      continue;
    }

    const statusCode =
      code(field(contact, ["status_name", "statusName", "status"]))
      ?? "unknown";
    if (
      normalizedWorkflowScope === "estimating_board"
      && !ESTIMATING_STATUS_CODES.has(statusCode)
    ) {
      excluded.outsideWorkflowStatus += 1;
      continue;
    }

    const providerFileId = providerId(
      field(contact, ["jnid", "id", "contact_id", "contactId"]),
      "file"
    );
    if (providerIds.has(providerFileId)) {
      fail("duplicate JobNimbus file");
    }
    providerIds.add(providerFileId);
    const jobNumber = boundedText(
      field(contact, [
        "number",
        "recid",
        "job_number",
        "jobNumber",
        "file_number",
        "fileNumber"
      ]),
      64
    );
    if (!SAFE_JOB_NUMBER.test(jobNumber)) {
      fail("invalid JobNimbus file number");
    }
    const updatedAt = providerTimestamp(
      field(contact, ["date_updated", "updated_at", "updatedAt"])
    );
    if (!updatedAt) fail("invalid JobNimbus file update time");
    const activeSince = providerTimestamp(
      field(contact, ["date_created", "created_at", "createdAt"])
    );
    if (!activeSince) fail("invalid JobNimbus file creation time");
    files.push({
      providerFileId,
      jobNumber,
      displayName: contactDisplayName(contact),
      statusCode,
      stageCode:
        code(
          field(contact, [
            "stage_name",
            "stageName",
            "workflow_stage_name",
            "workflowStageName"
          ])
        ) ?? "unknown",
      activeSince,
      updatedAt,
      assignedAdjusterId: matchingOwners[0].ownerId,
      assignedAdjusterName: matchingOwners[0].displayName
    });
  }

  const events = [];
  const openTasks = [];
  const seenEvidence = new Set();
  let ignoredUnrelatedActivities = 0;
  let ignoredUnrelatedTasks = 0;
  let ambiguousLinks = 0;

  for (const activity of activities) {
    if (!isPlainObject(activity)) fail("invalid JobNimbus activity");
    const links = relatedFileIds(activity, providerIds);
    if (links.length === 0) {
      ignoredUnrelatedActivities += 1;
      continue;
    }
    if (links.length !== 1) {
      ambiguousLinks += 1;
      continue;
    }
    const event = mapActivity(activity, links[0], configured);
    if (!event) fail("invalid JobNimbus activity");
    assertUniqueEvidence(event.evidenceId, seenEvidence);
    events.push(event);
  }

  for (const task of tasks) {
    if (!isPlainObject(task)) fail("invalid JobNimbus task");
    const links = relatedFileIds(task, providerIds);
    if (links.length === 0) {
      ignoredUnrelatedTasks += 1;
      continue;
    }
    if (links.length !== 1) {
      ambiguousLinks += 1;
      continue;
    }
    const mapped = mapTask(task, links[0], configured);
    if (!mapped) fail("invalid JobNimbus task");
    assertUniqueEvidence(mapped.evidenceId, seenEvidence);
    if (mapped.event) events.push(mapped.event);
    if (mapped.openTask) openTasks.push(mapped.openTask);
  }

  return immutableCopy({
    status: "ok",
    ...freshness,
    data: {
      complete: true,
      files,
      events,
      openTasks,
      excluded,
      diagnostics: {
        ignoredUnrelatedActivities,
        ignoredUnrelatedTasks,
        ambiguousLinks
      }
    }
  });
}

function normalizeWorkflowScope(value) {
  if (!WORKFLOW_SCOPES.has(value)) {
    fail("invalid management workflow scope");
  }
  return value;
}

function mapActivity(activity, providerFileId, adjusters) {
  const evidenceId = providerId(
    field(activity, ["jnid", "id", "activity_id", "activityId"]),
    "activity"
  );
  const occurredAt = providerTimestamp(
    field(activity, [
      "date_created",
      "created_at",
      "createdAt",
      "occurred_at",
      "occurredAt"
    ])
  );
  if (!occurredAt) return null;
  const rawKind = boundedText(
    field(activity, [
      "record_type_name",
      "recordTypeName",
      "activity_type",
      "activityType",
      "type"
    ]),
    120
  );
  const rawState = boundedText(
    field(activity, ["status_name", "statusName", "state", "status"]),
    120
  );
  const kind = code(rawKind) ?? "activity";
  const state = code(rawState) ?? "recorded";
  const actorAdjusterId = exactActorAdjusterId(activity, adjusters);

  return {
    evidenceId,
    providerFileId,
    source: "jobnimbus",
    kind,
    state,
    occurredAt,
    actorAdjusterId,
    classification: classifyActivity(kind, state)
  };
}

function mapTask(task, providerFileId, adjusters) {
  const evidenceId = providerId(
    field(task, ["jnid", "id", "task_id", "taskId"]),
    "task"
  );
  const completed = [
    task.is_completed,
    task.isCompleted,
    task.completed
  ].some((value) => value === true);
  const cancelled = [
    task.is_cancelled,
    task.isCancelled,
    task.cancelled
  ].some((value) => value === true);
  const occurredAt = providerTimestamp(
    field(task, [
      "date_updated",
      "updated_at",
      "updatedAt",
      "date_created",
      "created_at",
      "createdAt"
    ])
  );
  const dueAt = nullableProviderTimestamp(
    field(task, [
      "date_start",
      "date_end",
      "due_at",
      "dueAt",
      "due_date",
      "dueDate"
    ])
  );
  if (!occurredAt) return null;
  const actorAdjusterId = exactActorAdjusterId(task, adjusters);
  return {
    evidenceId,
    // JobNimbus task dates are not yet proven to be completion timestamps.
    // A completed task therefore cannot reset a management activity gap.
    event: null,
    openTask:
      completed || cancelled
        ? null
        : {
            evidenceId,
            providerFileId,
            dueAt,
            assignedAdjusterId: actorAdjusterId,
            priority:
              code(
                field(task, [
                  "priority_name",
                  "priorityName",
                  "priority"
                ])
              ) ?? "normal"
          }
  };
}

function classifyActivity(kind, state) {
  if (
    EXPLICIT_NOISE_KINDS.has(kind)
    || EXPLICIT_NOISE_STATES.has(state)
  ) {
    return "noise";
  }
  if (VERIFIED_COMMUNICATION_KINDS.has(kind)) {
    if (VERIFIED_COMMUNICATION_SUCCESS_STATES.has(state)) {
      return "successful_communication";
    }
    if (VERIFIED_COMMUNICATION_ATTEMPT_STATES.has(state)) {
      return "contact_attempt";
    }
    return "unsupported";
  }
  if (VERIFIED_OPERATIONAL_KIND_STATES.has(`${kind}:${state}`)) {
    return "operational";
  }
  if (UNSUPPORTED_ACTIVITY_STATES.has(state)) return "unsupported";
  return VERIFIED_OPERATIONAL_KINDS.has(kind)
    ? "operational"
    : "unsupported";
}

function exactActorAdjusterId(record, adjusters) {
  const matches = adjusters.filter((adjuster) =>
    actorOwnerIds(record).includes(adjuster.ownerId)
  );
  return matches.length === 1 ? matches[0].ownerId : null;
}

function relatedFileIds(record, eligibleIds) {
  const ids = [];
  for (const key of [
    "primary",
    "related",
    "customer",
    "contact",
    "parent"
  ]) {
    collectIds(record?.[key], ids);
  }
  return [...new Set(ids.map(String).filter((id) => eligibleIds.has(id)))];
}

function normalizeAdjusters(value) {
  if (!Array.isArray(value) || value.length !== 3) {
    fail("exactly three management adjusters are required");
  }
  const adjusters = value.map((candidate) => {
    if (!isPlainObject(candidate)) fail("invalid management adjuster");
    return {
      ownerId: providerId(candidate.ownerId, "adjuster owner"),
      displayName: boundedText(candidate.displayName, 80)
    };
  });
  if (
    new Set(adjusters.map((item) => item.ownerId)).size !== adjusters.length
  ) {
    fail("duplicate management adjuster owner");
  }
  return adjusters;
}

function normalizeFreshness(input) {
  const asOf = utcTimestamp(input?.asOf, "asOf");
  const checkedAt = utcTimestamp(input?.checkedAt, "checkedAt");
  const validUntil = utcTimestamp(input?.validUntil, "validUntil");
  if (
    Date.parse(asOf) > Date.parse(checkedAt)
    || Date.parse(checkedAt) > Date.parse(validUntil)
  ) {
    fail("invalid management evidence chronology");
  }
  return { asOf, checkedAt, validUntil };
}

function requireComplete(input, collection) {
  if (input?.[`${collection}Complete`] !== true) {
    fail(`JobNimbus ${collection} pagination is incomplete`);
  }
}

function boundedArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(`JobNimbus ${label} exceed the management read bound`);
  }
  return value;
}

function isInsuranceFile(contact) {
  return String(
    field(contact, [
      "record_type_name",
      "recordTypeName",
      "file_type_name",
      "fileTypeName"
    ]) ?? ""
  ).trim().toLocaleLowerCase("en-US") === "insurance";
}

function isActiveFile(contact) {
  const activeKeys = ["is_active", "isActive", "active"];
  if (
    !activeKeys.some(
      (key) =>
        Object.prototype.hasOwnProperty.call(contact, key)
        && contact[key] === true
    )
  ) {
    return false;
  }
  if (activeKeys.some((key) => contact[key] === false)) return false;
  return ![
    "is_archived",
    "isArchived",
    "archived",
    "is_closed",
    "isClosed",
    "closed"
  ].some((key) => contact[key] === true);
}

function assignmentOwnerIds(record) {
  return referencedOwnerIds(record, [
    "owners",
    "owner_ids",
    "ownerIds",
    "assigned_to",
    "assignedTo",
    "assignees"
  ]);
}

function actorOwnerIds(record) {
  return referencedOwnerIds(record, [
    "owners",
    "owner_ids",
    "ownerIds",
    "assigned_to",
    "assignedTo",
    "assignees",
    "created_by",
    "createdBy",
    "updated_by",
    "updatedBy"
  ]);
}

function referencedOwnerIds(record, fields) {
  const ids = [];
  for (const key of fields) {
    collectIds(record?.[key], ids);
  }
  return [...new Set(ids.map(String))];
}

function collectIds(value, ids) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "string" || typeof value === "number") {
    ids.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectIds(item, ids));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of ["id", "jnid", "user_id", "userId", "owner_id", "ownerId"]) {
    if (value[key] !== undefined && value[key] !== null) {
      ids.push(String(value[key]));
    }
  }
}

function contactDisplayName(contact) {
  const explicit = boundedText(
    field(contact, ["display_name", "displayName", "name"]),
    120
  );
  if (explicit) return explicit;
  return [
    boundedText(field(contact, ["first_name", "firstName"]), 60),
    boundedText(field(contact, ["last_name", "lastName"]), 60)
  ].filter(Boolean).join(" ") || "Unnamed file";
}

function field(record, keys) {
  if (!isPlainObject(record)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function providerId(value, label) {
  const result =
    typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  if (!PROVIDER_ID.test(result)) fail(`invalid ${label} id`);
  return result;
}

function providerTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  let milliseconds;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value > 10_000_000_000 ? value : value * 1000;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    milliseconds = number > 10_000_000_000 ? number : number * 1000;
  } else if (typeof value === "string") {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function nullableProviderTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  return providerTimestamp(value);
}

function utcTimestamp(value, label) {
  if (
    typeof value !== "string"
    || !ISO_UTC.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail(`invalid ${label}`);
  }
  return value;
}

function code(value) {
  const result = String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return result && SAFE_CODE.test(result) ? result : null;
}

function boundedText(value, maximumCharacters) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    fail("invalid provider text");
  }
  const result = String(value).trim().replace(/ +/g, " ");
  if (
    Array.from(result).length > maximumCharacters
    || /[\x00-\x1f\x7f]/.test(result)
  ) {
    fail("invalid provider text");
  }
  return result;
}

function assertUniqueEvidence(id, seen) {
  if (seen.has(id)) fail("duplicate JobNimbus evidence");
  seen.add(id);
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

function fail(message) {
  const error = new Error(message);
  error.name = "HcnManagementProviderError";
  error.statusCode = 502;
  throw error;
}
