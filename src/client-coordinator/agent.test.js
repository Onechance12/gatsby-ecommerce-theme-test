import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClientCoordinatorConversation,
  buildClientCoordinatorLlmConfig,
  clientCoordinatorAnalysisSchema,
  extractClientCoordinatorResult
} from "./agent.js";

test("appointment mode creates one conversational purpose and fallback text", () => {
  const plan = buildClientCoordinatorConversation({
    mode: "appointment_confirmation",
    firstName: "Rosa",
    appointmentDate: "Friday, July 17",
    appointmentWindow: "2:00 PM and 4:00 PM",
    interiorAccessRequired: true
  });

  assert.equal(plan.opening, "Hey Rosa, this is Chance's AI assistant. How are you doing today?");
  assert.match(plan.purpose, /^So I'm calling because/);
  assert.match(plan.purpose, /adjuster appointment scheduled Friday, July 17/);
  assert.match(plan.purpose, /Will you or another adult be available/);
  assert.match(plan.fallbackText, /provide interior access/);
  assert.equal(plan.reminderTopics.length, 0);
});

test("only explicitly selected Brain reminder topics enter a call plan", () => {
  const plan = buildClientCoordinatorConversation({
    mode: "status_update",
    firstName: "Robert",
    statusUpdate: "the carrier inspection is complete and we are waiting for the carrier's report.",
    reminderTopics: ["process_timing", "not_a_topic"],
    reminderRules: {
      process_timing: "Carrier response time often controls the pace.",
      titan_role: "Titan supports the claim process."
    }
  });

  assert.deepEqual(plan.reminderTopics, ["process_timing"]);
  assert.match(plan.reminderGuidance, /Carrier response time/);
  assert.doesNotMatch(plan.reminderGuidance, /Titan supports/);
});

test("mode-specific required facts fail closed", () => {
  assert.throws(
    () => buildClientCoordinatorConversation({ mode: "missing_document_request", firstName: "Sonia" }),
    /documentNeeded is required/
  );
  assert.throws(
    () => buildClientCoordinatorConversation({ mode: "appointment_confirmation", firstName: "Sonia" }),
    /appointmentDate is required/
  );
});

test("client coordinator prompt cannot send, write, impersonate, or promise", () => {
  const config = buildClientCoordinatorLlmConfig();
  assert.match(config.general_prompt, /Never impersonate Andrea/);
  assert.match(config.general_prompt, /cannot send a text or email, update JobNimbus/);
  assert.match(config.general_prompt, /promise approval/);
  assert.match(config.general_prompt, /Do not leave a voicemail/);
  assert.match(config.general_prompt, /respond naturally in one short sentence/);
  assert.deepEqual(config.general_tools.map((tool) => tool.name), ["end_call"]);
});

test("post-call extraction keeps structured client commitments separate", () => {
  const result = extractClientCoordinatorResult({
    call_id: "call-1",
    call_status: "ended",
    call_analysis: {
      call_successful: true,
      custom_analysis_data: {
        contact_outcome: "connected",
        objective_completed: "yes",
        appointment_confirmed: true,
        interior_access_confirmed: true,
        client_questions: "Asked who will attend.",
        preferred_contact_method: "text",
        opt_out_requested: false
      }
    }
  });

  assert.equal(result.structured.contactOutcome, "connected");
  assert.equal(result.structured.appointmentConfirmed, true);
  assert.equal(result.structured.preferredContactMethod, "text");
  assert.equal(result.structured.clientQuestions, "Asked who will attend.");
});

test("post-call schema includes opt-out and human follow-up fields", () => {
  const names = clientCoordinatorAnalysisSchema().map((field) => field.name);
  assert.equal(names.includes("opt_out_requested"), true);
  assert.equal(names.includes("follow_up_needed"), true);
  assert.equal(names.includes("reminders_used"), true);
});
