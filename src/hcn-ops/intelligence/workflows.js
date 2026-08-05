import {
  LIMITS,
  MILLISECONDS_PER_DAY,
  WORKFLOW_EVALUATION_SCHEMA,
  WORKFLOW_IDS
} from "./constants.js";
import { immutableCopy } from "./contracts.js";

/**
 * Evaluate all five deterministic HCN workflows over a derived file state.
 */
export function evaluateFileWorkflows(fileState) {
  assertFileState(fileState);
  return immutableCopy({
    neglected_files: evaluateNeglectedFilesWorkflow(fileState),
    communications: evaluateCommunicationsWorkflow(fileState),
    claim_filing: evaluateClaimFilingWorkflow(fileState),
    inspection_scheduling:
      evaluateInspectionSchedulingWorkflow(fileState),
    follow_up: evaluateFollowUpWorkflow(fileState)
  });
}

export function evaluateWorkflow(workflowId, fileState) {
  if (!WORKFLOW_IDS.includes(workflowId)) {
    throw new TypeError(`unsupported HCN workflow: ${workflowId}`);
  }
  switch (workflowId) {
    case "neglected_files":
      return evaluateNeglectedFilesWorkflow(fileState);
    case "communications":
      return evaluateCommunicationsWorkflow(fileState);
    case "claim_filing":
      return evaluateClaimFilingWorkflow(fileState);
    case "inspection_scheduling":
      return evaluateInspectionSchedulingWorkflow(fileState);
    case "follow_up":
      return evaluateFollowUpWorkflow(fileState);
    default:
      throw new TypeError(`unsupported HCN workflow: ${workflowId}`);
  }
}

export function evaluateNeglectedFilesWorkflow(fileState) {
  assertFileState(fileState);
  if (fileState.fileStatus !== "active") {
    return result(fileState, "neglected_files", {
      eligibility: "ineligible",
      readiness: "not_applicable",
      requiredFacts: [
        syntheticFact(
          "active_file",
          "not_applicable",
          fileState.activeSinceEvidenceRef
            ? [fileState.activeSinceEvidenceRef]
            : []
        )
      ],
      requiredDocuments: [],
      blockers: [],
      nextActions: [],
      escalationFlags: [],
      metrics: emptyGapMetrics()
    });
  }

  const authority = sourceState(fileState, "jobnimbus");
  const activityHistoryComplete =
    sourceFacetComplete(fileState, "activityHistory", authority);
  const baseline =
    fileState.lastMeaningfulActivity ??
    (fileState.activeSince
      ? {
          eventCode: "file_activated",
          occurredAt: fileState.activeSince,
          source: "jobnimbus",
          evidenceRef: fileState.activeSinceEvidenceRef
        }
      : null);
  const requiredFacts = [
    syntheticFact(
      "active_since",
      fileState.activeSince ? "confirmed" : "unknown",
      fileState.activeSinceEvidenceRef
        ? [fileState.activeSinceEvidenceRef]
        : []
    ),
    syntheticFact(
      "last_meaningful_activity",
      fileState.lastMeaningfulActivity
        ? "confirmed"
        : activityHistoryComplete
          ? "absent"
          : "unknown",
      fileState.lastMeaningfulActivity
        ? [fileState.lastMeaningfulActivity.evidenceRef]
        : []
    )
  ];
  const blockers = [];
  if (authority.status !== "fresh") {
    blockers.push(blocker("authoritative_source_unavailable", "jobnimbus"));
  } else if (!activityHistoryComplete) {
    blockers.push(
      blocker(
        "authoritative_source_incomplete",
        "jobnimbus_activity_history"
      )
    );
  }
  if (!baseline) {
    blockers.push(blocker("activity_baseline_missing", "activity"));
  }
  const communicationIncomplete = ["gmail", "quo"].some((source) => {
    const state = sourceState(fileState, source);
    return state.status !== "fresh" || state.completeness !== "complete";
  });
  if (communicationIncomplete) {
    blockers.push(
      blocker("communication_source_incomplete", "gmail_or_quo")
    );
  }

  const activityGapDays = activityHistoryComplete && baseline
    ? elapsedDays(fileState.generatedAt, baseline.occurredAt)
    : null;
  const contactBaseline =
    fileState.lastMeaningfulContact ??
    (fileState.activeSince
      ? {
          occurredAt: fileState.activeSince,
          evidenceRef: fileState.activeSinceEvidenceRef
        }
      : null);
  const contactGapDays = contactBaseline
    ? elapsedDays(fileState.generatedAt, contactBaseline.occurredAt)
    : null;
  const nextActions =
    activityGapDays !== null && activityGapDays >= 7
      ? [
          action(
            "review_neglected_file",
            "verified_activity_gap",
            null,
            baseline.evidenceRef ? [baseline.evidenceRef] : [],
            false
          )
        ]
      : [];
  const escalationFlags = [];
  if (
    activityHistoryComplete
    && activityGapDays !== null
    && activityGapDays >= 30
  ) {
    escalationFlags.push("severely_neglected");
  }
  if (fileState.lastMeaningfulContact === null) {
    escalationFlags.push("no_verified_contact");
  }
  if (communicationIncomplete) {
    escalationFlags.push("communication_sources_incomplete");
  }

  return result(fileState, "neglected_files", {
    eligibility:
      authority.status === "fresh" && activityHistoryComplete && baseline
        ? "eligible"
        : "indeterminate",
    readiness:
      authority.status !== "fresh" || !baseline
        ? "blocked"
        : !activityHistoryComplete || communicationIncomplete
          ? "partially_ready"
          : "ready",
    requiredFacts,
    requiredDocuments: [],
    blockers,
    nextActions,
    escalationFlags,
    metrics: {
      activityGapDays,
      contactGapDays,
      baselineKind: !activityHistoryComplete
        ? "unknown"
        : baseline
          ? fileState.lastMeaningfulActivity
            ? "verified_activity"
            : "file_activation"
          : "unknown",
      baselineAt: activityHistoryComplete
        ? baseline?.occurredAt ?? null
        : null
    }
  });
}

