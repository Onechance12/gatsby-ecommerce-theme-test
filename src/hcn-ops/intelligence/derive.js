import {
  ATTEMPT_ONLY_CODES,
  DOCUMENT_CODES,
  FACT_CODES,
  FILE_INTELLIGENCE_SCHEMA,
  MILLISECONDS_PER_DAY,
  OPERATIONAL_ACTIVITY_CODES,
  SOURCE_NAMES,
  SUCCESSFUL_CONTACT_CODES
} from "./constants.js";
import { immutableCopy, normalizeFileEvidence } from "./contracts.js";

const SUCCESSFUL_CONTACT = new Set(SUCCESSFUL_CONTACT_CODES);
const OPERATIONAL_ACTIVITY = new Set(OPERATIONAL_ACTIVITY_CODES);
const ATTEMPT_ONLY = new Set(ATTEMPT_ONLY_CODES);
const CORE_OPERATIONAL_SOURCES = new Set([
  "jobnimbus",
  "gmail",
  "quo"
]);

const REQUIRED_FACTS_BY_STAGE = Object.freeze({
  intake: Object.freeze([
    "carrier",
    "policy_identifier",
    "carrier_contact",
    "date_of_loss",
    "damage_facts"
  ]),
  claim_readiness: Object.freeze([
    "carrier",
    "policy_identifier",
    "carrier_contact",
    "date_of_loss",
    "damage_facts"
  ]),
  claim_filed: Object.freeze(["carrier", "claim_identifier"]),
  inspection_scheduling: Object.freeze([
    "claim_identifier",
    "carrier_contact"
  ]),
  inspection_scheduled: Object.freeze([
    "claim_identifier",
    "inspection_appointment",
    "homeowner_confirmation"
  ]),
  adjustment: Object.freeze(["claim_identifier"]),
  estimate: Object.freeze(["claim_identifier", "damage_facts"]),
  supplement: Object.freeze(["claim_identifier"]),
  settlement_review: Object.freeze(["settlement_status"]),
  payment_collection: Object.freeze(["settlement_status"]),
  closed: Object.freeze([]),
  unknown: Object.freeze([])
});

const REQUIRED_DOCUMENTS_BY_STAGE = Object.freeze({
  intake: Object.freeze([
    "policy_declaration",
    "authorization_lor",
    "damage_evidence"
  ]),
  claim_readiness: Object.freeze([
    "policy_declaration",
    "authorization_lor",
    "damage_evidence"
  ]),
  claim_filed: Object.freeze([]),
  inspection_scheduling: Object.freeze([]),
  inspection_scheduled: Object.freeze([]),
  adjustment: Object.freeze(["damage_evidence"]),
  estimate: Object.freeze(["damage_evidence"]),
  supplement: Object.freeze(["estimate", "carrier_scope"]),
  settlement_review: Object.freeze(["settlement_document"]),
  payment_collection: Object.freeze(["settlement_document"]),
  closed: Object.freeze([]),
  unknown: Object.freeze([])
});

/**
 * Derive an immutable, evidence-backed operational state for one exact file.
 *
 * This function is pure and performs no reads or writes. Only evidence from a
 * source whose effective status is fresh may establish a current file fact.
 * Stale, unavailable, unsupported, and unknown source evidence remains visible
 * as unsupported evidence but cannot satisfy readiness.
 */
