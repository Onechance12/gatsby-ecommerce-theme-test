const FILE_REF = /^subject_[a-f0-9]{32}$/;
const PLAN_ID = /^plan_[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const APPROVAL_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const USER_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function validateJobroloAssistantTurnInput(value) {
  exactRecord(value, ["kind", "fileRef", "prompt", "mode"], "assistant turn");
  if (!new Set(["general", "file"]).has(value.kind)) {
    invalid("kind must be general or file");
  }
  if (
    (value.kind === "general" && value.fileRef !== "")
    || (value.kind === "file" && !FILE_REF.test(value.fileRef))
  ) {
    invalid("fileRef must exactly match the selected assistant scope");
  }
  if (
    typeof value.prompt !== "string"
    || !value.prompt.trim()
    || value.prompt.length > 4_000
    || Buffer.byteLength(value.prompt.trim(), "utf8") > 8 * 1024
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.prompt)
  ) {
    invalid("prompt must contain 1-4000 safe characters");
  }
  if (!new Set(["auto", "deep"]).has(value.mode)) {
    invalid("mode must be auto or deep");
  }
  return Object.freeze({
    kind: value.kind,
    fileRef: value.fileRef,
    prompt: value.prompt.trim(),
    mode: value.mode
  });
}

export function validateJobroloActionExecuteInput(
  value,
  { plan, now = Date.now } = {}
) {
  exactRecord(value, ["planId", "approval"], "action execution");
  if (!PLAN_ID.test(value.planId)) invalid("planId is invalid");
  exactRecord(
    value.approval,
    [
      "schema",
      "approvalRequestId",
      "planDigest",
      "approvedAt",
      "approvedByUserId"
    ],
    "approval attestation"
  );
  if (value.approval.schema !== "jobrolo.approval-attestation.v1") {
    invalid("approval attestation schema is invalid");
  }
  if (!APPROVAL_ID.test(value.approval.approvalRequestId)) {
    invalid("approvalRequestId is invalid");
  }
  if (!USER_ID.test(value.approval.approvedByUserId)) {
    invalid("approvedByUserId is invalid");
  }
  if (!DIGEST.test(value.approval.planDigest)) {
    invalid("planDigest is invalid");
  }
  if (!ISO_UTC.test(value.approval.approvedAt)) {
    invalid("approvedAt must be an ISO UTC instant");
  }
  if (
    !plan
    || plan.planId !== value.planId
    || plan.approvalDigest !== value.approval.planDigest
    || plan.status !== "pending"
  ) {
    conflict(
      "The Jobrolo approval does not match the exact pending HCN plan."
    );
  }
  const approvedAtMs = Date.parse(value.approval.approvedAt);
  const createdAtMs = Date.parse(String(plan.createdAt || ""));
  const current = now();
  if (
    !Number.isFinite(approvedAtMs)
    || new Date(approvedAtMs).toISOString() !== value.approval.approvedAt
    || !Number.isFinite(createdAtMs)
    || approvedAtMs < createdAtMs - 5_000
    || approvedAtMs > current + 60_000
    || current - approvedAtMs > 15 * 60_000
  ) {
    conflict(
      "The Jobrolo approval is not current for this exact HCN plan."
    );
  }
  return Object.freeze({
    planId: value.planId,
    approval: Object.freeze({ ...value.approval })
  });
}

export function validateJobroloReceiptDetailInput(value) {
  exactRecord(value, ["planId"], "receipt detail");
  if (!PLAN_ID.test(value.planId)) invalid("planId is invalid");
  return Object.freeze({ planId: value.planId });
}

export function jobroloHcnResponse(requestId, result) {
  const isManagementSweep =
    result?.schema === "hcn.console.management-sweep.v1"
    || result?.schemaVersion === "hcn.console.management-sweep.v1";
  return Object.freeze({
    schema: "hcn.jobrolo.response.v1",
    requestId,
    generatedAt: new Date().toISOString(),
    authority: Object.freeze({
      principalMode: "fixed_server_side",
      fileScope: isManagementSweep
        ? "configured_management_adjusters"
        : "assigned_only",
      liveSourcesWin: true,
      automaticExecution: false,
      exactApprovalRequired: !isManagementSweep,
      providerCredentialsExposed: false
    }),
    result
  });
}

export function projectJobroloAssistantTurnResult(value) {
  if (!isPlainRecord(value)) invalid("assistant turn result must be an object");
  const allowed = [
    "schema",
    "generatedAt",
    "persisted",
    "cachePolicy",
    "authority",
    "routing",
    "message",
    "plan",
    "sources",
    "uiDirective"
  ];
  const result = {};
  for (const key of allowed) {
    if (Object.hasOwn(value, key)) result[key] = value[key];
  }
  if (
    result.schema !== "hcn.console.assistant-turn.v4"
    || typeof result.message !== "string"
    || !result.message.trim()
  ) {
    invalid("assistant turn result is invalid");
  }
  assertNoInternalAssistantReferences(result);
  return Object.freeze(result);
}

function assertNoInternalAssistantReferences(value) {
  const pending = [value];
  const visited = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (visited.has(item)) {
      invalid("assistant turn result contains a cyclic value");
    }
    visited.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (key === "conversationRef" || key === "messageRef") {
        invalid("assistant turn result exposes internal HCN references");
      }
      if (
        typeof child === "string"
        && /\b(?:conversation|message)_[a-f0-9]{32}\b/.test(child)
      ) {
        invalid("assistant turn result exposes internal HCN references");
      }
      if (child && typeof child === "object") pending.push(child);
    }
  }
}

function exactRecord(value, keys, label) {
  if (!isPlainRecord(value)) invalid(`${label} must be an object`);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} contains unsupported fields`);
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message) {
  const error = new Error(message);
  error.code = "invalid_jobrolo_hcn_contract";
  error.statusCode = 400;
  throw error;
}

function conflict(message) {
  const error = new Error(message);
  error.code = "jobrolo_hcn_approval_mismatch";
  error.statusCode = 409;
  throw error;
}
