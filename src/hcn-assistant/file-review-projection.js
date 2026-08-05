const MODEL_FILE_REVIEW_MAX_BYTES = 24 * 1024;
const RECENT_DETAIL_LIMIT = 5;
const MAX_LANE_ITEMS = 20;

const RECENT_COLLECTION_NAMES = Object.freeze([
  "activities",
  "tasks",
  "documents",
  "gmail",
  "quo"
]);

const WORKFLOW_NAMES = Object.freeze([
  "claim_filing",
  "communications",
  "follow_up",
  "inspection_scheduling",
  "neglected_files"
]);

const WORKFLOW_METRIC_FIELDS = Object.freeze([
  "activityGapDays",
  "appointmentEvidenced",
  "awaitingResponseCount",
  "baselineAt",
  "baselineKind",
  "claimAlreadyEvidenced",
  "contactGapDays",
  "homeownerConfirmed",
  "incompleteDeliveryCount",
  "missingRequiredFactCount",
  "overduePromiseCount",
  "overdueTaskCount",
  "schedulingContactAvailable",
  "verifiedActivityGapDays",
  "verifiedContactGapDays"
]);

/**
 * Build the exact allowlisted disclosure sent to Groq after review_file.
 *
 * The full fresh review remains authoritative for deterministic intelligence,
 * source reporting, and HCN persistence. This projection keeps every coded
 * action lane and workflow conclusion while removing repeated provenance,
 * internal persistence state, and non-actionable recent detail.
 */
export function projectHcnAssistantFileReview(review) {
  if (!isRecord(review) || !isRecord(review.file)) {
    throw new TypeError("HCN assistant file review is unavailable");
  }

  const laneReferences = collectLaneReferences(review.lanes);
  const meaningfulReferences = new Set([
    optionalText(review.intelligence?.lastMeaningfulActivity?.evidenceRef, 80),
    optionalText(review.intelligence?.lastMeaningfulContact?.evidenceRef, 80)
  ].filter(Boolean));
  const preferredReferences = new Set([
    ...meaningfulReferences,
    ...laneReferences
  ]);

  const projected = {
    schema: text(review.schema, 80),
    generatedAt: optionalText(review.generatedAt, 40),
    evidenceStatus: text(review.evidenceStatus, 32),
    file: projectFile(review.file),
    sources: projectSources(review.sources),
    lanes: projectLanes(review.lanes),
    recent: {
      activities: projectRecentCollection(
        review.recent?.activities,
        projectActivity,
        preferredReferences,
        meaningfulReferences,
        "activities"
      ),
      tasks: projectRecentCollection(
        review.recent?.tasks,
        projectTask,
        preferredReferences,
        meaningfulReferences,
        "tasks"
      ),
      documents: projectRecentCollection(
        review.recent?.documents,
        projectDocument,
        preferredReferences,
        meaningfulReferences,
        "documents"
      ),
      gmail: projectRecentCollection(
        review.recent?.gmail,
        projectGmail,
        preferredReferences,
        meaningfulReferences,
        "gmail"
      ),
      quo: projectRecentCollection(
        review.recent?.quo,
        projectQuo,
        preferredReferences,
        meaningfulReferences,
        "quo"
      )
    },
    intelligence: projectIntelligence(review.intelligence),
    projection: {
      kind: "bounded_operational_review",
      recentDetailLimitPerSource: RECENT_DETAIL_LIMIT,
      effectiveRecentDetailLimitPerSource: RECENT_DETAIL_LIMIT,
      recentDetailReducedForBudget: false,
      recentSelectionOrder:
        "meaningful_then_lane_then_operational_priority_then_recent",
      tupleFields: {
        lane: ["reasonCode", "source", "at"],
        promise: ["promiseCode", "madeAt", "dueAt", "overdue", "source"],
        missingFact: ["factCode", "state"],
        missingDocument: ["documentCode", "state", "reviewRequired"],
        overdueTask: ["taskCode", "status", "priority", "dueAt", "source"],
        action: ["actionCode", "targetCode", "urgency", "dueAt", "requiresApproval"],
        conflict: ["conflictCode", "fieldCode", "requiresManualReview"],
        blocker: ["blockerCode", "targetCode"],
        communicationEvent: ["eventCode", "actionState", "occurredAt", "source"]
      },
      availableFollowUpCatalogs: {
        documents: true,
        photos: true,
        activities: false,
        tasks: false,
        gmail: false,
        quo: false
      },
      omittedInternalPersistenceState: true
    }
  };

  fitRecentDetailToReplayBudget(projected);
  const frozen = deepFreeze(projected);
  const bytes = Buffer.byteLength(JSON.stringify(frozen), "utf8");
  if (bytes > MODEL_FILE_REVIEW_MAX_BYTES) {
    throw new RangeError(
      `HCN assistant file review projection exceeds its replay budget (${bytes} bytes)`
    );
  }
  return frozen;
}

