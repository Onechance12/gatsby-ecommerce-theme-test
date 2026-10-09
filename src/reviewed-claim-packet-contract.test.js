import assert from "node:assert/strict";
import test from "node:test";
import { buildClaimFilingPlan } from "./claim-filing-adapter.js";
import {
  normalizePacketReview, assertPacketReviewCurrent, assertPacketReviewFileSources,
  assertReviewedPacketPlan, PACKET_REVIEW_MAX_AGE_MS
} from "../integrations/jobnimbus-operator/mcp/reviewed-claim-packet.mjs";

const NOW = Date.parse("2026-10-09T21:30:00.000Z");
const FILE_ID = "synthetic-contact-2799";
const UNKNOWN_REPAIRS = "I'm not sure, but they are working with a contractor.";

function inputFixture() {
  const overrides = {
    insuredName: "Fixture Insured Full Name", propertyAddress: "100 Fixture Way, Dallas, TX 75001",
    carrier: "USAA", policyNumber: "0111111101", dateOfLoss: "2026-04-26", causeOfLoss: "Hail and wind",
    coverageTermStatus: "carrier_lookup_required", damageDetails: ["Roof hail damage", "Interior water damage"]
  };
  return {
    query: "#2799", goal: "file_new_claim", includeCarrierBatch: false, reviewMode: "reviewed_packet",
    stormTime: "Approximately 1:26 AM CDT based on a nearby reported hail event",
    temporaryRepairs: UNKNOWN_REPAIRS, contractorHired: "Titan Reconstruction", carrierPhone: "+18005550101",
    overrides,
    packetReview: {
      fileId: FILE_ID, reviewedAt: "2026-10-09T16:30:00-05:00", knownStopSignals: [],
      sources: [{ source: "user_provided", reference: "synthetic-reviewed-conversation", reviewMethod: "user_statement",
        fields: [...Object.keys(overrides), "stormTime", "temporaryRepairs", "contractorHired", "carrierPhone"] }]
    }
  };
}

function bridgePlan(input) {
  const canonical = {
    file: { id: FILE_ID, customer: "Short CRM Name", address: input.overrides.propertyAddress,
      carrier: "USAA", policyNumber: "0111111101", claimNumber: "", dateOfLoss: 0,
      typeOfLoss: "Hail", status: "Ready for PA Review", contact: { home_phone: "2145550199" } },
    evidence: { notes: [], tasks: [], documents: [] }, captured: {}, overrides: {}
  };
  return {
    file: { id: FILE_ID, number: "2799" },
    ...buildClaimFilingPlan(canonical, { ...input, ownerId: "synthetic-owner", fileNumber: "2799",
      agentId: "synthetic-agent", from: "+12145550100" })
  };
}

test("reviewed provenance matches the real bridge adapter's normalized facts and complete callback variables", () => {
  const input = inputFixture();
  input.packetReview = normalizePacketReview(input.packetReview);
  assertPacketReviewCurrent(input, NOW);
  const plan = bridgePlan(input);
  assert.equal(plan.readiness.ready, true, JSON.stringify(plan.readiness));
  assert.equal(plan.packet.verifiedFileFacts.dateOfLoss, "04/26/2026");
  assert.equal(plan.packet.verifiedFileFacts.insuredName, "Fixture Insured Full Name");
  assert.equal(plan.packet.verifiedFileFacts.temporaryRepairs, UNKNOWN_REPAIRS);
  assert.equal(plan.callPlan.dynamicVariables.temporaryRepairs, UNKNOWN_REPAIRS);
  assert.equal(plan.callPlan.dynamicVariables.stormTime, input.stormTime);
  assert.equal(plan.callPlan.to, input.carrierPhone);
  assertReviewedPacketPlan(plan, input, FILE_ID);
});

