import assert from "node:assert/strict";
import test from "node:test";

import {
  callbackCandidateFromCall,
  buildCallbackDynamicVariables,
  buildCallbackMetadata,
  confirmedCallbackRequest,
  analyzeClaimCall,
  assertApprovalDigest,
  buildClaimFilingPlan,
  normalizePhone,
  retellCallBody,
  selectCallbackCandidate,
  validateRetellCallOwnership
} from "./claim-filing-adapter.js";
import { spokenPolicyNumber } from "./claim-filing-core/dynamicVariables.js";
import { normalizeDateOfLoss } from "./claim-filing-core/packet.js";
import { buildRetellLlmFromPacket, renderRetellPrompt } from "./claim-filing-core/retellPrompt.js";

const OWNER_ID = "chance-owner";

test("spokenPolicyNumber strips mortgage control and loan references", () => {
  assert.equal(
    spokenPolicyNumber("Master Policy 7007-0002 / Control Q4622430 / Loan 0055298467"),
    "7007-0002"
  );
  assert.equal(spokenPolicyNumber("Policy # 93-E4-B591-7"), "93-E4-B591-7");
  assert.equal(spokenPolicyNumber("POLICY-1"), "POLICY-1");
});

test("normalizeDateOfLoss converts JobNimbus epoch seconds before the voice call", () => {
  assert.equal(normalizeDateOfLoss(1777136400), "04/25/2026");
  assert.equal(normalizeDateOfLoss("4/25/2026"), "04/25/2026");
});

test("callbackCandidateFromCall reconstructs a pending case from Retell metadata", () => {
  assert.deepEqual(callbackCandidateFromCall({
    call_id: "call-1",
    to_number: "+18008248562",
    start_timestamp: 1770000000000,
    metadata: {
      source: "hcn-wave-jobnimbus-bridge",
      contactId: "contact-2717",
      fileNumber: "2717",
      goal: "file_new_claim"
    },
    retell_llm_dynamic_variables: {
      goal: "file_new_claim",
      carrier: "National General",
      insuredName: "Margarito Vega",
      propertyAddress: "5412 Meadow Nest Dr",
      policyNumber: "Master Policy 7007-0002 / Control Q4622430",
      policyNumberSpoken: "7007-0002",
      dateOfLoss: "04/25/2026",
      causeOfLoss: "Hail",
      damageOpening: "Roof and exterior damage",
      damageDetails: "Roof hail damage"
    }
  }), {
    callId: "call-1",
    contactId: "contact-2717",
    fileNumber: "2717",
    goal: "file_new_claim",
    carrier: "National General",
    insuredName: "Margarito Vega",
    propertyAddress: "5412 Meadow Nest Dr",
    policyNumber: "Master Policy 7007-0002 / Control Q4622430",
    policyNumberSpoken: "7007-0002",
    claimNumber: "",
    filingOutcome: "",
    callbackRequested: false,
    carrierPhone: "+18008248562",
    createdAt: 1770000000000,
    ownerId: "",
    planDigest: "",
    version: "",
    batchContactIds: "",
    dynamicVariables: {
      goal: "file_new_claim",
      carrier: "National General",
      insuredName: "Margarito Vega",
      propertyAddress: "5412 Meadow Nest Dr",
      policyNumber: "Master Policy 7007-0002 / Control Q4622430",
      policyNumberSpoken: "7007-0002",
      dateOfLoss: "04/25/2026",
      causeOfLoss: "Hail",
      damageOpening: "Roof and exterior damage",
      damageDetails: "Roof hail damage"
    }
  });
});

