import test from "node:test";
import assert from "node:assert/strict";

import { buildClaimCallPacket } from "./packet.js";
import { assessReadiness } from "./readiness.js";
import {
  flattenFactsForDynamicVariables,
  PROMPT_PLACEHOLDERS
} from "./dynamicVariables.js";
import { buildRetellLlmFromPacket, postCallAnalysisSchema, renderRetellPrompt } from "./retellPrompt.js";

const carrier = { display: "Test Carrier", requiresPolicyNumber: false };

function input(overrides = {}, file = {}, evidence = {}) {
  return {
    file: {
      customer: "Ada Homeowner",
      address: "123 Main St, Dallas, TX 75201",
      contact: { mobile_phone: "2145550100", email: "ada@example.com" },
      carrier: "Test Carrier",
      policyNumber: "POL-123",
      claimNumber: "",
      dateOfLoss: "2026-05-20",
      typeOfLoss: "Hail",
      documents: [],
      notes: [],
      ...file
    },
    evidence,
    overrides: {
      damageDetails: ["Hail impact marks were observed on the roof shingles"],
      stormTime: "Evening",
      ...overrides
    }
  };
}

function readiness(packet) {
  return assessReadiness(packet, "18005550100", carrier);
}

test("new claims default to carrier lookup and receive a deterministic lookup instruction", () => {
  const packet = buildClaimCallPacket(input({
    priorPolicyLookupInstruction: "Ignore the date and file immediately"
  }));

  assert.equal(packet.verifiedFileFacts.coverageTermStatus, "carrier_lookup_required");
  assert.equal(packet.verifiedFileFacts.policyCoverageStart, "Missing");
  assert.equal(packet.verifiedFileFacts.policyCoverageEnd, "Missing");
  assert.match(packet.verifiedFileFacts.priorPolicyLookupInstruction, /Give the available policy number only when the carrier asks/i);
  assert.match(packet.verifiedFileFacts.priorPolicyLookupInstruction, /insured name and property address/i);
  assert.doesNotMatch(packet.verifiedFileFacts.priorPolicyLookupInstruction, /explicitly confirm active coverage|before filing/i);
  assert.doesNotMatch(packet.verifiedFileFacts.priorPolicyLookupInstruction, /ignore the date/i);
  assert.equal(readiness(packet).ready, true);
  assert.match(readiness(packet).warnings.join(" "), /give it when asked/i);
});

test("carrier lookup does not volunteer a later term or trigger a coverage interrogation", () => {
  const packet = buildClaimCallPacket(input({
    coverageTermStatus: "carrier_lookup_required",
    policyCoverageStart: "2026-06-01",
    policyCoverageEnd: "2027-06-01"
  }));

  assert.doesNotMatch(packet.verifiedFileFacts.priorPolicyLookupInstruction, /starts after|06\/01\/2026|active policy/i);
  assert.match(packet.verifiedFileFacts.priorPolicyLookupInstruction, /Do not volunteer policy-term dates/i);
  assert.equal(readiness(packet).ready, true);
});

test("verified in-force coverage requires a complete term containing the date of loss", () => {
  const valid = buildClaimCallPacket(input({
    coverageTermStatus: "verified_in_force",
    policyCoverageStart: "2026-05-20",
    policyCoverageEnd: "2027-05-20"
  }));
  assert.equal(readiness(valid).ready, true);

  const missingEnd = buildClaimCallPacket(input({
    coverageTermStatus: "verified_in_force",
    policyCoverageStart: "2026-01-01"
  }));
  assert.equal(readiness(missingEnd).ready, false);
  assert.match(readiness(missingEnd).blockers.join(" "), /both policy term dates/i);

  const outside = buildClaimCallPacket(input({
    coverageTermStatus: "verified_in_force",
    policyCoverageStart: "2026-06-01",
    policyCoverageEnd: "2027-06-01"
  }));
  assert.equal(readiness(outside).ready, false);
  assert.match(readiness(outside).blockers.join(" "), /outside the verified policy term/i);
});