export function deriveFileState(input) {
  const evidence = normalizeFileEvidence(input);
  const sourceMap = new Map(
    evidence.sources.map((source) => [source.source, source])
  );
  const authoritativeMetadataUsable =
    sourceMap.get("jobnimbus")?.status === "fresh";
  const activeSince = authoritativeMetadataUsable
    ? evidence.activeSince
    : null;
  const activeSinceEvidenceRef = authoritativeMetadataUsable
    ? evidence.activeSinceEvidenceRef
    : null;
  const ownerRef = authoritativeMetadataUsable ? evidence.ownerRef : null;
  const ownerEvidenceRef = authoritativeMetadataUsable
    ? evidence.ownerEvidenceRef
    : null;
  const conflicts = [];
  const currentStage = deriveCurrentStage(evidence, conflicts);
  const factIndex = deriveFactIndex(evidence, conflicts);
  const documentIndex = deriveDocumentIndex(evidence, conflicts);
  const lastMeaningfulActivity = latestEvent(
    evidence.events,
    (event) =>
      event.usable &&
      (SUCCESSFUL_CONTACT.has(event.eventCode) ||
        OPERATIONAL_ACTIVITY.has(event.eventCode))
  );
  const lastMeaningfulContact = latestEvent(
    evidence.events,
    (event) => event.usable && SUCCESSFUL_CONTACT.has(event.eventCode)
  );
  const openPromises = deriveOpenPromises(evidence);
  const overdueTasks = deriveOverdueTasks(evidence);
  const sourceCompleteness = deriveSourceCompleteness(sourceMap);
  const unsupportedEvidence = deriveUnsupportedEvidence(evidence, sourceMap);
  const missingFacts = deriveMissingFacts(
    currentStage.code,
    ownerRef,
    factIndex
  );
  const missingDocuments = deriveMissingDocuments(
    currentStage.code,
    documentIndex
  );
  const nextRequiredActions = deriveNextActions({
    generatedAt: evidence.generatedAt,
    sourceCompleteness,
    conflicts,
    missingFacts,
    missingDocuments,
    overdueTasks,
    openPromises,
    documents: documentIndex
  });
  const urgency = deriveUrgency({
    generatedAt: evidence.generatedAt,
    conflicts,
    sourceCompleteness,
    overdueTasks,
    openPromises,
    missingFacts,
    missingDocuments
  });
  const confidence = deriveConfidence({
    ownerRef,
    currentStage,
    conflicts,
    sourceCompleteness
  });

  return immutableCopy({
    schemaVersion: FILE_INTELLIGENCE_SCHEMA,
    generatedAt: evidence.generatedAt,
    fileRef: evidence.fileRef,
    fileStatus: evidence.fileStatus,
    activeSince,
    activeSinceEvidenceRef,
    ownerRef,
    ownerEvidenceRef,
    currentStage,
    lastMeaningfulActivity,
    lastMeaningfulContact,
    openPromises,
    missingFacts,
    missingDocuments,
    overdueTasks,
    nextRequiredActions,
    urgency,
    confidence,
    conflicts: sortConflicts(conflicts),
    sourceCompleteness,
    unsupportedEvidence,
    facts: factIndex,
    documents: documentIndex,
    communicationHealth: deriveCommunicationHealth(evidence, sourceMap)
  });
}

function deriveCurrentStage(evidence, conflicts) {
  const current = evidence.stages.filter(
    (stage) => stage.usable && stage.state === "current"
  );
  const authoritative = current.filter(
    (stage) => stage.source === "jobnimbus"
  );
  const authoritativeCodes = unique(authoritative.map(({ stageCode }) => stageCode));

  if (authoritativeCodes.length > 1) {
    conflicts.push({
      conflictCode: "authoritative_stage_conflict",
      fieldCode: "current_stage",
      evidenceRefs: sortedRefs(authoritative),
      requiresManualReview: true
    });
    return {
      code: "unknown",
      state: "conflicted",
      source: "jobnimbus",
      evidenceRefs: sortedRefs(authoritative)
    };
  }

  if (authoritativeCodes.length === 0) {
    const unsupportedJobNimbusRefs = evidence.stages
      .filter(
        (stage) =>
          stage.source === "jobnimbus" && stage.state === "current"
      )
      .map(({ evidenceRef }) => evidenceRef);
    conflicts.push({
      conflictCode: "authoritative_stage_missing",
      fieldCode: "current_stage",
      evidenceRefs: [...unsupportedJobNimbusRefs].sort(),
      requiresManualReview: true
    });
    return {
      code: "unknown",
      state: "unknown",
      source: null,
      evidenceRefs: [...unsupportedJobNimbusRefs].sort()
    };
  }

  const code = authoritativeCodes[0];
  const supporting = current.filter((stage) => stage.source !== "jobnimbus");
  const disagreeing = supporting.filter((stage) => stage.stageCode !== code);
  if (disagreeing.length > 0) {
    conflicts.push({
      conflictCode: "supporting_stage_conflict",
      fieldCode: "current_stage",
      evidenceRefs: sortedRefs([...authoritative, ...disagreeing]),
      requiresManualReview: true
    });
  }
  return {
    code,
    state: disagreeing.length > 0 ? "authoritative_with_conflict" : "confirmed",
    source: "jobnimbus",
    evidenceRefs: sortedRefs(authoritative)
  };
}

