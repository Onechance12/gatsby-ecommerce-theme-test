import assert from "node:assert/strict";
import test from "node:test";

import {
  callbackCandidateFromCall,
  buildCallbackDynamicVariables,
  buildCallbackMetadata,
  buildPostClaimWorkflow,
  confirmedCallbackRequest,
  analyzeClaimCall,
  assertApprovalDigest,
  buildClaimFilingPlan,
  normalizePhone,
  retellCallBody,
  selectCallbackCandidate,
  validateRetellCallChainOwnership,
  validateRetellCallOwnership
} from "./claim-filing-adapter.js";
import { spokenPolicyNumber } from "./claim-filing-core/dynamicVariables.js";
import { normalizeDateOfLoss } from "./claim-filing-core/packet.js";
import { buildRetellLlmFromPacket, renderRetellPrompt } from "./claim-filing-core/retellPrompt.js";
import { extractCallResults } from "./claim-filing-core/resultExtraction.js";

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
  assert.equal(normalizeDateOfLoss(1777161600), "04/26/2026");
  assert.equal(normalizeDateOfLoss("2026-04-26"), "04/26/2026");
  assert.equal(normalizeDateOfLoss("4/25/2026"), "04/25/2026");
});

test("Retell prompt has a dedicated homeowner appointment mode", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /HIGHEST-PRIORITY HOMEOWNER APPOINTMENT MODE/);
  assert.match(prompt, /homeowner_appointment_confirmation/);
  assert.match(prompt, /do not leave a message/);
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
  }), false);
  assert.equal(confirmedCallbackRequest({
    transcript: "Press one to receive a callback.",
    call_analysis: { custom_analysis_data: { callback_requested: true, filing_outcome: "callback_requested" } }
  }), false);
  assert.equal(confirmedCallbackRequest({ transcript: "We will call you back when an agent is available." }), true);
});

test("voice prompt uses the loaded homeowner phone for IVR account lookup", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /ACCOUNT PHONE LOOKUP/);
  assert.match(prompt, /use \{\{homeownerPhone\}\}/);
  assert.match(prompt, /Do not answer 'I don't know it' when homeownerPhone is present/);
  assert.match(prompt, /remain connected until the IVR explicitly confirms/);
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
  const config = buildRetellLlmFromPacket(
    {},
    { guardedEndCallUrl: "https://hcn.example.test/retell/guarded-end-call" }
  );
  const guardedEnd = config.generalTools.find((tool) => tool.name === "request_guarded_end_call");
  const pressDigit = config.generalTools.find((tool) => tool.name === "press_digit");
  assert.equal(guardedEnd.type, "custom");
  assert.match(guardedEnd.url, /\/retell\/guarded-end-call$/);
  assert.equal(guardedEnd.speak_after_execution, true);
  assert.equal(config.generalTools.some((tool) => tool.type === "end_call"), false);
  assert.equal(pressDigit.delay_ms, 250);
  assert.equal(pressDigit.speak_after_execution, false);
  assert.match(config.generalPrompt, /wait about 0\.75 to 1 second/i);
  assert.doesNotMatch(config.generalPrompt, /wait a full 3 seconds after the system/i);
});

test("Retell configuration fails closed without an explicit guarded end-call URL", () => {
  assert.throws(
    () => buildRetellLlmFromPacket({}),
    /guardedEndCallUrl is required/
  );
});

test("carrier calls refuse sensitive identity and banking information", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /never provide, request, confirm, or invent a Social Security number/i);
  assert.match(prompt, /driver's license number, bank account, routing number/i);
  assert.match(prompt, /Just making sure we are still connected\./);
  assert.match(prompt, /first configured silence reminder triggers at 30 seconds/i);
  assert.match(prompt, /second reminder triggers at 60 seconds total/i);
});

