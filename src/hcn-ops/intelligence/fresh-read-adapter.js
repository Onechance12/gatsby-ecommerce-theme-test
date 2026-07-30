import { lookupCarrier } from "../../claim-filing-core/carrierDirectory.js";

/**
 * Convert one already-minimized HCN fresh file review into the strict coded
 * intelligence contract. This adapter does not persist, fetch, or execute.
 * Raw presentation text is used only to classify closed-vocabulary evidence.
 */
export function adaptFreshReviewToFileEvidence({
  review,
  ownerRef,
  ownerEvidenceRef,
  evidenceRefFor,
  valueRefFor
} = {}) {
  assertReview(review);
  assertOpaque(ownerRef, /^(?:actor|adjuster|employee)_[a-f0-9]{16,64}$/);
  assertOpaque(ownerEvidenceRef, /^ref_[a-f0-9]{16,64}$/);
  if (
    typeof evidenceRefFor !== "function"
    || typeof valueRefFor !== "function"
  ) {
    throw new TypeError("fresh review reference functions are required");
  }

  const file = review.file;
  const observedAt = file.updatedAt;
  const sources = Object.values(review.sources)
    .map(normalizeSource)
    .sort((left, right) => left.source.localeCompare(right.source));
  const stageCode = normalizeStageCode(file.stageCode);
  const facts = mapFacts({
    file,
    observedAt,
    evidenceRefFor,
    valueRefFor
  });
  const documents = review.recent.documents
    .map(mapDocument)
    .filter(Boolean);
  const events = [
    ...review.recent.activities.map((item) =>
      mapActivity(item, ownerRef)
    ),
    ...review.recent.gmail.map(mapGmailEvent),
    ...review.recent.quo.map(mapQuoEvent)
  ].filter(Boolean);
  const jobNimbusSource = sources.find(
    ({ source }) => source === "jobnimbus"
  );

  return deepFreeze({
    generatedAt: review.generatedAt,
    fileRef: file.fileRef,
    fileStatus: "active",
    activeSince: null,
    activeSinceEvidenceRef: null,
    ownerRef,
    ownerEvidenceRef,
    sources,
    stages: [{
      stageCode,
      state: "current",
      source: "jobnimbus",
      evidenceRef: evidenceRefFor("stage", stageCode),
      observedAt
    }],
    facts,
    documents,
    events,
    tasks: review.recent.tasks.map((task) => ({
      taskCode: normalizeTaskCode(task.kind),
      status: normalizeTaskStatus(task.status),
      priority: normalizePriority(task.priority),
      ownerRef: isAssignedEmployeeRole(task.assignedRole)
        ? ownerRef
        : null,
      dueAt: task.dueAt,
      source: "jobnimbus",
      evidenceRef: task.reference,
      observedAt: jobNimbusSource?.checkedAt ?? review.generatedAt
    })),
    promises: []
  });
}

function mapFacts({
  file,
  observedAt,
  evidenceRefFor,
  valueRefFor
}) {
  const facts = [];
  pushFact(facts, {
    code: "carrier",
    value: file.insurance?.carrierName,
    explicitlyMissing: !file.insurance?.carrierName,
    observedAt,
    evidenceRefFor,
    valueRefFor
  });
  pushFact(facts, {
    code: "policy_identifier",
    value: file.insurance?.policyNumber,
    explicitlyMissing: file.missing?.policyNumber === true,
    observedAt,
    evidenceRefFor,
    valueRefFor
  });
  pushFact(facts, {
    code: "date_of_loss",
    value: file.insurance?.dateOfLoss,
    explicitlyMissing: file.missing?.dateOfLoss === true,
    observedAt,
    evidenceRefFor,
    valueRefFor
  });
  pushFact(facts, {
    code: "claim_identifier",
    value: file.insurance?.claimNumber,
    explicitlyMissing: file.missing?.claimNumber === true,
    observedAt,
    evidenceRefFor,
    valueRefFor
  });
  const adjusterContactValue = [
    file.adjuster?.email,
    file.adjuster?.phone
  ].filter(Boolean).join("|");
  const carrierDirectoryEntry = lookupCarrier(
    file.insurance?.carrierName,
    file.insurance?.policyNumber
  );
  const carrierContactValue = carrierDirectoryEntry?.filingPhone ?? "";
  pushFact(facts, {
    code: "adjuster_contact",
    value: adjusterContactValue,
    explicitlyMissing: !adjusterContactValue,
    observedAt,
    evidenceRefFor,
    valueRefFor
  });
  pushFact(facts, {
    code: "carrier_contact",
    value: carrierContactValue,
    explicitlyMissing: !carrierContactValue,
    observedAt,
    evidenceRefFor,
    valueRefFor
  });
  pushFact(facts, {
    code: "damage_facts",
    value: file.insurance?.damageFactsPresent === true
      ? "structured_damage_facts_present"
      : null,
    explicitlyMissing: false,
    observedAt,
    evidenceRefFor,
    valueRefFor
  });
  if (file.nextAppointmentAt) {
    pushFact(facts, {
      code: "inspection_appointment",
      value: file.nextAppointmentAt,
      explicitlyMissing: false,
      observedAt,
      evidenceRefFor,
      valueRefFor
    });
  }
  return facts;
}

