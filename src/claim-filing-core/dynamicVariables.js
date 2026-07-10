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
  "claimNumber",
  "dateOfLoss",
  "stormTime",
  "causeOfLoss",
  "adjuster",
  "mortgageCompany",
  "damageSummary",
  "injuries",
  "homeLivable",
  "temporaryRepairs",
  "contractorHired",
  "occupancy",
  "damageDiscovered"
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
  // The goal rides along so post-call extraction can tell a new filing from a
  // status follow-up even without call metadata.
  if (packet.goal) out.goal = String(packet.goal);
  for (const key of PROMPT_PLACEHOLDERS) {
    if (!out[key]) out[key] = "Missing";
  }
  return out;
}