function deriveFactIndex(evidence, conflicts) {
  return FACT_CODES.map((factCode) => {
    const usable = evidence.facts.filter(
      (fact) => fact.usable && fact.factCode === factCode
    );
    const confirmed = usable.filter((fact) => fact.state === "confirmed");
    const distinctValues = unique(confirmed.map(({ valueRef }) => valueRef));
    const absent = usable.filter((fact) => fact.state === "absent");
    const disputed = usable.filter((fact) => fact.state === "disputed");
    const contradictory =
      distinctValues.length > 1 ||
      (confirmed.length > 0 && absent.length > 0) ||
      disputed.length > 0;
    if (contradictory) {
      conflicts.push({
        conflictCode: "fact_conflict",
        fieldCode: factCode,
        evidenceRefs: sortedRefs([...confirmed, ...absent, ...disputed]),
        requiresManualReview: true
      });
    }

    let state = "unknown";
    let valueRef = null;
    if (contradictory) {
      state = "disputed";
    } else if (distinctValues.length === 1) {
      state = "confirmed";
      valueRef = distinctValues[0];
    } else if (absent.length > 0) {
      state = "absent";
    } else if (
      usable.length > 0 &&
      usable.every((fact) => fact.state === "not_applicable")
    ) {
      state = "not_applicable";
    }

    return {
      factCode,
      state,
      valueRef,
      evidenceRefs: sortedRefs(usable)
    };
  });
}

function deriveDocumentIndex(evidence, conflicts) {
  return DOCUMENT_CODES.map((documentCode) => {
    const usable = evidence.documents.filter(
      (document) =>
        document.usable && document.documentCode === documentCode
    );
    const present = usable.filter((document) => document.state === "present");
    const absent = usable.filter((document) => document.state === "absent");
    const contradictory = present.length > 0 && absent.length > 0;
    if (contradictory) {
      conflicts.push({
        conflictCode: "document_presence_conflict",
        fieldCode: documentCode,
        evidenceRefs: sortedRefs([...present, ...absent]),
        requiresManualReview: true
      });
    }
    let state = "unknown";
    if (contradictory) state = "disputed";
    else if (present.length > 0) state = "present";
    else if (absent.length > 0) state = "absent";
    else if (
      usable.length > 0 &&
      usable.every((document) => document.state === "not_applicable")
    ) {
      state = "not_applicable";
    }
    const reviewRequired = present.some((document) =>
      ["needs_review", "in_review", "unknown"].includes(document.reviewState)
    );
    return {
      documentCode,
      state,
      reviewRequired,
      evidenceRefs: sortedRefs(usable)
    };
  });
}

function latestEvent(events, predicate) {
  const event = events.find(predicate);
  if (!event) return null;
  return {
    eventCode: event.eventCode,
    occurredAt: event.occurredAt,
    source: event.source,
    evidenceRef: event.evidenceRef
  };
}

function deriveOpenPromises(evidence) {
  return evidence.promises
    .filter((promise) => promise.usable && promise.state === "open")
    .map((promise) => ({
      promiseCode: promise.promiseCode,
      ownerRef: promise.ownerRef,
      madeAt: promise.madeAt,
      dueAt: promise.dueAt,
      overdue:
        promise.dueAt !== null &&
        Date.parse(promise.dueAt) < Date.parse(evidence.generatedAt),
      source: promise.source,
      evidenceRef: promise.evidenceRef
    }))
    .sort(compareDueThenRef);
}