test("confirmed callbacks restore the complete approved claim packet", () => {
  const outbound = buildClaimFilingPlan(fixture(), {
    ownerId: OWNER_ID,
    fileNumber: "2742",
    from: "+18176867361",
    to: "+18002557828",
    agentId: "agent-1",
    overrides: {
      carrier: "Allstate Insurance Company",
      dateOfLoss: "04/27/2026",
      causeOfLoss: "Hail and wind",
      damageDetails: ["Roof hail/wind damage", "Interior water damage"]
    }
  });
  const call = {
    call_id: "call-alice-outbound",
    to_number: "+18002557828",
    start_timestamp: 1770000000000,
    transcript: "Your request for a callback has been confirmed.",
    metadata: outbound.callPlan.metadata,
    retell_llm_dynamic_variables: outbound.callPlan.dynamicVariables
  };
  const candidate = callbackCandidateFromCall(call);
  const callback = buildCallbackDynamicVariables(candidate, "matched");
  const metadata = buildCallbackMetadata(candidate, "matched");

  assert.equal(confirmedCallbackRequest(call), true);
  assert.equal(candidate.callbackRequested, true);
  assert.equal(callback.directionMode, "carrier_callback");
  assert.equal(callback.callbackPacketStatus, "READY");
  assert.equal(callback.insuredName, "Fixture Homeowner");
  assert.equal(callback.propertyAddress, "100 Test St, Dallas, TX 75201");
  assert.equal(callback.carrier, "Allstate Insurance Company");
  assert.equal(callback.policyNumberSpoken, "POLICY-1");
  assert.equal(callback.dateOfLoss, "04/27/2026");
  assert.equal(callback.causeOfLoss, "Hail and wind");
  assert.match(callback.damageDetails, /Interior water damage/);
  assert.equal(callback.injuries, "No injuries reported");
  assert.equal(callback.homeLivable, "Yes, the home is livable");
  assert.equal(callback.temporaryRepairs, "Yes, temporary repairs have been made");
  assert.match(callback.contractorHired, /Titan Reconstruction/);
  assert.equal(metadata.source, "hcn-wave-jobnimbus-bridge");
  assert.equal(metadata.ownerId, OWNER_ID);
  assert.equal(metadata.contactId, "contact-2739");
  assert.equal(metadata.fileNumber, "2742");
  assert.equal(metadata.planDigest, outbound.planDigest);
  assert.equal(metadata.originalCallId, "call-alice-outbound");
  assert.equal(metadata.callLeg, "carrier_callback");
  assert.doesNotThrow(() => validateRetellCallOwnership({ raw: { metadata } }, OWNER_ID));
});

test("callback packet fails closed when a critical fact is missing", () => {
  const callback = buildCallbackDynamicVariables({
    carrier: "Allstate",
    insuredName: "Alice Gonzales",
    propertyAddress: "2904 Hillside Dr",
    policyNumberSpoken: "844118424",
    dynamicVariables: {
      goal: "file_new_claim",
      insuredName: "Alice Gonzales",
      propertyAddress: "2904 Hillside Dr",
      carrier: "Allstate",
      policyNumber: "844118424",
      policyNumberSpoken: "844118424",
      dateOfLoss: "Missing",
      causeOfLoss: "Hail and wind",
      damageOpening: "Roof and exterior damage",
      damageDetails: "Roof hail damage"
    }
  }, "matched");
  assert.match(callback.callbackPacketStatus, /^INCOMPLETE:/);
  assert.match(callback.callbackPacketStatus, /dateOfLoss/);
});

test("callback matching requires a unique safe association", () => {
  const alice = { contactId: "alice", carrierPhone: "+18002557828" };
  const vega = { contactId: "vega", carrierPhone: "+18003251088" };
  assert.deepEqual(selectCallbackCandidate([alice, vega], "+18002557828"), { selected: alice, match: "matched" });
  assert.deepEqual(selectCallbackCandidate([alice], "anonymous"), {
    selected: alice,
    match: "single_pending_case_requires_carrier_confirmation"
  });
  assert.deepEqual(selectCallbackCandidate([alice, vega], "anonymous"), {
    selected: null,
    match: "needs_identity_confirmation"
  });
});

test("callback eligibility requires carrier confirmation, not merely an offer", () => {
  assert.equal(confirmedCallbackRequest({ transcript: "Press one if you would like a callback." }), false);
  assert.equal(confirmedCallbackRequest({ transcript: "Your request for a callback has been confirmed." }), true);
  assert.equal(confirmedCallbackRequest({
    call_analysis: { custom_analysis_data: { filing_outcome: "callback_requested" } }
  }), true);
});

test("completed filings are not offered as callback candidates", () => {
  assert.equal(callbackCandidateFromCall({
    call_id: "call-complete",
    to_number: "+18008248562",
    metadata: { source: "hcn-wave-jobnimbus-bridge", contactId: "contact-1" },
    call_analysis: { custom_analysis_data: { filing_outcome: "claim_filed" } }
  }), null);
});

test("inbound callback prompt recovers from a clipped carrier introduction", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /stay silent for about two seconds/i);
  assert.match(prompt, /AI assistant\. Give me a second while I pull up that information\./);
  assert.match(prompt, /If they already clearly named the carrier, do not ask for it again\./);
  assert.match(prompt, /Callback packet status/);
  assert.match(prompt, /complete claim file did not load on my side/i);
  assert.match(prompt, /Do not ask the representative to confirm the insured name/i);
});

test("voice prompt contains no speakable pacing label", () => {
  const prompt = renderRetellPrompt({});
  assert.doesNotMatch(prompt, /\bpause\b/i);
  assert.match(prompt, /Never verbalize stage directions, pacing instructions/);
});

