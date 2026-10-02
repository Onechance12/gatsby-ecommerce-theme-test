import { createHash } from "node:crypto";

export const PDF_UPLOAD_TYPE = "jobnimbus.upload_pdf";
export const PDF_MAX_BYTES = 8 * 1024 * 1024;
export const pdfHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const providerId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(id);
export const exactKeys = (value, keys) => Boolean(value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));

export function validatePdfMetadata(value) {
  if (!value || typeof value.filename !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9 _().-]{0,154}\.pdf$/i.test(value.filename)
    || value.filename.includes("..") || value.contentType !== "application/pdf"
    || typeof value.isPrivate !== "boolean" || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 20 || value.sizeBytes > PDF_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(value.sha256 || "")) {
    throw new Error("PDF upload requires a safe .pdf filename, application/pdf, explicit privacy, 20 bytes–8 MiB, and a SHA-256 digest.");
  }
  return { filename: value.filename, contentType: value.contentType,
    sizeBytes: value.sizeBytes, sha256: value.sha256, isPrivate: value.isPrivate };
}

export function validatePdfPayload(input, { scoped = false } = {}) {
  const keys = ["query", "filename", "contentType", "sizeBytes", "sha256", "isPrivate", "contentBase64"];
  if (scoped && Object.hasOwn(input || {}, "operatorScope")) keys.push("operatorScope");
  if (!exactKeys(input, keys) || (input.operatorScope !== undefined && input.operatorScope !== "assigned")
    || typeof input.query !== "string" || !/^#?\d+$/.test(input.query)
    || input.query.replace(/^#/, "") === "2628") {
    throw new Error("PDF upload accepts only an exact assigned numeric file and the fixed PDF fields; overrides and extra fields are forbidden.");
  }
  const metadata = validatePdfMetadata(input);
  if (typeof input.contentBase64 !== "string" || input.contentBase64.length > 4 * Math.ceil(PDF_MAX_BYTES / 3)
    || input.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) {
    throw new Error("PDF content must be bounded canonical base64.");
  }
  const bytes = Buffer.from(input.contentBase64, "base64");
  if (bytes.toString("base64") !== input.contentBase64 || bytes.length !== metadata.sizeBytes
    || pdfHash(bytes) !== metadata.sha256 || !/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0, 12).toString("latin1"))
    || !/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1"))) {
    throw new Error("PDF bytes do not match the approved size, digest, or PDF framing. Nothing was uploaded.");
  }
  // Framing is not malware scanning or substantive document review.
  return { metadata, bytes };
}

export function pdfProviderBody(fileId, metadata) {
  if (!providerId(fileId)) throw new Error("Invalid exact-file provider ID.");
  return { filename: metadata.filename, description: "", sizeBytes: metadata.sizeBytes,
    type: 1, related: [fileId], isPrivate: metadata.isPrivate };
}

export function assertPdfPlan(response, operations) {
  if (!operations.some((row) => row?.type === PDF_UPLOAD_TYPE)) return;
  if (operations.length !== 1) throw new Error("A PDF upload must be the sole operation.");
  const { metadata } = validatePdfPayload(operations[0].payload);
  const number = operations[0].payload.query.replace(/^#/, "");
  const file = response?.files?.[0];
  const prepared = response?.operations?.[0]?.plan;
  const plan = prepared?.plan;
  const expectedKeys = ["endpoint", ...Object.keys(metadata), "beforeIds", "body"];
  if (response?.mode !== "dry_run" || response.batchMode !== "assigned_single_file_v2"
    || response.fileCount !== 1 || response.operationCount !== 1 || response.displayComplete !== true
    || response.executionSemantics !== "sequential_fail_stop_no_rollback"
    || response.files?.length !== 1 || !providerId(file?.id) || String(file.number) !== number
    || JSON.stringify(file.operationIndexes) !== "[0]" || JSON.stringify(file.operationTypes) !== JSON.stringify([PDF_UPLOAD_TYPE])
    || response.operations?.length !== 1 || !exactKeys(response.operations[0], ["type", "plan"])
    || response.operations[0].type !== PDF_UPLOAD_TYPE || !exactKeys(prepared, ["mode", "file", "plan"])
    || prepared.mode !== "dry_run" || prepared.file?.id !== file.id || String(prepared.file?.number) !== number
    || !exactKeys(plan, expectedKeys) || plan.endpoint !== "/files/v1/uploads/url"
    || Object.entries(metadata).some(([key, value]) => plan[key] !== value)
    || !Array.isArray(plan.beforeIds) || !plan.beforeIds.every(providerId) || new Set(plan.beforeIds).size !== plan.beforeIds.length
    || !exactKeys(plan.body, Object.keys(pdfProviderBody(file.id, metadata)))
    || Object.entries(pdfProviderBody(file.id, metadata)).some(([key, value]) => JSON.stringify(plan.body[key]) !== JSON.stringify(value))) {
    throw new Error("Upload approval display does not bind the exact PDF bytes, privacy and client. No approval was stored.");
  }
}

export function assertPdfReceipt(receipt, expected) {
  const metadata = validatePdfMetadata(expected);
  if (!providerId(receipt?.externalId) || receipt?.verifiedByReadback !== true
    || receipt?.contentVerified !== true || Object.entries(metadata).some(([key, value]) => receipt[key] !== value)) {
    throw new Error("PDF receipt does not prove the exact provider document ID and approved bytes/metadata.");
  }
}
