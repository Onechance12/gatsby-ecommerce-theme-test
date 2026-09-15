const CALLBACK_CONFIRMATIONS = [
  /\b(?:request for (?:a )?callback|callback request)\s+(?:(?:has been|is|was)\s+)?(?:accepted|confirmed|queued|reserved|saved|scheduled)\b/i,
  /\b(?:request for (?:a )?callback|callback request)\b.{0,60}\b(?:(?:has been|is|was|has now been|is now|was now)\s+)?(?:accepted|confirmed|queued|reserved|saved|scheduled)\b/i,
  /\b(?:your|the) callback\s+(?:(?:has been|is|was|has now been|is now|was now)\s+)?(?:accepted|confirmed|queued|reserved|saved|scheduled)\b/i,
  /\b(?:i|we)(?:'ve| have)?\s+(?:accepted|confirmed|queued|reserved|saved|scheduled)\s+(?:(?:your|the|a)\s+)?(?:callback|callback request|request for (?:a )?callback)\b/i,
  /\b(?:you(?:'ll| will)|we(?:'ll| will)|the (?:claims |callback )?(?:team|department|representative)(?:'ll| will))\s+(?:receive (?:a|the|your) callback|call you back)\b/i,
  /\b(?:your|the) (?:place|position) in (?:the )?(?:callback )?(?:line|queue)\s+(?:(?:has been|is|was)\s+)?(?:confirmed|reserved|saved)\b/i
];

const CALLBACK_NEGATIONS = [
  /\b(?:request for (?:a )?callback|callback request|callback|call back)\b.{0,20}\b(?:has not been|is not|was not|not)\s+(?:accepted|confirmed|queued|received|reserved|saved|scheduled|submitted)\b/i,
  /\b(?:cannot|can't|could not|did not|didn't|unable to|will not|won't)\s+(?:accept|confirm|place|queue|receive|reserve|save|schedule|submit)\s+(?:(?:your|the|a)\s+)?(?:callback|callback request|request for (?:a )?callback)\b/i,
  /\b(?:callback|call back|request)\b.{0,30}\b(?:cancelled|canceled|declined|failed|removed|rejected)\b/i
];

const CALLBACK_OFFERS = [
  /\b(?:would|do) you (?:like|want)\b.{0,60}\b(?:callback|call back)\b/i,
  /\bpress\b.{0,30}\b(?:callback|call back)\b/i,
  /\bif you\b.{0,50}\b(?:choose|request|select|want|would like)\b.{0,50}\b(?:callback|call back)\b/i,
  /\b(?:callback|call back)\b.{0,40}\b(?:is available|is an option|may be requested)\b/i
];

// Acknowledging that a request was received or submitted is not a promise that
// the carrier will return the call. Likewise, conditional or uncertain language
// cannot create a durable callback reservation even when the same sentence also
// contains words such as "confirmed" or "will call."
const CALLBACK_UNCERTAINTY = [
  /\b(?:callback(?: request)?|request for (?:a )?callback)\b.{0,60}\b(?:is |remains |still )?pending\b/i,
  /\bpending\b.{0,60}\b(?:callback(?: request)?|request for (?:a )?callback)\b/i,
  /\b(?:callback(?: request)?|request for (?:a )?callback)\b.{0,60}\b(?:awaiting|subject to|depending on)\s+(?:carrier |supervisor |manager |agent )?(?:approval|authorization|availability|confirmation)\b/i,
  /\b(?:not yet|has not yet been|have not yet|isn't yet|is not yet|wasn't yet|was not yet)\s*(?:been\s+)?(?:accepted|approved|authorized|confirmed|queued|reserved|saved|scheduled)\b/i,
  /\b(?:not|never)\s+(?:guaranteed|assured)\b/i,
  /\b(?:cannot|can't|do not|don't|could not|couldn't)\s+guarantee\b/i,
  /\b(?:may|might|could)\s+or\s+(?:may|might|could)\s+not\b.{0,60}\b(?:callback|call(?:ed)? back|call you)\b/i,
  /\b(?:callback|call(?:ed)? back|call you)\b.{0,60}\b(?:may|might|could)\s+or\s+(?:may|might|could)\s+not\b/i,
  /\b(?:may|might|could)\s+(?:receive (?:a|the|your) callback|be called back|call you back)\b/i,
  /\b(?:may|might|could)\s+(?:be\s+)?(?:accepted|approved|authorized|confirmed|queued|reserved|saved|scheduled)\b/i,
  /\bif\b.{0,60}\b(?:approved|authorized|accepted|confirmed|available|availability)\b/i,
  /\bif\s+(?:an?|the|our)\s+(?:agent|representative|adjuster|team member)\s+(?:is|becomes)\s+available\b/i,
  /\bif\s+(?:someone|anyone)\s+(?:is|becomes)\s+available\b/i,
  /\b(?:subject to|depending on)\s+(?:carrier |supervisor |manager |agent )?(?:approval|authorization|availability|confirmation)\b/i
];

// A callback is a confirmed continuation only when the carrier/callee said so.
// Model extraction and an agent's own restatement are never sufficient proof.
export function isConfirmedCarrierCallback(call = {}) {
  return carrierStatements(call).some((statement) => (
    !CALLBACK_NEGATIONS.some((pattern) => pattern.test(statement))
    && !CALLBACK_OFFERS.some((pattern) => pattern.test(statement))
    && !CALLBACK_UNCERTAINTY.some((pattern) => pattern.test(statement))
    && CALLBACK_CONFIRMATIONS.some((pattern) => pattern.test(statement))
  ));
}

export const confirmedCallbackRequest = isConfirmedCarrierCallback;

function carrierStatements(call) {
  if (Array.isArray(call?.transcript_object)) {
    return call.transcript_object
      .filter((turn) => isCarrierRole(turn?.role))
      .map((turn) => String(turn?.content || turn?.text || "").trim())
      .filter(Boolean);
  }

  const transcript = String(call?.transcript || "").trim();
  if (!transcript) return [];
  const lines = transcript.split(/\r?\n/);
  const labelled = lines.map((line) => {
    const match = line.match(/^\s*(agent|assistant|bot|caller|user|callee|representative|human)\s*:\s*(.*)$/i);
    return match
      ? { role: String(match[1] || ""), content: String(match[2] || "").trim() }
      : null;
  });
  if (labelled.some(Boolean)) {
    return labelled
      .filter((turn) => turn && isCarrierRole(turn.role))
      .map((turn) => turn.content)
      .filter(Boolean);
  }
  // Without speaker attribution, the same sentence could be the model merely
  // repeating an offer. Fail closed rather than turning an unlabelled phrase
  // into a durable callback reservation.
  return [];
}

function isCarrierRole(role) {
  return ["user", "callee", "representative", "human"].includes(String(role || "").toLowerCase());
}
