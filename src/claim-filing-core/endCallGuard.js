const WAIT_STATE = /\b(?:one|1)\s+(?:sec(?:ond)?|moment)\b|\b(?:just\s+)?(?:give me|bear with me)\b|\bplease hold\b|\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:documenting|typing|checking|looking|working|pulling|gathering)\b|\bi(?:'ll| will)\s+let you know if i have (?:a|any) questions?\b|\bi(?:'ll| will)\s+be right back\b/i;
const WRAP_UP = /\b(?:goodbye|bye(?:-bye)?|have a (?:good|great|blessed|wonderful) (?:day|evening|weekend)|you(?:'re| are) all set|that (?:completes|finishes|wraps up)|thank you for calling)\b/i;
const CALLBACK_CONFIRMED = /\b(?:callback|call back)\b.{0,80}\b(?:queued|scheduled|requested|confirmed|will call|should call|going to call)\b|\b(?:queued|scheduled|requested|confirmed)\b.{0,80}\b(?:callback|call back)\b/i;
const NO_NUMBER_YET = /\b(?:no|not)\b.{0,50}\b(?:claim|reference)\s*(?:number|#)\b|\b(?:claim|reference)\s*(?:number|#)\b.{0,50}\b(?:not (?:available|assigned|generated)|will be (?:issued|assigned|generated))\b/i;
const VOICEMAIL = /\b(?:leave (?:a|your) message|record your message|voicemail|mailbox is full|after the (?:tone|beep))\b/i;
const WRONG_NUMBER = /\b(?:wrong number|not the right (?:number|department)|you have reached .{0,40}(?:instead|not))\b/i;
const HUMAN_END_REQUEST = /\b(?:please )?(?:hang up|end the call|stop calling|do not call)\b/i;
const BATCH_ATTEMPT = /\b(?:another|additional|second)\s+(?:claim|policyholder|client|insured)\b/i;
const BATCH_REFUSAL = /\b(?:cannot|can't|unable|not able|won't)\b.{0,80}\b(?:another|additional|second)\s+(?:claim|policyholder|client|insured)\b|\b(?:another|additional|second)\s+(?:claim|policyholder|client|insured)\b.{0,80}\b(?:cannot|can't|unable|not able|separate call|different department)\b/i;

export function evaluateGuardedEndCall({ call = {}, args = {} } = {}) {
  const turns = transcriptTurns(call);
  const transcript = turns.map((turn) => turn.content).join("\n");
  const latestCallee = [...turns].reverse().find((turn) => turn.role === "user")?.content || "";
  const goal = String(
    call.retell_llm_dynamic_variables?.goal ||
    call.metadata?.goal ||
    args.goal ||
    ""
  ).trim();
  const reason = String(args.reason || "").trim();

  if (WAIT_STATE.test(latestCallee)) {
    return deny("The representative is still working or asked for time. Stay connected and wait silently.", "active_wait_state");
  }

  if (HUMAN_END_REQUEST.test(latestCallee)) return allow("The person explicitly requested that the call end.", "human_requested_end");
  if (VOICEMAIL.test(transcript) && ["voicemail", "automated_system"].includes(reason)) {
    return allow("Voicemail or an automated message was verified.", "voicemail");
  }
  if (WRONG_NUMBER.test(transcript) && reason === "wrong_number") {
    return allow("The destination was verified as a wrong number.", "wrong_number");
  }
  if (reason === "safety_stop") return allow("The agent declared a safety stop.", "safety_stop");

  if (goal === "homeowner_appointment_confirmation") {
    if (!WRAP_UP.test(latestCallee)) {
      return deny("The homeowner has not finished or said goodbye. Continue the conversation.", "homeowner_not_wrapped");
    }
    return allow("The homeowner conversation reached a verified wrap-up.", "homeowner_complete");
  }

  if (!["file_new_claim", "find_existing_claim", "confirm_existing_claim", "claim_status", "inspection_scheduling"].includes(goal)) {
    return deny("The call objective is missing or is not authorized for guarded termination.", "unsupported_goal");
  }

  const outcome = String(args.outcome || "").trim();
  const claimNumber = String(args.claim_number || args.claimNumber || "").trim();
  const normalizedClaim = normalizeIdentifier(claimNumber);
  const transcriptBacksClaimNumber = identifierAppearsInTranscript(normalizedClaim, transcript);
  const noNumberWithTiming = NO_NUMBER_YET.test(transcript) && /\b(?:later|within|after|when|once|by|business (?:day|hours?)|hours?|days?|assigned|generated|issued)\b/i.test(transcript);
  const callbackConfirmed = args.callback_confirmed === true && CALLBACK_CONFIRMED.test(transcript);

  if (["file_new_claim", "find_existing_claim", "confirm_existing_claim"].includes(goal)) {
    if (!["claim_filed", "existing_claim_confirmed"].includes(outcome) && !callbackConfirmed && !noNumberWithTiming) {
      return deny("The filing outcome is incomplete. Keep the call connected.", "incomplete_outcome");
    }
    if (["claim_filed", "existing_claim_confirmed"].includes(outcome) && !transcriptBacksClaimNumber) {
      return deny("A transcript-backed claim or reference number has not been captured.", "missing_verified_claim_number");
    }
    if (!transcriptBacksClaimNumber && !callbackConfirmed && !noNumberWithTiming) {
      return deny("No claim/reference number or explicit issuance instruction was verified.", "missing_claim_number");
    }
    if (args.document_submission_requested !== true) {
      return deny("The Letter of Representation delivery question has not been asked.", "document_destination_not_requested");
    }
    if (args.next_step_requested !== true) {
      return deny("The carrier next-step question has not been asked.", "next_step_not_requested");
    }
    const additionalRequired = batchClaimCount(call);
    if (additionalRequired > 0) {
      const agentTranscript = turns.filter((turn) => turn.role === "agent").map((turn) => turn.content).join("\n");
      if (!BATCH_ATTEMPT.test(agentTranscript)) {
        return deny(
          `There ${additionalRequired === 1 ? "is" : "are"} ${additionalRequired} approved additional same-carrier ${additionalRequired === 1 ? "claim" : "claims"}. Ask the representative to file the next approved policyholder before wrapping up.`,
          "batch_claim_not_attempted"
        );
      }
      const additionalNumbers = String(args.additional_claim_numbers || "")
        .split(/[,;\n]+/)
        .map((value) => normalizeIdentifier(value))
        .filter(Boolean);
      const completed = Number(args.additional_claims_completed || 0);
      const completedAndVerified = completed >= additionalRequired
        && additionalNumbers.length >= additionalRequired
        && additionalNumbers.slice(0, additionalRequired).every((value) => identifierAppearsInTranscript(value, transcript));
      const refusalVerified = args.batch_continuation_resolved === true && BATCH_REFUSAL.test(transcript);
      if (!completedAndVerified && !refusalVerified) {
        return deny("The approved same-carrier batch is not complete and the representative did not refuse it. Continue with the additional claim.", "batch_claim_incomplete");
      }
    }
  }

  if (!WRAP_UP.test(latestCallee)) {
    return deny("The carrier representative has not said goodbye or clearly wrapped up.", "representative_not_wrapped");
  }
  return allow("The objective, required closing questions, and carrier wrap-up were verified.", "objective_complete");
}

export function transcriptTurns(call = {}) {
  if (Array.isArray(call.transcript_object)) {
    return call.transcript_object
      .map((turn) => ({ role: String(turn?.role || ""), content: String(turn?.content || turn?.text || "").trim() }))
      .filter((turn) => turn.content);
  }
  const raw = String(call.transcript || "").trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(agent|assistant|user|caller|callee|representative)\s*:\s*(.*)$/i);
    const label = String(match?.[1] || "").toLowerCase();
    return {
      role: ["agent", "assistant"].includes(label) ? "agent" : "user",
      content: String(match?.[2] || line).trim()
    };
  }).filter((turn) => turn.content);
}

function normalizeIdentifier(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function identifierAppearsInTranscript(normalizedIdentifier, transcript) {
  if (normalizedIdentifier.length < 5) return false;
  if (normalizeIdentifier(transcript).includes(normalizedIdentifier)) return true;
  return spokenIdentifierSequences(transcript).some((sequence) => sequence.includes(normalizedIdentifier));
}

function spokenIdentifierSequences(value) {
  const digitWords = {
    zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9"
  };
  const prepared = String(value || "")
    .toLowerCase()
    .replace(/\b([a-z])\s+as\s+in\s+[a-z]+\b/g, " $1 ");
  const sequences = [];
  let current = "";
  for (const token of prepared.match(/[a-z0-9]+/g) || []) {
    const encoded = digitWords[token] || (/^[a-z0-9]$/.test(token) ? token.toUpperCase() : "");
    if (encoded) current += encoded;
    else if (current) {
      if (current.length >= 5) sequences.push(current);
      current = "";
    }
  }
  if (current.length >= 5) sequences.push(current);
  return sequences;
}

function batchClaimCount(call) {
  const dynamicCount = Number(call.retell_llm_dynamic_variables?.batchClaimCount || 0);
  if (Number.isInteger(dynamicCount) && dynamicCount > 0) return dynamicCount;
  return String(call.metadata?.batchContactIds || "").split(",").map((value) => value.trim()).filter(Boolean).length;
}

function allow(message, code) {
  return { allowed: true, code, message };
}

function deny(message, code) {
  return { allowed: false, code, message };
}
