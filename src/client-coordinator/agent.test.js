import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClientCoordinatorAgentSettings,
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
  assert.match(plan.purpose, /Will you or another adult be available to meet Chance and the adjuster\?$/);
  assert.match(plan.fallbackText, /Chance's AI assistant/);
  assert.match(plan.fallbackText, /meet Chance and the adjuster and provide interior access/);
  assert.equal(plan.reminderTopics.length, 0);
});

test("every fallback message identifies Chance's AI assistant", () => {
  const plans = [
    buildClientCoordinatorConversation({
      mode: "appointment_confirmation",
      firstName: "Robert",
      appointmentDate: "Tuesday, July 21",
      appointmentWindow: "10:00 AM and 12:00 PM"
    }),
    buildClientCoordinatorConversation({
      mode: "missing_document_request",
      firstName: "Sonia",
      documentNeeded: "the current declarations page"
    }),
    buildClientCoordinatorConversation({
      mode: "status_update",
      firstName: "Rosa",
      statusUpdate: "the carrier inspection is scheduled."
    }),
    buildClientCoordinatorConversation({
      mode: "client_check_in",
      firstName: "David"
    })
  ];

  for (const plan of plans) assert.match(plan.fallbackText, /Chance's AI assistant/);
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
  assert.match(config.general_prompt, /CONFIRM IDENTITY BEFORE THE PURPOSE/);
  assert.match(config.general_prompt, /Only after confirmation, say exactly/);
  assert.equal(config.start_speaker, "user");
  assert.equal(config.begin_message, "");
  assert.deepEqual(config.general_tools.map((tool) => tool.name), ["end_call"]);
});

test("client coordinator agent settings bound silence, voicemail, and IVR behavior", () => {
  const settings = buildClientCoordinatorAgentSettings();
  assert.equal(settings.reminder_trigger_ms, 30000);
  assert.equal(settings.reminder_max_count, 1);
  assert.equal(settings.end_call_after_silence_ms, 90000);
  assert.equal(settings.max_call_duration_ms, 300000);
  assert.deepEqual(settings.voicemail_option, { action: { type: "hangup" } });
  assert.deepEqual(settings.ivr_option, { action: { type: "hangup" } });
  assert.equal(settings.responsiveness, 0.85);
  assert.equal(settings.interruption_sensitivity, 0.8);
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
