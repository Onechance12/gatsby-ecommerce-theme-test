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
  const adjusterName = carrierAdjusterName(cad.adjuster_name, dv);
  const adjusterPhone = carrierAdjusterPhone(
    firstNonEmpty(cad.adjuster_phone, transcriptNear(transcript, /adjuster|team/i, /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|1[\s.-]?8\d{2}[\s.-]?\d{3}[\s.-]?\d{4})/)),
    dv
  );
  const adjusterEmail = carrierAdjusterEmail(cad.adjuster_email, dv);
  const documentSubmission = firstNonEmpty(cad.document_submission, transcriptEmail(transcript));
  const documentSubmissionRequested = cad.document_submission_requested === true || /^true$/i.test(String(cad.document_submission_requested || ""));
  const nextStep = firstNonEmpty(cad.next_step);
  const inspectionScheduled = cad.inspection_scheduled === true || /^true$/i.test(String(cad.inspection_scheduled || ""));
  const inspectionStart = inspectionScheduled ? firstNonEmpty(cad.inspection_start) : "";
  const inspectionEnd = inspectionScheduled ? firstNonEmpty(cad.inspection_end) : "";
  const inspectionTimezone = inspectionScheduled ? firstNonEmpty(cad.inspection_timezone) : "";
  const inspectionAccessRequirements = firstNonEmpty(cad.inspection_access_requirements);
  const representativeName = firstNonEmpty(cad.representative_name);
  const blockingReason = firstNonEmpty(cad.blocking_reason);
  const callbackRequested = cad.callback_requested === true || /^true$/i.test(String(cad.callback_requested || ""));
  const additionalClaims = parseAdditionalClaims(cad.additional_claims);

  // Goal decides new-vs-existing when the analysis didn't supply filing_outcome.
  const goal = firstNonEmpty(call?.raw?.metadata?.goal, dv.goal);
  const outcome = firstNonEmpty(cad.filing_outcome, inferOutcome(claimNumber, call, goal));

  // Per-field source: "retell-analysis" (structured, verified), "transcript-guess"
  // (regex from transcript, UNVERIFIED), or "none".
  const source = {
    claimNumber: cad.claim_number ? "retell-analysis" : (claimNumber ? "transcript-guess" : "none"),
    adjusterName: adjusterName && cad.adjuster_name ? "retell-analysis" : "none",
    adjusterPhone: adjusterPhone && cad.adjuster_phone ? "retell-analysis" : (adjusterPhone ? "transcript-guess" : "none"),
    adjusterEmail: adjusterEmail && cad.adjuster_email ? "retell-analysis" : "none",
    documentSubmission: cad.document_submission ? "retell-analysis" : (documentSubmission ? "transcript-guess" : "none"),
    inspectionStart: cad.inspection_start ? "retell-analysis" : "none",
    inspectionEnd: cad.inspection_end ? "retell-analysis" : "none",
    inspectionTimezone: cad.inspection_timezone ? "retell-analysis" : "none",
    inspectionAccessRequirements: cad.inspection_access_requirements ? "retell-analysis" : "none"
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
    documentSubmissionRequested,
    nextStep,
    inspectionScheduled,
    inspectionStart,
    inspectionEnd,
    inspectionTimezone,
    inspectionAccessRequirements,
    representativeName,
    blockingReason,
    callbackRequested,
    additionalClaims,
    outcome,
    source,
    callStatus: call?.callStatus,
    disconnectionReason: call?.disconnectionReason
  };
}

function parseAdditionalClaims(value) {
  if (Array.isArray(value)) return value;
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

function carrierAdjusterName(value, dynamicVariables) {
  const text = firstNonEmpty(value);
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const insured = firstNonEmpty(dynamicVariables?.insuredName).toLowerCase().replace(/[^a-z0-9]/g, "");
  const publicAdjuster = firstNonEmpty(dynamicVariables?.publicAdjusterName, "Chance Pearson").toLowerCase().replace(/[^a-z0-9]/g, "");
  const firm = firstNonEmpty(dynamicVariables?.firmName, "Wave Public Adjusting").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!text || (publicAdjuster && normalized === publicAdjuster) || (firm && normalized.includes(firm)) || (insured && normalized === insured)) return "";
  return text;
}

function carrierAdjusterPhone(value, dynamicVariables) {
  const text = firstNonEmpty(value);
  const digits = text.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const homeowner = firstNonEmpty(dynamicVariables?.homeownerPhone).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const publicAdjuster = firstNonEmpty(dynamicVariables?.officePhone, "9725731730").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const queueCallback = firstNonEmpty(dynamicVariables?.queueCallbackPhone).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (
    !digits
    || (publicAdjuster && digits === publicAdjuster)
    || (queueCallback && digits === queueCallback)
    || (homeowner && digits === homeowner)
  ) return "";
  return text;
}

function carrierAdjusterEmail(value, dynamicVariables) {
  const text = firstNonEmpty(value).toLowerCase();
  const homeowner = firstNonEmpty(dynamicVariables?.homeownerEmail).toLowerCase();
  const publicAdjuster = firstNonEmpty(dynamicVariables?.publicAdjusterEmail, "cpearson@wavepa.com").toLowerCase();
  if (!text || (publicAdjuster && text === publicAdjuster) || (homeowner && text === homeowner)) return "";
  return text;
}
