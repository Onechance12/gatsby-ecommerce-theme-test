import { fetchBoundedJson } from "../http/bounded-json.js";

export const HCN_OPENAI_RESPONSES_URL =
  "https://api.openai.com/v1/responses";

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
 * Create the dedicated HCN Responses API adapter.
 *
 * The endpoint is intentionally fixed. The caller cannot supply provider
 * state, a response id, background mode, streaming, files, or hosted tools.
 */
export function createHcnOpenAIResponsesClient({
  apiKey,
  model,
  reasoningEffort,
  maxOutputTokens,
  fetchImpl = fetch
} = {}) {
  const key = boundedApiKey(apiKey);
  const configuredModel = boundedModel(model);
  const effort = boundedReasoningEffort(reasoningEffort);
  integerBetween(maxOutputTokens, 256, 4096, "maxOutputTokens");
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  return Object.freeze(async function createResponse(request) {
    validateRequest(request, {
      model: configuredModel,
      maxOutputTokens
    });
    return fetchBoundedJson(
      fetchImpl,
      HCN_OPENAI_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...request,
          model: configuredModel,
          store: false,
          stream: false,
          parallel_tool_calls: false,
          max_output_tokens: maxOutputTokens,
          reasoning: { effort }
        })
      },
      {
        timeoutMs: 55_000,
        maxBytes: 2 * 1024 * 1024,
        errorCode: "HCN_ASSISTANT_PROVIDER_FAILED"
      }
    );
  });
}

function validateRequest(request, { model, maxOutputTokens }) {
  exactRecord(request, REQUEST_FIELDS, "assistant provider request");
  if (
    request.model !== model
    || request.store !== false
    || request.parallel_tool_calls !== false
    || request.tool_choice !== "auto"
    || request.max_output_tokens !== maxOutputTokens
    || typeof request.instructions !== "string"
    || !request.instructions
    || !Array.isArray(request.input)
    || !Array.isArray(request.tools)
  ) {
    throw new TypeError(
      "assistant provider request does not match the fixed HCN contract"
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

function boundedModel(value) {
  const model = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
    throw new TypeError("model must be a bounded model identifier");
  }
  return model;
}

function boundedReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (!["none", "minimal", "low", "medium", "high"].includes(effort)) {
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
    throw new TypeError(
      `${label} must contain only its fixed fields`
    );
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
