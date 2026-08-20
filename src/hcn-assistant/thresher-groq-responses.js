import { fetchBoundedJson } from "../http/bounded-json.js";
import { THRESHER_AI_MODEL } from "./thresher-ai-runtime.js";

export const THRESHER_GROQ_RESPONSES_URL =
  "https://api.groq.com/openai/v1/responses";

const BASE_REQUEST_FIELDS = Object.freeze([
  "model",
  "instructions",
  "input",
  "parallel_tool_calls",
  "store",
  "max_output_tokens"
]);
const TOOLED_REQUEST_FIELDS = Object.freeze([
  ...BASE_REQUEST_FIELDS,
  "tools",
  "tool_choice"
]);

/**
 * Create HCN's dedicated Groq-backed Thresher AI Responses adapter.
 *
 * Provider, endpoint, and model are deliberately fixed in source. The caller
 * cannot supply provider state, built-in tools, MCP servers, background mode,
 * files, streaming, or an alternate model.
 * The HCN boundary rejects provider-managed conversation state and keeps
 * replay bounded and HCN-controlled. `store:false` remains an internal
 * invariant supplied by the assistant core, but it is deliberately omitted
 * from the Groq wire payload because this endpoint does not support that
 * request field. Provider project Data Controls remain a separate deployment
 * gate; omission of the field is not a retention or ZDR claim.
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
    const toolFields = Object.hasOwn(request, "tools")
      ? {
          tools: request.tools,
          tool_choice: request.tool_choice
        }
      : {};
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
          ...toolFields,
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
  const hasTools = Object.hasOwn(request, "tools");
  const hasToolChoice = Object.hasOwn(request, "tool_choice");
  if (hasTools !== hasToolChoice) {
    throw new TypeError(
      "Thresher AI provider request does not match the fixed HCN contract"
    );
  }
  exactRecord(
    request,
    hasTools ? TOOLED_REQUEST_FIELDS : BASE_REQUEST_FIELDS,
    "Thresher AI provider request"
  );
  if (
    request.model !== THRESHER_AI_MODEL
    || request.store !== false
    || request.parallel_tool_calls !== false
    || (hasTools && !["auto", "required"].includes(request.tool_choice))
    || (hasTools && !Array.isArray(request.tools))
    || (hasTools && request.tools.length === 0)
    || (request.tool_choice === "required" && request.tools.length !== 1)
    || request.max_output_tokens !== maxOutputTokens
    || typeof request.instructions !== "string"
    || !request.instructions
    || !Array.isArray(request.input)
    || (hasTools && request.tools.some((tool) => tool?.type !== "function"))
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
