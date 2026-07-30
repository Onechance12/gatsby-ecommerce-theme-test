import assert from "node:assert/strict";
import test from "node:test";

import {
  FileIntelligenceContractError,
  deriveFileIntelligence,
  deriveFileState,
  evaluateWorkflow,
  normalizeFileEvidence
} from "./index.js";

const GENERATED_AT = "2026-07-30T12:00:00.000Z";
const FILE_REF = `subject_${"a".repeat(32)}`;
const OWNER_REF = `employee_${"b".repeat(16)}`;

function source(
  name,
  {
    status = "fresh",
    completeness = "complete",
    asOf = "2026-07-30T10:00:00.000Z",
    checkedAt = "2026-07-30T11:00:00.000Z",
    validUntil = "2026-07-30T13:00:00.000Z"
  } = {}
) {
  if (["unavailable", "unsupported", "unknown"].includes(status)) {
    return {
      source: name,
      status,
      completeness: "none",
      asOf: null,
      checkedAt,
      validUntil: null
    };
  }
  return {
    source: name,
    status,
    completeness,
    asOf,
    checkedAt,
    validUntil
  };
}

function allFreshSources() {
  return [
    source("jobnimbus"),
    source("gmail"),
    source("quo"),
    source("google_calendar"),
    source("retell")
  ];
}

function ref(number) {
  return `ref_${number.toString(16).padStart(16, "0")}`;
}

function value(number) {
  return `value_${number.toString(16).padStart(16, "0")}`;
}

function stage(
  evidenceRef,
  stageCode = "claim_readiness",
  sourceName = "jobnimbus",
  observedAt = "2026-07-30T10:00:00.000Z"
) {
  return {
    stageCode,
    state: "current",
    source: sourceName,
    evidenceRef,
    observedAt
  };
}

function fact(
  evidenceRef,
  factCode,
  valueRef,
  {
    state = "confirmed",
    sourceName = "jobnimbus",
    observedAt = "2026-07-30T10:00:00.000Z"
  } = {}
) {
  return {
    factCode,
    state,
    valueRef: state === "confirmed" ? valueRef : null,
    source: sourceName,
    evidenceRef,
    observedAt
  };
}

function document(
  evidenceRef,
  documentCode,
  {
    state = "present",
    reviewState = "reviewed",
    sourceName = "jobnimbus",
    observedAt = "2026-07-30T10:00:00.000Z"
  } = {}
) {
  return {
    documentCode,
    state,
    reviewState,
    source: sourceName,
    evidenceRef,
    observedAt
  };
}

function event(
  evidenceRef,
  eventCode,
  occurredAt,
  {
    actionState = "none",
    sourceName = "jobnimbus",
    actorRef = OWNER_REF
  } = {}
) {
  return {
    eventCode,
    actionState,
    source: sourceName,
    evidenceRef,
    occurredAt,
    actorRef
  };
}

function baseInput() {
  return {
    generatedAt: GENERATED_AT,
    fileRef: FILE_REF,
    fileStatus: "active",
    activeSince: "2026-06-01T12:00:00.000Z",
    activeSinceEvidenceRef: ref(1),
    ownerRef: OWNER_REF,
    ownerEvidenceRef: ref(100),
    sources: allFreshSources(),
    stages: [stage(ref(2))],
    facts: [
      fact(ref(3), "carrier", value(3)),
      fact(ref(4), "policy_identifier", value(4)),
      fact(ref(5), "carrier_contact", value(5)),
      fact(ref(6), "date_of_loss", value(6)),
      fact(ref(7), "damage_facts", value(7)),
      fact(ref(8), "claim_identifier", null, { state: "absent" })
    ],
    documents: [
      document(ref(9), "policy_declaration"),
      document(ref(10), "authorization_lor"),
      document(ref(11), "damage_evidence")
    ],
    events: [
      event(ref(12), "email_sent_verified", "2026-07-20T12:00:00.000Z", {
        sourceName: "gmail"
      }),
      event(ref(13), "note_substantive", "2026-07-25T12:00:00.000Z")
    ],
    tasks: [
      {
        taskCode: "file_review",
        status: "open",
        priority: "high",
        ownerRef: OWNER_REF,
        dueAt: "2026-07-29T12:00:00.000Z",
        source: "jobnimbus",
        evidenceRef: ref(14),
        observedAt: "2026-07-28T12:00:00.000Z"
      }
    ],
    promises: [
      {
        promiseCode: "provide_update",
        state: "open",
        ownerRef: OWNER_REF,
        madeAt: "2026-07-28T12:00:00.000Z",
        dueAt: "2026-07-31T12:00:00.000Z",
        source: "jobnimbus",
        evidenceRef: ref(15),
        observedAt: "2026-07-28T12:00:00.000Z"
      }
    ]
  };
}