export function evaluateCommunicationsWorkflow(fileState) {
  assertFileState(fileState);
  if (fileState.fileStatus !== "active") {
    return result(fileState, "communications", {
      eligibility: "ineligible",
      readiness: "not_applicable",
      requiredFacts: [],
      requiredDocuments: [],
      blockers: [],
      nextActions: [],
      escalationFlags: [],
      metrics: {
        awaitingResponseCount: 0,
        incompleteDeliveryCount: 0,
        verifiedContactGapDays: null
      }
    });
  }

  const communicationSources = ["gmail", "quo"].map((source) =>
    sourceState(fileState, source)
  );
  const freshSources = communicationSources.filter(
    ({ status }) => status === "fresh"
  );
  const incompleteSources = communicationSources.filter(
    ({ status, completeness }) =>
      status !== "fresh" || completeness !== "complete"
  );
  const awaiting = fileState.communicationHealth.awaitingResponse;
  const incompleteDelivery =
    fileState.communicationHealth.incompleteDelivery;
  const requiredFacts = [
    syntheticFact(
      "owner_assignment",
      fileState.ownerRef ? "confirmed" : "unknown",
      fileState.ownerEvidenceRef ? [fileState.ownerEvidenceRef] : []
    ),
    syntheticFact(
      "latest_verified_contact",
      fileState.lastMeaningfulContact ? "confirmed" : "absent",
      fileState.lastMeaningfulContact
        ? [fileState.lastMeaningfulContact.evidenceRef]
        : []
    ),
    syntheticFact(
      "communication_source_coverage",
      freshSources.length === 2
        ? "confirmed"
        : freshSources.length === 1
          ? "partial"
          : "unknown",
      []
    )
  ];
  const blockers = [];
  if (fileState.ownerRef === null) {
    blockers.push(blocker("owner_assignment_missing", "owner_assignment"));
  }
  for (const source of incompleteSources) {
    blockers.push(
      blocker("communication_source_incomplete", source.source)
    );
  }
  for (const event of incompleteDelivery) {
    blockers.push(
      blocker(
        "communication_delivery_unverified",
        event.eventCode,
        [event.evidenceRef]
      )
    );
  }
  const nextActions = [
    ...awaiting.map((event) =>
      action(
        "review_and_prepare_response",
        event.eventCode,
        null,
        [event.evidenceRef],
        true
      )
    ),
    ...incompleteDelivery.map((event) =>
      action(
        "reconcile_delivery_state",
        event.eventCode,
        null,
        [event.evidenceRef],
        false
      )
    )
  ];
  if (
    fileState.lastMeaningfulContact === null &&
    fileState.activeSince !== null
  ) {
    nextActions.push(
      action(
        "review_missing_verified_contact",
        "client_communication",
        null,
        fileState.activeSinceEvidenceRef
          ? [fileState.activeSinceEvidenceRef]
          : [],
        false
      )
    );
  }
  const escalationFlags = [];
  if (awaiting.length > 0) escalationFlags.push("response_due");
  if (incompleteDelivery.length > 0) {
    escalationFlags.push("unresolved_delivery_state");
  }
  if (incompleteSources.length > 0) {
    escalationFlags.push("communication_sources_incomplete");
  }
  if (fileState.lastMeaningfulContact === null) {
    escalationFlags.push("no_verified_contact");
  }
  const contactGapDays = fileState.lastMeaningfulContact
    ? elapsedDays(
        fileState.generatedAt,
        fileState.lastMeaningfulContact.occurredAt
      )
    : fileState.activeSince
      ? elapsedDays(fileState.generatedAt, fileState.activeSince)
      : null;

  return result(fileState, "communications", {
    eligibility: freshSources.length > 0 ? "eligible" : "indeterminate",
    readiness:
      freshSources.length === 0 || fileState.ownerRef === null
        ? "blocked"
        : incompleteSources.length > 0 || incompleteDelivery.length > 0
          ? "partially_ready"
          : "ready",
    requiredFacts,
    requiredDocuments: [],
    blockers,
    nextActions,
    escalationFlags,
    metrics: {
      awaitingResponseCount: awaiting.length,
      incompleteDeliveryCount: incompleteDelivery.length,
      verifiedContactGapDays: contactGapDays
    }
  });
}

