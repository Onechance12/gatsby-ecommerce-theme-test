import { z } from "zod";
import { GMAIL_REJECTED_REVIEW_ENABLED } from "./gmail-rejected-review-release.mjs";

// Shared by the actual native entrypoint and the inert protocol tests. This
// module has no credentials, provider client, approval state or startup effect.
function readSchema(fields, rejectedReviewEnabled) {
  return z.object({
    fileQuery: z.string().min(1),
    ...fields,
    completeReview: z.boolean().optional(),
    includeCorrelationAudit: z.boolean().optional(),
    ...(rejectedReviewEnabled ? { includeRejectedReview: z.boolean().optional() } : {})
  }).strict().refine(input => !input.includeCorrelationAudit || input.completeReview === true, {
    message: "includeCorrelationAudit requires completeReview:true."
  }).refine(input => !input.includeRejectedReview || (input.completeReview === true && input.includeCorrelationAudit !== false), {
    message: "includeRejectedReview requires completeReview:true and its correlation audit."
  });
}

export function registerExactGmailReads(register, bridgeRequest, {
  rejectedReviewEnabled = GMAIL_REJECTED_REVIEW_ENABLED, reviewRejectedMessage
} = {}) {
  if (rejectedReviewEnabled && typeof reviewRejectedMessage !== "function") throw new Error("The rejected-email reader must use the attested read coordinator.");
  const read = (route, input) => bridgeRequest("POST", route, rejectedReviewEnabled
    && input.completeReview === true && input.includeRejectedReview !== false
    ? { ...input, includeRejectedReview: true } : input);
  const reviewDescription = rejectedReviewEnabled
    ? " Complete reviews automatically include a separate rejectedReview list: permitted sender/date/subject/IDs, exact reason and expiring read-only reviewRef. Inspect candidates independently; rejection does not mean unrelated. Restricted candidates remain reason-only."
    : " Rejected originals are not exposed in this release.";
  register(
    "gmail_search_exact_file",
    "Search Wave Gmail using facts freshly bound to one Chance-assigned file. With completeReview:true, includeCorrelationAudit:true returns a bounded reason-only decision trail; it never admits rejected content or proves withheld mail irrelevant." + reviewDescription,
    readSchema({
      communicationDays: z.number().int().min(1).max(3650).optional(),
      limit: z.number().int().min(1).max(25).optional()
    }, rejectedReviewEnabled),
    input => read("/gmail/search", input)
  );
  register(
    "gmail_read_thread_exact_file",
    "Read a thread after exact Chance-file verification. Optional includeCorrelationAudit:true requires completeReview:true and explains withheld decisions without changing admission. A wholly unmatched thread remains denied." + reviewDescription,
    readSchema({ threadId: z.string().min(1) }, rejectedReviewEnabled),
    input => read("/gmail/thread", input)
  );
  if (rejectedReviewEnabled) register(
    "gmail_review_rejected_message",
    "Independently inspect one rejected Gmail candidate from a fresh complete exact-file review using its reviewRef. Separate read-only evidence, not file admission: classify relevant, unrelated, mixed or unresolved with reasons. No arbitrary message lookup, attachment access, drafting, sending or CRM changes. Restricted candidates stay withheld.",
    z.object({ fileQuery: z.string().min(1).max(512), reviewRef: z.string().min(1).max(4096) }).strict(),
    reviewRejectedMessage
  );
}