test("carrier prompt forbids repetitive hold and intake filler", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /AFTER ANSWERING A HUMAN'S QUESTION, STOP SPEAKING IMMEDIATELY/i);
  assert.match(prompt, /Never append phrases such as 'let me know if you need anything else'/i);
  assert.match(prompt, /reply only 'Ok\.' once/i);
  assert.match(prompt, /Do not ask 'What else do you need\?'/i);
  assert.match(prompt, /only once at final wrap-up/i);
  assert.match(prompt, /I don't have any additional verified details beyond what I already provided/i);
  assert.match(prompt, /FINAL WRAP-UP IS A HARD STATE GATE/i);
  assert.match(prompt, /where should I send our Letter of Representation and supporting documents/i);
  assert.match(prompt, /NEVER answer 'No', 'That's all'/i);
  assert.match(prompt, /I'll let you know if I have a question.*ALWAYS mean the representative is still working/i);
  assert.match(prompt, /During a wait state, never say the closing blessing and never invoke request_guarded_end_call/i);
  assert.match(prompt, /request_guarded_end_call is forbidden while claim_number is empty/i);
  assert.match(prompt, /documentation delay.*never satisfies this rule/i);
  assert.match(prompt, /The phrases 'I can follow up'.*are forbidden during claim intake/i);
  assert.match(prompt, /NEVER answer 'No'.*additional claim has been attempted/i);
});

test("carrier prompt stays silent for IVR openings and accepts transfers", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /first response to that audio must contain NO spoken words/i);
  assert.match(prompt, /We are the public adjuster for the homeowner, and I'm calling to file a new property insurance claim on their behalf/);
  assert.match(prompt, /Never substitute a made-up noon, morning, afternoon, or evening/i);
  assert.match(prompt, /A transfer is not a completed objective/i);
  assert.match(prompt, /silence-reminder event that occurs before that period expires must produce no spoken check-in/i);
});

test("claim packet exposes only the fixed Retell-owned human opening", () => {
  const plan = buildClaimFilingPlan(fixture(), {
    ownerId: OWNER_ID,
    from: "+12145550100",
    agentId: "agent-1"
  });
  assert.equal(plan.packet.scriptAuthority, "retell_fixed_carrier_workflow");
  assert.match(plan.packet.humanRepresentativeScript, /We are the public adjuster for the homeowner/);
  assert.doesNotMatch(plan.packet.humanRepresentativeScript.split("\n")[0], /Fixture Homeowner|100 Test St|POLICY-1|04\/25\/2026/);
  assert.match(plan.packet.scriptInstruction, /Do not invent or rewrite an opening script/);
});

test("inspection scheduling prompt uses only merged live calendar authority", () => {
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /LIVE INSPECTION SCHEDULING AUTHORITY/);
  assert.match(prompt, /Availability status: \{\{availabilityStatus\}\}/);
  assert.match(prompt, /ONLY appointment windows you are authorized to accept/);
  assert.match(prompt, /If availability status is not exactly 'READY', do not schedule/);
  assert.match(prompt, /full arrival window fits entirely inside one authorized window/);
  assert.match(prompt, /merged JobNimbus and Google Calendar availability above is the check/);
  assert.match(prompt, /JobNimbus calendar creation remains a separate approval-gated action/);
});

