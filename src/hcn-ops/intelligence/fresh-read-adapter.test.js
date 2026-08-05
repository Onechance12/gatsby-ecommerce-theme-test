import assert from "node:assert/strict";
import test from "node:test";

import { deriveFileIntelligence } from "./index.js";
import {
  adaptFreshReviewToFileEvidence
} from "./fresh-read-adapter.js";

const FILE_REF = `subject_${"a".repeat(32)}`;
const OWNER_REF = `employee_${"b".repeat(16)}`;
const OWNER_EVIDENCE_REF = `ref_${"c".repeat(16)}`;

function ref(seed) {
  return `ref_${String(seed).padStart(16, "0")}`;
}

function review() {
  return {
    schema: "hcn.console.file.v1",
    generatedAt: "2026-07-30T12:00:00.000Z",
    evidenceStatus: "complete",
    file: {
      fileRef: FILE_REF,
      jobNumber: "2862",
      displayName: "Synthetic Homeowner",
      statusCode: "active",
      stageCode: "claim_readiness",
      updatedAt: "2026-07-30T10:00:00.000Z",
      nextAppointmentAt: null,
      insurance: {
        carrierName: "Synthetic Carrier",
         claimNumber: "",
         policyNumber: "SYNTHETIC-POLICY",
         dateOfLoss: "2026-05-17",
         damageFactsPresent: false
      },
      adjuster: { name: "", email: "", phone: "" },
      missing: {
        claimNumber: true,
        policyNumber: false,
        dateOfLoss: false,
        adjuster: true
      }
    },
    sources: {
      jobnimbus: {
        source: "jobnimbus",
        status: "fresh",
        completeness: "complete",
        asOf: "2026-07-30T10:00:00.000Z",
        checkedAt: "2026-07-30T11:00:00.000Z",
        validUntil: "2026-07-30T13:00:00.000Z"
      },
      gmail: {
        source: "gmail",
        status: "fresh",
        completeness: "complete",
        asOf: "2026-07-30T10:00:00.000Z",
        checkedAt: "2026-07-30T11:00:00.000Z",
        validUntil: "2026-07-30T13:00:00.000Z"
      },
      quo: {
        source: "quo",
        status: "incomplete",
        completeness: "none",
        failureCode: "source_unavailable",
        asOf: null,
        checkedAt: "2026-07-30T11:00:00.000Z",
        validUntil: null
      }
    },
    recent: {
      activities: [{
        reference: ref(1),
        kind: "status_change",
        state: "completed",
        occurredAt: "2026-07-29T10:00:00.000Z",
        actorRole: "employee",
        label: "Synthetic status"
      }],
      tasks: [{
        reference: ref(2),
        kind: "claim_filing",
        status: "open",
        priority: "high",
        dueAt: "2026-07-29T12:00:00.000Z",
        assignedRole: "employee",
        label: "Synthetic task"
      }],
      documents: [{
        reference: ref(3),
        kind: "declaration_page",
        reviewState: "reviewed",
        createdAt: "2026-07-28T10:00:00.000Z",
        fileName: "synthetic-declaration.pdf"
      }],
      gmail: [{
        reference: ref(4),
       direction: "inbound",
       occurredAt: "2026-07-30T09:00:00.000Z",
       hasAttachment: false,
       deliveryState: "received",
       actionState: "needs_reply",
        subject: "Synthetic",
        snippet: "Synthetic"
      }],
      quo: []
    }
  };
}

const references = {
  evidenceRefFor: (kind, code) =>
    `ref_${Buffer.from(`${kind}:${code}`)
      .toString("hex").slice(0, 16).padEnd(16, "0")}`,
  valueRefFor: (code, value) =>
    `value_${Buffer.from(`${code}:${value}`)
      .toString("hex").slice(0, 16).padEnd(16, "0")}`
};