function clone(valueToClone) {
  return structuredClone(valueToClone);
}

function assertDeepFrozen(valueToInspect, seen = new Set()) {
  if (
    valueToInspect === null ||
    typeof valueToInspect !== "object" ||
    seen.has(valueToInspect)
  ) {
    return;
  }
  seen.add(valueToInspect);
  assert.equal(Object.isFrozen(valueToInspect), true);
  for (const nested of Object.values(valueToInspect)) {
    assertDeepFrozen(nested, seen);
  }
}

test("derives complete immutable operational intelligence and five workflows", () => {
  const result = deriveFileIntelligence(baseInput());

  assert.equal(result.currentStage.code, "claim_readiness");
  assert.equal(result.ownerRef, OWNER_REF);
  assert.deepEqual(result.lastMeaningfulActivity, {
    eventCode: "note_substantive",
    occurredAt: "2026-07-25T12:00:00.000Z",
    source: "jobnimbus",
    evidenceRef: ref(13)
  });
  assert.equal(result.lastMeaningfulContact.evidenceRef, ref(12));
  assert.equal(result.openPromises.length, 1);
  assert.equal(result.openPromises[0].overdue, false);
  assert.equal(result.overdueTasks.length, 1);
  assert.equal(result.missingFacts.length, 0);
  assert.equal(result.missingDocuments.length, 0);
  assert.equal(result.urgency.level, "high");
  assert.equal(result.confidence.level, "high");
  assert.equal(result.sourceCompleteness.status, "complete");
  assert.deepEqual(Object.keys(result.workflows).sort(), [
    "claim_filing",
    "communications",
    "follow_up",
    "inspection_scheduling",
    "neglected_files"
  ]);
  assert.equal(result.workflows.claim_filing.readiness, "ready");
  assert.equal(
    result.workflows.claim_filing.nextActions[0].actionCode,
    "prepare_claim_filing_review"
  );
  for (const workflow of Object.values(result.workflows)) {
    for (const field of [
      "eligibility",
      "readiness",
      "requiredFacts",
      "blockers",
      "evidenceRefs",
      "nextActions",
      "escalationFlags"
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(workflow, field), field);
    }
  }
  assertDeepFrozen(result);
  assert.throws(() => {
    result.workflows.claim_filing.nextActions.push({});
  }, TypeError);
});

test("drafts and system noise never reset activity or communication gaps", () => {
  const input = baseInput();
  input.events.push(
    event(ref(16), "email_draft", "2026-07-29T12:00:00.000Z", {
      sourceName: "gmail",
      actionState: "draft"
    }),
    event(ref(17), "system_sync", "2026-07-30T09:00:00.000Z"),
    event(ref(18), "note_automated", "2026-07-30T10:00:00.000Z")
  );

  const result = deriveFileIntelligence(input);

  assert.equal(result.lastMeaningfulActivity.evidenceRef, ref(13));
  assert.equal(result.lastMeaningfulContact.evidenceRef, ref(12));
  assert.equal(
    result.workflows.neglected_files.metrics.activityGapDays,
    5
  );
  assert.equal(
    result.workflows.neglected_files.metrics.contactGapDays,
    10
  );
});

test("contradictory fresh sources remain explicit and block risky workflows", () => {
  const input = baseInput();
  input.stages.push(
    stage(ref(16), "claim_filed", "gmail", "2026-07-30T10:30:00.000Z")
  );
  input.facts.push(
    fact(ref(17), "date_of_loss", value(17), {
      sourceName: "gmail",
      observedAt: "2026-07-30T10:30:00.000Z"
    })
  );

  const result = deriveFileIntelligence(input);
  const dateOfLoss = result.facts.find(
    ({ factCode }) => factCode === "date_of_loss"
  );

  assert.equal(result.currentStage.code, "claim_readiness");
  assert.equal(result.currentStage.state, "authoritative_with_conflict");
  assert.equal(dateOfLoss.state, "disputed");
  assert.equal(dateOfLoss.valueRef, null);
  assert.ok(
    result.conflicts.some(
      ({ conflictCode, fieldCode }) =>
        conflictCode === "supporting_stage_conflict" &&
        fieldCode === "current_stage"
    )
  );
  assert.ok(
    result.conflicts.some(
      ({ conflictCode, fieldCode, evidenceRefs }) =>
        conflictCode === "fact_conflict" &&
        fieldCode === "date_of_loss" &&
        evidenceRefs.includes(ref(6)) &&
        evidenceRefs.includes(ref(17))
    )
  );
  assert.equal(result.workflows.claim_filing.readiness, "blocked");
  assert.ok(
    result.workflows.claim_filing.escalationFlags.includes(
      "conflicting_claim_evidence"
    )
  );
});

