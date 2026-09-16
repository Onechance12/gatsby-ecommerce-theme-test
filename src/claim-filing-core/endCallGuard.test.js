import assert from "node:assert/strict";
import test from "node:test";

import { confirmedCallbackRequest } from "./callbackConfirmation.js";
import { evaluateGuardedEndCall } from "./endCallGuard.js";

function call(turns, goal = "file_new_claim") {
  return {
    call_id: "call-test",
    call_status: "ongoing",
    metadata: { goal },
    retell_llm_dynamic_variables: {
      goal,
      coverageTermStatus: goal === "file_new_claim" ? "verified_in_force" : "not_applicable"
    },
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

const NATURAL_FINAL_CLOSING = "I really appreciate all your help. I hope you have a blessed day. Goodbye.";
const REPRESENTATIVE_GOODBYE = "You too. Goodbye.";

test("callback confirmation requires affirmative carrier evidence", () => {
  const rejected = [
    call([["agent", "I requested a callback and we will call you back."]]),
    call([["user", "Press one if you would like a callback."]]),
    call([["user", "I requested a callback."]]),
    call([["user", "Your callback request was received."]]),
    call([["user", "Your callback request has been submitted."]]),
    call([["user", "Your callback request is pending."]]),
    call([["user", "Your callback request has not yet been confirmed."]]),
    call([["user", "The callback is not guaranteed."]]),
    call([["user", "A representative may or may not call you back."]]),
    call([["user", "We will call you back if the request is approved."]]),
    call([["user", "If an agent is available, we will call you back."]]),
    call([["user", "The callback request was not confirmed."]]),
    call([["user", "The callback request was canceled."]]),
    {
      transcript: "Agent: We will call you back.\nUser: I cannot confirm a callback."
    }
  ];
  for (const candidate of rejected) {
    assert.equal(confirmedCallbackRequest(candidate), false);
  }

  assert.equal(confirmedCallbackRequest(call([
    ["agent", "Can I request a callback?"],
    ["user", "I queued the callback. The claims team will call you back."]
  ])), true);
  assert.equal(confirmedCallbackRequest(call([
    ["user", "We received your request, and your callback has now been confirmed."]
  ])), true);
  assert.equal(confirmedCallbackRequest(call([
    ["user", "Your callback request was submitted and is now scheduled for tomorrow."]
  ])), true);
  assert.equal(confirmedCallbackRequest({
    transcript: "Your request for a callback has been confirmed."
  }), false);
});

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

test("blocks a claim number spoken only by the AI agent", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["agent", "The claim number is 430J1Z808."],
      ["user", "Goodbye."]
    ]),
    args: completedArgs
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "missing_verified_claim_number");

  const fallbackDecision = evaluateGuardedEndCall({
    call: {
      metadata: { goal: "file_new_claim" },
      retell_llm_dynamic_variables: {
        goal: "file_new_claim",
        coverageTermStatus: "verified_in_force"
      },
      transcript: "Caller: The claim number is 430J1Z808.\nRepresentative: Goodbye."
    },
    args: completedArgs
  });
  assert.equal(fallbackDecision.allowed, false);
  assert.equal(fallbackDecision.code, "missing_verified_claim_number");
});

test("accepts an exact claim-number readback only after carrier affirmation", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["agent", "To confirm, is the claim number 430J1Z808?"],
      ["user", "Yes, that is correct."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You are all set. Goodbye."],
      ["agent", NATURAL_FINAL_CLOSING],
      ["user", REPRESENTATIVE_GOODBYE]
    ]),
    args: completedArgs
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "objective_complete");
});

test("carrier denial or correction cancels claim-number proof", () => {
  const sameTurnDenial = evaluateGuardedEndCall({
    call: call([
      ["agent", "Is the claim number 430J1Z808?"],
      ["user", "No, 430J1Z808 is not the claim number."],
      ["user", "Goodbye."]
    ]),
    args: completedArgs
  });
  assert.equal(sameTurnDenial.allowed, false);
  assert.equal(sameTurnDenial.code, "missing_verified_claim_number");

  const laterCorrection = evaluateGuardedEndCall({
    call: call([
      ["user", "The claim number is 430J1Z808."],
      ["user", "Correction, that claim number is wrong."],
      ["user", "Goodbye."]
    ]),
    args: completedArgs
  });
  assert.equal(laterCorrection.allowed, false);
  assert.equal(laterCorrection.code, "missing_verified_claim_number");
});

test("lookup-mode filing completes from a carrier-issued claim number without a coverage interrogation", () => {
  const completed = call([
    ["user", "The claim number is four three zero J one Z eight zero eight. Have a good day."],
    ["agent", NATURAL_FINAL_CLOSING],
    ["user", "Thank you. You too."]
  ]);
  completed.retell_llm_dynamic_variables = {
    goal: "file_new_claim",
    coverageTermStatus: "carrier_lookup_required"
  };
  const allowed = evaluateGuardedEndCall({
    call: completed,
    args: completedArgs
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, "objective_complete");

  const noNumber = call([
    ["user", "I found the insured, but I do not have a claim number for you. Goodbye."]
  ]);
  noNumber.retell_llm_dynamic_variables = completed.retell_llm_dynamic_variables;
  const denied = evaluateGuardedEndCall({
    call: noNumber,
    args: { ...completedArgs, claim_number: "" }
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "missing_verified_claim_number");
});

test("new-claim completion fails closed on an invalid coverage disposition", () => {
  const candidate = call([
    ["user", "The claim number is four three zero J one Z eight zero eight. Have a good day."]
  ]);
  candidate.retell_llm_dynamic_variables = { goal: "file_new_claim", coverageTermStatus: "Missing" };
  const decision = evaluateGuardedEndCall({ call: candidate, args: completedArgs });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "invalid_coverage_disposition");
});

test("blocks ending immediately after the agent closing until the representative responds", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "The claim number is 430J1Z808."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You're all set. Have a great day."],
      ["agent", NATURAL_FINAL_CLOSING]
    ]),
    args: completedArgs
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "representative_not_wrapped_after_closing");
});

