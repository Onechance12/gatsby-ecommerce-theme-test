// Retell dynamic-variable assembly. Pure + dependency-free. Every {{placeholder}}
// referenced in the Retell prompt (retellPrompt.js) must get a value here, or it
// would be spoken literally ("curly brace insured name"), so we default them all.
// Keep PROMPT_PLACEHOLDERS limited to the placeholders actually rendered by
// renderRetellPrompt. Other bridge-only variables (for example the callback
// guard's batch counters) may still ride in the packet without becoming model
// instructions.
export const PROMPT_PLACEHOLDERS = [
  "goal",
  "objective",
  "insuredName",
  "propertyAddress",
  "homeownerPhone",
  "homeownerEmail",
  "carrier",
  "policyNumberSpoken",
  "claimNumber",
  "dateOfLoss",
  "stormTime",
  "causeOfLoss",
  "adjuster",
  "mortgageCompany",
  "damageOpening",
  "damageDetails",
  "injuries",
  "homeLivable",
  "temporaryRepairs",
  "contractorHired",
  "occupancy",
  "damageDiscovered",
  "propertyStories",
  "roofAccessibility",
  "damagedRooms",
  "damagedRoomCount",
  "contractorPhone",
  "directionMode",
  "callbackMatch",
  "callbackCarrier",
  "callbackInsuredName",
  "callbackPropertyAddress",
  "callbackPolicyNumber",
  "callbackClaimNumber",
  "callbackPacketStatus",
  "pendingCallbackCases"
];

export function flattenFactsForDynamicVariables(packet) {
  const out = {};
  for (const [key, value] of Object.entries(packet.verifiedFileFacts || {})) {
    out[key] = String(value ?? "");
  }
  out.objective = String(packet.objective ?? "");
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
  out.callbackPacketStatus = "not_applicable";
  out.pendingCallbackCases = "Missing";
  out.batchClaimCount = "0";
  out.batchClaims = "None";
  out.availabilityStatus = "NOT_REQUESTED";
  out.availableAppointmentWindows = "None. Do not schedule an appointment.";
  out.availabilityTimeZone = "America/Chicago";
  out.appointmentDurationMinutes = "120";
  out.availabilitySources = "Not checked for this call";
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
  const master = raw.match(/\bmaster\s+policy\s*[:#]?\s+([a-z0-9-]+)/i);
  const policy = raw.match(/\bpolicy(?:\s+number|\s*#)?\s*[:#]?\s+([a-z0-9-]+)/i);
  const slashPrefix = raw.split(/\s*\/\s*/)[0].trim();
  const standalone = /^[a-z0-9-]+$/i.test(slashPrefix) ? slashPrefix : "";
  const identifier = raw.match(/\b(?=[a-z0-9-]*\d)[a-z0-9-]{5,}\b/i);
  const selected = String(master?.[1] || policy?.[1] || standalone || identifier?.[0] || "").trim();

  return selected || "Missing";
}
