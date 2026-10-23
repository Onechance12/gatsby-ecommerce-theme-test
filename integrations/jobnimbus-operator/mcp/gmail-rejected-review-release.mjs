// Candidate only. Activate through a reviewed bridge/capability pin and a new
// versioned Operator build, never by modifying an installed package or a gate
// to work around a denied read. This permission never admits action evidence.
export const GMAIL_REJECTED_REVIEW_ENABLED = false;
export const GMAIL_REJECTED_REVIEW_ROUTE = "/gmail/rejected-review";

export function validateRejectedReviewInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["fileQuery", "reviewRef"].includes(key))
    || typeof input.fileQuery !== "string" || !input.fileQuery.trim() || input.fileQuery.length > 512
    || typeof input.reviewRef !== "string" || input.reviewRef.length > 4096
    || !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(input.reviewRef)) {
    throw new Error("Rejected-email inspection requires one exact fileQuery and a fresh bounded reviewRef.");
  }
  return { fileQuery: input.fileQuery, reviewRef: input.reviewRef };
}

// This check does not authenticate a reference; only the bridge can do that.
// It additionally checks that the returned evidence matches the reviewed ref.
function expectedReference(request) {
  let value;
  try { value = JSON.parse(Buffer.from(request.reviewRef.split(".")[0], "base64url").toString("utf8")); } catch {}
  if (value?.v !== 1 || value.purpose !== "rejected_email_inspection"
    || !value.binding?.fileId || !value.binding.mailbox || !value.messageId || !value.threadId
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) {
    throw new Error("Rejected-email inspection requires a fresh bridge-issued candidate reference.");
  }
  return value;
}

export function assertRejectedReviewResult(result, reference) {
  if (result?.mode !== "rejected_email_inspection" || result.readOnly !== true
    || result.verifiedFileEvidence !== false || result.authorizesAction !== false
    || result.scope !== "chance_own_mailbox_rejected_candidate"
    || result.file?.id !== reference.binding.fileId || String(result.file?.number) === "2628"
    || result.mailbox !== reference.binding.mailbox
    || result.message?.id !== reference.messageId || result.message?.threadId !== reference.threadId
    || result.decision !== reference.decision || result.sourceChanged !== false
    || result.originalRejectionUnchanged !== true
    || result.correlationAudit?.readOnly !== true || result.correlationAudit?.changesAdmission !== false
    || !Number.isFinite(Date.parse(result.observedAt))
    || typeof result.message?.bodyTruncated !== "boolean"
    || result.message?.attachmentBodiesReviewed !== false
    || !Array.isArray(result.message?.attachments)
    || result.message.attachments.some(row => Object.keys(row).some(key => !["filename", "mimeType", "size"].includes(key)))) {
    throw new Error("Rejected-email inspection failed its read-only reference-bound response contract.");
  }
  return result;
}

export async function readAttestedRejectedGmail({ input, verify, read, canonical = JSON.stringify }) {
  const request = validateRejectedReviewInput(input);
  const reference = expectedReference(request);
  const before = await verify();
  if (before?.ready !== true || !before.boundary) throw new Error("Rejected-email inspection requires a ready attested boundary.");
  const result = assertRejectedReviewResult(await read(request), reference);
  const after = await verify();
  if (after?.ready !== true || canonical(before.boundary) !== canonical(after.boundary)) {
    throw new Error("The bridge boundary changed during rejected-email inspection.");
  }
  return result;
}
