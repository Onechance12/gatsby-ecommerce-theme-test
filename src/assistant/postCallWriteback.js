// Post-call writeback: turn a completed Retell filing call into a proposed,
// DRY-RUN JobNimbus write bundle (claim #, adjuster fields, status, filing note)
// for Chance to approve. Closes the last manual mile — no more reading transcripts
// by hand. It NEVER writes; it emits the exact gated commands to run on approval.
import { loadReviews, findMatches } from "./fileReview.js";
import { fetchRetellCallResult } from "../voice/retell.js";

// Pull structured results, preferring Retell's post-call analysis extraction and
// falling back to light transcript parsing for older calls (no schema at runtime).
export function extractCallResults(call) {
  const cad = call?.raw?.call_analysis?.custom_analysis_data || call?.callAnalysis?.custom_analysis_data || {};
  const transcript = String(call?.transcript || "");
  const dv = call?.raw?.retell_llm_dynamic_variables || {};

  const claimNumber = firstNonEmpty(cad.claim_number, transcriptClaimNumber(transcript));
  const adjusterName = firstNonEmpty(cad.adjuster_name);
  const adjusterPhone = firstNonEmpty(cad.adjuster_phone, transcriptNear(transcript, /adjuster|team/i, /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|1[\s.-]?8\d{2}[\s.-]?\d{3}[\s.-]?\d{4})/));
  const adjusterEmail = firstNonEmpty(cad.adjuster_email, transcriptEmail(transcript));
  const documentSubmission = firstNonEmpty(cad.document_submission, transcriptEmail(transcript));
  const nextStep = firstNonEmpty(cad.next_step);
  // Goal came in from file:claim metadata. It decides whether a captured claim #
  // means a NEW filing landed or an EXISTING claim was merely confirmed — the two
  // must not both be labeled "claim_filed" (that mislabels follow-up calls).
  const goal = firstNonEmpty(call?.raw?.metadata?.goal, dv.goal);
  const outcome = firstNonEmpty(cad.filing_outcome, inferOutcome(claimNumber, call, goal));

  return {
    insuredName: firstNonEmpty(dv.insuredName),
    carrier: firstNonEmpty(dv.carrier),
    fromMetadata: call?.raw?.metadata || {},
    claimNumber,
    adjusterName,
    adjusterPhone,
    adjusterEmail,
    documentSubmission,
    nextStep,
    outcome,
    // confidence flags so Chance knows what came from Retell vs a transcript guess
    source: {
      claimNumber: cad.claim_number ? "retell-analysis" : (claimNumber ? "transcript-guess" : "none"),
      adjuster: cad.adjuster_name || cad.adjuster_phone || cad.adjuster_email ? "retell-analysis" : "none"
    },
    callStatus: call?.callStatus,
    disconnectionReason: call?.disconnectionReason
  };
}

// Map extracted results onto the JobNimbus custom fields + status + note. The
// STRUCTURED data (claim #, adjuster, status) belongs in FIELDS — that's what the
// sweep, pulse, and filer read back. The note is a short, human, timeline line —
// NOT a dump of the same values (that just clutters the activity feed and drifts
// out of sync with the fields). One source of truth per fact.
export function buildWritebackBundle(file, ex) {
  const fields = {};
  if (ex.claimNumber) fields.cf_string_2 = cleanClaim(ex.claimNumber);
  if (ex.adjusterName) fields.cf_string_7 = ex.adjusterName;
  if (ex.adjusterPhone) fields.cf_string_8 = ex.adjusterPhone;
  if (ex.adjusterEmail) fields.cf_string_9 = ex.adjusterEmail;

  // Status suggestion is advisory — only propose the move when a claim landed.
  let suggestedStatus = "";
  if (ex.claimNumber && /photo file|estimate needed|ready for pa|paperwork/i.test(file.status || "")) {
    suggestedStatus = "Submitted Awaiting Confirmation";
  }
  if (suggestedStatus) fields.status_name = suggestedStatus;

  // ONE short note. Distinguishes a new filing from an existing-claim confirmation,
  // and points at the fields for the details rather than restating them.
  const confirmed = ex.outcome === "existing_claim_confirmed";
  const note = ex.claimNumber
    ? (confirmed
        ? "Existing claim confirmed by phone. Claim #, adjuster, and status updated in the file fields."
        : "Claim filed by phone. Awaiting adjuster assignment and inspection scheduling; claim # saved to the file.")
    : "Filing call completed — no claim number captured. See call transcript before re-attempting.";

  return {
    file: { id: file.id, customer: file.customer, currentStatus: file.status },
    outcome: ex.outcome,
    proposedFields: fields,
    proposedNote: note,
    commands: {
      fields: Object.keys(fields).length
        ? `ALLOW_JOBNIMBUS_WRITES=true npm run chat:action -- update_jobnimbus_contact '${JSON.stringify({ query: file.customer, fields, execute: true })}'`
        : "(no field updates extracted)",
      note: `ALLOW_JOBNIMBUS_WRITES=true npm run chat:action -- create_jobnimbus_note '${JSON.stringify({ query: file.customer, note, execute: true })}'`
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
  result.note = "DRY RUN — review the extracted values, then run the commands under writeback.commands to write (each is gated + dry-run-first itself).";
  return result;
}

// ---------- helpers ----------
function firstNonEmpty(...vals) {
  for (const v of vals) { const s = String(v ?? "").trim(); if (s && !/^n\/?a$/i.test(s)) return s; }
  return "";
}
function cleanClaim(v) { return String(v || "").replace(/claim\s*#?:?/ig, "").replace(/[^\w-]/g, "").trim(); }
const DIGIT_WORDS = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
function transcriptClaimNumber(t) {
  // Reps/agents confirm the claim number two ways: as digits, or spelled out in
  // words ("zero eight three two..."). Catch the read-back line and handle both.
  const anchor = /claim (?:or reference )?number is[,:]?\s*/i;
  const idx = t.search(anchor);
  if (idx >= 0) {
    const after = t.slice(idx).replace(anchor, "");
    const digits = after.match(/^([0-9][0-9\s\-]{5,}[0-9]|[A-Z0-9]{6,})/);
    if (digits) return digits[1].replace(/[\s-]/g, "");
    // spelled-out: take the run of digit-words immediately following
    const words = after.split(/[\s,.]+/);
    let out = "";
    for (const w of words) {
      const d = DIGIT_WORDS[w.toLowerCase()];
      if (d !== undefined) out += d;
      else if (out.length) break; // stop at first non-digit-word after the run
    }
    if (out.length >= 5) return out;
  }
  return "";
}
function transcriptEmail(t) {
  const m = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0].replace(/[.,;]$/, "") : "";
}
function transcriptNear(t, anchor, pattern) {
  const idx = t.search(anchor);
  if (idx < 0) return "";
  const window = t.slice(idx, idx + 160);
  const m = window.match(pattern);
  return m ? m[0] : "";
}
function inferOutcome(claimNumber, call, goal) {
  if (claimNumber) {
    // A follow-up/status call that surfaced a claim # merely CONFIRMED an existing
    // claim — it did not file a new one. Only a new-filing goal earns "claim_filed".
    return /follow|status|existing|confirm/i.test(String(goal || "")) ? "existing_claim_confirmed" : "claim_filed";
  }
  if (call?.disconnectionReason === "dial_no_answer" || call?.disconnectionReason === "dial_failed") return "no_result";
  return "no_result";
}
function extractJnid(metadata) {
  const blob = JSON.stringify(metadata || {});
  const m = blob.match(/[a-f0-9]{32}/i);
  return m ? m[0] : "";
}
