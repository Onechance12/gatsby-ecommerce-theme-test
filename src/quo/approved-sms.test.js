import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_QUO_SMS_MAX_CHARACTERS,
  APPROVED_QUO_SMS_TYPE,
  quoSmsContentSha256,
  validateApprovedQuoSmsPayload
} from "./approved-sms.js";

const exact = Object.freeze({
  query: "#990001",
  from: "+12025550101",
  to: "+12025550102",
  content: "Synthetic inspection scheduling message — reply with a convenient time. Saturday at 11:00 or 12:00 also works."
});

test("approved Quo SMS binds one exact file, sender, recipient and text hash", () => {
  const result = validateApprovedQuoSmsPayload({ ...exact });
  assert.equal(APPROVED_QUO_SMS_TYPE, "quo.send_text");
  assert.equal(result.fileNumber, "990001");
  assert.equal(exact.content.length, 110);
  assert.equal(Buffer.byteLength(exact.content, "utf8"), 112);
  assert.equal(result.characterCount, 110);
  assert.equal(result.contentSha256, "9befcb7a6ff8708291660557419284c7464471f5be1ebc43d7fb9c172c08767d");
  assert.equal(result.contentSha256, quoSmsContentSha256(exact.content));
  assert.equal(Object.isFrozen(result), true);
});

test("approved Quo SMS rejects aliases, control fields, formatting ambiguity and excluded files", () => {
  for (const patch of [
    { query: "Synthetic Client" },
    { query: "#2628" },
    { from: "(202) 555-0101" },
    { to: "202-555-0102" },
    { to: exact.from },
    { content: " leading" },
    { content: "trailing " },
    { content: "bad\u0000text" },
    { content: "x".repeat(APPROVED_QUO_SMS_MAX_CHARACTERS + 1) }
  ]) {
    assert.throws(() => validateApprovedQuoSmsPayload({ ...exact, ...patch }));
  }
  for (const key of ["execute", "approvalDigest", "approvalChallenge", "message", "text", "userId", "attemptId", "followUps"]) {
    assert.throws(() => validateApprovedQuoSmsPayload({ ...exact, [key]: "unsafe" }));
  }
  assert.throws(() => validateApprovedQuoSmsPayload({ ...exact, operatorScope: "assigned" }));
  assert.doesNotThrow(() => validateApprovedQuoSmsPayload(
    { ...exact, operatorScope: "assigned" },
    { allowOperatorScope: true }
  ));
  assert.throws(() => validateApprovedQuoSmsPayload(
    { ...exact, operatorScope: "company" },
    { allowOperatorScope: true }
  ));
});