test("does not mistake a post-closing question for a final acknowledgement", () => {
  const question = evaluateGuardedEndCall({
    call: call([
      ["user", "The claim number is 430J1Z808."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You're all set."],
      ["agent", NATURAL_FINAL_CLOSING],
      ["user", "Thanks, but what is your callback number?"]
    ]),
    args: completedArgs
  });
  assert.equal(question.allowed, false);
  assert.equal(question.code, "representative_not_wrapped_after_closing");

  const resumed = evaluateGuardedEndCall({
    call: call([
      ["user", "The claim number is 430J1Z808."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You're all set."],
      ["agent", NATURAL_FINAL_CLOSING],
      ["user", "Thanks, but what is your callback number?"],
      ["agent", "Nine seven two, five seven three, one seven three zero."]
    ]),
    args: completedArgs
  });
  assert.equal(resumed.allowed, false);
  assert.equal(resumed.code, "representative_not_wrapped");
});

test("allows a completed filing only after a post-closing representative goodbye", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "The claim number is 430J1Z808."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You're all set. Have a great day."],
      ["agent", NATURAL_FINAL_CLOSING],
      ["user", REPRESENTATIVE_GOODBYE]
    ]),
    args: completedArgs
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "objective_complete");
});

test("raw transcript parsing preserves the post-closing turn order", () => {
  const decision = evaluateGuardedEndCall({
    call: {
      metadata: { goal: "file_new_claim" },
      retell_llm_dynamic_variables: { goal: "file_new_claim", coverageTermStatus: "verified_in_force" },
      transcript: [
        "Representative: The claim number is 430J1Z808.",
        "Caller: Where should I send our Letter of Representation and what is the next step?",
        "Representative: Use the claims portal. The adjuster will call tomorrow. You're all set.",
        `Caller: ${NATURAL_FINAL_CLOSING}`,
        `Representative: ${REPRESENTATIVE_GOODBYE}`
      ].join("\n")
    },
    args: completedArgs
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "objective_complete");
});

test("accepts a carrier statement that the claim was filed under the exact identifier", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "The claim was filed under 430J1Z808."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You are all set. Goodbye."],
      ["agent", NATURAL_FINAL_CLOSING],
      ["user", REPRESENTATIVE_GOODBYE]
    ]),
    args: completedArgs
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "objective_complete");
});

test("uncertain carrier language cannot prove a claim identifier", () => {
  for (const statement of [
    "I cannot confirm whether the claim was filed under 430J1Z808.",
    "I'm unable to confirm the claim was filed under 430J1Z808.",
    "I don't know whether the claim was filed under 430J1Z808.",
    "The claim may be filed under 430J1Z808.",
    "The claim might be filed under 430J1Z808.",
    "I think the claim was filed under 430J1Z808."
  ]) {
    const decision = evaluateGuardedEndCall({
      call: call([
        ["user", statement],
        ["user", "Goodbye."]
      ]),
      args: completedArgs
    });
    assert.equal(decision.allowed, false, statement);
    assert.equal(decision.code, "missing_verified_claim_number", statement);
  }
});

test("allows the operator find_existing_claim goal after a transcript-backed existing claim", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "I found the existing claim. The claim number is 430J1Z808."],
      ["agent", "Where should I send our Letter of Representation and what is the next step?"],
      ["user", "Use the claims portal. The adjuster will call tomorrow. You're all set. Have a great day."],
      ["agent", NATURAL_FINAL_CLOSING],
      ["user", REPRESENTATIVE_GOODBYE]
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
      ["agent", NATURAL_FINAL_CLOSING],
      ["user", REPRESENTATIVE_GOODBYE]
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
  batchCall.retell_llm_dynamic_variables = { goal: "file_new_claim", coverageTermStatus: "verified_in_force", batchClaimCount: "1" };
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
    ["agent", NATURAL_FINAL_CLOSING],
    ["user", REPRESENTATIVE_GOODBYE]
  ]);
  batchCall.metadata.batchContactIds = "contact-carson";
  batchCall.retell_llm_dynamic_variables = { goal: "file_new_claim", coverageTermStatus: "verified_in_force", batchClaimCount: "1" };
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
      ["agent", NATURAL_FINAL_CLOSING],
      ["user", REPRESENTATIVE_GOODBYE]
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

test("a verified callback still waits for a post-closing response", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["user", "I queued the callback and the claims team will call you within one business day. Have a good day."],
      ["agent", NATURAL_FINAL_CLOSING]
    ]),
    args: {
      ...completedArgs,
      reason: "callback_confirmed",
      outcome: "callback_requested",
      claim_number: "",
      callback_confirmed: true
    }
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "representative_not_wrapped_after_closing");
});

test("blocks an agent-requested callback that the carrier did not confirm", () => {
  const decision = evaluateGuardedEndCall({
    call: call([
      ["agent", "I requested a callback for this claim."],
      ["user", "The callback has not been confirmed. Have a good day."]
    ]),
    args: {
      ...completedArgs,
      reason: "callback_confirmed",
      outcome: "callback_requested",
      claim_number: "",
      callback_confirmed: true
    }
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "incomplete_outcome");
});
