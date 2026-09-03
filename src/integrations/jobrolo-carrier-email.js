export const JOBROLO_HCN_CARRIER_EMAIL_CONTRACT =
  "jobrolo.hcn.carrier-email.v1";

export const HCN_JOBROLO_CARRIER_EMAIL_ROUTES = Object.freeze({
  status: "/integrations/jobrolo/v1/carrier-emails/status",
  draftPrepare:
    "/integrations/jobrolo/v1/carrier-emails/drafts/prepare",
  draftExecute:
    "/integrations/jobrolo/v1/carrier-emails/drafts/execute",
  sendPrepare:
    "/integrations/jobrolo/v1/carrier-emails/sends/prepare",
  sendExecute:
    "/integrations/jobrolo/v1/carrier-emails/sends/execute",
  receiptDetail:
    "/integrations/jobrolo/v1/carrier-emails/receipts/detail"
});

export const HCN_JOBROLO_CARRIER_EMAIL_ROUTE_LIST = Object.freeze(
  Object.values(HCN_JOBROLO_CARRIER_EMAIL_ROUTES)
);

const FILE_REF = /^subject_[a-f0-9]{32}$/;
const RECORD_REF = /^ref_[a-f0-9]{32}$/;
const PLAN_ID = /^plan_[a-f0-9]{32}$/;
const MAX_BODY_BYTES = 48 * 1024;

export function validateJobroloCarrierStatusInput(value) {
  exactRecord(value, ["contract"], "carrier status");
  return Object.freeze({ contract: contract(value.contract) });
}

export function validateJobroloCarrierDraftPrepareInput(value) {
  exactRecord(
    value,
    ["contract", "fileRef", "documentRef", "body"],
    "carrier draft preparation"
  );
  return Object.freeze({
    contract: contract(value.contract),
    fileRef: opaque(value.fileRef, FILE_REF, "fileRef"),
    documentRef: opaque(value.documentRef, RECORD_REF, "documentRef"),
    body: boundedBody(value.body)
  });
}

export function validateJobroloCarrierSendPrepareInput(value) {
  exactRecord(
    value,
    ["contract", "fileRef", "draftRef"],
    "carrier send preparation"
  );
  return Object.freeze({
    contract: contract(value.contract),
    fileRef: opaque(value.fileRef, FILE_REF, "fileRef"),
    draftRef: opaque(value.draftRef, RECORD_REF, "draftRef")
  });
}

export function validateJobroloCarrierExecuteInput(value) {
  exactRecord(
    value,
    ["contract", "planId", "approval"],
    "carrier execution"
  );
  return Object.freeze({
    contract: contract(value.contract),
    planId: opaque(value.planId, PLAN_ID, "planId"),
    approval: immutableRecord(value.approval, "approval")
  });
}

export function validateJobroloCarrierReceiptInput(value) {
  exactRecord(
    value,
    ["contract", "planId"],
    "carrier receipt detail"
  );
  return Object.freeze({
    contract: contract(value.contract),
    planId: opaque(value.planId, PLAN_ID, "planId")
  });
}

export function assertJobroloCarrierPlan(plan, expectedType) {
  if (
    !["gmail.create_draft", "gmail.send_existing_draft"].includes(
      expectedType
    )
    || !plan
    || typeof plan !== "object"
    || Array.isArray(plan)
    || !Array.isArray(plan.operations)
    || plan.operations.length !== 1
    || plan.operations[0]?.type !== expectedType
  ) {
    const error = new Error(
      "The pending HCN plan is not the exact carrier-email operation authorized by this route."
    );
    error.code = "jobrolo_hcn_carrier_plan_mismatch";
    error.statusCode = 409;
    throw error;
  }
  return plan;
}

export function projectJobroloCarrierEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("carrier envelope value must be an object");
  }
  return Object.freeze({
    ...value,
    schema: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT,
    contract: JOBROLO_HCN_CARRIER_EMAIL_CONTRACT
  });
}

function contract(value) {
  if (value !== JOBROLO_HCN_CARRIER_EMAIL_CONTRACT) {
    invalid("carrier-email contract version is not supported");
  }
  return value;
}

function boundedBody(value) {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES
    || /[\u0000\u0008\u000b\u000c\u007f]/.test(value)
  ) {
    invalid("body must be exact bounded email text");
  }
  return value;
}

function opaque(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid(`${label} must be an opaque HCN reference`);
  }
  return value;
}

function immutableRecord(value, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${label} must be an exact object`);
  }
  return Object.freeze({ ...value });
}

function exactRecord(value, keys, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) {
    invalid(`${label} has an invalid shape`);
  }
}

function invalid(message) {
  const error = new Error(message);
  error.code = "jobrolo_hcn_carrier_contract_invalid";
  error.statusCode = 400;
  throw error;
}