export function hcnAssistantFileReviewProjectionLimitBytes() {
  return MODEL_FILE_REVIEW_MAX_BYTES;
}

function projectFile(value) {
  const file = isRecord(value) ? value : {};
  const client = isRecord(file.client) ? file.client : {};
  const property = isRecord(file.property) ? file.property : {};
  const insurance = isRecord(file.insurance) ? file.insurance : {};
  const adjuster = isRecord(file.adjuster) ? file.adjuster : {};
  const missing = isRecord(file.missing) ? file.missing : {};
  return {
    fileRef: text(file.fileRef, 80),
    jobNumber: text(file.jobNumber, 64),
    displayName: text(file.displayName, 120),
    statusCode: text(file.statusCode, 64),
    stageCode: text(file.stageCode, 64),
    fileTypeCode: text(file.fileTypeCode, 64),
    updatedAt: optionalText(file.updatedAt, 40),
    nextAppointmentAt: optionalText(file.nextAppointmentAt, 40),
    client: {
      primaryEmail: optionalText(client.primaryEmail, 254),
      primaryPhone: optionalText(client.primaryPhone, 40)
    },
    property: {
      address: optionalText(property.address, 180)
    },
    insurance: {
      carrierName: optionalText(insurance.carrierName, 120),
      claimNumber: optionalText(insurance.claimNumber, 80),
      policyNumber: optionalText(insurance.policyNumber, 80),
      dateOfLoss: optionalText(insurance.dateOfLoss, 40),
      damageFactsPresent: insurance.damageFactsPresent === true
    },
    adjuster: {
      name: optionalText(adjuster.name, 120),
      email: optionalText(adjuster.email, 254),
      phone: optionalText(adjuster.phone, 40)
    },
    missing: {
      policyNumber: missing.policyNumber === true,
      dateOfLoss: missing.dateOfLoss === true,
      claimNumber: missing.claimNumber === true,
      adjuster: missing.adjuster === true
    }
  };
}

function projectSources(value) {
  const sources = isRecord(value) ? value : {};
  return Object.fromEntries(
    ["jobnimbus", "gmail", "quo"].map((name) => [
      name,
      projectSource(sources[name], name)
    ])
  );
}

function projectSource(value, fallbackName) {
  const source = isRecord(value) ? value : {};
  return {
    source: text(source.source || fallbackName, 32),
    status: text(source.status, 32),
    completeness: text(source.completeness, 32),
    failureCode: optionalText(source.failureCode, 64),
    asOf: optionalText(source.asOf, 40),
    checkedAt: optionalText(source.checkedAt, 40),
    validUntil: optionalText(source.validUntil, 40),
    acceptedItems: integer(source.acceptedItems),
    droppedItems: integer(source.droppedItems),
    ...(isRecord(source.collections)
      ? { collections: projectSourceCollections(source.collections) }
      : {})
  };
}

function projectSourceCollections(value) {
  return Object.fromEntries(
    ["activities", "tasks", "documents"]
      .filter((name) => isRecord(value[name]))
      .map((name) => {
        const collection = value[name];
        return [name, {
          completeness: text(collection.completeness, 32),
          limitationCode: optionalText(collection.limitationCode, 64)
        }];
      })
  );
}

function collectLaneReferences(value) {
  const lanes = isRecord(value) ? value : {};
  return new Set(
    ["priority", "today", "waiting"]
      .flatMap((name) => Array.isArray(lanes[name]) ? lanes[name] : [])
      .map((item) => optionalText(item?.reference, 80))
      .filter(Boolean)
  );
}

function projectLanes(value) {
  const lanes = isRecord(value) ? value : {};
  return Object.fromEntries(
    ["priority", "today", "waiting"].map((name) => {
      const items = Array.isArray(lanes[name])
        ? lanes[name].slice(0, MAX_LANE_ITEMS).map(projectLane)
        : [];
      return [name, items];
    })
  );
}

function projectLane(value) {
  const item = isRecord(value) ? value : {};
  return [
    text(item.reasonCode, 64),
    text(item.source, 32),
    optionalText(item.at, 40)
  ];
}

