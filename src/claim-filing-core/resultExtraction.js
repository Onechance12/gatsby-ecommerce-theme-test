// Portable post-call result extraction. Pure + dependency-free. Turns a fetched
// Retell call object into structured results, PREFERRING Retell's post-call
// analysis (call_analysis.custom_analysis_data) and falling back to light
// transcript parsing. Every field carries a per-field source so the writeback
// can treat structured values as proposals and transcript guesses as unverified.

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

  // Goal decides new-vs-existing when the analysis didn't supply filing_outcome.
  const goal = firstNonEmpty(call?.raw?.metadata?.goal, dv.goal);
  const outcome = firstNonEmpty(cad.filing_outcome, inferOutcome(claimNumber, call, goal));

  // Per-field source: "retell-analysis" (structured, verified), "transcript-guess"
  // (regex from transcript, UNVERIFIED), or "none".
  const source = {
    claimNumber: cad.claim_number ? "retell-analysis" : (claimNumber ? "transcript-guess" : "none"),
    adjusterName: cad.adjuster_name ? "retell-analysis" : "none",
    adjusterPhone: cad.adjuster_phone ? "retell-analysis" : (adjusterPhone ? "transcript-guess" : "none"),
    adjusterEmail: cad.adjuster_email ? "retell-analysis" : (adjusterEmail ? "transcript-guess" : "none"),
    documentSubmission: cad.document_submission ? "retell-analysis" : (documentSubmission ? "transcript-guess" : "none")
  };

  return {
    insuredName: firstNonEmpty(dv.insuredName),
    carrier: firstNonEmpty(dv.carrier),
    goal,
    fromMetadata: call?.raw?.metadata || {},
    claimNumber,
    adjusterName,
    adjusterPhone,
    adjusterEmail,
    documentSubmission,
    nextStep,
    outcome,
    source,
    callStatus: call?.callStatus,
    disconnectionReason: call?.disconnectionReason
  };
}

export function inferOutcome(claimNumber, call, goal) {
  if (claimNumber) {
    // A follow-up/status call that surfaced a claim # merely CONFIRMED an existing
    // claim — it did not file a new one. Only a new-filing goal earns "claim_filed".
    return /follow|status|existing|confirm/i.test(String(goal || "")) ? "existing_claim_confirmed" : "claim_filed";
  }
  if (call?.disconnectionReason === "dial_no_answer" || call?.disconnectionReason === "dial_failed") return "no_result";
  return "no_result";
}

// ---------- transcript parsing helpers ----------
const DIGIT_WORDS = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

export function transcriptClaimNumber(t) {
  // Reps/agents confirm the claim number two ways: as digits, or spelled out in
  // words ("zero eight three two..."). Catch the read-back line and handle both.
  const anchor = /claim (?:or reference )?number is[,:]?\s*/i;
  const idx = t.search(anchor);
  if (idx >= 0) {
    const after = t.slice(idx).replace(anchor, "");
    const digits = after.match(/^([0-9][0-9\s\-]{5,}[0-9]|[A-Z0-9]{6,})/);
    if (digits) return digits[1].replace(/[\s-]/g, "");
    const words = after.split(/[\s,.]+/);
    let out = "";
    for (const w of words) {
      const d = DIGIT_WORDS[w.toLowerCase()];
      if (d !== undefined) out += d;
      else if (out.length) break;
    }
    if (out.length >= 5) return out;
  }
  return "";
}
export function transcriptEmail(t) {
  const m = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0].replace(/[.,;]$/, "") : "";
}
export function transcriptNear(t, anchor, pattern) {
  const idx = t.search(anchor);
  if (idx < 0) return "";
  const window = t.slice(idx, idx + 160);
  const m = window.match(pattern);
  return m ? m[0] : "";
}
function firstNonEmpty(...vals) {
  for (const v of vals) { const s = String(v ?? "").trim(); if (s && !/^n\/?a$/i.test(s)) return s; }
  return "";
}