test("IVR controls listen to the full menu without waiting for a repeat", () => {
  const config = buildRetellLlmFromPacket({});
  const pressDigit = config.generalTools.find((tool) => tool.name === "press_digit");
  assert.equal(pressDigit.delay_ms, 250);
  assert.equal(pressDigit.speak_after_execution, false);
  assert.match(config.generalPrompt, /wait about 0\.75 to 1 second/i);
  assert.doesNotMatch(config.generalPrompt, /wait a full 3 seconds after the system/i);
});

test("carrier calls refuse sensitive identity and banking information", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /never provide, request, confirm, or invent a Social Security number/i);
  assert.match(prompt, /driver's license number, bank account, routing number/i);
  assert.match(prompt, /Just making sure we are still connected\./);
  assert.match(prompt, /first configured silence reminder triggers at 30 seconds/i);
  assert.match(prompt, /second reminder triggers at 60 seconds total/i);
});

test("carrier prompt stays silent for IVR openings and accepts transfers", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /first response to that audio must contain NO spoken words/i);
  assert.match(prompt, /A transfer is not a completed objective/i);
  assert.match(prompt, /silence-reminder event that occurs before that period expires must produce no spoken check-in/i);
});

test("claim packet separates the short damage opening from detailed follow-up scope", () => {
  const input = fixture({
    evidence: {
      documents: [{ name: "Final Draft Estimate.pdf" }],
      notes: [{ body: "Roof hail damage. Front window screens. Gutters and fascia. Garage door. Wood fence. Bathroom ceiling and adjoining wall water damage." }],
      tasks: []
    }
  });
  const plan = buildClaimFilingPlan(input, {
    ownerId: OWNER_ID,
    from: "+12145550100",
    agentId: "agent-1"
  });
  assert.equal(
    plan.callPlan.dynamicVariables.damageOpening,
    "It has roof damage along with collateral on the exterior of the home, mostly paint, window screens, and gutters. I also believe there is some interior damage."
  );
  assert.match(plan.callPlan.dynamicVariables.damageDetails, /window screens\/windows/);
  assert.match(plan.callPlan.dynamicVariables.damageDetails, /garage door/);
  assert.match(plan.callPlan.dynamicVariables.damageDetails, /bathroom ceiling and adjoining walls/);
  assert.doesNotMatch(plan.callPlan.dynamicVariables.damageDetails, /detached structures/);
  assert.doesNotMatch(plan.callPlan.dynamicVariables.damageDetails, /personal property/);
  assert.match(renderRetellPrompt({}), /When a human representative first asks broadly what was damaged/);
});

test("approved per-call overrides replace stale verified carrier and DOL facts", () => {
  const input = fixture();
  input.file.carrier = "Allsate";
  input.file.dateOfLoss = "";
  const plan = buildClaimFilingPlan(input, {
    ownerId: OWNER_ID,
    from: "+12145550100",
    agentId: "agent-1",
    to: "+18002557828",
    overrides: {
      carrier: "Allstate Insurance Company",
      dateOfLoss: "04/27/2026",
      causeOfLoss: "Hail and wind"
    }
  });
  assert.equal(plan.readiness.ready, true);
  assert.equal(plan.packet.verifiedFileFacts.carrier, "Allstate Insurance Company");
  assert.equal(plan.packet.verifiedFileFacts.dateOfLoss, "04/27/2026");
  assert.equal(plan.packet.verifiedFileFacts.causeOfLoss, "Hail and wind");
});

test("verified damage details replace broader inferred damage categories", () => {
  const input = fixture({
    evidence: {
      documents: [{ name: "Estimate.pdf" }],
      notes: [{ body: "Roof, fence, and detached structure damage." }],
      tasks: []
    }
  });
  const plan = buildClaimFilingPlan(input, {
    ownerId: OWNER_ID,
    from: "+12145550100",
    agentId: "agent-1",
    overrides: { damageDetails: ["Roof hail damage", "Fence damage"] }
  });
  assert.deepEqual(plan.packet.damageSummary, ["Roof hail damage", "Fence damage"]);
  assert.doesNotMatch(plan.callPlan.dynamicVariables.damageSummary, /detached/i);
});

function fixture(overrides = {}) {
  return {
    file: {
      id: "contact-2739",
      customer: "Fixture Homeowner",
      address: "100 Test St, Dallas, TX 75201",
      carrier: "State Farm",
      policyNumber: "POLICY-1",
      claimNumber: "",
      dateOfLoss: "2026-04-25",
      typeOfLoss: "Hail / wind",
      status: "Ready for PA Review",
      contact: { mobile_phone: "2145551212", email: "fixture@example.test" },
      adjuster: {}
    },
    evidence: {
      documents: [{ name: "Roof and exterior estimate.pdf" }],
      notes: [],
      tasks: []
    },
    ...overrides
  };
}

