import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCarrierFollowUpConversation,
  buildCarrierFollowUpLlmConfig,
  carrierFollowUpAnalysisSchema
} from "./agent.js";

test("direct inspector call uses a conversational opening and cannot reschedule by default", () => {
  const call = buildCarrierFollowUpConversation({
    goal: "inspector_eta",
    destinationType: "field_inspector",
    contactName: "Kory Smith"
  });
  assert.equal(call.opening, "Hi Kory, this is Chance Pearson's AI assistant with Wave Public Adjusting. How are you today?");
  assert.equal(call.schedulingAuthority, "NOT_ALLOWED");
  assert.match(call.approvedQuestions.join(" "), /estimated arrival time/i);
});

test("prompt keeps desk adjuster and field inspector separate and blocks writes and negotiation", () => {
  const prompt = buildCarrierFollowUpLlmConfig().general_prompt;
  assert.match(prompt, /distinct roles/i);
  assert.match(prompt, /do not broaden the call, negotiate coverage or price/i);
  assert.match(prompt, /cannot update JobNimbus/i);
  assert.match(prompt, /scheduling authority is \{\{schedulingAuthority\}\}/i);
  assert.match(prompt, /Give me a second while I pull up that information/i);
  assert.match(prompt, /destination extension is \{\{destinationExtension\}\}/i);
  assert.match(prompt, /enter the extension one digit at a time/i);
  assert.match(prompt, /Press pound only if the IVR specifically requests it/i);
});

test("analysis schema extracts distinct carrier roles and operational results", () => {
  const names = carrierFollowUpAnalysisSchema().map((field) => field.name);
  for (const name of [
    "desk_adjuster_name",
    "field_inspector_name",
    "estimated_arrival_time",
    "document_submission",
    "representation_recognized",
    "carrier_next_step"
  ]) assert.ok(names.includes(name), `${name} missing`);
});