function deriveOverdueTasks(evidence) {
  return evidence.tasks
    .filter(
      (task) =>
        task.usable &&
        ["open", "blocked"].includes(task.status) &&
        task.dueAt !== null &&
        Date.parse(task.dueAt) < Date.parse(evidence.generatedAt)
    )
    .map((task) => ({
      taskCode: task.taskCode,
      status: task.status,
      priority: task.priority,
      ownerRef: task.ownerRef,
      dueAt: task.dueAt,
      source: task.source,
      evidenceRef: task.evidenceRef
    }))
    .sort(compareDueThenRef);
}

function deriveMissingFacts(stageCode, ownerRef, factIndex) {
  const result = [];
  if (ownerRef === null) {
    result.push({
      factCode: "owner_assignment",
      state: "unknown",
      evidenceRefs: []
    });
  }
  if (stageCode === "unknown") {
    result.push({
      factCode: "current_stage",
      state: "unknown",
      evidenceRefs: []
    });
  }
  for (const factCode of REQUIRED_FACTS_BY_STAGE[stageCode] ?? []) {
    const fact = readIndex(factIndex, "factCode", factCode);
    if (fact.state !== "confirmed") {
      result.push({
        factCode,
        state: fact.state,
        evidenceRefs: fact.evidenceRefs
      });
    }
  }
  return result;
}

function deriveMissingDocuments(stageCode, documentIndex) {
  return (REQUIRED_DOCUMENTS_BY_STAGE[stageCode] ?? [])
    .map((documentCode) =>
      readIndex(documentIndex, "documentCode", documentCode)
    )
    .filter((document) => document.state !== "present")
    .map((document) => ({
      documentCode: document.documentCode,
      state: document.state,
      evidenceRefs: document.evidenceRefs
    }));
}

function deriveSourceCompleteness(sourceMap) {
  const sources = SOURCE_NAMES.map((source) => {
    const state = sourceMap.get(source);
    return state
      ? {
          source,
          provided: true,
          status: state.status,
          completeness: state.completeness,
          asOf: state.asOf,
          checkedAt: state.checkedAt,
          validUntil: state.validUntil,
          reasonCode: state.reasonCode
        }
      : {
          source,
          provided: false,
          status: "not_provided",
          completeness: "none",
          asOf: null,
          checkedAt: null,
          validUntil: null,
          reasonCode: "source_not_provided"
        };
  });
  const jobNimbus = sources.find(({ source }) => source === "jobnimbus");
  const coreSources = sources.filter(({ source }) =>
    CORE_OPERATIONAL_SOURCES.has(source)
  );
  const status =
    jobNimbus.status !== "fresh"
      ? "insufficient"
      : coreSources.every(
            (source) =>
              source.status === "fresh" &&
              source.completeness === "complete"
          )
        ? "complete"
        : "partial";
  return {
    status,
    freshSources: sources.filter(({ status }) => status === "fresh").length,
    completeSources: sources.filter(
      ({ status, completeness }) =>
        status === "fresh" && completeness === "complete"
    ).length,
    requiredAuthorityAvailable: jobNimbus.status === "fresh",
    sources
  };
}

function deriveUnsupportedEvidence(evidence, sourceMap) {
  const records = [
    ...evidence.stages,
    ...evidence.facts,
    ...evidence.documents,
    ...evidence.events,
    ...evidence.tasks,
    ...evidence.promises
  ]
    .filter((record) => !record.usable)
    .map((record) => ({
      evidenceRef: record.evidenceRef,
      source: record.source,
      reasonCode: sourceMap.get(record.source)?.reasonCode ?? "source_not_provided"
    }));
  if (sourceMap.get("jobnimbus")?.status !== "fresh") {
    for (const evidenceRef of [
      evidence.activeSinceEvidenceRef,
      evidence.ownerEvidenceRef
    ].filter(Boolean)) {
      records.push({
        evidenceRef,
        source: "jobnimbus",
        reasonCode:
          sourceMap.get("jobnimbus")?.reasonCode ?? "source_not_provided"
      });
    }
  }
  const uniqueRecords = records
    .filter(
      (record, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.evidenceRef === record.evidenceRef &&
            candidate.source === record.source &&
            candidate.reasonCode === record.reasonCode
        ) === index
    )
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.evidenceRef.localeCompare(right.evidenceRef)
    );
  return {
    count: uniqueRecords.length,
    records: uniqueRecords
  };
}

