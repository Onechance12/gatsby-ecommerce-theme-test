import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGuardedEndCall } from "./endCallGuard.js";

function call(turns, goal = "file_new_claim") {
  return {
    call_id: "call-test",
    call_status: "ongoing",
    metadata: { goal },
    transcript_object: turns.map(([role, content]) => ({ role, content }))
  };
}

const completedArgs = {
  goal: "file_new_claim",
  reason: "objective_complete",
  outcome: "claim_filed",
  claim_number: "430J1Z808",
  callback_confirmed: false,
  document_submission_requested: true,
  next_step_requested: true
};

test("blocks the exact Emigdio-style representative wait state", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "Just give me one second. I'll just let you know if I have a question. Okay?"],
      ["agent", "Thank you for all of your help. Have a blessed day."]
    ]),
    args: { ...completedArgs, outcome: "no_result", claim_number: "", document_submission_requested: false, next_step_requested: false }
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "active_wait_state");
});

test("blocks a claimed completion when the claim number is absent", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "That should be everything. Have a good day."],
      ["agent", "Thank you."]
    ]),
    args: { ...completedArgs, claim_number: "" }
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "missing_verified_claim_number");
});

test("blocks a model-supplied claim number that the transcript does not contain", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "Your claim has been filed. Have a great day."],
      ["agent", "Thank you."]
    ]),
    args: completedArgs
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "missing_verified_claim_number");
});

test("allows a completed filing only after claim number, closing questions, and goodbye", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "The claim number is 430J1Z808."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You're all set. Have a great day."],
      ["agent", "Thank you for all of your help. Have a blessed day."]
    ]),
    args: completedArgs
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "objective_complete");
});

test("allows the operator find_existing_claim goal after a transcript-backed existing claim", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "I found the existing claim. The claim number is 430J1Z808."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You're all set. Have a great day."],
      ["agent", "Thank you."]
    ], "find_existing_claim"),
    args: {
      ...completedArgs,
      goal: "find_existing_claim",
      outcome: "existing_claim_confirmed"
    }
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "objective_complete");
});

test("accepts a claim number spoken one digit word at a time", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "The claim number is zero eight three three three seven five one seven three."],
      ["agent", "Where should I send the LOR and what is the next step?"],
      ["user", "Use claims at claims dot allstate dot com. We will call within three days. Have a good day."],
      ["agent", "Thank you."]
    ]),
    args: { ...completedArgs, claim_number: "0833375173" }
  });
  assert.equal(decision.allowed, true);
});

test("blocks wrap-up when an approved same-carrier batch was never attempted", () => {
  const batchCall = call([
    ["user", "The claim number is zero eight three three three seven five one seven three."],
    ["agent", "Where should I send the LOR and what is the next step?"],
    ["user", "Use the claims email. We will call within three days. Have a good day."],
    ["agent", "Thank you."]
  ]);
  batchCall.metadata.batchContactIds = "contact-carson";
  batchCall.retell_llm_dynamic_variables = { goal: "file_new_claim", batchClaimCount: "1" };
  const decision = evaluateGuardedEndCall({
    call: batchCall,
    args: { ...completedArgs, claim_number: "0833375173", additional_claims_completed: 0, additional_claim_numbers: "", batch_continuation_resolved: false }
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "batch_claim_not_attempted");
});

test("allows wrap-up after the approved additional claim is completed", () => {
  const batchCall = call([
    ["user", "The first claim number is zero eight three three three seven five one seven three."],
    ["agent", "Could you also help me open a claim for another policyholder?"],
    ["user", "The second claim number is four three zero J one Z eight zero eight."],
    ["agent", "Where should I send the LOR and what is the next step?"],
    ["user", "Use the claims email. We will call within three days. Have a good day."],
    ["agent", "Thank you."]
  ]);
  batchCall.metadata.batchContactIds = "contact-carson";
  batchCall.retell_llm_dynamic_variables = { goal: "file_new_claim", batchClaimCount: "1" };
  const decision = evaluateGuardedEndCall({
    call: batchCall,
    args: { ...completedArgs, claim_number: "0833375173", additional_claims_completed: 1, additional_claim_numbers: "430J1Z808", batch_continuation_resolved: true }
  });
  assert.equal(decision.allowed, true);
});

test("allows a verified callback only after an explicit queue and carrier goodbye", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "I queued the callback and the claims team will call you within one business day. Have a good day."],
      ["agent", "Thank you."]
    ]),
    args: {
      ...completedArgs,
      reason: "callback_confirmed",
      outcome: "callback_requested",
      claim_number: "",
      callback_confirmed: true
    }
  });
  assert.equal(decision.allowed, true);
});
