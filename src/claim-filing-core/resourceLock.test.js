import assert from "node:assert/strict";
import test from "node:test";

import { evaluateClaimCallResource } from "./resourceLock.js";

const ended = (overrides = {}) => ({
  callId: "call-1",
  callStatus: "ended",
  callbackConfirmed: false,
  callbackStatus: "",
  createdAt: 100,
  goal: "file_new_claim",
  outcome: "no_result",
  claimNumber: "",
  ...overrides
});

test("claim-call resource blocks provider windows, active calls, and confirmed callbacks", () => {
  assert.equal(evaluateClaimCallResource({
    unresolvedReservations: [{ callStatus: "provider_outcome_unknown" }]
  }).code, "provider_outcome_unresolved");
  assert.equal(evaluateClaimCallResource({
    attempts: [ended({ callStatus: "registered" })]
  }).code, "claim_call_active");
  assert.equal(evaluateClaimCallResource({
    attempts: [ended({ callbackConfirmed: true })]
  }).code, "claim_callback_pending");
  assert.equal(evaluateClaimCallResource({
    attempts: [ended({ callbackConfirmed: true, callbackStatus: "ongoing" })]
  }).code, "claim_callback_active");
});

test("claim-call resource requires the latest ended call id across changed plan digests", () => {
  const attempts = [
    ended({ callId: "call-1", createdAt: 100 }),
    ended({ callId: "call-2", createdAt: 200 })
  ];
  assert.equal(evaluateClaimCallResource({ attempts }).code, "latest_call_id_required");
  assert.equal(evaluateClaimCallResource({ attempts, retryOfCallId: "call-1" }).code, "stale_retry_lineage");
  assert.deepEqual(evaluateClaimCallResource({ attempts, retryOfCallId: "call-2" }), {
    allowed: true,
    code: "retry_of_latest_ended_call",
    latestPriorCallId: "call-2"
  });
});

test("claim-call resource permits safer new-to-existing lookup but not existing-to-new escalation", () => {
  assert.equal(evaluateClaimCallResource({
    attempts: [ended()],
    requestedGoal: "find_existing_claim",
    retryOfCallId: "call-1"
  }).allowed, true);
  assert.equal(evaluateClaimCallResource({
    attempts: [ended({ goal: "find_existing_claim" })],
    requestedGoal: "file_new_claim",
    retryOfCallId: "call-1"
  }).code, "unsafe_goal_escalation");
});

test("claim-call resource never redials after a claim result", () => {
  assert.equal(evaluateClaimCallResource({
    attempts: [ended({ outcome: "existing_claim_confirmed", claimNumber: "ABC-1" })],
    requestedGoal: "find_existing_claim",
    retryOfCallId: "call-1"
  }).code, "claim_already_captured");
  assert.equal(evaluateClaimCallResource({
    attempts: [
      ended({ callId: "call-with-claim", outcome: "claim_filed", claimNumber: "ABC-1", createdAt: 100 }),
      ended({ callId: "later-no-result", outcome: "no_result", claimNumber: "", createdAt: 200 })
    ],
    retryOfCallId: "later-no-result"
  }).code, "claim_already_captured");
});
