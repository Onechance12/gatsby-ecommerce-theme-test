import assert from "node:assert/strict";
import test from "node:test";

import { hcnAssistantAvailableToolNames } from "./tool-selection.js";

const select = (prompt) => hcnAssistantAvailableToolNames({
  prompt,
  conversationKind: "file"
});

test("ordinary and incidental file language does not widen post-review reads", () => {
  for (const prompt of [
    "Review this exact file and tell me what needs attention.",
    "What status is the estimate in?",
    "The appointment is already scheduled.",
    "There are photos in this file.",
    "Give me the current claim status and next safest step."
  ]) {
    assert.deepEqual(select(prompt), []);
  }
});

test("explicit and non-negated file requests select only necessary read tools", () => {
  assert.deepEqual(select("Review the policy document."), [
    "read_file_document_catalog",
    "read_file_document"
  ]);
  assert.deepEqual(select("Show me the images."), [
    "read_file_photo_catalog"
  ]);
  assert.deepEqual(select("Research the hail date candidates."), [
    "research_file_hail_dates"
  ]);
  assert.deepEqual(select("When is the adjuster appointment?"), [
    "read_calendar_day"
  ]);
  assert.deepEqual(
    select("Review the policy and check the calendar appointment."),
    [
      "read_file_document_catalog",
      "read_file_document",
      "read_calendar_day"
    ]
  );
});

test("negated requests stay closed and chat kinds receive narrow read registries", () => {
  assert.deepEqual(select("Do not check the calendar appointment."), []);
  assert.deepEqual(select("Don't review the policy document."), []);
  assert.deepEqual(select("Skip the photos and just summarize the file."), []);
  assert.deepEqual(select("Avoid researching the hail date."), []);

  const general = hcnAssistantAvailableToolNames({
    prompt: "Tell me what you can do.",
    conversationKind: "general"
  });
  assert.deepEqual(general, []);
  assert.equal(Object.isFrozen(general), true);
  assert.deepEqual(hcnAssistantAvailableToolNames({
    prompt: "Check my calendar availability tomorrow.",
    conversationKind: "general"
  }), []);
  assert.deepEqual(hcnAssistantAvailableToolNames({
    prompt: "Do not check my calendar availability.",
    conversationKind: "general"
  }), []);
  assert.deepEqual(hcnAssistantAvailableToolNames({
    prompt: "Review the management picture.",
    conversationKind: "sweep"
  }), ["run_management_sweep", "read_closed_file_benchmark"]);
  assert.deepEqual(hcnAssistantAvailableToolNames({
    prompt: "Anything",
    conversationKind: "unknown"
  }), []);
});