test("absent date of loss and claim identifier are not inferred", () => {
  const input = baseInput();
  input.facts = input.facts.map((candidate) =>
    candidate.factCode === "date_of_loss"
      ? {
          ...candidate,
          state: "absent",
          valueRef: null
        }
      : candidate
  );

  const result = deriveFileIntelligence(input);
  const claimWorkflow = result.workflows.claim_filing;
  const inspectionWorkflow = result.workflows.inspection_scheduling;

  assert.equal(claimWorkflow.readiness, "blocked");
  assert.ok(
    claimWorkflow.blockers.some(
      ({ blockerCode, targetCode }) =>
        blockerCode === "required_fact_missing" &&
        targetCode === "date_of_loss"
    )
  );
  assert.equal(inspectionWorkflow.readiness, "blocked");
  assert.ok(
    inspectionWorkflow.blockers.some(
      ({ targetCode }) => targetCode === "claim_identifier"
    )
  );
  assert.equal(
    claimWorkflow.nextActions.some(
      ({ actionCode }) => actionCode === "prepare_claim_filing_review"
    ),
    false
  );
  assert.equal(
    inspectionWorkflow.nextActions.some(
      ({ actionCode }) =>
        actionCode === "prepare_inspection_scheduling_request"
    ),
    false
  );
});

test("expired source evidence becomes stale and cannot establish contact", () => {
  const input = baseInput();
  input.sources = input.sources.map((candidate) =>
    candidate.source === "gmail"
      ? {
          ...candidate,
          validUntil: "2026-07-30T11:30:00.000Z"
        }
      : candidate
  );
  input.events = input.events.filter(
    ({ eventCode }) => eventCode !== "note_substantive"
  );

  const result = deriveFileIntelligence(input);
  const gmail = result.sourceCompleteness.sources.find(
    ({ source: sourceName }) => sourceName === "gmail"
  );

  assert.equal(gmail.status, "stale");
  assert.equal(gmail.reasonCode, "freshness_window_expired");
  assert.equal(result.lastMeaningfulContact, null);
  assert.equal(result.unsupportedEvidence.count, 1);
  assert.deepEqual(result.unsupportedEvidence.records[0], {
    evidenceRef: ref(12),
    source: "gmail",
    reasonCode: "freshness_window_expired"
  });
  assert.equal(result.workflows.communications.readiness, "partially_ready");
  assert.ok(
    result.workflows.communications.escalationFlags.includes(
      "communication_sources_incomplete"
    )
  );
});

test("stale JobNimbus evidence cannot establish stage, facts, or readiness", () => {
  const input = baseInput();
  input.sources = input.sources.map((candidate) =>
    candidate.source === "jobnimbus"
      ? {
          ...candidate,
          status: "stale",
          completeness: "complete",
          validUntil: "2026-07-30T11:00:00.000Z"
        }
      : candidate
  );

  const result = deriveFileIntelligence(input);

  assert.equal(result.currentStage.code, "unknown");
  assert.equal(result.sourceCompleteness.status, "insufficient");
  assert.equal(result.confidence.level, "insufficient");
  assert.equal(result.workflows.claim_filing.eligibility, "indeterminate");
  assert.equal(result.workflows.claim_filing.readiness, "blocked");
  assert.equal(
    result.unsupportedEvidence.records.some(
      ({ evidenceRef, reasonCode }) =>
        evidenceRef === ref(2) && reasonCode === "source_stale"
    ),
    true
  );
});

