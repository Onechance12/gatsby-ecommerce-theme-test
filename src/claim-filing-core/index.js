// Portable claim-filing core — bridge-ready business logic with NO dependency on
// fileReview, sweep reports, CLI parsers/printers, JobNimbus clients, Gmail, Quo,
// or the filesystem. The Render bridge adapter (owned by Codex) and the local
// file:claim CLI wrapper both build on exactly these exports, so there is one
// implementation, not two.
//
// See docs/claim-filing-core-contract.md for the input contract and usage.

export { normalizeClaimFileInput } from "./inputContract.js";
export { buildClaimCallPacket, normalizeGoal, cleanClaimNumber, DEFAULT_GOAL } from "./packet.js";
export {
  STANDARD_FILING_ANSWERS,
  resolveStandardAnswers,
  inferCause,
  inferDamageCategories
} from "./standardAnswers.js";
export { lookupCarrier, knownCarriers } from "./carrierDirectory.js";
export { assessReadiness, existingClaimBlock } from "./readiness.js";
export { flattenFactsForDynamicVariables, PROMPT_PLACEHOLDERS } from "./dynamicVariables.js";
export { buildRetellLlmFromPacket, renderRetellPrompt, postCallAnalysisSchema } from "./retellPrompt.js";
export {
  extractCallResults,
  inferOutcome,
  transcriptClaimNumber,
  transcriptEmail,
  transcriptNear
} from "./resultExtraction.js";
export { buildWritebackProposal } from "./writeback.js";