function pushFact(facts, {
  code,
  value,
  explicitlyMissing,
  observedAt,
  evidenceRefFor,
  valueRefFor
}) {
  const hasValue = typeof value === "string" && value.trim() !== "";
  if (!hasValue && !explicitlyMissing) return;
  facts.push({
    factCode: code,
    state: hasValue ? "confirmed" : "absent",
    valueRef: hasValue ? valueRefFor(code, value) : null,
    source: "jobnimbus",
    evidenceRef: evidenceRefFor("fact", code),
    observedAt
  });
}

function mapDocument(document) {
  const documentCode = normalizeDocumentCode(
    document.kind,
    document.fileName
  );
  if (!documentCode) return null;
  return {
    documentCode,
    state: "present",
    reviewState: normalizeReviewState(document.reviewState),
    source: "jobnimbus",
    evidenceRef: document.reference,
    observedAt: document.createdAt
  };
}

function mapActivity(activity, ownerRef) {
  return {
    eventCode: normalizeActivityCode(activity.kind, activity.state),
    actionState: "none",
    source: "jobnimbus",
    evidenceRef: activity.reference,
    occurredAt: activity.occurredAt,
    actorRef: isAssignedEmployeeRole(activity.actorRole)
      ? ownerRef
      : null
  };
}

function mapGmailEvent(item) {
  let eventCode = "unknown";
  let actionState = "unknown";
  if (item.deliveryState === "draft") {
    eventCode = "email_draft";
    actionState = "draft";
  } else if (item.deliveryState === "failed") {
    eventCode = "email_send_failed";
    actionState = "failed";
  } else if (item.deliveryState === "received") {
    eventCode = "email_received";
    actionState =
      item.actionState === "needs_reply"
        ? "awaiting_response"
        : "none";
  } else if (item.deliveryState === "sent_verified") {
    eventCode = "email_sent_verified";
    actionState =
      item.actionState === "awaiting_response"
        ? "awaiting_response"
        : "none";
  } else if (item.direction === "outbound") {
    eventCode = "email_outbound_unverified";
    actionState = "unverified";
  }
  return {
    eventCode,
    actionState,
    source: "gmail",
    evidenceRef: item.reference,
    occurredAt: item.occurredAt,
    actorRef: null
  };
}

function mapQuoEvent(item) {
  const disposition = String(item.disposition || "");
  let eventCode = "unknown";
  let actionState = "unknown";
  if (item.actionState === "draft") {
    eventCode = item.channel === "text" ? "text_draft" : "unknown";
    actionState = item.channel === "text" ? "draft" : "unknown";
  } else if (
    item.actionState === "failed"
    || /failed|undelivered/.test(disposition)
  ) {
    eventCode =
      item.channel === "text" ? "text_failed" : "outbound_call_failed";
    actionState = "failed";
  } else if (item.channel === "text") {
    if (item.direction === "inbound") {
      eventCode = "text_received";
      actionState =
        item.actionState === "needs_reply"
          ? "awaiting_response"
          : "none";
    } else if (/delivered/.test(disposition)) {
      eventCode = "text_delivered";
      actionState =
        item.actionState === "awaiting_response"
          ? "awaiting_response"
          : "none";
    } else {
      eventCode = "text_sent_unconfirmed";
      actionState = "unverified";
    }
  } else if (item.channel === "call") {
    if (/missed/.test(disposition)) {
      eventCode = "call_missed";
      actionState = "none";
    } else if (/no_answer|no answer/.test(disposition)) {
      eventCode = "call_no_answer";
      actionState = "none";
    } else if (/completed|answered/.test(disposition)) {
      eventCode =
        item.direction === "inbound"
          ? "call_answered"
          : "call_completed";
      actionState = "none";
    }
  }
  return {
    eventCode,
    actionState,
    source: "quo",
    evidenceRef: item.reference,
    occurredAt: item.occurredAt,
    actorRef: null
  };
}

function normalizeSource(source) {
  if (!source || typeof source !== "object") {
    throw new TypeError("fresh review source is invalid");
  }
  const status =
    source.status === "fresh"
      ? "fresh"
      : source.failureCode === "source_stale"
        ? "stale"
        : "unavailable";
  return {
    source: source.source,
    status,
    completeness:
      status === "fresh" && ["complete", "partial"].includes(
        source.completeness
      )
        ? source.completeness
        : "none",
    asOf: status === "fresh" || status === "stale"
      ? source.asOf
      : null,
    checkedAt: source.checkedAt,
    validUntil: status === "fresh" || status === "stale"
      ? source.validUntil
      : null
  };
}

