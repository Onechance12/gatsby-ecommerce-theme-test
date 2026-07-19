import test from "node:test";
import assert from "node:assert/strict";

import { buildCommunicationRecoveryQueue } from "./communication-recovery.js";

const files = [
  {
    id: "birtha-id",
    number: "2750",
    name: "Birtha Jeter",
    address: "2332 Blanton St, Dallas, TX 75227",
    phone: "214-555-0100",
    carrier: "State Farm",
    claimNumber: "43-0H7J-927",
    policyNumber: "58-YA-U017-0"
  },
  {
    id: "alice-id",
    number: "2742",
    name: "Alice Gonzales",
    address: "2904 Hillside Dr, Mesquite, TX 75149",
    phone: "469-438-0475",
    claimNumber: "000832906218"
  }
];

test("matches an unknown-number voicemail by claim number and prioritizes scheduling", () => {
  const result = buildCommunicationRecoveryQueue([{
    id: "AC1",
    channel: "quo",
    type: "voicemail",
    participant: "+18005550199",
    atUtc: "2026-07-18T15:00:00Z",
    transcript: "Calling about claim 43-0H7J-927 to schedule the property inspection."
  }], files);

  assert.equal(result.appointmentCandidates, 1);
  assert.equal(result.queue[0].match.file.number, "2750");
  assert.equal(result.queue[0].match.confidence, "high");
});

test("keeps unmatched missed calls visible for manual recovery", () => {
  const result = buildCommunicationRecoveryQueue([{
    id: "AC2",
    channel: "quo",
    type: "missed_call",
    participant: "+12817738143",
    atUtc: "2026-07-18T16:00:00Z"
  }], files);

  assert.equal(result.unmatched, 1);
  assert.equal(result.queue[0].reviewRequired, true);
  assert.equal(result.queue[0].classification, "callback_required");
});

test("matches scheduling email by insured and property address", () => {
  const result = buildCommunicationRecoveryQueue([{
    id: "gmail-1",
    channel: "gmail",
    type: "email",
    atUtc: "2026-07-18T17:00:00Z",
    subject: "Inspection for Alice Gonzales",
    text: "Please confirm access at 2904 Hillside Dr."
  }], files);

  assert.equal(result.queue[0].match.file.number, "2742");
  assert.equal(result.queue[0].classification, "appointment_scheduling");
});
