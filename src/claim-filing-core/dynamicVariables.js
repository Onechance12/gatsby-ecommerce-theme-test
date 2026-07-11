// Retell dynamic-variable assembly. Pure + dependency-free. Every {{placeholder}}
// referenced in the Retell prompt (retellPrompt.js) must get a value here, or it
// would be spoken literally ("curly brace insured name"), so we default them all.
// Keep PROMPT_PLACEHOLDERS in sync with renderRetellPrompt.
export const PROMPT_PLACEHOLDERS = [
  "objective",
  "insuredName",
  "propertyAddress",
  "homeownerPhone",
  "homeownerEmail",
  "carrier",
  "policyNumber",
  "policyNumberSpoken",
  "claimNumber",
  "dateOfLoss",
  "stormTime",
  "causeOfLoss",
  "adjuster",
  "mortgageCompany",
  "damageSummary",
  "damageOpening",
  "damageDetails",
  "injuries",
  "homeLivable",
  "temporaryRepairs",
  "contractorHired",
  "occupancy",
  "damageDiscovered",
  "directionMode",
  "callbackMatch",
  "callbackCarrier",
  "callbackInsuredName",
  "callbackPropertyAddress",
  "callbackPolicyNumber",
  "callbackClaimNumber",
  "pendingCallbackCases",
  "batchClaimCount",
  "batchClaims"
];

export function flattenFactsForDynamicVariables(packet) {
  const out = {};
  for (const [key, value] of Object.entries(packet.verifiedFileFacts || {})) {
    out[key] = String(value ?? "");
  }
  out.objective = String(packet.objective ?? "");
  // damageSummary is a separate packet field (array); the prompt references
  // {{damageSummary}}, so join it to a string per call.
  out.damageSummary = (packet.damageSummary || []).join(", ");
  out.damageOpening = String(packet.damageOpening || "");
  out.damageDetails = (packet.damageDetails || packet.damageSummary || []).join(", ");
  out.policyNumberSpoken = spokenPolicyNumber(out.policyNumber);
  out.directionMode = "outbound_claim_call";
  out.callbackMatch = "not_applicable";
  out.callbackCarrier = "Missing";
  out.callbackInsuredName = "Missing";
  out.callbackPropertyAddress = "Missing";
  out.callbackPolicyNumber = "Missing";
  out.callbackClaimNumber = "Missing";
  out.pendingCallbackCases = "Missing";
  out.batchClaimCount = "0";
  out.batchClaims = "None";
  // The goal rides along so post-call extraction can tell a new filing from a
  // status follow-up even without call metadata.
  if (packet.goal) out.goal = String(packet.goal);
  for (const key of PROMPT_PLACEHOLDERS) {
    if (!out[key]) out[key] = "Missing";
  }
  return out;
}

export function spokenPolicyNumber(value) {
  const raw = String(value || "").trim();
  if (!raw || /^missing/i.test(raw)) return "Missing";

  // Mortgage declarations often combine a usable policy identifier with
  // control and loan references. Give only the policy itself unless a carrier
  // representative explicitly asks for another identifier.
  const master = raw.match(/\bmaster\s+policy\s*[:#-]?\s*([a-z0-9-]+)/i);
  const policy = raw.match(/\bpolicy(?:\s+number|\s*#)?\s*[:#-]?\s*([a-z0-9-]+)/i);
  const selected = String(master?.[1] || policy?.[1] || raw.split(/\s*\/\s*/)[0])
    .replace(/^master\s+policy\s*/i, "")
    .replace(/^policy(?:\s+number|\s*#)?\s*/i, "")
    .trim();

  return selected || raw;
}