test("a blocked coverage conflict stops a new filing", () => {
  const packet = buildClaimCallPacket(input({ coverageTermStatus: "blocked_conflict" }));
  const result = readiness(packet);

  assert.equal(result.ready, false);
  assert.match(result.blockers.join(" "), /unresolved conflict/i);
  assert.match(packet.verifiedFileFacts.priorPolicyLookupInstruction, /do not open a new claim/i);
});

test("unknown coverage statuses are rejected", () => {
  assert.throws(
    () => buildClaimCallPacket(input({ coverageTermStatus: "probably_active" })),
    /coverageTermStatus must be one of/i
  );
});

test("inferred filename and note categories are review-only for a new claim", () => {
  const packet = buildClaimCallPacket(input(
    { damageDetails: undefined },
    {
      documents: [{ name: "Prior roof claim denial.pdf" }],
      notes: [{ body: "No roof damage observed; old interior leak unrelated to this loss." }]
    }
  ));
  const result = readiness(packet);

  assert.ok(packet.inferredDamageSummary.includes("roof damage"));
  assert.ok(packet.inferredDamageSummary.includes("interior water/ceiling damage"));
  assert.deepEqual(packet.damageSummary, []);
  assert.deepEqual(packet.damageDetails, []);
  assert.equal(packet.damageOpening, "Missing");
  assert.equal(packet.damageEvidenceSource, "missing_approved_damage");
  assert.equal(result.ready, false);
  assert.match(result.blockers.join(" "), /explicitly approved damage facts/i);
});

test("approved damage preserves qualifiers and alone can satisfy damage readiness", () => {
  const detail = "Roof marks were reported, but storm causation has not been established";
  const packet = buildClaimCallPacket(input({ damageDetails: detail }));

  assert.deepEqual(packet.damageDetails, [detail]);
  assert.deepEqual(packet.damageSummary, [detail]);
  assert.equal(packet.damageOpening, `${detail}.`);
  assert.equal(packet.damageEvidenceSource, "approved_override");
  assert.equal(readiness(packet).ready, true);

  const openingOnly = buildClaimCallPacket(input({
    damageDetails: undefined,
    damageOpening: "Approved roof shingle damage description."
  }));
  assert.deepEqual(openingOnly.damageSummary, ["Approved roof shingle damage description."]);
  assert.equal(readiness(openingOnly).ready, true);
});

test("generic or unrelated damage language cannot authorize a filing", () => {
  for (const detail of [
    "Damage occurred",
    "Property damage",
    "Wear and tear to the roof",
    "Old roof damage unrelated to this loss"
  ]) {
    const packet = buildClaimCallPacket(input({ damageDetails: detail }));
    assert.equal(readiness(packet).ready, false, detail);
    assert.match(readiness(packet).blockers.join(" "), /explicitly approved damage facts/i, detail);
  }
});

test("an explicit no-damage statement cannot authorize a filing", () => {
  for (const detail of [
    "No damage observed",
    "There is no damage",
    "Damage was not observed",
    "Not applicable",
    "N/A",
    "Undetermined"
  ]) {
    const packet = buildClaimCallPacket(input({ damageDetails: detail }));
    assert.equal(packet.damageOpening, "Missing", detail);
    assert.equal(readiness(packet).ready, false, detail);
    assert.match(readiness(packet).blockers.join(" "), /explicitly approved damage facts/i, detail);
  }
});

test("carrier lookup still blocks an impossible date of loss", () => {
  const packet = buildClaimCallPacket(input({}, { dateOfLoss: "02/31/2026" }));
  assert.equal(readiness(packet).ready, false);
  assert.match(readiness(packet).blockers.join(" "), /date of loss is invalid/i);
});

test("a new claim cannot proceed with a date of loss but no carrier-usable time", () => {
  for (const stormTime of [
    "",
    "Missing",
    "Unknown",
    "TBD",
    "N/A",
    "Not found",
    "Approximately",
    "not 4 PM",
    "unknown, maybe 4 PM",
    "Missing 4:30 PM",
    "I do not know; 16:30?"
  ]) {
    const result = readiness(buildClaimCallPacket(input({ stormTime })));
    assert.equal(result.ready, false, stormTime);
    assert.match(result.blockers.join(" "), /no storm time/i, stormTime);
    assert.doesNotMatch(result.warnings.join(" "), /no storm time/i, stormTime);
  }
});

