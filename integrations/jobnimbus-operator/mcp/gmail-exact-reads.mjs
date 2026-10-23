import { z } from "zod";

// Shared by the actual native entrypoint and the inert protocol tests. This
// module has no credentials, provider client, approval state or startup effect.
function readSchema(fields) {
  return z.object({
    fileQuery: z.string().min(1),
    ...fields,
    completeReview: z.boolean().optional(),
    includeCorrelationAudit: z.boolean().optional()
  }).strict().refine(input => !input.includeCorrelationAudit || input.completeReview === true, {
    message: "includeCorrelationAudit requires completeReview:true."
  });
}

export function registerExactGmailReads(register, bridgeRequest) {
  register(
    "gmail_search_exact_file",
    "Search Wave Gmail using facts freshly bound to one Chance-assigned file. With completeReview:true, includeCorrelationAudit:true returns a bounded reason-only decision trail; it never admits rejected content or proves withheld mail irrelevant.",
    readSchema({
      communicationDays: z.number().int().min(1).max(3650).optional(),
      limit: z.number().int().min(1).max(25).optional()
    }),
    input => bridgeRequest("POST", "/gmail/search", input)
  );
  register(
    "gmail_read_thread_exact_file",
    "Read a thread after exact Chance-file verification. Optional includeCorrelationAudit:true requires completeReview:true and explains withheld decisions without returning their content or changing access. A wholly unmatched thread remains denied.",
    readSchema({ threadId: z.string().min(1) }),
    input => bridgeRequest("POST", "/gmail/thread", input)
  );
}
