// Post-call writeback CLI wrapper. Turns a completed Retell filing call into a
// proposed, DRY-RUN JobNimbus write bundle for Chance to approve. The extraction
// and proposal logic live in the portable claim core; this wrapper only fetches
// the call, matches it to a local file, and appends the gated CLI commands. It
// NEVER writes.
import { loadReviews, findMatches } from "./fileReview.js";
import { fetchRetellCallResult } from "../voice/retell.js";
import { extractCallResults, buildWritebackProposal } from "../claim-filing-core/index.js";
import { safeCloseoutAction } from "../memory/actionCloseout.js";

// Re-export the core extraction for callers/tests that used this module before.
export { extractCallResults } from "../claim-filing-core/index.js";

// Build the DRY-RUN bundle: the portable proposal (fields/note/confidence/
// unverified) plus the exact gated commands to run on approval (each dry-run-first).
export function buildWritebackBundle(file, ex) {
  const proposal = buildWritebackProposal(file, ex);
  const { proposedFields, proposedNote } = proposal;
  return {
    ...proposal,
    commands: {
      fields: Object.keys(proposedFields).length
        ? `ALLOW_JOBNIMBUS_WRITES=true npm run chat:action -- update_jobnimbus_contact '${JSON.stringify({ query: file.customer, fields: proposedFields, execute: true })}'`
        : "(no field updates extracted)",
      note: `ALLOW_JOBNIMBUS_WRITES=true npm run chat:action -- create_jobnimbus_note '${JSON.stringify({ query: file.customer, note: proposedNote, execute: true })}'`
    }
  };
}

// CLI entry: file:claim '{"callId":"..."}' routes here for the full writeback view.
export async function runPostCallWriteback(config, callId, input = {}) {
  const call = await fetchRetellCallResult(config, callId);
  const ex = extractCallResults(call);

  // Match the call to a file: prefer a jnid in metadata, else the insured name.
  const reviews = loadReviews(config);
  let review = null;
  const metaId = extractJnid(ex.fromMetadata);
  if (metaId) review = reviews.find((r) => r.file.id === metaId) || null;
  if (!review && (input.query || ex.insuredName)) {
    review = findMatches(reviews, input.query || ex.insuredName)[0] || null;
  }

  const result = {
    tool: "post_call_writeback",
    callId,
    callStatus: ex.callStatus,
    disconnectionReason: ex.disconnectionReason,
    extracted: {
      claimNumber: ex.claimNumber || "(none)",
      adjusterName: ex.adjusterName || "(none)",
      adjusterPhone: ex.adjusterPhone || "(none)",
      adjusterEmail: ex.adjusterEmail || "(none)",
      documentSubmission: ex.documentSubmission || "(none)",
      nextStep: ex.nextStep || "(none)",
      outcome: ex.outcome || "(unknown)",
      source: ex.source
    }
  };

  if (!review) {
    result.matchedFile = null;
    result.note = `Could not match this call to a file (insured: ${ex.insuredName || "?"}). Pass {"callId":"...","query":"<name>"} to target the file.`;
    return result;
  }

  result.writeback = buildWritebackBundle(review.file, ex);
  result.memoryCloseout = safeCloseoutAction(config, {
    channel: "retell",
    action: "review_claim_call_result",
    status: ex.callStatus || "reviewed",
    subjectKey: review.file.id,
    fileLabel: review.file.customer,
    summary: `Retell call result reviewed for ${review.file.customer}; outcome ${ex.outcome || "unknown"}.`,
    externalId: callId,
    followUps: ["Chance must approve any proposed JobNimbus field, status, note, or task changes."],
    evidence: [`retell:${callId}`]
  });
  result.note = "DRY RUN — review the extracted values (and any unverified transcript guesses), then run the commands under writeback.commands to write (each is gated + dry-run-first itself).";
  return result;
}

// ---------- helpers ----------
function extractJnid(metadata) {
  const blob = JSON.stringify(metadata || {});
  const m = blob.match(/[a-f0-9]{32}/i);
  return m ? m[0] : "";
}