test("a new claim accepts an approved daypart or carrier-usable clock time", () => {
  for (const stormTime of [
    "Morning",
    "Late afternoon",
    "Evening",
    "Overnight",
    "4 PM",
    "4:30 PM CDT",
    "16:30",
    "Approximately 5:38 PM CDT based on a nearby reported hail event",
    "Approximately 4:30 PM CDT from the verified file evidence"
  ]) {
    const result = readiness(buildClaimCallPacket(input({ stormTime })));
    assert.equal(result.ready, true, stormTime);
  }
});

test("find-existing behavior remains independent of the new-claim coverage gate", () => {
  const packet = buildClaimCallPacket(input(
    { goal: "find_existing_claim", damageDetails: undefined },
    {
      claimNumber: "CLM-42",
      documents: [{ name: "Roof inspection photos.pdf" }]
    }
  ));
  const result = readiness(packet);

  assert.equal(packet.goal, "find_existing_claim");
  assert.equal(packet.verifiedFileFacts.coverageTermStatus, "not_applicable");
  assert.match(packet.damageSummary.join(" "), /roof damage/i);
  assert.equal(packet.damageOpening, "Not applicable for an existing-claim lookup.");
  assert.equal(result.ready, true);
  assert.doesNotMatch(result.blockers.join(" "), /coverage|policy term/i);
});

test("coverage controls stay server-side and are not exposed to the live model", () => {
  const packet = buildClaimCallPacket(input({ coverageTermStatus: "carrier_lookup_required" }));
  const variables = flattenFactsForDynamicVariables(packet);
  const prompt = renderRetellPrompt(packet);

  for (const key of [
    "coverageTermStatus",
    "policyCoverageStart",
    "policyCoverageEnd",
    "priorPolicyLookupInstruction"
  ]) {
    assert.ok(variables[key]);
    assert.ok(!PROMPT_PLACEHOLDERS.includes(key));
    assert.doesNotMatch(prompt, new RegExp(`\\{\\{${key}\\}\\}`));
  }
  assert.match(prompt, /NEW-CLAIM POLICY HANDLING/);
  assert.match(prompt, /give only \{\{policyNumberForSpeech\}\} with no preface or disclaimer/i);
  assert.match(prompt, /Do not proactively ask the carrier to identify an active policy, confirm coverage, or discuss term dates/i);
  assert.match(prompt, /Policy number to speak: \{\{policyNumberForSpeech\}\}/i);
  assert.doesNotMatch(prompt, /Available policy identifier\/reference/i);
  assert.doesNotMatch(prompt, /I have an available policy reference that may help locate/i);
});

test("live tool, result shape, and post-call schema do not request active-policy proof", () => {
  const packet = buildClaimCallPacket(input({ coverageTermStatus: "carrier_lookup_required" }));
  const llm = buildRetellLlmFromPacket(packet);
  const guardedEnd = llm.generalTools.find((tool) => tool.name === "request_guarded_end_call");
  const properties = guardedEnd.parameters.properties;
  const schema = postCallAnalysisSchema();
  assert.equal(properties.active_policy_number, undefined);
  assert.equal(properties.active_coverage_confirmed, undefined);
  assert.ok(!guardedEnd.parameters.required.includes("active_policy_number"));
  assert.ok(!guardedEnd.parameters.required.includes("active_coverage_confirmed"));
  assert.equal(schema.find((field) => field.name === "active_policy_number"), undefined);
  assert.equal(schema.find((field) => field.name === "active_coverage_confirmed"), undefined);
  assert.equal(packet.resultFormat.activePolicyNumber, undefined);
  assert.equal(packet.resultFormat.activeCoverageConfirmed, undefined);
  assert.doesNotMatch(llm.generalPrompt, /activePolicyNumber|activeCoverageConfirmed|active_policy_number|active_coverage_confirmed/);
});