function projectRecentCollection(
  value,
  projector,
  preferredReferences,
  meaningfulReferences,
  collectionName
) {
  const items = Array.isArray(value) ? value : [];
  const ranked = items.map((item, index) => {
    const reference = optionalText(item?.reference, 80);
    return {
      item,
      index,
      meaningful: meaningfulReferences.has(reference),
      preferred: preferredReferences.has(reference),
      operationalPriority: recentOperationalPriority(item, collectionName),
      timeRank: recentTimeRank(item, collectionName)
    };
  }).sort(compareRecentRank);
  const selected = ranked.slice(0, RECENT_DETAIL_LIMIT);
  return {
    availableCount: items.length,
    returnedCount: selected.length,
    omittedCount: Math.max(0, items.length - selected.length),
    items: selected.map(({ item }) => projector(item))
  };
}

function compareRecentRank(left, right) {
  return Number(right.meaningful) - Number(left.meaningful)
    || Number(right.preferred) - Number(left.preferred)
    || right.operationalPriority - left.operationalPriority
    || right.timeRank - left.timeRank
    || left.index - right.index;
}

function recentOperationalPriority(value, collectionName) {
  const item = isRecord(value) ? value : {};
  const state = normalizedCode(item.state);
  const status = normalizedCode(item.status);
  const priority = normalizedCode(item.priority);
  const reviewState = normalizedCode(item.reviewState);
  const actionState = normalizedCode(item.actionState);
  const deliveryState = normalizedCode(item.deliveryState);
  const disposition = normalizedCode(item.disposition);

  if (collectionName === "tasks") {
    const actionable = [
      "overdue",
      "blocked",
      "open",
      "pending",
      "in_progress"
    ].includes(status);
    if (!actionable) return 0;
    return 16 + codeWeight(priority, {
      urgent: 8,
      critical: 8,
      high: 6,
      normal: 3,
      low: 1
    }) + codeWeight(status, {
      overdue: 6,
      blocked: 5,
      open: 3,
      pending: 2,
      in_progress: 2,
      complete: 0,
      completed: 0
    });
  }
  if (collectionName === "documents") {
    return codeWeight(reviewState, {
      rejected: 8,
      needs_review: 7,
      review_required: 7,
      missing: 6,
      pending: 3,
      reviewed: 0,
      accepted: 0
    });
  }
  if (collectionName === "gmail") {
    return codeWeight(actionState, {
      failed: 9,
      needs_reply: 8,
      action_required: 8,
      awaiting_response: 5,
      complete: 0
    }) + codeWeight(deliveryState, {
      failed: 8,
      bounced: 8,
      incomplete: 7,
      received: 2,
      delivered: 1
    });
  }
  if (collectionName === "quo") {
    return codeWeight(actionState, {
      failed: 9,
      needs_reply: 8,
      action_required: 8,
      awaiting_response: 5,
      complete: 0
    }) + codeWeight(disposition, {
      failed: 8,
      undelivered: 8,
      no_answer: 6,
      voicemail: 5,
      delivered: 1
    });
  }
  return codeWeight(state, {
    failed: 9,
    blocked: 8,
    needs_review: 7,
    action_required: 7,
    open: 4,
    pending: 3,
    complete: 0,
    completed: 0
  });
}

function recentTimeRank(value, collectionName) {
  const item = isRecord(value) ? value : {};
  const candidate = collectionName === "tasks"
    ? item.dueAt
    : collectionName === "documents"
      ? item.createdAt
      : item.occurredAt;
  const parsed = Date.parse(String(candidate || ""));
  if (!Number.isFinite(parsed)) return Number.NEGATIVE_INFINITY;
  // Earlier open-task deadlines are more actionable; all other collections
  // prefer the newest evidence after evidence and operational priority.
  return collectionName === "tasks" ? -parsed : parsed;
}

function normalizedCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function codeWeight(value, weights) {
  return Object.hasOwn(weights, value) ? weights[value] : 0;
}

function fitRecentDetailToReplayBudget(projected) {
  let bytes = projectionBytes(projected);
  if (bytes <= MODEL_FILE_REVIEW_MAX_BYTES) return;

  for (
    let effectiveLimit = RECENT_DETAIL_LIMIT - 1;
    effectiveLimit >= 0 && bytes > MODEL_FILE_REVIEW_MAX_BYTES;
    effectiveLimit -= 1
  ) {
    for (const name of RECENT_COLLECTION_NAMES) {
      const collection = projected.recent[name];
      if (collection.items.length <= effectiveLimit) continue;
      collection.items = collection.items.slice(0, effectiveLimit);
      collection.returnedCount = collection.items.length;
      collection.omittedCount = Math.max(
        0,
        collection.availableCount - collection.returnedCount
      );
    }
    projected.projection.effectiveRecentDetailLimitPerSource = effectiveLimit;
    projected.projection.recentDetailReducedForBudget = true;
    bytes = projectionBytes(projected);
  }
}

function projectionBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function projectActivity(value) {
  const item = isRecord(value) ? value : {};
  return {
    reference: optionalText(item.reference, 80),
    kind: text(item.kind, 64),
    state: text(item.state, 64),
    occurredAt: optionalText(item.occurredAt, 40),
    actorRole: text(item.actorRole, 64),
    label: optionalText(item.label, 160)
  };
}

function projectTask(value) {
  const item = isRecord(value) ? value : {};
  return {
    reference: optionalText(item.reference, 80),
    kind: text(item.kind, 64),
    status: text(item.status, 64),
    priority: text(item.priority, 64),
    dueAt: optionalText(item.dueAt, 40),
    assignedRole: text(item.assignedRole, 64),
    label: optionalText(item.label, 160)
  };
}

function projectDocument(value) {
  const item = isRecord(value) ? value : {};
  return {
    reference: optionalText(item.reference, 80),
    kind: text(item.kind, 64),
    reviewState: text(item.reviewState, 64),
    createdAt: optionalText(item.createdAt, 40),
    fileName: optionalText(item.fileName, 160)
  };
}

function projectGmail(value) {
  const item = isRecord(value) ? value : {};
  return {
    reference: optionalText(item.reference, 80),
    direction: text(item.direction, 32),
    occurredAt: optionalText(item.occurredAt, 40),
    hasAttachment: item.hasAttachment === true,
    deliveryState: text(item.deliveryState, 64),
    actionState: text(item.actionState, 64),
    subject: optionalText(item.subject, 160),
    snippet: optionalText(item.snippet, 200)
  };
}

function projectQuo(value) {
  const item = isRecord(value) ? value : {};
  return {
    reference: optionalText(item.reference, 80),
    channel: text(item.channel, 32),
    direction: text(item.direction, 32),
    occurredAt: optionalText(item.occurredAt, 40),
    disposition: text(item.disposition, 64),
    actionState: text(item.actionState, 64),
    preview: optionalText(item.preview, 200)
  };
}

function projectIntelligence(value) {
  if (!isRecord(value)) return null;
  const workflows = isRecord(value.workflows) ? value.workflows : {};
  return {
    schemaVersion: text(value.schemaVersion, 80),
    generatedAt: optionalText(value.generatedAt, 40),
    fileStatus: text(value.fileStatus, 32),
    activeSince: optionalText(value.activeSince, 40),
    currentStage: projectStage(value.currentStage),
    lastMeaningfulActivity: projectMeaningfulEvent(
      value.lastMeaningfulActivity
    ),
    lastMeaningfulContact: projectMeaningfulEvent(
      value.lastMeaningfulContact
    ),
    openPromises: array(value.openPromises).map(projectPromise),
    missingFacts: array(value.missingFacts).map(projectMissingFact),
    missingDocuments: array(value.missingDocuments)
      .map(projectMissingDocument),
    overdueTasks: array(value.overdueTasks).map(projectOverdueTask),
    nextRequiredActions: array(value.nextRequiredActions).map(projectAction),
    urgency: projectLevel(value.urgency),
    confidence: projectLevel(value.confidence),
    conflicts: array(value.conflicts).map(projectConflict),
    sourceCompleteness: projectSourceCompleteness(
      value.sourceCompleteness
    ),
    communicationHealth: projectCommunicationHealth(
      value.communicationHealth
    ),
    workflows: Object.fromEntries(WORKFLOW_NAMES.map((name) => [
      name,
      projectWorkflow(workflows[name], name)
    ]))
  };
}

function projectStage(value) {
  const stage = isRecord(value) ? value : {};
  return {
    code: text(stage.code, 64),
    state: text(stage.state, 64),
    source: optionalText(stage.source, 32)
  };
}

function projectMeaningfulEvent(value) {
  if (!isRecord(value)) return null;
  return {
    eventCode: text(value.eventCode, 64),
    occurredAt: optionalText(value.occurredAt, 40),
    source: text(value.source, 32)
  };
}

function projectPromise(value) {
  const item = isRecord(value) ? value : {};
  return [
    text(item.promiseCode, 64),
    optionalText(item.madeAt, 40),
    optionalText(item.dueAt, 40),
    item.overdue === true,
    text(item.source, 32)
  ];
}

