// Portable JobNimbus writeback PROPOSAL builder. Pure + dependency-free. Given a
// file summary + extracted results, it proposes the field/status updates and ONE
// short operational note — but writes nothing. Structured (retell-analysis)
// values become proposed fields; transcript-guessed adjuster phone/email/doc
// destinations are surfaced separately as UNVERIFIED (never silently written as
// verified adjuster fields). The note is accurate to what was actually captured:
// it never claims an adjuster/status field was set when it wasn't, and never says
// "awaiting adjuster" when one was captured.
import { cleanClaimNumber } from "./packet.js";

// buildWritebackProposal(file, ex)
//   file — { id, customer, status, carrier }
//   ex   — extractCallResults(...) output (with per-field source)
export function buildWritebackProposal(file, ex) {
  const proposedFields = {};
  const fieldConfidence = {};
  const unverified = [];
  const src = ex.source || {};

  if (ex.claimNumber) {
    proposedFields.cf_string_2 = cleanClaim(ex.claimNumber);
    fieldConfidence.cf_string_2 = src.claimNumber || "unknown";
  }
  // Adjuster name only ever comes from structured analysis — safe to write.
  if (ex.adjusterName && src.adjusterName === "retell-analysis") {
    proposedFields.cf_string_7 = ex.adjusterName;
    fieldConfidence.cf_string_7 = "retell-analysis";
  }
  // Adjuster phone/email: write only when structured. Transcript guesses are
  // surfaced for human confirmation, not written as verified fields.
  writeOrFlag(proposedFields, fieldConfidence, unverified, "cf_string_8", "adjuster phone", ex.adjusterPhone, src.adjusterPhone);
  writeOrFlag(proposedFields, fieldConfidence, unverified, "cf_string_9", "adjuster email", ex.adjusterEmail, src.adjusterEmail);
  // Document destination is not a stored field; surface it if only a guess.
  if (ex.documentSubmission && src.documentSubmission === "transcript-guess") {
    unverified.push({ label: "document submission destination", value: ex.documentSubmission, source: "transcript-guess", note: "Confirm before saving/using — parsed from transcript, not carrier-confirmed." });
  }

  // Status suggestion is advisory — only when a claim landed and the file is at a
  // pre-filing status.
  let suggestedStatus = "";
  if (ex.claimNumber && /photo file|estimate needed|ready for pa|paperwork/i.test(file.status || "")) {
    suggestedStatus = "Submitted Awaiting Confirmation";
  }
  if (suggestedStatus) {
    proposedFields.status_name = suggestedStatus;
    fieldConfidence.status_name = "suggested";
  }

  const adjusterFieldWritten = Boolean(proposedFields.cf_string_7);
  const note = buildNote(ex, { adjusterCaptured: adjusterFieldWritten, statusMoved: Boolean(suggestedStatus) });

  return {
    file: { id: file.id, customer: file.customer, currentStatus: file.status },
    outcome: ex.outcome,
    proposedFields,
    fieldConfidence,
    proposedNote: note,
    unverified
  };
}

// One short operational note, accurate to what was actually captured/written.
function buildNote(ex, { adjusterCaptured, statusMoved }) {
  if (!ex.claimNumber) {
    return "Filing call completed — no claim number captured. See call transcript before re-attempting.";
  }
  const confirmed = ex.outcome === "existing_claim_confirmed";
  const lead = confirmed ? "Existing claim confirmed by phone." : "Claim filed by phone.";
  const tail = adjusterCaptured
    ? "Claim # and adjuster saved to the file fields."
    : "Claim # saved to the file; awaiting adjuster assignment and inspection scheduling.";
  const statusBit = statusMoved ? " Status advanced." : "";
  return `${lead} ${tail}${statusBit}`;
}

function writeOrFlag(fields, confidence, unverified, fieldKey, label, value, source) {
  if (!value) return;
  if (source === "retell-analysis") {
    fields[fieldKey] = value;
    confidence[fieldKey] = "retell-analysis";
  } else {
    unverified.push({ field: fieldKey, label, value, source: source || "transcript-guess", note: "Not written as a verified field — parsed from transcript. Confirm, then save manually if correct." });
  }
}

function cleanClaim(v) { return String(cleanClaimNumber(v)).replace(/[^\w-]/g, "").trim(); }