test("structured inspection result preserves exact confirmed calendar details", () => {
  const extracted = extractCallResults({
    raw: {
      metadata: { goal: "inspection_scheduling" },
      retell_llm_dynamic_variables: { insuredName: "Fixture Homeowner", carrier: "Allstate" },
      call_analysis: {
        custom_analysis_data: {
          inspection_scheduled: true,
          inspection_start: "2026-07-17T14:00:00-05:00",
          inspection_end: "2026-07-17T16:00:00-05:00",
          inspection_timezone: "America/Chicago",
          inspection_access_requirements: "Interior access required"
        }
      }
    }
  });
  assert.equal(extracted.inspectionScheduled, true);
  assert.equal(extracted.inspectionStart, "2026-07-17T14:00:00-05:00");
  assert.equal(extracted.inspectionEnd, "2026-07-17T16:00:00-05:00");
  assert.equal(extracted.inspectionTimezone, "America/Chicago");
  assert.equal(extracted.inspectionAccessRequirements, "Interior access required");
  assert.equal(extracted.source.inspectionStart, "retell-analysis");
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

test("verified property intake facts travel into Retell without global assumptions", () => {
  const plan = buildClaimFilingPlan(fixture(), {
    ownerId: OWNER_ID,
    from: "+12145550100",
    agentId: "agent-1",
    propertyStories: "One story",
    roofAccessibility: "Not verified",
    damagedRooms: "Bathroom ceiling and adjoining walls",
    damagedRoomCount: "One bathroom area",
    contractorPhone: "Missing"
  });

  assert.equal(plan.callPlan.dynamicVariables.propertyStories, "One story");
  assert.equal(plan.callPlan.dynamicVariables.roofAccessibility, "Not verified");
  assert.equal(plan.callPlan.dynamicVariables.damagedRooms, "Bathroom ceiling and adjoining walls");
  assert.equal(plan.callPlan.dynamicVariables.damagedRoomCount, "One bathroom area");
  assert.equal(plan.callPlan.dynamicVariables.contractorPhone, "Missing");
  const prompt = renderRetellPrompt({});
  assert.match(prompt, /How many stories is the home\?/);
  assert.match(prompt, /I don't have that verified in front of me/);
  assert.doesNotMatch(prompt, /defer naturally and offer to follow up/);
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

test("uses The Hartford official non-AARP homeowners claims number", () => {
  const input = fixture();
  input.file.carrier = "Hartford Insurance Company of the Southeast";
  input.file.policyNumber = "55200160102";
  const plan = buildClaimFilingPlan(input, {
    ownerId: OWNER_ID,
    fileNumber: "2765",
    from: "+18176867361",
    agentId: "agent-1"
  });
  assert.equal(plan.callPlan.to, "+18002435860");
  assert.equal(plan.carrier.display, "The Hartford Home Claims (non-AARP)");
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
  assert.equal(result.completionReview.complete, false);
  assert.match(result.completionReview.gaps.join(" "), /did not ask where to send the Letter of Representation/i);
});

test("post-call extraction rejects Wave contact details as carrier adjuster fields", () => {
  const extracted = extractCallResults({
    transcript: "",
    raw: {
      metadata: { goal: "file_new_claim" },
      retell_llm_dynamic_variables: {
        insuredName: "Emigdio Lejia",
        homeownerPhone: "4694635168",
        homeownerEmail: "ezleija1025@yahoo.com"
      },
      call_analysis: {
        custom_analysis_data: {
          claim_number: "0833375173",
          adjuster_name: "Chance Pearson",
          adjuster_phone: "9725731730",
          adjuster_email: "cpearson@wavepa.com",
          filing_outcome: "claim_filed"
        }
      }
    }
  });
  assert.equal(extracted.adjusterName, "");
  assert.equal(extracted.adjusterPhone, "");
  assert.equal(extracted.adjusterEmail, "");
  assert.equal(extracted.source.adjusterName, "none");
  assert.equal(extracted.source.adjusterPhone, "none");
  assert.equal(extracted.source.adjusterEmail, "none");
});

test("call completion review confirms the representation destination was captured", () => {
  const call = {
    callId: "call-docs",
    transcript: "",
    callStatus: "ended",
    raw: {
      call_id: "call-docs",
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
          claim_number: "43-TEST-789",
          filing_outcome: "claim_filed",
          document_submission_requested: true,
          document_submission: "claims@example.com"
        }
      }
    }
  };
  const result = analyzeClaimCall(call, { id: "contact-2739", customer: "Fixture Homeowner", status: "Ready for PA Review", carrier: "State Farm" });
  assert.equal(result.completionReview.documentSubmissionRequested, true);
  assert.equal(result.completionReview.documentSubmissionCaptured, true);
  assert.equal(result.completionReview.complete, true);
  assert.deepEqual(result.completionReview.gaps, []);

  const workflow = buildPostClaimWorkflow(result);
  assert.equal(workflow.applicable, true);
  assert.equal(workflow.phase, "post_claim_filing_representation");
  assert.match(workflow.primaryAction, /prepare the verified LOR/i);
  assert.equal(workflow.steps.find((step) => step.id === "representation_destination").status, "complete");
  assert.deepEqual(
    workflow.steps.find((step) => step.id === "lor_package").requiredDocuments,
    ["Letter of Representation", "TDI/FIN535", "W-9"]
  );
  assert.equal(workflow.steps.find((step) => step.id === "lor_package").emailSubjectRule, "Claim number only");
  assert.equal(workflow.steps.find((step) => step.id === "lor_package").emailTemplate, "payment_redirection");
  assert.match(workflow.steps.find((step) => step.id === "lor_package").emailBodyRule, /included as a payee/i);
});

test("post-claim workflow blocks the LOR send until a destination is captured", () => {
  const workflow = buildPostClaimWorkflow({
    extracted: {
      outcome: "claim_filed",
      claimNumber: "43-TEST-999",
      documentSubmission: ""
    }
  });
  assert.equal(workflow.applicable, true);
  assert.match(workflow.primaryAction, /obtain a verified representation-document destination/i);
  assert.equal(workflow.steps.find((step) => step.id === "representation_destination").status, "blocked");
  assert.equal(workflow.steps.find((step) => step.id === "lor_package").status, "blocked");
  assert.equal(workflow.steps.find((step) => step.id === "representation_send").status, "blocked");
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

test("legacy callback legs are accepted only when anchored to a validated outbound call", () => {
  const outbound = { raw: {
    call_id: "call-outbound",
    metadata: {
      source: "hcn-wave-jobnimbus-bridge",
      ownerId: OWNER_ID,
      contactId: "contact-1",
      planDigest: "digest-1"
    }
  } };
  const legacyCallback = { raw: {
    call_id: "call-callback",
    metadata: {
      source: "hcn-wave-retell-callback",
      ownerId: OWNER_ID,
      contactId: "contact-1",
      originalCallId: "call-outbound"
    }
  } };
  const metadata = validateRetellCallChainOwnership(outbound, legacyCallback, OWNER_ID);
  assert.equal(metadata.planDigest, "digest-1");
  assert.throws(() => validateRetellCallChainOwnership(outbound, {
    raw: { metadata: { ...legacyCallback.raw.metadata, originalCallId: "wrong-call" } }
  }, OWNER_ID), /not linked/);
});

test("normalizes US phone numbers", () => {
  assert.equal(normalizePhone("(214) 555-1212"), "+12145551212");
  assert.equal(normalizePhone("+1 844 458 4300"), "+18444584300");
  assert.throws(() => normalizePhone("123"), /Invalid phone/);
});