test("partial authoritative evidence can inform state but cannot authorize risky readiness", () => {
  const input = baseInput();
  input.sources = input.sources.map((candidate) =>
    candidate.source === "jobnimbus"
      ? { ...candidate, completeness: "partial" }
      : candidate
  );

  const result = deriveFileIntelligence(input);

  assert.equal(result.currentStage.code, "claim_readiness");
  assert.equal(result.confidence.level, "medium");
  assert.equal(result.workflows.claim_filing.readiness, "blocked");
  assert.ok(
    result.workflows.claim_filing.blockers.some(
      ({ blockerCode }) =>
        blockerCode === "authoritative_source_incomplete"
    )
  );
  assert.equal(
    result.workflows.claim_filing.nextActions.some(
      ({ actionCode }) => actionCode === "prepare_claim_filing_review"
    ),
    false
  );
  assert.equal(result.workflows.neglected_files.readiness, "partially_ready");
  assert.equal(result.workflows.follow_up.readiness, "partially_ready");
});

test("unsupported sources and their evidence are represented but never trusted", () => {
  const input = baseInput();
  input.sources = input.sources.map((candidate) =>
    candidate.source === "quo"
      ? source("quo", { status: "unsupported" })
      : candidate
  );
  input.events.push(
    event(ref(16), "text_received", "2026-07-30T10:30:00.000Z", {
      sourceName: "quo",
      actionState: "awaiting_response"
    })
  );

  const result = deriveFileIntelligence(input);
  const quo = result.sourceCompleteness.sources.find(
    ({ source: sourceName }) => sourceName === "quo"
  );

  assert.equal(quo.status, "unsupported");
  assert.equal(
    result.communicationHealth.awaitingResponse.some(
      ({ evidenceRef }) => evidenceRef === ref(16)
    ),
    false
  );
  assert.deepEqual(
    result.unsupportedEvidence.records.find(
      ({ evidenceRef }) => evidenceRef === ref(16)
    ),
    {
      evidenceRef: ref(16),
      source: "quo",
      reasonCode: "source_unsupported"
    }
  );
  assert.equal(result.workflows.communications.readiness, "partially_ready");
});

test("unverified outbound delivery never counts as contact and requires reconciliation", () => {
  const input = baseInput();
  input.events = [
    event(
      ref(16),
      "text_sent_unconfirmed",
      "2026-07-29T12:00:00.000Z",
      {
        sourceName: "quo",
        actionState: "unverified"
      }
    )
  ];

  const result = deriveFileIntelligence(input);
  const workflow = result.workflows.communications;

  assert.equal(result.lastMeaningfulActivity, null);
  assert.equal(result.lastMeaningfulContact, null);
  assert.equal(result.communicationHealth.incompleteDelivery.length, 1);
  assert.equal(workflow.readiness, "partially_ready");
  assert.ok(
    workflow.blockers.some(
      ({ blockerCode, evidenceRefs }) =>
        blockerCode === "communication_delivery_unverified" &&
        evidenceRefs.includes(ref(16))
    )
  );
  assert.ok(
    workflow.nextActions.some(
      ({ actionCode, dueAt }) =>
        actionCode === "reconcile_delivery_state" && dueAt === null
    )
  );
  assert.ok(
    workflow.escalationFlags.includes("unresolved_delivery_state")
  );
});

test("fresh inbound communication awaiting response produces a gated next action", () => {
  const input = baseInput();
  input.events.push(
    event(ref(16), "email_received", "2026-07-30T10:30:00.000Z", {
      sourceName: "gmail",
      actionState: "awaiting_response"
    })
  );

  const result = deriveFileIntelligence(input);
  const workflow = result.workflows.communications;
  const proposed = workflow.nextActions.find(
    ({ actionCode }) => actionCode === "review_and_prepare_response"
  );

  assert.equal(result.lastMeaningfulContact.evidenceRef, ref(16));
  assert.ok(proposed);
  assert.equal(proposed.requiresApproval, true);
  assert.equal(proposed.dueAt, null);
  assert.deepEqual(proposed.evidenceRefs, [ref(16)]);
  assert.ok(workflow.escalationFlags.includes("response_due"));
});

test("inspection scheduling can request coordination without inventing an appointment", () => {
  const input = baseInput();
  input.facts = input.facts.map((candidate) =>
    candidate.factCode === "claim_identifier"
      ? {
          ...candidate,
          state: "confirmed",
          valueRef: value(8)
        }
      : candidate
  );
  input.stages = [stage(ref(2), "inspection_scheduling")];

  const result = deriveFileIntelligence(input);
  const workflow = result.workflows.inspection_scheduling;
  const proposed = workflow.nextActions.find(
    ({ actionCode }) =>
      actionCode === "prepare_inspection_scheduling_request"
  );

  assert.equal(workflow.readiness, "ready");
  assert.equal(workflow.metrics.appointmentEvidenced, false);
  assert.ok(proposed);
  assert.equal(proposed.dueAt, null);
  assert.equal(proposed.requiresApproval, true);
  assert.equal(
    workflow.requiredFacts.find(
      ({ factCode }) => factCode === "inspection_appointment"
    ).state,
    "unknown"
  );
});

