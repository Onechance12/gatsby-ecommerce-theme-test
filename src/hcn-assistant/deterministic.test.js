import assert from "node:assert/strict";
import test from "node:test";

import {
  extractDeterministicJobNumber,
  formatCodexEscalation,
  formatDeterministicAssignedWorkSummary,
  formatDeterministicFileStatus,
  formatDeterministicManagementSweep,
  formatDeterministicWorkCenter
} from "./deterministic.js";

test("extracts one exact numeric JobNimbus number and rejects ambiguity", () => {
  assert.equal(
    extractDeterministicJobNumber("Show me the status of file #2862."),
    "2862"
  );
  assert.equal(
    extractDeterministicJobNumber("Compare job 2862 and job 2863."),
    null
  );
});

test("formats a bounded Work Center answer without opaque references", () => {
  const message = formatDeterministicWorkCenter({
    page: { total: 2, hasMore: false },
    files: [
      {
        fileRef: `subject_${"a".repeat(32)}`,
        jobNumber: "2862",
        displayName: "Example Homeowner",
        statusCode: "active_claim",
        stageCode: "claim_filed",
        attentionCodes: ["missing_adjuster"]
      }
    ]
  });
  assert.match(message, /2 assigned files/);
  assert.match(message, /2862 · Example Homeowner/);
  assert.match(message, /Missing Adjuster/);
  assert.doesNotMatch(message, /subject_[a-f0-9]{32}/);
  assert.match(message, /Nothing was changed/);
});

test("formats an assigned-work count without file or client detail", () => {
  const forbidden = [
    "Example Homeowner",
    "2862",
    `subject_${"a".repeat(32)}`,
    "client@example.com"
  ];
  const message = formatDeterministicAssignedWorkSummary({
    generatedAt: "2026-08-04T20:00:00.000Z",
    page: { total: 58 },
    source: {
      status: "fresh",
      completeness: "complete",
      checkedAt: "2026-08-04T20:00:00.000Z"
    },
    files: [
      {
        jobNumber: forbidden[1],
        displayName: forbidden[0],
        fileRef: forbidden[2],
        email: forbidden[3]
      }
    ]
  });

  assert.match(message, /Assigned files ready for review: 58/);
  assert.match(message, /Source status: JobNimbus Fresh \/ Complete/);
  assert.match(message, /Checked: 2026-08-04T20:00:00.000Z/);
  assert.match(message, /Nothing changed/);
  for (const value of forbidden) assert.doesNotMatch(message, new RegExp(value));
});

test("assigned-work count fails closed without a verified check time", () => {
  assert.throws(
    () => formatDeterministicAssignedWorkSummary({
      page: { total: 1 },
      source: {
        status: "fresh",
        completeness: "complete",
        checkedAt: "not-a-timestamp"
      }
    }),
    /checkedAt is invalid/
  );
});

test("labels the management sweep as JobNimbus activity only", () => {
  const message = formatDeterministicManagementSweep({
    checkedAt: "2026-07-30T12:00:00.000Z",
    adjusters: [
      {
        name: "Example Adjuster",
        items: [
          {
            display: {
              jobNumber: "2862",
              name: "Example Homeowner"
            },
            stageCode: "adjustment",
            gaps: {
              operationalActivity: { days: 11 }
            }
          }
        ]
      }
    ]
  });
  assert.match(message, /Example Adjuster/);
  assert.match(message, /11 days/);
  assert.match(message, /JobNimbus activity only/);
  assert.match(message, /not evaluated/);
});

test("formats exact file status from proven fields only", () => {
  const message = formatDeterministicFileStatus({
    evidenceStatus: "partial",
    file: {
      jobNumber: "2862",
      displayName: "Example Homeowner",
      statusCode: "active",
      stageCode: "inspection_scheduling",
      updatedAt: "2026-07-29T15:00:00.000Z",
      missing: {
        claimNumber: false,
        policyNumber: false,
        dateOfLoss: true,
        adjuster: true
      }
    },
    lanes: {
      priority: [{ reasonCode: "missing_date_of_loss" }],
      today: []
    }
  });
  assert.match(message, /Inspection Scheduling/);
  assert.match(message, /date of loss, adjuster/);
  assert.match(message, /Evidence is partial/);
});

test("escalation wording never implies an external action occurred", () => {
  const message = formatCodexEscalation(["unsupported_live_call"]);
  assert.match(message, /approval-gated operator workflow/);
  assert.match(
    message,
    /Nothing was changed, sent, called, uploaded, deleted, or paid/
  );
});
