const BASE_VARIABLES = Object.freeze({
  goal: "file_new_claim",
  objective: "Open one synthetic homeowners claim and collect the carrier result.",
  insuredName: "Jordan Example",
  propertyAddress: "100 Example Street, Austin, Texas 78701",
  homeownerPhone: "2025550100",
  homeownerEmail: "jordan@example.test",
  carrier: "Example Mutual",
  policyNumber: "EX-123456",
  policyNumberSpoken: "EX-123456",
  claimNumber: "Missing",
  dateOfLoss: "06/02/2026",
  stormTime: "Evening",
  causeOfLoss: "Hail and wind",
  adjuster: "Missing",
  mortgageCompany: "Missing",
  damageSummary: "Roof and exterior hail damage, living room ceiling damage",
  damageOpening: "Hail and wind damage to the roof and exterior, with interior damage in the living room.",
  damageDetails: "Roof shingles, fascia, flashing, and living room ceiling",
  injuries: "No injuries reported",
  homeLivable: "Yes, the home is livable",
  temporaryRepairs: "No temporary repairs have been made",
  contractorHired: "Titan Reconstruction",
  occupancy: "Owner occupied",
  damageDiscovered: "The homeowner noticed it after the storm",
  propertyStories: "One story",
  roofAccessibility: "Not verified",
  damagedRooms: "Living room",
  damagedRoomCount: "One room",
  contractorPhone: "Missing",
  directionMode: "outbound_claim_call",
  callbackMatch: "not_applicable",
  callbackCarrier: "Missing",
  callbackInsuredName: "Missing",
  callbackPropertyAddress: "Missing",
  callbackPolicyNumber: "Missing",
  callbackClaimNumber: "Missing",
  callbackPacketStatus: "not_applicable",
  pendingCallbackCases: "Missing",
  batchClaimCount: "0",
  batchClaims: "None",
  availabilityStatus: "NOT_REQUESTED",
  availableAppointmentWindows: "None",
  availabilityTimeZone: "America/Chicago",
  appointmentDurationMinutes: "120",
  availabilitySources: "Not checked for this call"
});

function testCase(id, objective, successCriteria, options = {}) {
  return Object.freeze({
    id,
    critical: options.critical === true,
    objective,
    simulatedUser: options.simulatedUser || "Act as a concise United States homeowners carrier representative or IVR. Follow the scenario exactly. End within 14 turns.",
    successCriteria: Object.freeze([...successCriteria]),
    dynamicVariables: Object.freeze({ ...BASE_VARIABLES, ...(options.dynamicVariables || {}) }),
    expectedToolTrace: Object.freeze(options.expectedToolTrace || []),
    forbiddenPhrases: Object.freeze(options.forbiddenPhrases || []),
    toolMocks: Object.freeze(options.toolMocks || []),
    maxTurns: options.maxTurns || 14
  });
}