test("open promises without a due date remain undated", () => {
  const input = baseInput();
  input.tasks = [];
  input.promises = [
    {
      promiseCode: "collect_payment",
      state: "open",
      ownerRef: OWNER_REF,
      madeAt: "2026-07-28T12:00:00.000Z",
      dueAt: null,
      source: "jobnimbus",
      evidenceRef: ref(16),
      observedAt: "2026-07-28T12:00:00.000Z"
    }
  ];

  const result = deriveFileIntelligence(input);
  const promise = result.openPromises[0];
  const action = result.nextRequiredActions.find(
    ({ actionCode }) => actionCode === "fulfill_open_promise"
  );

  assert.equal(promise.dueAt, null);
  assert.equal(promise.overdue, false);
  assert.equal(action.dueAt, null);
  assert.equal(
    result.facts.find(({ factCode }) => factCode === "payment_status").state,
    "unknown"
  );
  assert.equal(
    result.facts.find(({ factCode }) => factCode === "coverage_decision").state,
    "unknown"
  );
});

test("missing owner lowers confidence and blocks communication and follow-up work", () => {
  const input = baseInput();
  input.ownerRef = null;
  input.ownerEvidenceRef = null;

  const result = deriveFileIntelligence(input);

  assert.equal(result.ownerRef, null);
  assert.equal(result.confidence.level, "low");
  assert.ok(
    result.missingFacts.some(
      ({ factCode }) => factCode === "owner_assignment"
    )
  );
  assert.equal(result.workflows.communications.readiness, "blocked");
  assert.equal(result.workflows.follow_up.readiness, "blocked");
  assert.ok(
    result.workflows.follow_up.blockers.some(
      ({ blockerCode }) => blockerCode === "owner_assignment_missing"
    )
  );
});

test("inactive files make every workflow ineligible without proposing actions", () => {
  const input = baseInput();
  input.fileStatus = "inactive";

  const result = deriveFileIntelligence(input);
  for (const workflow of Object.values(result.workflows)) {
    assert.equal(workflow.eligibility, "ineligible");
    assert.equal(workflow.readiness, "not_applicable");
    assert.equal(workflow.nextActions.length, 0);
  }
});

test("normalization is strict, bounded, and rejects ambiguous records", () => {
  const extra = baseInput();
  extra.clientName = "not allowed";
  assert.throws(
    () => normalizeFileEvidence(extra),
    (error) =>
      error instanceof FileIntelligenceContractError &&
      /clientName is not allowed/.test(error.message)
  );

  const invalidRef = baseInput();
  invalidRef.fileRef = "JN-123";
  assert.throws(
    () => deriveFileState(invalidRef),
    /fileEvidence\.fileRef must be an opaque reference/
  );

  const overLimit = baseInput();
  overLimit.events = Array.from({ length: 513 }, (_, index) =>
    event(
      ref(1000 + index),
      "system_sync",
      "2026-07-30T10:00:00.000Z"
    )
  );
  assert.throws(
    () => normalizeFileEvidence(overLimit),
    /at most 512 items/
  );

  const sharedEvidence = baseInput();
  sharedEvidence.facts[1].evidenceRef = sharedEvidence.facts[0].evidenceRef;
  assert.doesNotThrow(() => normalizeFileEvidence(sharedEvidence));
});

test("input order cannot change derived intelligence", () => {
  const original = baseInput();
  const reordered = clone(original);
  reordered.sources.reverse();
  reordered.facts.reverse();
  reordered.documents.reverse();
  reordered.events.reverse();
  reordered.tasks.reverse();
  reordered.promises.reverse();

  assert.deepEqual(
    deriveFileIntelligence(original),
    deriveFileIntelligence(reordered)
  );
});

test("named workflow evaluation rejects non-derived or unknown states", () => {
  assert.throws(
    () => evaluateWorkflow("claim_filing", {}),
    /requires a derived HCN file intelligence state/
  );
  assert.throws(
    () => evaluateWorkflow("anything_else", deriveFileState(baseInput())),
    /unsupported HCN workflow/
  );
});
