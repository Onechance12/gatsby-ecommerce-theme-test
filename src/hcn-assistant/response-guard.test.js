import assert from "node:assert/strict";
import test from "node:test";

import { guardHcnAssistantResponse } from "./response-guard.js";

test("assistant response guard removes opaque references and known internal codes", () => {
  const result = guardHcnAssistantResponse({
    message:
      `Review subject_${"a".repeat(32)} and ref_${"b".repeat(32)} in ready_for_pa_review.`,
    sources: []
  });
  assert.doesNotMatch(result, /subject_|ref_|ready_for_pa_review/);
  assert.match(result, /internal reference/);
  assert.match(result, /Ready for PA review/);
});

test("assistant response guard replaces unsupported negative Quo claims", () => {
  const result = guardHcnAssistantResponse({
    message: "There were no recent calls or texts on this file.",
    sources: [
      { key: "jobnimbus", status: "fresh" },
      { key: "quo", status: "incomplete" }
    ]
  });
  assert.doesNotMatch(result, /There were no recent calls/);
  assert.match(result, /couldn't verify Quo calls or texts/i);
  assert.match(result, /won't treat unavailable information as proof/i);
});

test("assistant response guard preserves qualified source limitations", () => {
  const message =
    "I couldn't verify recent Quo calls because that source was unavailable.";
  assert.equal(
    guardHcnAssistantResponse({
      message,
      sources: [{ key: "quo", status: "unavailable" }]
    }),
    message
  );
});

test("assistant response guard permits proven absence from a complete source", () => {
  const message = "No recent Gmail messages matched this exact file.";
  assert.equal(
    guardHcnAssistantResponse({
      message,
      sources: [{ key: "gmail", status: "fresh" }]
    }),
    message
  );
});

test("assistant response guard qualifies negative JobNimbus history claims", () => {
  const result = guardHcnAssistantResponse({
    message: "There are no JobNimbus notes or tasks on this file.",
    sources: [{
      key: "jobnimbus",
      status: "partial"
    }]
  });

  assert.doesNotMatch(result, /There are no JobNimbus notes/);
  assert.match(result, /bounded JobNimbus history check/i);
  assert.match(result, /cannot verify that no older notes/i);
  assert.match(result, /Current file facts and documents were evaluated separately/i);
});