export function evaluateClaimFilingWorkflow(fileState) {
  assertFileState(fileState);
  const requiredFactCodes = [
    "carrier",
    "policy_identifier",
    "carrier_contact",
    "date_of_loss",
    "damage_facts"
  ];
  const requiredFacts = requiredFactCodes.map((code) =>
    exposeFact(fileState, code)
  );
  const claim = readFact(fileState, "claim_identifier");
  const authority = sourceState(fileState, "jobnimbus");
  const authorityReady =
    authority.status === "fresh"
    && sourceFacetComplete(fileState, "currentFacts", authority);

  if (fileState.fileStatus !== "active") {
    return result(fileState, "claim_filing", {
      eligibility: "ineligible",
      readiness: "not_applicable",
      requiredFacts,
      requiredDocuments: [],
      blockers: [],
      nextActions: [],
      escalationFlags: [],
      metrics: { missingRequiredFactCount: 0, claimAlreadyEvidenced: false }
    });
  }
  if (claim.state === "confirmed") {
    return result(fileState, "claim_filing", {
      eligibility: "ineligible",
      readiness: "not_applicable",
      requiredFacts,
      requiredDocuments: [],
      blockers: [
        blocker(
          "claim_already_evidenced",
          "claim_identifier",
          claim.evidenceRefs
        )
      ],
      nextActions: [],
      escalationFlags: [],
      metrics: { missingRequiredFactCount: 0, claimAlreadyEvidenced: true }
    });
  }

  const missing = requiredFacts.filter(({ state }) => state !== "confirmed");
  const blockers = [];
  if (!authorityReady) {
    blockers.push(
      blocker(
        authority.status === "fresh"
          ? "authoritative_source_incomplete"
          : "authoritative_source_unavailable",
        "jobnimbus"
      )
    );
  }
  for (const fact of missing) {
    blockers.push(
      blocker(
        fact.state === "disputed"
          ? "required_fact_conflicted"
          : "required_fact_missing",
        fact.factCode,
        fact.evidenceRefs
      )
    );
  }
  if (claim.state === "disputed") {
    blockers.push(
      blocker(
        "claim_existence_conflicted",
        "claim_identifier",
        claim.evidenceRefs
      )
    );
  }
  const stageInconsistent =
    ["claim_filed", "inspection_scheduling", "inspection_scheduled",
      "adjustment", "estimate", "supplement", "settlement_review",
      "payment_collection", "closed"].includes(fileState.currentStage.code) &&
    claim.state !== "confirmed";
  if (stageInconsistent) {
    blockers.push(
      blocker("claim_stage_inconsistent", "claim_identifier")
    );
  }
  const ready =
    authorityReady &&
    missing.length === 0 &&
    claim.state !== "disputed" &&
    !stageInconsistent;
  const nextActions = ready
    ? [
        action(
          "prepare_claim_filing_review",
          "claim_filing",
          null,
          requiredFacts.flatMap(({ evidenceRefs }) => evidenceRefs),
          true
        )
      ]
    : missing.map((fact) =>
        action(
          fact.state === "disputed"
            ? "manually_reconcile_fact"
            : "obtain_required_fact",
          fact.factCode,
          null,
          fact.evidenceRefs,
          false
        )
      );
  const escalationFlags = [];
  if (
    missing.some(({ state }) => state === "disputed") ||
    claim.state === "disputed"
  ) {
    escalationFlags.push("conflicting_claim_evidence");
  }
  if (stageInconsistent) escalationFlags.push("claim_stage_inconsistent");
  if (!authorityReady) {
    escalationFlags.push("authoritative_source_incomplete");
  }

  return result(fileState, "claim_filing", {
    eligibility:
      authorityReady && !stageInconsistent
        ? "eligible"
        : "indeterminate",
    readiness: ready ? "ready" : "blocked",
    requiredFacts,
    requiredDocuments: [],
    blockers,
    nextActions,
    escalationFlags,
    metrics: {
      missingRequiredFactCount: missing.length,
      claimAlreadyEvidenced: false
    }
  });
}

