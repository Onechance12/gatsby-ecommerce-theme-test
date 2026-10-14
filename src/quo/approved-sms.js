import { createHash } from "node:crypto";

export const APPROVED_QUO_SMS_TYPE = "quo.send_text";
export const APPROVED_QUO_SMS_MAX_CHARACTERS = 1600;

export function quoSmsContentSha256(content) {
  return createHash("sha256").update(String(content), "utf8").digest("hex");
}

export function validateApprovedQuoSmsPayload(payload, options = {}) {
  if (!plainObject(payload)) {
    throw new Error("Approved Quo SMS payload must be one exact object.");
  }
  const allowedKeys = ["content", "from", "query", "to"];
  if (options.allowOperatorScope === true) allowedKeys.push("operatorScope");
  const keys = Object.keys(payload).sort();
  const expectedKeys = [...allowedKeys].sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(
      `Approved Quo SMS payload must be exactly {query,from,to,content}${
        options.allowOperatorScope === true ? " plus the coordinator-injected operatorScope" : ""
      }.`
    );
  }
  if (options.allowOperatorScope === true && payload.operatorScope !== "assigned") {
    throw new Error("Approved Quo SMS requires the assigned operator scope.");
  }
  const query = String(payload.query || "").trim();
  const fileNumber = query.replace(/^#/, "");
  const from = exactE164(payload.from, "from");
  const to = exactE164(payload.to, "to");
  const content = payload.content;
  if (!/^#?\d+$/.test(query) || fileNumber === "2628") {
    throw new Error("Approved Quo SMS requires one exact numeric, non-excluded JobNimbus file number.");
  }
  if (from === to) {
    throw new Error("Approved Quo SMS sender and recipient must differ.");
  }
  if (
    typeof content !== "string"
    || !content
    || content !== content.trim()
    || content.length > APPROVED_QUO_SMS_MAX_CHARACTERS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)
  ) {
    throw new Error(
      `Approved Quo SMS content must be exact, nonblank, trimmed text of at most ${APPROVED_QUO_SMS_MAX_CHARACTERS} characters without control bytes.`
    );
  }
  return Object.freeze({
    query,
    fileNumber,
    from,
    to,
    content,
    characterCount: content.length,
    contentSha256: quoSmsContentSha256(content)
  });
}

function exactE164(value, label) {
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error(`Approved Quo SMS ${label} must be one exact E.164 number.`);
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
