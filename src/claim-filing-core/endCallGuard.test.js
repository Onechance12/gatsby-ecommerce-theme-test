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
