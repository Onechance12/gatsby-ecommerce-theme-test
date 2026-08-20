import { immutableCopy } from "./contracts.js";
import { deriveFileState } from "./derive.js";
import { evaluateFileWorkflows } from "./workflows.js";

export {
  FileIntelligenceContractError,
  normalizeFileEvidence
} from "./contracts.js";
export { deriveFileState } from "./derive.js";
export {
  evaluateClaimFilingWorkflow,
  evaluateCommunicationsWorkflow,
  evaluateFileWorkflows,
  evaluateFollowUpWorkflow,
  evaluateInspectionSchedulingWorkflow,
  evaluateNeglectedFilesWorkflow,
  evaluateWorkflow
} from "./workflows.js";
export {
  DOCUMENT_CODES,
  EVENT_CODES,
  FACT_CODES,
  FILE_INTELLIGENCE_SCHEMA,
  SOURCE_NAMES,
  STAGE_CODES,
  WORKFLOW_EVALUATION_SCHEMA,
  WORKFLOW_IDS
} from "./constants.js";

/**
 * One-call API: normalize evidence, derive file state, then attach all
 * deterministic workflow evaluations.
 */
export function deriveFileIntelligence(input) {
  const state = deriveFileState(input);
  return immutableCopy({
    ...state,
    workflows: evaluateFileWorkflows(state)
  });
}