function projectMissingFact(value) {
  const item = isRecord(value) ? value : {};
  return [text(item.factCode, 64), text(item.state, 32)];
}

function projectMissingDocument(value) {
  const item = isRecord(value) ? value : {};
  return [text(item.documentCode, 64), text(item.state, 32)];
}

function projectOverdueTask(value) {
  const item = isRecord(value) ? value : {};
  return [
    text(item.taskCode, 64),
    text(item.status, 32),
    text(item.priority, 32),
    optionalText(item.dueAt, 40),
    text(item.source, 32)
  ];
}

function projectAction(value) {
  const item = isRecord(value) ? value : {};
  return [
    text(item.actionCode, 64),
    text(item.targetCode, 64),
    optionalText(item.urgency, 32),
    optionalText(item.dueAt, 40),
    item.requiresApproval === true
  ];
}

function projectLevel(value) {
  const level = isRecord(value) ? value : {};
  return {
    level: text(level.level, 32),
    reasonCodes: array(level.reasonCodes).map((item) => text(item, 64))
  };
}

function projectConflict(value) {
  const item = isRecord(value) ? value : {};
  return [
    text(item.conflictCode, 64),
    text(item.fieldCode, 64),
    item.requiresManualReview === true
  ];
}

function projectSourceCompleteness(value) {
  const item = isRecord(value) ? value : {};
  return {
    status: text(item.status, 32),
    freshSources: integer(item.freshSources),
    completeSources: integer(item.completeSources),
    requiredAuthorityAvailable: item.requiredAuthorityAvailable === true,
    sources: array(item.sources).map((source) => {
      const projected = isRecord(source) ? source : {};
      return {
        source: text(projected.source, 32),
        provided: projected.provided === true,
        status: text(projected.status, 32),
        completeness: text(projected.completeness, 32),
        asOf: optionalText(projected.asOf, 40),
        checkedAt: optionalText(projected.checkedAt, 40),
        validUntil: optionalText(projected.validUntil, 40),
        reasonCode: optionalText(projected.reasonCode, 64)
      };
    })
  };
}

function projectCommunicationHealth(value) {
  const item = isRecord(value) ? value : {};
  return {
    incompleteDelivery: array(item.incompleteDelivery)
      .map(projectCommunicationEvent),
    awaitingResponse: array(item.awaitingResponse)
      .map(projectCommunicationEvent),
    sources: array(item.sources).map((source) => {
      const projected = isRecord(source) ? source : {};
      return {
        source: text(projected.source, 32),
        status: text(projected.status, 32),
        completeness: text(projected.completeness, 32)
      };
    })
  };
}

function projectCommunicationEvent(value) {
  const item = isRecord(value) ? value : {};
  return [
    text(item.eventCode, 64),
    optionalText(item.actionState, 32),
    optionalText(item.occurredAt, 40),
    text(item.source, 32)
  ];
}

function projectWorkflow(value, name) {
  const workflow = isRecord(value) ? value : {};
  return {
    workflowId: text(workflow.workflowId || name, 64),
    eligibility: text(workflow.eligibility, 32),
    readiness: text(workflow.readiness, 32),
    requiredFacts: array(workflow.requiredFacts).map(projectMissingFact),
    requiredDocuments: array(workflow.requiredDocuments).map((item) => {
      const document = projectMissingDocument(item);
      return [...document, item?.reviewRequired === true];
    }),
    blockers: array(workflow.blockers).map((item) => {
      const blocker = isRecord(item) ? item : {};
      return [
        text(blocker.blockerCode, 64),
        text(blocker.targetCode, 64)
      ];
    }),
    nextActions: array(workflow.nextActions).map(projectAction),
    escalationFlags: array(workflow.escalationFlags)
      .map((item) => text(item, 64)),
    metrics: projectMetrics(workflow.metrics)
  };
}

function projectMetrics(value) {
  const metrics = isRecord(value) ? value : {};
  return Object.fromEntries(
    WORKFLOW_METRIC_FIELDS
      .filter((name) => Object.hasOwn(metrics, name))
      .map((name) => [name, metricValue(metrics[name])])
  );
}

function metricValue(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return optionalText(value, 64);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optionalText(value, maximumCharacters) {
  if (value === undefined || value === null || value === "") return null;
  return text(value, maximumCharacters);
}

function text(value, maximumCharacters) {
  return [...String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()]
    .slice(0, maximumCharacters)
    .join("");
}

function isRecord(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
