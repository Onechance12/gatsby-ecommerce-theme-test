import assert from "node:assert/strict";
import test from "node:test";

import {
  validateJobroloActionExecuteInput,
  validateJobroloAssistantTurnInput
} from "./jobrolo-contracts.js";

test("assistant input binds general and file scopes exactly", () => {
  assert.equal(validateJobroloAssistantTurnInput({
    kind: "general",
    fileRef: "",
    prompt: "What needs attention?",
    mode: "auto"
  }).prompt, "What needs attention?");
  assert.throws(() => validateJobroloAssistantTurnInput({
    kind: "general",
    fileRef: "subject_0123456789abcdef0123456789abcdef",
    prompt: "Read it",
    mode: "auto"
  }), /fileRef/);
});

test("execution attestation must match the exact pending plan digest", () => {
  const now = Date.parse("2026-08-05T10:01:00.000Z");
  const plan = {
    planId: "plan_0123456789abcdef0123456789abcdef",
    approvalDigest: "a".repeat(64),
    status: "pending",
    createdAt: "2026-08-05T10:00:00.000Z"
  };
  const input = {
    planId: plan.planId,
    approval: {
      schema: "jobrolo.approval-attestation.v1",
      approvalRequestId: "approval_0123456789abcdef",
      planDigest: plan.approvalDigest,
      approvedAt: "2026-08-05T10:00:30.000Z",
      approvedByUserId: "user_0123456789abcdef"
    }
  };
  assert.equal(
    validateJobroloActionExecuteInput(input, { plan, now: () => now }).planId,
    plan.planId
  );
  assert.throws(
    () => validateJobroloActionExecuteInput({
      ...input,
      approval: { ...input.approval, planDigest: "b".repeat(64) }
    }, { plan, now: () => now }),
    /does not match/
  );
  assert.throws(
    () => validateJobroloActionExecuteInput({
      ...input,
      approval: {
        ...input.approval,
        approvedAt: "2026-02-31T10:00:30.000Z"
      }
    }, { plan, now: () => now }),
    /not current/
  );
});
