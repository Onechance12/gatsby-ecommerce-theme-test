import assert from "node:assert/strict";
import test from "node:test";
import { createGmailCorrelationAudit } from "./correlation-audit.js";

test("correlation audit copies only fixed reasons and evidence locations, never private values", () => {
  const collector = createGmailCorrelationAudit();
  const privateValue = "PRIVATE-SYNTHETIC-VALUE";
  collector.record({ complete: true, targetMatch: true, conflictingFileIds: [privateValue],
    id: privateValue, message: privateValue, audit: {
      uniqueClientEmail: false, uniqueClaim: true, policyPropertyBindingAvailable: false,
      matchedBy: ["unique_claim_identifier", privateValue],
      target: [{ kind: "claim_identifier", locations: ["subject", privateValue], value: privateValue }],
      conflicts: [{ kind: "client_email_header", locations: ["bcc", privateValue], id: privateValue },
        { kind: "client_email_header", locations: ["to", "bcc"] }, { kind: privateValue, locations: ["from"] }]
    } });
  const result = collector.snapshot();
  assert.equal(result.readOnly, true);
  assert.equal(result.changesAdmission, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SYNTHETIC-VALUE/);
  assert.deepEqual(result.rows, [{ candidateNumber: 1, disposition: "withheld",
    decision: "conflicting_file_evidence", evidenceTraceAvailable: true,
    target: { match: true, uniqueClientEmail: false, uniqueClaim: true,
      policyPropertyBindingAvailable: false, matchedBy: ["unique_claim_identifier"],
      observations: [{ kind: "claim_identifier", locations: ["subject"] }] },
    conflicts: [{ kind: "client_email_header", locations: ["to", "bcc"] }] }]);
});

test("correlation audit short-circuits all later predicates and traces for an incomplete index", () => {
  const collector = createGmailCorrelationAudit();
  const fail = () => { throw new Error("later predicate must not be inspected"); };
  collector.record({ complete: false,
    get targetMatch() { return fail(); }, get conflictingFileIds() { return fail(); },
    get conflictingFileReference() { return fail(); }, get audit() { return fail(); } });
  assert.deepEqual(collector.snapshot().rows, [{ candidateNumber: 1,
    disposition: "withheld", decision: "incomplete_correlation_index" }]);
});

test("correlation audit preserves missing evidence and other-file exclusions as different outcomes", () => {
  const collector = createGmailCorrelationAudit();
  collector.record({ complete: true, targetMatch: false, conflictingFileIds: [] });
  collector.record({ complete: true, targetMatch: false, conflictingFileIds: ["private-other"] }, { excludedOtherFile: true });
  collector.record({ complete: true, targetMatch: true, conflictingFileIds: [] });
  assert.deepEqual(collector.snapshot().rows.map(row => [row.disposition, row.decision]), [
    ["withheld", "missing_unique_target_evidence"],
    ["excluded_other_file", "conflicting_file_evidence"], ["matched", "matched"]
  ]);
  assert.equal(collector.snapshot().rows[0].evidenceTraceAvailable, false);
});

test("an exclusion hint cannot mark missing, incomplete or mixed target evidence as unrelated", () => {
  const collector = createGmailCorrelationAudit();
  for (const row of [
    { complete: false },
    { complete: true, targetMatch: false, conflictingFileIds: [] },
    { complete: true, targetMatch: true, conflictingFileIds: ["private-other"] }
  ]) collector.record(row, { excludedOtherFile: true });
  assert.deepEqual(collector.snapshot().rows.map(row => row.disposition), ["withheld", "withheld", "withheld"]);
});

test("correlation audit has a fixed candidate bound, fresh response identity and immutable snapshots", () => {
  const collector = createGmailCorrelationAudit();
  const row = { complete: true, targetMatch: true, conflictingFileIds: [] };
  for (let i = 0; i < 251; i++) collector.record(row);
  const result = collector.snapshot();
  assert.equal(result.scannedCandidates, 251);
  assert.equal(result.reportedCandidates, 250);
  assert.equal(result.omittedCandidates, 1);
  assert.equal(result.rows.at(-1).candidateNumber, 250);
  result.rows[0].decision = "tampered";
  assert.equal(collector.snapshot().rows[0].decision, "matched");
  assert.notEqual(result.auditId, createGmailCorrelationAudit().snapshot().auditId);
});

test("claim boundary diagnostics cannot serialize arbitrary reasons, locations or evidence values", () => {
  const collector = createGmailCorrelationAudit();
  collector.record({ complete: true, targetMatch: false, conflictingFileIds: [], audit: {
    claimCheck: { matched: false, reason: "longer_identifier_boundary", value: "PRIVATE-CLAIM",
      rejectedBoundaries: [{ reason: "longer_identifier_suffix", locations: ["attachment_name", "PRIVATE-LOCATION"], value: "PRIVATE-FILENAME" },
        { reason: "PRIVATE-REASON", locations: ["subject"] }] }
  } });
  assert.deepEqual(collector.snapshot().rows[0].target.claimCheck, {
    matched: false, reason: "longer_identifier_boundary",
    rejectedBoundaries: [{ reason: "longer_identifier_suffix", locations: ["attachment_name"] }]
  });
  assert.doesNotMatch(JSON.stringify(collector.snapshot()), /PRIVATE-/);
});