export function evaluateInspectionSchedulingWorkflow(fileState) {
  assertFileState(fileState);
  const claim = exposeFact(fileState, "claim_identifier");
  const carrierContact = exposeFact(fileState, "carrier_contact");
  const adjusterContact = exposeFact(fileState, "adjuster_contact");
  const appointment = exposeFact(fileState, "inspection_appointment");
  const availability = exposeFact(fileState, "homeowner_availability");
  const confirmation = exposeFact(fileState, "homeowner_confirmation");
  const requiredFacts = [
    claim,
    carrierContact,
    adjusterContact,
    appointment,
    availability,
    confirmation
  ];

  if (fileState.fileStatus !== "active") {
    return result(fileState, "inspection_scheduling", {
      eligibility: "ineligible",
      readiness: "not_applicable",
      requiredFacts,
      requiredDocuments: [],
      blockers: [],
      nextActions: [],
      escalationFlags: [],
      metrics: {
        schedulingContactAvailable: false,
        appointmentEvidenced: false,
        homeownerConfirmed: false
      }
    });
  }

  const authority = sourceState(fileState, "jobnimbus");
  const authorityReady =
    authority.status === "fresh"
    && sourceFacetComplete(fileState, "currentFacts", authority);
  const contactAvailable =
    carrierContact.state === "confirmed" ||
    adjusterContact.state === "confirmed";
  const hardConflict = [claim, carrierContact, adjusterContact, appointment,
    availability, confirmation].some(({ state }) => state === "disputed");
  const blockers = [];
  if (!authorityReady) {
    blockers.push(
      blocker(
        authority.status === "fresh"
          ? "authoritative_source_incomplete"
          : "authoritative_source_unavailable",
        "jobnimbus"
      )
    );
  }
  if (claim.state !== "confirmed") {
    blockers.push(
      blocker(
        claim.state === "disputed"
          ? "required_fact_conflicted"
          : "required_fact_missing",
        "claim_identifier",
        claim.evidenceRefs
      )
    );
  }
  if (!contactAvailable) {
    blockers.push(
      blocker(
        carrierContact.state === "disputed" ||
          adjusterContact.state === "disputed"
          ? "scheduling_contact_conflicted"
          : "scheduling_contact_missing",
        "carrier_or_adjuster_contact",
        [...carrierContact.evidenceRefs, ...adjusterContact.evidenceRefs]
      )
    );
  }
  if (appointment.state === "disputed") {
    blockers.push(
      blocker(
        "inspection_appointment_conflicted",
        "inspection_appointment",
        appointment.evidenceRefs
      )
    );
  }

  const canCoordinate =
    authorityReady &&
    claim.state === "confirmed" &&
    contactAvailable &&
    !hardConflict;
  const nextActions = [];
  if (canCoordinate && appointment.state !== "confirmed") {
    nextActions.push(
      action(
        "prepare_inspection_scheduling_request",
        "inspection_appointment",
        null,
        [
          ...claim.evidenceRefs,
          ...carrierContact.evidenceRefs,
          ...adjusterContact.evidenceRefs
        ],
        true
      )
    );
  } else if (
    canCoordinate &&
    appointment.state === "confirmed" &&
    confirmation.state !== "confirmed"
  ) {
    nextActions.push(
      action(
        "request_homeowner_confirmation",
        "inspection_appointment",
        null,
        appointment.evidenceRefs,
        true
      )
    );
  } else if (
    canCoordinate &&
    appointment.state === "confirmed" &&
    confirmation.state === "confirmed"
  ) {
    nextActions.push(
      action(
        "review_confirmed_inspection",
        "inspection_appointment",
        null,
        [...appointment.evidenceRefs, ...confirmation.evidenceRefs],
        false
      )
    );
  }

  const escalationFlags = [];
  if (hardConflict) escalationFlags.push("inspection_evidence_conflict");
  if (!authorityReady) {
    escalationFlags.push("authoritative_source_incomplete");
  }
  if (
    appointment.state === "confirmed" &&
    confirmation.state !== "confirmed"
  ) {
    escalationFlags.push("homeowner_confirmation_missing");
  }

  return result(fileState, "inspection_scheduling", {
    eligibility:
      authorityReady && claim.state === "confirmed"
        ? "eligible"
        : "indeterminate",
    readiness: canCoordinate ? "ready" : "blocked",
    requiredFacts,
    requiredDocuments: [],
    blockers,
    nextActions,
    escalationFlags,
    metrics: {
      schedulingContactAvailable: contactAvailable,
      appointmentEvidenced: appointment.state === "confirmed",
      homeownerConfirmed: confirmation.state === "confirmed"
    }
  });
}