function deriveNextActions({
  sourceCompleteness,
  conflicts,
  missingFacts,
  missingDocuments,
  overdueTasks,
  openPromises,
  documents
}) {
  const actions = [];
  for (const source of sourceCompleteness.sources) {
    const operationallyRequired =
      CORE_OPERATIONAL_SOURCES.has(source.source) || source.provided;
    if (
      operationallyRequired &&
      (source.status !== "fresh" || source.completeness !== "complete")
    ) {
      actions.push({
        actionCode:
          source.status === "unsupported"
            ? "manual_source_review"
            : "refresh_source",
        targetCode: source.source,
        urgency: source.source === "jobnimbus" ? "high" : "normal",
        dueAt: null,
        evidenceRefs: []
      });
    }
  }
  for (const conflict of conflicts) {
    actions.push({
      actionCode: "manual_conflict_review",
      targetCode: conflict.fieldCode,
      urgency: "high",
      dueAt: null,
      evidenceRefs: conflict.evidenceRefs
    });
  }
  for (const task of overdueTasks) {
    actions.push({
      actionCode: "review_overdue_task",
      targetCode: task.taskCode,
      urgency: task.priority === "urgent" ? "urgent" : "high",
      dueAt: task.dueAt,
      evidenceRefs: [task.evidenceRef]
    });
  }
  for (const promise of openPromises) {
    actions.push({
      actionCode: "fulfill_open_promise",
      targetCode: promise.promiseCode,
      urgency: promise.overdue ? "high" : "normal",
      dueAt: promise.dueAt,
      evidenceRefs: [promise.evidenceRef]
    });
  }
  for (const missing of missingFacts) {
    actions.push({
      actionCode: "obtain_required_fact",
      targetCode: missing.factCode,
      urgency: "normal",
      dueAt: null,
      evidenceRefs: missing.evidenceRefs
    });
  }
  for (const missing of missingDocuments) {
    actions.push({
      actionCode: "obtain_required_document",
      targetCode: missing.documentCode,
      urgency: "normal",
      dueAt: null,
      evidenceRefs: missing.evidenceRefs
    });
  }
  for (const document of documents.filter(
    ({ state, reviewRequired }) => state === "present" && reviewRequired
  )) {
    actions.push({
      actionCode: "review_document",
      targetCode: document.documentCode,
      urgency: "high",
      dueAt: null,
      evidenceRefs: document.evidenceRefs
    });
  }
  return deduplicateActions(actions).sort(compareActions).slice(0, 256);
}

function deriveUrgency({
  generatedAt,
  conflicts,
  sourceCompleteness,
  overdueTasks,
  openPromises,
  missingFacts,
  missingDocuments
}) {
  const reasons = [];
  const generatedAtMs = Date.parse(generatedAt);
  if (
    overdueTasks.some(
      (task) =>
        task.priority === "urgent" ||
        generatedAtMs - Date.parse(task.dueAt) >= 7 * MILLISECONDS_PER_DAY
    )
  ) {
    reasons.push("urgent_overdue_task");
  }
  if (
    openPromises.some(
      (promise) =>
        promise.dueAt &&
        generatedAtMs - Date.parse(promise.dueAt) >= 7 * MILLISECONDS_PER_DAY
    )
  ) {
    reasons.push("severely_overdue_promise");
  }
  if (conflicts.length > 0) reasons.push("material_conflict");
  if (sourceCompleteness.status === "insufficient") {
    reasons.push("authoritative_source_insufficient");
  }
  if (overdueTasks.length > 0) reasons.push("overdue_task");
  if (openPromises.some(({ overdue }) => overdue)) {
    reasons.push("overdue_promise");
  }
  if (missingFacts.length > 0) reasons.push("required_fact_missing");
  if (missingDocuments.length > 0) reasons.push("required_document_missing");

  let level = "low";
  if (
    reasons.includes("urgent_overdue_task") ||
    reasons.includes("severely_overdue_promise")
  ) {
    level = "urgent";
  } else if (
    reasons.some((reason) =>
      [
        "material_conflict",
        "authoritative_source_insufficient",
        "overdue_task",
        "overdue_promise"
      ].includes(reason)
    )
  ) {
    level = "high";
  } else if (reasons.length > 0) {
    level = "normal";
  }
  return { level, reasonCodes: [...new Set(reasons)].sort() };
}