test("adapts minimized fresh evidence and derives all five workflows", () => {
  const input = adaptFreshReviewToFileEvidence({
    review: review(),
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  const intelligence = deriveFileIntelligence(input);

  assert.equal(intelligence.currentStage.code, "claim_readiness");
  assert.equal(intelligence.ownerRef, OWNER_REF);
  assert.equal(
    intelligence.workflows.claim_filing.readiness,
    "blocked"
  );
  assert.equal(
    intelligence.workflows.communications.escalationFlags
      .includes("response_due"),
    true
  );
  assert.equal(
    intelligence.sourceCompleteness.status,
    "partial"
  );
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(intelligence.workflows), true);
  assert.doesNotMatch(
    JSON.stringify(intelligence),
    /SYNTHETIC-POLICY|Synthetic Homeowner|Synthetic Carrier/
  );
});

test("unsupported source and presentation values cannot become raw output", () => {
  const candidate = review();
  candidate.file.insurance.carrierName =
    "PRIVATE-CARRIER-NEVER-OUTPUT";
  candidate.sources.gmail = {
    source: "gmail",
    status: "incomplete",
    completeness: "none",
    failureCode: "source_stale",
    asOf: null,
    checkedAt: "2026-07-30T11:00:00.000Z",
    validUntil: null
  };
  const input = adaptFreshReviewToFileEvidence({
    review: candidate,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  assert.equal(
    input.sources.find(({ source }) => source === "gmail").status,
    "stale"
  );
  assert.doesNotMatch(
    JSON.stringify(input),
    /PRIVATE-CARRIER-NEVER-OUTPUT/
  );
});

test("JobNimbus status does not masquerade as an authoritative stage", () => {
  const candidate = review();
  candidate.file.stageCode = "unknown";
  candidate.file.statusCode = "ready_for_pa_review";
  const input = adaptFreshReviewToFileEvidence({
    review: candidate,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  const intelligence = deriveFileIntelligence(input);

  assert.equal(input.stages[0].stageCode, "unknown");
  assert.equal(intelligence.currentStage.code, "unknown");
  assert.equal(intelligence.currentStage.source, "jobnimbus");
});

test("unsupported JobNimbus stage and status remain fail-closed unknown", () => {
  const candidate = review();
  candidate.file.stageCode = "unknown";
  candidate.file.statusCode = "unmapped_custom_board_status";
  const input = adaptFreshReviewToFileEvidence({
    review: candidate,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  const intelligence = deriveFileIntelligence(input);

  assert.equal(input.stages[0].stageCode, "unknown");
  assert.equal(intelligence.currentStage.code, "unknown");
});

test("estimate completion status is not misclassified as a closed file", () => {
  const candidate = review();
  candidate.file.stageCode = "estimate_completed";
  const input = adaptFreshReviewToFileEvidence({
    review: candidate,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });

  assert.equal(input.stages[0].stageCode, "estimate");
});

test("draft Gmail is never verified contact or response due", () => {
  const candidate = review();
  candidate.recent.gmail = [{
    reference: ref(8),
    direction: "outbound",
    occurredAt: "2026-07-30T09:30:00.000Z",
    hasAttachment: false,
    deliveryState: "draft",
    actionState: "draft",
    subject: "Synthetic draft",
    snippet: "Synthetic"
  }];
  const input = adaptFreshReviewToFileEvidence({
    review: candidate,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  const intelligence = deriveFileIntelligence(input);

  assert.equal(
    input.events.some(({ eventCode }) =>
      eventCode === "email_sent_verified"
    ),
    false
  );
  assert.equal(
    input.events.some(({ eventCode }) => eventCode === "email_draft"),
    true
  );
  assert.equal(intelligence.lastMeaningfulContact, null);
  assert.equal(
    intelligence.workflows.communications.escalationFlags
      .includes("response_due"),
    false
  );
});

test("automated JobNimbus task reminders are system evidence, not contact or response due", () => {
  const candidate = review();
  candidate.recent.gmail = [{
    reference: ref(9),
    direction: "inbound",
    occurredAt: "2026-07-30T09:30:00.000Z",
    hasAttachment: false,
    deliveryState: "received",
    actionState: "no_action",
    subject: "JobNimbus Task Reminders",
    snippet: "Tasks are due."
  }];
  const input = adaptFreshReviewToFileEvidence({
    review: candidate,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  const intelligence = deriveFileIntelligence(input);

  assert.equal(
    input.events.some(({ eventCode }) => eventCode === "reminder_generated"),
    true
  );
  assert.equal(intelligence.lastMeaningfulContact, null);
  assert.equal(
    intelligence.workflows.communications.escalationFlags
      .includes("response_due"),
    false
  );
});

test("scheduling requires a real contact channel and supported facts can make claim filing ready", () => {
  const nameOnly = review();
  nameOnly.file.adjuster = {
    name: "Name Without A Channel",
    email: "",
    phone: ""
  };
  nameOnly.file.missing.adjuster = false;
  const nameOnlyInput = adaptFreshReviewToFileEvidence({
    review: nameOnly,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  const nameOnlyIntelligence = deriveFileIntelligence(nameOnlyInput);
  assert.equal(
    nameOnlyIntelligence.workflows.inspection_scheduling.metrics
      .schedulingContactAvailable,
    false
  );

  const wrongDestination = review();
  wrongDestination.file.adjuster = {
    name: "Synthetic Adjuster",
    email: "adjuster@example.test",
    phone: ""
  };
  wrongDestination.file.missing.adjuster = false;
  wrongDestination.file.insurance.damageFactsPresent = true;
  const wrongDestinationInput = adaptFreshReviewToFileEvidence({
    review: wrongDestination,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  const wrongDestinationIntelligence =
    deriveFileIntelligence(wrongDestinationInput);
  assert.equal(
    wrongDestinationIntelligence.workflows.claim_filing.readiness,
    "blocked"
  );
  assert.equal(
    wrongDestinationIntelligence.missingFacts.some(
      (fact) => fact.factCode === "carrier_contact"
    ),
    true
  );

  const ready = review();
  ready.file.insurance.carrierName = "State Farm";
  ready.file.insurance.damageFactsPresent = true;
  const readyInput = adaptFreshReviewToFileEvidence({
    review: ready,
    ownerRef: OWNER_REF,
    ownerEvidenceRef: OWNER_EVIDENCE_REF,
    ...references
  });
  const readyIntelligence = deriveFileIntelligence(readyInput);
  assert.equal(
    readyIntelligence.workflows.claim_filing.readiness,
    "ready"
  );
  assert.equal(
    readyIntelligence.workflows.claim_filing.metrics
      .missingRequiredFactCount,
    0
  );
  assert.doesNotMatch(
    JSON.stringify({
      wrongDestinationIntelligence,
      readyIntelligence
    }),
    /adjuster@example\.test|Synthetic Adjuster/
  );
});