export function evaluateFollowUpWorkflow(fileState) {
  assertFileState(fileState);
  if (fileState.fileStatus !== "active") {
    return result(fileState, "follow_up", {
      eligibility: "ineligible",
      readiness: "not_applicable",
      requiredFacts: [],
      requiredDocuments: [],
      blockers: [],
      nextActions: [],
      escalationFlags: [],
      metrics: {
        overdueTaskCount: 0,
        overduePromiseCount: 0,
        awaitingResponseCount: 0,
        verifiedActivityGapDays: null
      }
    });
  }

  const authority = sourceState(fileState, "jobnimbus");
  const authorityReady =
    authority.status === "fresh"
    && sourceFacetComplete(fileState, "currentFacts", authority);
  const activityHistoryComplete =
    sourceFacetComplete(fileState, "activityHistory", authority);
  const taskHistoryComplete =
    sourceFacetComplete(fileState, "taskHistory", authority);
  const overduePromises = fileState.openPromises.filter(
    ({ overdue }) => overdue
  );
  const awaiting = fileState.communicationHealth.awaitingResponse;
  const incompleteDelivery =
    fileState.communicationHealth.incompleteDelivery;
  const gapBaseline =
    fileState.lastMeaningfulActivity?.occurredAt ?? fileState.activeSince;
  const gapDays = activityHistoryComplete && gapBaseline
    ? elapsedDays(fileState.generatedAt, gapBaseline)
    : null;
  const gapTrigger = gapDays !== null && gapDays >= 7;
  const requiredFacts = [
    syntheticFact(
      "owner_assignment",
      fileState.ownerRef ? "confirmed" : "unknown",
      fileState.ownerEvidenceRef ? [fileState.ownerEvidenceRef] : []
    ),
    syntheticFact(
      "follow_up_trigger",
      fileState.overdueTasks.length > 0 ||
        overduePromises.length > 0 ||
        awaiting.length > 0 ||
        incompleteDelivery.length > 0 ||
        gapTrigger
        ? "confirmed"
        : activityHistoryComplete && taskHistoryComplete
          ? "absent"
          : "unknown",
      [
        ...fileState.overdueTasks.map(({ evidenceRef }) => evidenceRef),
        ...overduePromises.map(({ evidenceRef }) => evidenceRef),
        ...awaiting.map(({ evidenceRef }) => evidenceRef),
        ...incompleteDelivery.map(({ evidenceRef }) => evidenceRef),
        ...(gapTrigger && fileState.lastMeaningfulActivity
          ? [fileState.lastMeaningfulActivity.evidenceRef]
          : gapTrigger && fileState.activeSinceEvidenceRef
            ? [fileState.activeSinceEvidenceRef]
            : [])
      ]
    )
  ];
  const blockers = [];
  if (!authorityReady) {
    blockers.push(
      blocker(
        authority.status === "fresh"
          ? "authoritative_source_incomplete"
          : "authoritative_source_unavailable",
        "jobnimbus"
      )
    );
  }
  if (authority.status === "fresh" && !activityHistoryComplete) {
    blockers.push(
      blocker(
        "authoritative_source_incomplete",
        "jobnimbus_activity_history"
      )
    );
  }
  if (authority.status === "fresh" && !taskHistoryComplete) {
    blockers.push(
      blocker(
        "authoritative_source_incomplete",
        "jobnimbus_task_history"
      )
    );
  }
  if (fileState.ownerRef === null) {
    blockers.push(blocker("owner_assignment_missing", "owner_assignment"));
  }
  for (const event of incompleteDelivery) {
    blockers.push(
      blocker(
        "communication_delivery_unverified",
        event.eventCode,
        [event.evidenceRef]
      )
    );
  }
  const communicationIncomplete = ["gmail", "quo"].some((source) => {
    const state = sourceState(fileState, source);
    return state.status !== "fresh" || state.completeness !== "complete";
  });
  if (communicationIncomplete) {
    blockers.push(
      blocker("communication_source_incomplete", "gmail_or_quo")
    );
  }

  const nextActions = [
    ...fileState.overdueTasks.map((task) =>
      action(
        "review_overdue_task",
        task.taskCode,
        task.dueAt,
        [task.evidenceRef],
        false
      )
    ),
    ...overduePromises.map((promise) =>
      action(
        "fulfill_overdue_promise",
        promise.promiseCode,
        promise.dueAt,
        [promise.evidenceRef],
        promise.promiseCode !== "review_document"
      )
    ),
    ...awaiting.map((event) =>
      action(
        "review_and_prepare_response",
        event.eventCode,
        null,
        [event.evidenceRef],
        true
      )
    ),
    ...incompleteDelivery.map((event) =>
      action(
        "reconcile_delivery_state",
        event.eventCode,
        null,
        [event.evidenceRef],
        false
      )
    )
  ];
  if (gapTrigger) {
    nextActions.push(
      action(
        "review_activity_gap",
        "verified_activity_gap",
        null,
        fileState.lastMeaningfulActivity
          ? [fileState.lastMeaningfulActivity.evidenceRef]
          : fileState.activeSinceEvidenceRef
            ? [fileState.activeSinceEvidenceRef]
            : [],
        false
      )
    );
  }
  const escalationFlags = [];
  if (fileState.overdueTasks.length > 0) escalationFlags.push("overdue_task");
  if (overduePromises.length > 0) escalationFlags.push("overdue_promise");
  if (awaiting.length > 0) escalationFlags.push("response_due");
  if (incompleteDelivery.length > 0) {
    escalationFlags.push("unresolved_delivery_state");
  }
  if (activityHistoryComplete && gapDays !== null && gapDays >= 30) {
    escalationFlags.push("severely_neglected");
  }
  if (communicationIncomplete) {
    escalationFlags.push("communication_sources_incomplete");
  }

  const hardBlocked =
    authority.status !== "fresh" || fileState.ownerRef === null;
  return result(fileState, "follow_up", {
    eligibility: authority.status === "fresh" ? "eligible" : "indeterminate",
    readiness: hardBlocked
      ? "blocked"
      : !activityHistoryComplete ||
          !taskHistoryComplete ||
          communicationIncomplete ||
          incompleteDelivery.length > 0
        ? "partially_ready"
        : "ready",
    requiredFacts,
    requiredDocuments: [],
    blockers,
    nextActions,
    escalationFlags,
    metrics: {
      overdueTaskCount: fileState.overdueTasks.length,
      overduePromiseCount: overduePromises.length,
      awaitingResponseCount: awaiting.length,
      verifiedActivityGapDays: gapDays
    }
  });
}

