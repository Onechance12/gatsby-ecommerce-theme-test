import assert from "node:assert/strict";
import test from "node:test";

import {
  hcnAssistantFileReviewProjectionLimitBytes,
  projectHcnAssistantFileReview
} from "./file-review-projection.js";

const FILE_REF = `subject_${"a".repeat(32)}`;
const EVIDENCE_REF = `ref_${"b".repeat(32)}`;

test("file review projection preserves operational truth within provider replay budget", () => {
  const repeated = (factory) => Array.from(
    { length: 20 },
    (_, index) => factory(index)
  );
  const review = {
    schema: "hcn.console.file.v1",
    generatedAt: "2026-08-04T16:00:00.000Z",
    evidenceStatus: "partial",
    file: {
      fileRef: FILE_REF,
      jobNumber: "2672",
      displayName: "Assigned file",
      statusCode: "ready_for_pa_review",
      stageCode: "estimate",
      updatedAt: "2026-08-04T15:00:00.000Z",
      client: { primaryEmail: "client@example.com", primaryPhone: "5550000000" },
      property: { address: "Bounded property address" },
      insurance: {
        carrierName: "Carrier",
        claimNumber: "claim",
        policyNumber: "policy",
        dateOfLoss: "2026-07-01",
        damageFactsPresent: true
      },
      adjuster: { name: "Adjuster", email: "adjuster@example.com", phone: "5551111111" },
      missing: { claimNumber: false },
      futurePrivateField: "must-not-cross-model-boundary"
    },
    sources: {
      jobnimbus: source("jobnimbus", "complete"),
      gmail: source("gmail", "partial"),
      quo: source("quo", "complete")
    },
    lanes: {
      priority: repeated((index) => lane("reply_required", index)),
      today: repeated((index) => lane("file_review_today", index)),
      waiting: repeated((index) => lane("awaiting_response", index))
    },
    recent: {
      activities: repeated((index) => ({
        reference: EVIDENCE_REF,
        kind: "note",
        state: "complete",
        occurredAt: instant(index),
        actorRole: "employee",
        label: "A".repeat(160)
      })),
      tasks: repeated((index) => ({
        reference: EVIDENCE_REF,
        kind: "follow_up",
        status: "open",
        priority: "normal",
        dueAt: instant(index),
        assignedRole: "employee",
        label: "T".repeat(160)
      })),
      documents: repeated((index) => ({
        reference: EVIDENCE_REF,
        kind: "estimate",
        reviewState: "needs_review",
        createdAt: instant(index),
        fileName: "D".repeat(160)
      })),
      gmail: repeated((index) => ({
        reference: evidenceRef(index),
        direction: "inbound",
        occurredAt: instant(index),
        hasAttachment: true,
        deliveryState: "received",
        actionState: "needs_reply",
        subject: "S".repeat(160),
        snippet: "G".repeat(240)
      })),
      quo: repeated((index) => ({
        reference: EVIDENCE_REF,
        channel: "text",
        direction: "inbound",
        occurredAt: instant(index),
        disposition: "delivered",
        actionState: "needs_reply",
        preview: "Q".repeat(240)
      }))
    },
    intelligence: oversizedIntelligence(repeated),
    thresher: {
      secretInternalPersistenceReceipt: "must-not-reach-model"
    }
  };
  const actionableLaterReference = review.recent.gmail[10].reference;
  review.lanes.priority[0].reference = actionableLaterReference;

  const projected = projectHcnAssistantFileReview(review);
  const serialized = JSON.stringify(projected);

  assert.equal(projected.schema, "hcn.console.file.v1");
  assert.equal(projected.file.fileRef, FILE_REF);
  assert.equal(projected.sources.jobnimbus.completeness, "complete");
  assert.equal(
    projected.intelligence.lastMeaningfulActivity.occurredAt,
    "2026-08-04T15:00:00.000Z"
  );
  assert.equal(
    projected.intelligence.workflows.follow_up.readiness,
    "partially_ready"
  );
  assert.equal(projected.recent.activities.returnedCount, 1);
  assert.equal(projected.recent.gmail.returnedCount, 1);
  assert.equal(projected.recent.gmail.omittedCount, 19);
  assert.equal(
    projected.recent.gmail.items.some(
      (item) => item.reference === actionableLaterReference
    ),
    true
  );
  assert.equal(projected.lanes.priority.length, 20);
  assert.equal(Object.hasOwn(projected, "thresher"), false);
  assert.doesNotMatch(
    serialized,
    /must-not-reach-model|must-not-cross-model-boundary/
  );
  assert.deepEqual(
    projected.projection.availableFollowUpCatalogs,
    {
      documents: true,
      photos: true,
      activities: false,
      tasks: false,
      gmail: false,
      quo: false
    }
  );
  assert.ok(
    Buffer.byteLength(serialized, "utf8")
      <= hcnAssistantFileReviewProjectionLimitBytes()
  );
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.recent.activities), true);
});