test("builds deterministic approval-gated State Farm plan", () => {
  const options = {
    ownerId: OWNER_ID,
    fileNumber: "2739",
    from: "+12145550100",
    agentId: "agent-1"
  };
  const first = buildClaimFilingPlan(fixture(), options);
  const second = buildClaimFilingPlan(fixture(), options);
  assert.equal(first.planDigest, second.planDigest);
  assert.equal(first.readiness.ready, true);
  assert.equal(first.callPlan.to, "+18444584300");
  assert.equal(first.callPlan.metadata.contactId, "contact-2739");
  assert.equal(retellCallBody(first).override_agent_id, "agent-1");
});

test("uses the verified National General homeowners claims number", () => {
  const input = fixture();
  input.file.carrier = "National General Insurance Company";
  const plan = buildClaimFilingPlan(input, {
    ownerId: OWNER_ID,
    fileNumber: "2717",
    from: "+12145550100",
    agentId: "agent-1"
  });
  assert.equal(plan.callPlan.to, "+18003251088");
  assert.equal(plan.readiness.ready, true);
});

test("routes National General master policies to lender services property claims", () => {
  const input = fixture();
  input.file.carrier = "National General Insurance Company";
  input.file.policyNumber = "Master Policy 7007-0002 / Control Q4622430 / Loan 0055298467";
  const plan = buildClaimFilingPlan(input, {
    ownerId: OWNER_ID,
    fileNumber: "2717",
    from: "+12145550100",
    agentId: "agent-1"
  });
  assert.equal(plan.callPlan.to, "+18008248562");
  assert.equal(plan.carrier.display, "National General Lender Services (property claims)");
});

test("changed live facts invalidate an approved digest", () => {
  const options = { ownerId: OWNER_ID, from: "+12145550100", agentId: "agent-1" };
  const approved = buildClaimFilingPlan(fixture(), options);
  const changed = fixture();
  changed.file.dateOfLoss = "2026-05-01";
  const fresh = buildClaimFilingPlan(changed, options);
  assert.throws(() => assertApprovalDigest(approved.planDigest, fresh.planDigest), /no longer matches/);
});

test("existing claim blocks accidental new filing", () => {
  const input = fixture();
  input.file.claimNumber = "43-TEST-123";
  const plan = buildClaimFilingPlan(input, {
    ownerId: OWNER_ID,
    from: "+12145550100",
    agentId: "agent-1",
    goal: "file_new_claim"
  });
  assert.equal(plan.readiness.ready, false);
  assert.match(plan.readiness.blockers.join(" "), /already has claim/i);
});

test("structured result produces a short writeback bundle", () => {
  const call = {
    callId: "call-1",
    transcript: "",
    callStatus: "ended",
    raw: {
      call_id: "call-1",
      metadata: {
        source: "hcn-wave-jobnimbus-bridge",
        ownerId: OWNER_ID,
        contactId: "contact-2739",
        planDigest: "approved",
        goal: "file_new_claim"
      },
      retell_llm_dynamic_variables: { goal: "file_new_claim" },
      call_analysis: {
        custom_analysis_data: {
          claim_number: "43-TEST-456",
          filing_outcome: "claim_filed",
          adjuster_phone: "214-555-9000"
        }
      }
    }
  };
  const file = { id: "contact-2739", customer: "Fixture Homeowner", status: "Ready for PA Review", carrier: "State Farm" };
  const result = analyzeClaimCall(call, file);
  assert.equal(result.writeback.fields.cf_string_2, "43-TEST-456");
  assert.equal(result.writeback.fields.cf_string_8, "214-555-9000");
  assert.equal(result.writeback.status, "Submitted Awaiting Confirmation");
  assert.match(result.writeback.note, /Claim filed by phone/);
  assert.equal(result.writeback.note.includes("damage"), false);
});

test("rejects calls outside the Chance bridge scope", () => {
  assert.throws(() => validateRetellCallOwnership({ raw: { metadata: { source: "other" } } }, OWNER_ID), /not created/);
  const metadata = validateRetellCallOwnership({ raw: { metadata: {
    source: "hcn-wave-jobnimbus-bridge",
    ownerId: OWNER_ID,
    contactId: "contact-1",
    planDigest: "digest-1"
  } } }, OWNER_ID);
  assert.equal(metadata.contactId, "contact-1");
});

test("normalizes US phone numbers", () => {
  assert.equal(normalizePhone("(214) 555-1212"), "+12145551212");
  assert.equal(normalizePhone("+1 844 458 4300"), "+18444584300");
  assert.throws(() => normalizePhone("123"), /Invalid phone/);
});