function result(
  fileState,
  workflowId,
  {
    eligibility,
    readiness,
    requiredFacts,
    requiredDocuments,
    blockers,
    nextActions,
    escalationFlags,
    metrics
  }
) {
  const boundedBlockers = deduplicateObjects(blockers, (item) =>
    `${item.blockerCode}:${item.targetCode}:${item.evidenceRefs.join(",")}`
  ).slice(0, LIMITS.workflowItems);
  const boundedNextActions = deduplicateObjects(nextActions, (item) =>
    `${item.actionCode}:${item.targetCode}:${item.dueAt ?? ""}:${
      item.evidenceRefs.join(",")
    }`
  ).slice(0, LIMITS.workflowItems);
  const evidenceRefs = unique(
    [
      ...requiredFacts.flatMap((item) => item.evidenceRefs),
      ...requiredDocuments.flatMap((item) => item.evidenceRefs),
      ...boundedBlockers.flatMap((item) => item.evidenceRefs),
      ...boundedNextActions.flatMap((item) => item.evidenceRefs)
    ].filter(Boolean)
  )
    .sort()
    .slice(0, LIMITS.evidenceRefsPerOutput);
  return immutableCopy({
    schemaVersion: WORKFLOW_EVALUATION_SCHEMA,
    workflowId,
    evaluatedAt: fileState.generatedAt,
    fileRef: fileState.fileRef,
    eligibility,
    readiness,
    requiredFacts,
    requiredDocuments,
    blockers: boundedBlockers,
    evidenceRefs,
    nextActions: boundedNextActions,
    escalationFlags: unique(escalationFlags).sort(),
    metrics
  });
}