function source(name, completeness) {
  return {
    source: name,
    status: "fresh",
    completeness,
    failureCode: completeness === "complete" ? null : "source_partial",
    asOf: "2026-08-04T15:59:00.000Z",
    checkedAt: "2026-08-04T16:00:00.000Z",
    validUntil: "2026-08-04T16:05:00.000Z",
    acceptedItems: 20,
    droppedItems: 0
  };
}

function lane(reasonCode, index) {
  return {
    reasonCode,
    source: "jobnimbus",
    reference: EVIDENCE_REF,
    at: instant(index)
  };
}

function instant(index) {
  return new Date(Date.UTC(2026, 7, 4, 15, 0, index)).toISOString();
}

function evidenceRef(index) {
  return `ref_${index.toString(16).padStart(32, "0")}`;
}

function oversizedIntelligence(repeated) {
  const take = (count, factory) => repeated(factory).slice(0, count);
  const action = (index) => ({
    actionCode: `review_${index}`,
    targetCode: "assigned_file",
    dueAt: instant(index),
    evidenceRefs: [EVIDENCE_REF],
    requiresApproval: false
  });
  const blocker = (index) => ({
    blockerCode: `blocker_${index}`,
    targetCode: "source",
    evidenceRefs: [EVIDENCE_REF]
  });
  const workflow = (workflowId) => ({
    workflowId,
    eligibility: "eligible",
    readiness: "partially_ready",
    requiredFacts: take(5, (index) => ({ factCode: `fact_${index}`, state: "unknown", evidenceRefs: [EVIDENCE_REF] })),
    requiredDocuments: take(3, (index) => ({ documentCode: `doc_${index}`, state: "unknown", evidenceRefs: [EVIDENCE_REF] })),
    blockers: take(8, blocker),
    evidenceRefs: take(20, () => EVIDENCE_REF),
    nextActions: take(4, action),
    escalationFlags: take(4, (index) => `flag_${index}`),
    metrics: { verifiedActivityGapDays: 12, awaitingResponseCount: 3 }
  });
  return {
    schemaVersion: "hcn.file-intelligence.v1",
    generatedAt: "2026-08-04T16:00:00.000Z",
    fileRef: FILE_REF,
    fileStatus: "active",
    ownerRef: `employee_${"c".repeat(32)}`,
    ownerEvidenceRef: EVIDENCE_REF,
    currentStage: { code: "estimate", state: "confirmed", source: "jobnimbus", evidenceRefs: [EVIDENCE_REF] },
    lastMeaningfulActivity: { eventCode: "note", occurredAt: "2026-08-04T15:00:00.000Z", source: "jobnimbus", evidenceRef: EVIDENCE_REF },
    lastMeaningfulContact: { eventCode: "text_received", occurredAt: "2026-08-03T15:00:00.000Z", source: "quo", evidenceRef: EVIDENCE_REF },
    openPromises: [],
    missingFacts: take(6, (index) => ({ factCode: `fact_${index}`, state: "unknown", evidenceRefs: [EVIDENCE_REF] })),
    missingDocuments: take(4, (index) => ({ documentCode: `document_${index}`, state: "unknown", evidenceRefs: [EVIDENCE_REF] })),
    overdueTasks: repeated(action),
    nextRequiredActions: take(32, action),
    urgency: { level: "high", reasonCodes: take(8, (index) => `reason_${index}`) },
    confidence: { level: "medium", reasonCodes: take(8, (index) => `confidence_${index}`) },
    conflicts: take(6, (index) => ({ conflictCode: `conflict_${index}`, fieldCode: `field_${index}`, requiresManualReview: true, evidenceRefs: [EVIDENCE_REF] })),
    sourceCompleteness: {
      status: "partial",
      freshSources: 2,
      completeSources: 2,
      requiredAuthorityAvailable: true,
      sources: [
        { source: "jobnimbus", provided: true, status: "fresh", completeness: "complete" },
        { source: "gmail", provided: true, status: "fresh", completeness: "partial" },
        { source: "quo", provided: true, status: "fresh", completeness: "complete" }
      ]
    },
    unsupportedEvidence: repeated(blocker),
    facts: repeated(blocker),
    documents: repeated(blocker),
    communicationHealth: {
      incompleteDelivery: take(10, (index) => ({ eventCode: `email_failed_${index}`, actionState: "failed", occurredAt: instant(index), source: "gmail" })),
      awaitingResponse: take(10, (index) => ({ eventCode: `email_received_${index}`, actionState: "awaiting_response", occurredAt: instant(index), source: "gmail" })),
      sources: [
        { source: "gmail", status: "fresh", completeness: "partial" },
        { source: "quo", status: "fresh", completeness: "complete" }
      ]
    },
    workflows: {
      neglected_files: workflow("neglected_files"),
      communications: workflow("communications"),
      claim_filing: workflow("claim_filing"),
      inspection_scheduling: workflow("inspection_scheduling"),
      follow_up: workflow("follow_up")
    }
  };
}
