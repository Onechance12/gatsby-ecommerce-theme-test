import { fetchBoundedJson } from "../http/bounded-json.js";
import { THRESHER_AI_MODEL } from "./thresher-ai-runtime.js";

export const THRESHER_GROQ_RESPONSES_URL =
  "https://api.groq.com/openai/v1/responses";

const REQUEST_FIELDS = Object.freeze([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "store",
  "max_output_tokens"
]);

/**
 * Create HCN's dedicated Groq-backed Thresher AI Responses adapter.
 *
 * Provider, endpoint, and model are deliberately fixed in source. The caller
 * cannot supply provider state, built-in tools, MCP servers, background mode,
 * files, streaming, or an alternate model. Groq currently does not accept the
 * Responses API `store` request field, so the adapter requires `store:false`
 * at the HCN boundary and deliberately omits that unsupported field on the
 * provider request. Conversation replay remains bounded and HCN-controlled.
 */
export function createThresherGroqResponsesClient({
  apiKey,
  reasoningEffort,
  maxOutputTokens,
  fetchImpl = fetch
} = {}) {
  const key = boundedApiKey(apiKey);
  const effort = boundedReasoningEffort(reasoningEffort);
  integerBetween(maxOutputTokens, 256, 4096, "maxOutputTokens");
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  return Object.freeze(async function createResponse(request) {
    validateRequest(request, { maxOutputTokens });
    return fetchBoundedJson(
      fetchImpl,
      THRESHER_GROQ_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: THRESHER_AI_MODEL,
          instructions: request.instructions,
          input: request.input,
          tools: request.tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
          max_output_tokens: maxOutputTokens,
          reasoning: { effort }
        })
      },
      {
        timeoutMs: 55_000,
        maxBytes: 2 * 1024 * 1024,
        errorCode: "THRESHER_AI_PROVIDER_FAILED"
      }
    );
  });
}

function validateRequest(request, { maxOutputTokens }) {
  exactRecord(request, REQUEST_FIELDS, "Thresher AI provider request");
  if (
    request.model !== THRESHER_AI_MODEL
    || request.store !== false
    || request.parallel_tool_calls !== false
    || request.tool_choice !== "auto"
    || request.max_output_tokens !== maxOutputTokens
    || typeof request.instructions !== "string"
    || !request.instructions
    || !Array.isArray(request.input)
    || !Array.isArray(request.tools)
    || request.tools.some((tool) => tool?.type !== "function")
  ) {
    throw new TypeError(
      "Thresher AI provider request does not match the fixed HCN contract"
    );
  }
}

function boundedApiKey(value) {
  const key = String(value || "");
  if (!/^[\x21-\x7e]{20,512}$/.test(key)) {
    throw new TypeError(
      "apiKey must contain 20 to 512 printable non-space ASCII characters"
    );
  }
  return key;
}

function boundedReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (!["low", "medium", "high"].includes(effort)) {
    throw new TypeError("reasoningEffort is not enabled");
  }
  return effort;
}

function integerBetween(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new TypeError(
      `${label} must be an integer from ${minimum} through ${maximum}`
    );
  }
}

function exactRecord(value, keys, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some(
      (key) => typeof key !== "string" || !keys.includes(key)
    )
  ) {
    throw new TypeError(`${label} must contain only its fixed fields`);
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(
        `${label} must contain plain enumerable data fields`
      );
    }
  }
}