function normalizeStageCode(value) {
  const code = normalizedCode(value);
  if (/closed|complete/.test(code)) return "closed";
  if (/payment|collection/.test(code)) return "payment_collection";
  if (/settlement/.test(code)) return "settlement_review";
  if (/supplement/.test(code)) return "supplement";
  if (/estimate/.test(code)) return "estimate";
  if (/adjust|carrier_review|desk_adjuster/.test(code)) return "adjustment";
  if (/inspection.*scheduled/.test(code)) return "inspection_scheduled";
  if (/inspection|schedule/.test(code)) return "inspection_scheduling";
  if (/claim.*filed/.test(code)) return "claim_filed";
  if (/claim|ready.*file/.test(code)) return "claim_readiness";
  if (/intake|new/.test(code)) return "intake";
  return "unknown";
}

function normalizeActivityCode(kindValue, stateValue) {
  const kind = normalizedCode(kindValue);
  const state = normalizedCode(stateValue);
  if (/claim/.test(kind) && /filed|complete/.test(state)) {
    return "claim_filed";
  }
  if (/claim/.test(kind)) return "claim_result_recorded";
  if (/appointment|inspection/.test(kind)) {
    if (/rescheduled/.test(state)) return "appointment_rescheduled";
    if (/completed/.test(state)) return "appointment_completed";
    return "appointment_scheduled";
  }
  if (/settlement/.test(kind)) return "settlement_received";
  if (/payment/.test(kind)) return "payment_follow_up";
  if (/supplement/.test(kind)) return "supplement_submitted";
  if (/estimate/.test(kind)) return "estimate_revised";
  if (/document|file|attachment/.test(kind)) return "document_received";
  if (/status/.test(kind)) return "status_progressed";
  if (/note/.test(kind)) return "note_substantive";
  return "unknown";
}

function normalizeDocumentCode(kindValue, fileNameValue) {
  const kind = normalizedCode(kindValue);
  const fileName = normalizedCode(fileNameValue);
  if (
    /declaration|dec_page|policy/.test(kind)
    || /declaration|dec_page/.test(fileName)
  ) {
    return "policy_declaration";
  }
  if (
    /authorization|letter_of_representation|lor/.test(kind)
    || /authorization|letter_of_representation|\blor\b/.test(fileName)
  ) {
    return "authorization_lor";
  }
  if (/damage_evidence|photo_report/.test(kind)) {
    return "damage_evidence";
  }
  if (/settlement/.test(kind)) return "settlement_document";
  if (/estimate/.test(kind)) return "estimate";
  if (/scope/.test(kind)) return "carrier_scope";
  if (/payment/.test(kind)) return "payment_evidence";
  return null;
}

function normalizeReviewState(value) {
  const code = normalizedCode(value);
  if (/needs_review|unreviewed|review_required/.test(code)) {
    return "needs_review";
  }
  if (/in_review|reviewing/.test(code)) return "in_review";
  if (/reviewed|complete/.test(code)) return "reviewed";
  return "unknown";
}

function normalizeTaskCode(value) {
  const code = normalizedCode(value);
  if (/document/.test(code)) return "document_review";
  if (/claim/.test(code)) return "claim_filing";
  if (/inspection|appointment/.test(code)) {
    return "inspection_coordination";
  }
  if (/payment|collect/.test(code)) return "payment_collection";
  if (/adjuster/.test(code)) return "adjuster_follow_up";
  if (/carrier/.test(code)) return "carrier_follow_up";
  if (/client|homeowner|communication/.test(code)) {
    return "client_follow_up";
  }
  if (/review/.test(code)) return "file_review";
  return "other";
}

function normalizeTaskStatus(value) {
  const code = normalizedCode(value);
  if (/completed|done/.test(code)) return "completed";
  if (/cancel/.test(code)) return "cancelled";
  if (/block/.test(code)) return "blocked";
  return "open";
}

function normalizePriority(value) {
  const code = normalizedCode(value);
  if (["low", "normal", "high", "urgent"].includes(code)) return code;
  if (code === "critical") return "urgent";
  return "normal";
}

function isAssignedEmployeeRole(value) {
  return ["employee", "chance", "adjuster"].includes(
    normalizedCode(value)
  );
}

function normalizedCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function assertReview(review) {
  if (
    !review
    || typeof review !== "object"
    || review.schema !== "hcn.console.file.v1"
    || !review.file
    || !review.sources
    || !review.recent
    || !Array.isArray(review.recent.activities)
    || !Array.isArray(review.recent.tasks)
    || !Array.isArray(review.recent.documents)
    || !Array.isArray(review.recent.gmail)
    || !Array.isArray(review.recent.quo)
  ) {
    throw new TypeError("fresh HCN file review is invalid");
  }
}

function assertOpaque(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError("opaque HCN reference is invalid");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
