/**
 * Fixed identity for HCN's dedicated Thresher AI reasoning runtime.
 *
 * These values are source-controlled policy, not environment-selected model
 * settings. The browser and request payload cannot choose a provider, model,
 * endpoint, or execution capability.
 */
export const THRESHER_AI_IDENTITY = "hcn.thresher-ai.v1";
export const THRESHER_AI_PROVIDER = "groq";
export const THRESHER_AI_PROVIDER_API = "groq_responses_api";
export const THRESHER_AI_MODEL = "openai/gpt-oss-20b";
export const THRESHER_AI_INSTRUCTIONS_VERSION =
  "hcn.thresher-ai.instructions.v2";

export const THRESHER_AI_RUNTIME = Object.freeze({
  identity: THRESHER_AI_IDENTITY,
  provider: THRESHER_AI_PROVIDER,
  providerApi: THRESHER_AI_PROVIDER_API,
  model: THRESHER_AI_MODEL,
  instructionsVersion: THRESHER_AI_INSTRUCTIONS_VERSION,
  providerSelectable: false,
  modelSelectable: false,
  providerStateEnabled: false,
  builtInProviderToolsEnabled: false,
  remoteToolsEnabled: false,
  modelCanExecute: false
});