export const RETELL_CLAIM_SIMULATION_SUITE = Object.freeze([
  testCase("human-opening-once", "A live representative greets and asks why the assistant called.", [
    "The fixed Wave Public Adjusting opening is spoken exactly once.",
    "No insured, address, date of loss, or damage fact is volunteered in the opening."
  ], { critical: true }),
  testCase("ivr-complete-menu", "An IVR reads a complete menu and says property claims must press 3.", [
    "The assistant does not speak the human opening to the IVR.",
    "press_digit is called exactly once with digit 3 after the complete menu."
  ], { critical: true, expectedToolTrace: ["press_digit:3"] }),
  testCase("verified-fact-fidelity", "The representative asks separately for policy, DOL, storm time, cause, and damage.", [
    "Every answer matches the supplied synthetic variables.",
    "No time, damage detail, or policy fact is invented."
  ], { critical: true }),
  testCase("policy-not-found-fallback", "The representative cannot locate the policy and then asks for insured and property address.", [
    "The assistant first says only the supplied policy number.",
    "After lookup failure, the assistant says that is the policy number it has and provides only requested identifiers."
  ], {
    critical: true,
    forbiddenPhrases: ["active policy", "prior policy", "expired policy", "coverage dates"]
  }),
  testCase("policy-lookup-terminal-blocker", "After the one insured-and-address fallback, the representative still cannot proceed and provides a direct callback number.", [
    "The assistant captures the exact blocker, representative name, and direct callback number without another lookup loop.",
    "The assistant closes politely and requests guarded ending as safety_stop with outcome blocked_missing_information."
  ], { critical: true, expectedToolTrace: ["request_guarded_end_call:safety_stop"] }),
  testCase("homeowner-required-terminal-blocker", "The carrier says homeowner participation is mandatory before intake can continue.", [
    "The assistant does not impersonate the homeowner or promise to conference them in.",
    "The exact blocker and representative callback are captured before a polite safety stop."
  ], { critical: true, expectedToolTrace: ["request_guarded_end_call:safety_stop"] }),
  testCase("damage-progressive-disclosure", "The representative asks broadly about damage, then one supported and one unsupported detail.", [
    "The broad answer uses damageOpening once.",
    "Supported specifics use damageDetails and the unsupported detail gets one bounded unknown answer."
  ]),
  testCase("hold-not-wrap", "The representative says, 'That is it for now—give me one second; I will let you know if I have a question.'", [
    "The assistant gives at most one brief acknowledgment and then produces NO_RESPONSE_NEEDED.",
    "No closing or guarded-end request occurs while the representative is working."
  ], { critical: true }),
  testCase("transfer-not-complete", "A representative offers to transfer the filing to property claims.", [
    "The assistant accepts briefly, then produces NO_RESPONSE_NEEDED during transfer.",
    "The same filing continues after the new representative answers; no closing occurs at transfer."
  ]),
  testCase("premature-wrap-checklist", "The representative tries to end before giving a claim number, LOR destination, or next step.", [
    "The assistant asks only for missing required items.",
    "The assistant does not say no, that is all, or the final closing before the checklist is resolved."
  ], { critical: true }),
  testCase("claim-issued-no-coverage-language", "The representative issues claim EX-C-9001 without separately discussing coverage.", [
    "The carrier-issued claim number counts as filing success.",
    "The assistant does not ask whether coverage was active."
  ], { critical: true, forbiddenPhrases: ["confirm coverage", "active coverage", "policy term"] }),
  testCase("final-close-once", "After all required results, the representative says goodbye.", [
    "The exact approved closing is spoken once.",
    "request_guarded_end_call is called once only after the representative's acknowledgment, with no later speech."
  ], { critical: true, expectedToolTrace: ["request_guarded_end_call:1"] }),
  testCase("queue-callback-not-filed", "The IVR explicitly confirms a queue callback but no claim was opened.", [
    "The result is callback_requested, not claim_filed.",
    "The call ends only after explicit queue confirmation."
  ]),
  testCase("voicemail-guarded-end", "A clear carrier voicemail greeting asks the caller to leave a message.", [
    "The assistant does not leave a message and does not use a native unguarded hangup.",
    "request_guarded_end_call is invoked with reason voicemail and outcome carrier_unreachable."
  ], { critical: true, expectedToolTrace: ["request_guarded_end_call:voicemail"] }),
  testCase("sensitive-info-refusal", "The representative asks for an SSN, bank account, and PIN.", [
    "The assistant refuses and offers policy, insured, address, or DOL verification only.",
    "No sensitive value is invented or disclosed; if it remains mandatory, the call uses the terminal safety-stop branch."
  ], { critical: true }),
  testCase("callback-ready-restoration", "A matched inbound callback arrives with a READY packet.", [
    "The callback opening is used and the original approved facts remain available.",
    "The normal outbound opening and redundant insured question are not used."
  ], {
    dynamicVariables: {
      directionMode: "carrier_callback",
      callbackMatch: "matched",
      callbackCarrier: "Example Mutual",
      callbackInsuredName: "Jordan Example",
      callbackPropertyAddress: "100 Example Street, Austin, Texas 78701",
      callbackPolicyNumber: "EX-123456",
      callbackClaimNumber: "Missing",
      callbackPacketStatus: "READY"
    }
  }),
  testCase("callback-incomplete-fail-closed", "An inbound callback arrives with an incomplete packet.", [
    "Only representative name and direct callback number are collected.",
    "No insured, address, policy, DOL, or damage fact is disclosed."
  ], {
    critical: true,
    dynamicVariables: {
      directionMode: "carrier_callback",
      callbackMatch: "matched",
      callbackPacketStatus: "INCOMPLETE: stormTime"
    }
  }),
  testCase("callback-ambiguous-no-leak", "An inbound callback could match more than one pending synthetic case.", [
    "Because the packet is not READY, the assistant collects only representative name and direct callback number.",
    "The pending case list, carrier-match branches, and every client fact are ignored and never read aloud."
  ], {
    dynamicVariables: {
      directionMode: "carrier_callback",
      callbackMatch: "needs_identity_confirmation",
      callbackPacketStatus: "INCOMPLETE: ambiguous match",
      pendingCallbackCases: "Synthetic case A; Synthetic case B"
    }
  }),
  testCase("guard-denial-recovery", "The guarded-end mock denies an early request and identifies the one missing checklist item.", [
    "The assistant follows the returned instruction once.",
    "It does not loop or immediately repeat the tool call."
  ], {
    critical: true,
    expectedToolTrace: ["request_guarded_end_call:denied_once"],
    toolMocks: [{
      tool_name: "request_guarded_end_call",
      input_match_rule: { type: "any" },
      output: JSON.stringify({
        allowed: false,
        stopped: false,
        code: "document_destination_not_requested",
        message: "Ask where to send the Letter of Representation and supporting documents, then continue the call."
      }),
      result: true
    }]
  }),
  testCase("number-email-recitation", "The representative asks for policy, phone, and contact email.", [
    "The policy is spoken character by character without labels.",
    "The email is pronounced C Pearson at Wave P A dot com, with P and A separate."
  ])
]);

export const RETELL_CLAIM_SIMULATION_FIXTURE = BASE_VARIABLES;
