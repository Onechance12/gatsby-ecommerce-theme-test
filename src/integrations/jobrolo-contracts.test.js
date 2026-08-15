import assert from "node:assert/strict";
import test from "node:test";

import {
  jobroloHcnResponse,
  projectJobroloAssistantTurnResult,
  validateJobroloActionExecuteInput,
  validateJobroloAssistantTurnInput
} from "./jobrolo-contracts.js";

test("exact Quo phone history is read-only and truthfully all-line scoped", () => {
  const response = jobroloHcnResponse(
    `request_${"a".repeat(32)}`,
    { schema: "hcn.console.quo-phone-history.v1" }
  );
  assert.equal(response.authority.fileScope, "fixed_principal_all_team_lines");
  assert.equal(response.authority.exactApprovalRequired, false);
  assert.equal(response.authority.automaticExecution, false);
});

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

test("assistant projection strips private store identifiers and fails closed on nested references", () => {
  const projected = projectJobroloAssistantTurnResult({
    schema: "hcn.console.assistant-turn.v4",
    generatedAt: "2026-08-05T10:00:00.000Z",
    persisted: true,
    cachePolicy: "no_store",
    conversationRef: `conversation_${"a".repeat(32)}`,
    revision: 2,
    messageRef: `message_${"b".repeat(32)}`,
    authority: { canRead: true },
    routing: { route: "deterministic" },
    message: "Safe user-visible response.",
    plan: null,
    sources: [],
    uiDirective: "open_work_center"
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    "authority",
    "cachePolicy",
    "generatedAt",
    "message",
    "persisted",
    "plan",
    "routing",
    "schema",
    "sources",
    "uiDirective"
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /conversation_|message_/);

  assert.throws(
    () => projectJobroloAssistantTurnResult({
      schema: "hcn.console.assistant-turn.v4",
      message: "Unsafe result.",
      sources: [{ messageRef: `message_${"c".repeat(32)}` }]
    }),
    /internal HCN references/
  );
  assert.throws(
    () => projectJobroloAssistantTurnResult({
      schema: "hcn.console.assistant-turn.v4",
      message: "Unsafe result.",
      sources: [{ value: `conversation_${"d".repeat(32)}` }]
    }),
    /internal HCN references/
  );
});