function deriveConfidence({
  ownerRef,
  currentStage,
  conflicts,
  sourceCompleteness
}) {
  const reasons = [];
  let level = "high";
  if (sourceCompleteness.status === "insufficient") {
    return {
      level: "insufficient",
      reasonCodes: ["authoritative_source_insufficient"]
    };
  }
  if (sourceCompleteness.status === "partial") {
    level = "medium";
    reasons.push("source_set_incomplete");
  }
  if (ownerRef === null) {
    level = "low";
    reasons.push("owner_unknown");
  }
  if (currentStage.code === "unknown") {
    level = "low";
    reasons.push("stage_unknown");
  }
  if (conflicts.length > 0) {
    level = "low";
    reasons.push("material_conflict");
  }
  return { level, reasonCodes: [...new Set(reasons)].sort() };
}

function deriveCommunicationHealth(evidence, sourceMap) {
  const incompleteDelivery = evidence.events
    .filter(
      (event) =>
        event.usable &&
        (ATTEMPT_ONLY.has(event.eventCode) ||
          ["failed", "unverified"].includes(event.actionState))
    )
    .map((event) => ({
      eventCode: event.eventCode,
      actionState: event.actionState,
      occurredAt: event.occurredAt,
      source: event.source,
      evidenceRef: event.evidenceRef
    }));
  const awaitingResponse = evidence.events
    .filter(
      (event) =>
        event.usable &&
        event.actionState === "awaiting_response" &&
        SUCCESSFUL_CONTACT.has(event.eventCode)
    )
    .map((event) => ({
      eventCode: event.eventCode,
      occurredAt: event.occurredAt,
      source: event.source,
      evidenceRef: event.evidenceRef
    }));
  const communicationSources = ["gmail", "quo"].map((source) => {
    const state = sourceMap.get(source);
    return {
      source,
      status: state?.status ?? "not_provided",
      completeness: state?.completeness ?? "none"
    };
  });
  return {
    incompleteDelivery,
    awaitingResponse,
    sources: communicationSources
  };
}

function readIndex(items, key, value) {
  return items.find((item) => item[key] === value);
}

function sortedRefs(records) {
  return unique(records.map(({ evidenceRef }) => evidenceRef)).sort();
}

function unique(values) {
  return [...new Set(values)];
}

function sortConflicts(conflicts) {
  return conflicts.sort(
    (left, right) =>
      left.fieldCode.localeCompare(right.fieldCode) ||
      left.conflictCode.localeCompare(right.conflictCode)
  );
}

function compareDueThenRef(left, right) {
  if (left.dueAt === null && right.dueAt !== null) return 1;
  if (left.dueAt !== null && right.dueAt === null) return -1;
  return (
    String(left.dueAt).localeCompare(String(right.dueAt)) ||
    left.evidenceRef.localeCompare(right.evidenceRef)
  );
}

function deduplicateActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = `${action.actionCode}:${action.targetCode}:${action.dueAt ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareActions(left, right) {
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
  return (
    rank[left.urgency] - rank[right.urgency] ||
    String(left.dueAt ?? "").localeCompare(String(right.dueAt ?? "")) ||
    left.actionCode.localeCompare(right.actionCode) ||
    left.targetCode.localeCompare(right.targetCode)
  );
}
