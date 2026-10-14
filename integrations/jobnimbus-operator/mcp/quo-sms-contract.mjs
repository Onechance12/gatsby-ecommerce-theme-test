import { createHash } from "node:crypto";

export const QUO_SMS_TYPE = "quo.send_text";
export const QUO_SMS_MAX_CHARACTERS = 1600;

export function quoSmsHash(content) {
  return createHash("sha256").update(String(content), "utf8").digest("hex");
}

export function validateQuoSmsPayload(payload, options = {}) {
  if (!plainObject(payload)) throw new Error("Quo SMS payload must be one exact object.");
  const expected = ["content", "from", "query", "to"];
  if (options.allowOperatorScope === true) expected.push("operatorScope");
  const keys = Object.keys(payload).sort();
  expected.sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(
      `Quo SMS payload must be exactly {query,from,to,content}${
        options.allowOperatorScope === true ? " plus the coordinator-injected operatorScope" : ""
      }.`
    );
  }
  if (options.allowOperatorScope === true && payload.operatorScope !== "assigned") {
    throw new Error("Quo SMS requires the assigned operator scope.");
  }
  const query = String(payload.query || "").trim();
  const fileNumber = query.replace(/^#/, "");
  const from = exactE164(payload.from, "from");
  const to = exactE164(payload.to, "to");
  const content = payload.content;
  if (!/^#?\d+$/.test(query) || fileNumber === "2628") {
    throw new Error("Quo SMS requires one exact numeric, non-excluded JobNimbus file number.");
  }
  if (from === to) throw new Error("Quo SMS sender and recipient must differ.");
  if (
    typeof content !== "string"
    || !content
    || content !== content.trim()
    || content.length > QUO_SMS_MAX_CHARACTERS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
  ) {
    throw new Error(
      `Quo SMS content must be exact, nonblank, trimmed text of at most ${QUO_SMS_MAX_CHARACTERS} characters without control bytes.`
    );
  }
  return Object.freeze({
    query,
    fileNumber,
    from,
    to,
    content,
    characterCount: content.length,
    contentSha256: quoSmsHash(content)
  });
}

export function assertQuoSmsPlan(response, operations) {
  const operation = Array.isArray(operations) && operations.length === 1
    ? operations[0]
    : null;
  if (operation?.type !== QUO_SMS_TYPE) {
    if (Array.isArray(operations) && operations.some((item) => item?.type === QUO_SMS_TYPE)) {
      throw new Error("Quo SMS must be the sole operation in its approval batch.");
    }
    return response;
  }
  const expected = validateQuoSmsPayload(operation.payload);
  const prepared = response?.operations?.[0];
  const plan = prepared?.plan?.plan;
  const file = prepared?.plan?.file;
  const descriptor = response?.files?.[0];
  if (
    response?.mode !== "dry_run"
    || response?.displayComplete !== true
    || response?.batchMode !== "assigned_single_file_v2"
    || response?.fileCount !== 1
    || response?.operationCount !== 1
    || !plainObject(prepared)
    || prepared.type !== QUO_SMS_TYPE
    || prepared.plan?.mode !== "dry_run"
    || !plainObject(plan)
    || String(file?.id || "") === ""
    || String(file?.number || "").replace(/^#/, "") !== expected.fileNumber
    || String(descriptor?.id || "") !== String(file.id)
    || String(descriptor?.number || "").replace(/^#/, "") !== expected.fileNumber
    || !Array.isArray(descriptor?.operationIndexes)
    || descriptor.operationIndexes.length !== 1
    || descriptor.operationIndexes[0] !== 0
    || !Array.isArray(descriptor?.operationTypes)
    || descriptor.operationTypes.length !== 1
    || descriptor.operationTypes[0] !== QUO_SMS_TYPE
    || plan.from !== expected.from
    || plan.to !== expected.to
    || plan.content !== expected.content
    || plan.characterCount !== expected.characterCount
    || plan.contentSha256 !== expected.contentSha256
  ) {
    throw new Error("The Quo SMS approval plan is not bound to the exact file, sender, recipient, and text.");
  }
  return response;
}

export function assertQuoSmsReceipt(receipt, payload) {
  const expected = validateQuoSmsPayload(payload);
  if (
    !plainObject(receipt)
    || receipt.verifiedByReadback !== true
    || receipt.manualVerificationRequired === true
    || !/^[A-Za-z0-9_-]{1,512}$/.test(String(receipt.externalId || ""))
    || receipt.sender !== expected.from
    || receipt.recipient !== expected.to
    || receipt.contentSha256 !== expected.contentSha256
    || receipt.characterCount !== expected.characterCount
    || !String(receipt.deliveryStatus || "").trim()
  ) {
    throw new Error("The Quo SMS receipt lacks exact provider identity, addressing, content-hash, and status readback.");
  }
  return receipt;
}

function exactE164(value, label) {
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error(`Quo SMS ${label} must be one exact E.164 number.`);
  }
  return value;
}

function plainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}
