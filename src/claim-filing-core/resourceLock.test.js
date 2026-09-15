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

test("confirmed-callback lock expires only at the explicit TTL boundary", () => {
  const pending = ended({ callbackConfirmed: true, createdAt: 1_000 });
  assert.equal(evaluateClaimCallResource({
    attempts: [pending],
    retryOfCallId: "call-1",
    callbackTtlMs: 500,
    nowMs: 1_499
  }).code, "claim_callback_pending");
  assert.deepEqual(evaluateClaimCallResource({
    attempts: [pending],
    retryOfCallId: "call-1",
    callbackTtlMs: 500,
    nowMs: 1_500
  }), {
    allowed: true,
    code: "retry_of_latest_ended_call",
    latestPriorCallId: "call-1"
  });
});

test("expired callback confirmation still requires exact latest-call retry lineage", () => {
  const expired = ended({ callbackConfirmed: true, createdAt: 1_000 });
  assert.equal(evaluateClaimCallResource({
    attempts: [expired],
    callbackTtlMs: 500,
    nowMs: 2_000
  }).code, "latest_call_id_required");
  assert.equal(evaluateClaimCallResource({
    attempts: [expired],
    retryOfCallId: "call-other",
    callbackTtlMs: 500,
    nowMs: 2_000
  }).code, "stale_retry_lineage");
});

test("invalid callback timing fails closed and an active continuation never expires", () => {
  for (const options of [
    { callbackTtlMs: 500, nowMs: 2_000, createdAt: 0 },
    { callbackTtlMs: 0, nowMs: 2_000, createdAt: 1_000 },
    { callbackTtlMs: 500, nowMs: Number.NaN, createdAt: 1_000 }
  ]) {
    assert.equal(evaluateClaimCallResource({
      attempts: [ended({ callbackConfirmed: true, createdAt: options.createdAt })],
      retryOfCallId: "call-1",
      callbackTtlMs: options.callbackTtlMs,
      nowMs: options.nowMs
    }).code, "claim_callback_pending");
  }
  assert.equal(evaluateClaimCallResource({
    attempts: [ended({
      callbackConfirmed: true,
      callbackStatus: "ongoing",
      createdAt: 1_000
    })],
    retryOfCallId: "call-1",
    callbackTtlMs: 500,
    nowMs: 2_000
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