function exposeFact(fileState, code) {
  const fact = readFact(fileState, code);
  return {
    factCode: code,
    state: fact.state,
    evidenceRefs: fact.evidenceRefs
  };
}

function syntheticFact(factCode, state, evidenceRefs) {
  return { factCode, state, evidenceRefs: unique(evidenceRefs).sort() };
}

function blocker(blockerCode, targetCode, evidenceRefs = []) {
  return {
    blockerCode,
    targetCode,
    evidenceRefs: unique(evidenceRefs).sort()
  };
}

function action(
  actionCode,
  targetCode,
  dueAt,
  evidenceRefs,
  requiresApproval
) {
  return {
    actionCode,
    targetCode,
    dueAt,
    evidenceRefs: unique(evidenceRefs).sort(),
    requiresApproval
  };
}

function readFact(fileState, code) {
  return (
    fileState.facts.find(({ factCode }) => factCode === code) ?? {
      factCode: code,
      state: "unknown",
      valueRef: null,
      evidenceRefs: []
    }
  );
}

function sourceState(fileState, source) {
  return (
    fileState.sourceCompleteness.sources.find(
      (candidate) => candidate.source === source
    ) ?? {
      source,
      status: "not_provided",
      completeness: "none"
    }
  );
}

function sourceFacetComplete(fileState, facet, fallbackSource) {
  const value = fileState?.historyCoverage?.[facet];
  if (["complete", "partial", "none"].includes(value)) {
    return value === "complete";
  }
  return fallbackSource.completeness === "complete";
}

function elapsedDays(later, earlier) {
  return Math.max(
    0,
    Math.floor((Date.parse(later) - Date.parse(earlier)) / MILLISECONDS_PER_DAY)
  );
}

function emptyGapMetrics() {
  return {
    activityGapDays: null,
    contactGapDays: null,
    baselineKind: "not_applicable",
    baselineAt: null
  };
}

function deduplicateObjects(items, keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values) {
  return [...new Set(values)];
}

function assertFileState(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.schemaVersion !== "hcn.ops.file-intelligence.v1" ||
    typeof value.fileRef !== "string" ||
    !Array.isArray(value.facts) ||
    !Array.isArray(value.documents) ||
    !value.sourceCompleteness
  ) {
    throw new TypeError(
      "workflow evaluation requires a derived HCN file intelligence state"
    );
  }
}