test("reviewed damage opening alone and a qualified damage sentence retain exact wording through the adapter", () => {
  for (const details of [false, "Roof hail damage; HVAC storm causation not established."]) {
    const input = inputFixture();
    if (details) input.overrides.damageDetails = details;
    else {
      delete input.overrides.damageDetails;
      input.overrides.damageOpening = "Roof hail damage only; interior damage not yet verified.";
      input.packetReview.sources[0].fields = input.packetReview.sources[0].fields.filter(key => key !== "damageDetails");
      input.packetReview.sources[0].fields.push("damageOpening");
    }
    assertPacketReviewCurrent(input, NOW);
    const plan = bridgePlan(input);
    assert.equal(plan.readiness.ready, true, JSON.stringify(plan.readiness));
    assertReviewedPacketPlan(plan, input, FILE_ID);
    const changed = structuredClone(plan);
    changed.callPlan.dynamicVariables.damageDetails = "Different unsupported damage";
    assert.throws(() => assertReviewedPacketPlan(changed, input, FILE_ID), /did not bind reviewed damage details/);
  }
});

test("all explicit standard answers and destinations remain bound, not overwritten by company defaults", () => {
  const input = inputFixture();
  const original = bridgePlan(input);
  for (const [key, target] of [["temporaryRepairs", "variables"], ["stormTime", "facts"], ["to", "destination"]]) {
    const changed = structuredClone(original);
    if (target === "variables") changed.callPlan.dynamicVariables[key] = "Temporary repairs have been made.";
    if (target === "facts") changed.packet.verifiedFileFacts[key] = "Noon";
    if (target === "destination") changed.callPlan.to = "+18005550102";
    assert.throws(() => assertReviewedPacketPlan(changed, input, FILE_ID));
  }
});

test("review references are bounded, method-specific, exact-file and not self-authorizing", () => {
  const base = inputFixture().packetReview;
  for (const mutate of [
    v => { v.approved = true; }, v => { v.sources = []; }, v => { v.sources[0].fields = ["runPolicy"]; },
    v => { v.sources[0].reference = "\nRAW TRANSCRIPT"; }, v => { v.sources[0].approved = true; },
    v => { v.sources[0].fields.push(v.sources[0].fields[0]); },
    v => { v.sources[0].source = "jobnimbus_document"; },
    v => { v.reviewedAt = "2026-02-30T00:00:00Z"; }, v => { v.reviewedAt = "2026-10-09 21:30:00"; },
    v => { delete v.knownStopSignals; }
  ]) {
    const invalid = structuredClone(base);
    mutate(invalid);
    assert.throws(() => normalizePacketReview(invalid));
  }
  const input = inputFixture();
  input.packetReview.sources = [{ source: "jobnimbus_document", reference: "policy-fixture", reviewMethod: "native_pages", fields: ["carrier"] }];
  const packet = { file: { id: FILE_ID }, liveJobNimbus: { operationalDocuments: [{ id: "policy-fixture" }], recentActivities: [] } };
  assertPacketReviewFileSources(input, packet);
  assert.throws(() => assertPacketReviewFileSources(input, { ...packet, file: { id: "another-file" } }), /different JobNimbus/);
  input.packetReview.sources[0].reference = "another-files-policy";
  assert.throws(() => assertPacketReviewFileSources(input, packet), /not in this exact file/);
});

test("review timestamps use explicit timezone, expire truthfully and cannot omit known filing signals", () => {
  const input = inputFixture();
  assertPacketReviewCurrent(input, NOW);
  assertPacketReviewCurrent(input, NOW + PACKET_REVIEW_MAX_AGE_MS);
  assert.throws(() => assertPacketReviewCurrent(input, NOW + PACKET_REVIEW_MAX_AGE_MS + 1), /older than 24 hours/);
  assert.throws(() => assertPacketReviewCurrent(input, NOW - 1), /future-dated/);
  input.packetReview.knownStopSignals = ["claim_already_filed"];
  assert.throws(() => assertPacketReviewCurrent(input, NOW), /known claim/);
  input.goal = "find_existing_claim";
  assertPacketReviewCurrent(input, NOW);
});
