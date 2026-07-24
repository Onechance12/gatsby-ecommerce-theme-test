import { createHash } from "node:crypto";

export const ZAI_OPERATIONAL_PROVIDER = "zai";
export const ZAI_OPERATIONAL_MODEL = "glm-4.7-flash";
export const ZAI_CHAT_COMPLETIONS_URL = "https://api.z.ai/api/paas/v4/chat/completions";
export const OPENAI_OPERATIONAL_PROVIDER = "openai";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

const PROVIDER_VERSION = 1;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;

export function createZaiOperationalProvider({
  apiKey,
  model = ZAI_OPERATIONAL_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clock = Date.now,
  now = () => new Date()
} = {}) {
  const key = requiredCredential(apiKey, "Z.AI");
  assertProviderConfig(model, fetchImpl, timeoutMs);
  return Object.freeze({
    provider: ZAI_OPERATIONAL_PROVIDER,
    model,
    async generate({ systemPrompt, userPayload, maxOutputTokens = 900, signal } = {}) {
      const body = {
        model,
        messages: [
          { role: "system", content: requiredText(systemPrompt, "systemPrompt") },
          { role: "user", content: JSON.stringify(userPayload || {}) }
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: boundedInteger(maxOutputTokens, 128, 2048, 900),
        temperature: 0.1,
        stream: false
      };
      const startedAt = now().toISOString();
      const startedClock = clock();
      const { response, raw } = await providerFetch({
        url: ZAI_CHAT_COMPLETIONS_URL,
        apiKey: key,
        body,
        fetchImpl,
        timeoutMs,
        signal
      });
      const value = parseJson(raw, "Z.AI returned invalid JSON.");
      rejectToolCalls(value);
      if (value.model !== model) throw providerError("invalid_response", "Z.AI returned an unexpected model.");
      if (typeof value.id !== "string" || !value.id || value.id.length > 256) {
        throw providerError("invalid_response", "Z.AI omitted valid request provenance.");
      }
      if (!Array.isArray(value.choices) || value.choices.length !== 1) {
        throw providerError("invalid_response", "Z.AI returned an invalid choice.");
      }
      const choice = value.choices[0];
      if (choice?.finish_reason !== "stop") throw providerError("invalid_response", "Z.AI did not finish cleanly.");
      rejectToolCalls(choice);
      const content = choice?.message?.content;
      if (typeof content !== "string" || !content.trim().startsWith("{") || !content.trim().endsWith("}")) {
        throw providerError("invalid_response", "Z.AI returned non-JSON advisory content.");
      }
      const output = parseJson(content, "Z.AI returned invalid advisory JSON.");
      const usage = normalizeChatUsage(value.usage, body.max_tokens);
      return {
        output,
        provenance: buildProvenance({
          provider: ZAI_OPERATIONAL_PROVIDER,
          model,
          adapter: "zai-openai-compatible-v1",
          providerRequestId: value.id,
          raw,
          body,
          usage,
          startedAt,
          completedAt: now().toISOString(),
          latencyMs: elapsedMs(clock() - startedClock),
          finishReason: choice.finish_reason,
          responseStatus: response.status
        })
      };
    }
  });
}

export function createOpenAiOperationalProvider({
  apiKey,
  model = "gpt-5.6-luna",
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clock = Date.now,
  now = () => new Date()
} = {}) {
  const key = requiredCredential(apiKey, "OpenAI");
  assertProviderConfig(model, fetchImpl, timeoutMs);
  return Object.freeze({
    provider: OPENAI_OPERATIONAL_PROVIDER,
    model,
    async generate({ systemPrompt, userPayload, outputSchema, maxOutputTokens = 900, signal } = {}) {
      const body = {
        model,
        store: false,
        reasoning: { effort: "none" },
        max_output_tokens: boundedInteger(maxOutputTokens, 128, 2048, 900),
        input: [
          { role: "developer", content: requiredText(systemPrompt, "systemPrompt") },
          { role: "user", content: JSON.stringify(userPayload || {}) }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "wave_operational_advisory",
            strict: true,
            schema: outputSchema
          }
        }
      };
      const startedAt = now().toISOString();
      const startedClock = clock();
      const { response, raw } = await providerFetch({
        url: OPENAI_RESPONSES_URL,
        apiKey: key,
        body,
        fetchImpl,
        timeoutMs,
        signal
      });
      const value = parseJson(raw, "OpenAI returned invalid JSON.");
      rejectToolCalls(value);
      const outputText = extractOpenAiOutputText(value);
      if (!outputText) throw providerError("invalid_response", "OpenAI returned no structured advisory.");
      const output = parseJson(outputText, "OpenAI returned invalid advisory JSON.");
      return {
        output,
        provenance: buildProvenance({
          provider: OPENAI_OPERATIONAL_PROVIDER,
          model,
          adapter: "openai-responses-v1",
          providerRequestId: String(value.id || ""),
          raw,
          body,
          usage: normalizeResponsesUsage(value.usage, body.max_output_tokens),
          startedAt,
          completedAt: now().toISOString(),
          latencyMs: elapsedMs(clock() - startedClock),
          finishReason: responseFinishReason(value),
          responseStatus: response.status
        })
      };
    }
  });
}

export function providerDescriptor(provider) {
  if (!provider || typeof provider.generate !== "function") return null;
  return {
    provider: String(provider.provider || ""),
    model: String(provider.model || "")
  };
}

async function providerFetch({ url, apiKey, body, fetchImpl, timeoutMs, signal }) {
  const timeout = boundedSignal(timeoutMs, signal);
  let response;
  let raw;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(body),
      signal: timeout.signal
    });
    raw = await readBoundedResponse(response);
  } catch (error) {
    if (timeout.timedOut()) throw providerError("timeout", "The operational model request timed out.");
    if (signal?.aborted || error?.name === "AbortError") throw providerError("aborted", "The operational model request was canceled.");
    if (error?.operationalProviderError) throw error;
    throw providerError("unavailable", "The operational model provider is unavailable.");
  } finally {
    timeout.dispose();
  }
  if (!response || response.redirected) throw providerError("rejected", "The operational model provider redirected the request.");
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw providerError("authentication", "The operational model provider rejected its credential.");
    if (response.status === 429) throw providerError("rate_limit", "The operational model provider rate limit was reached.");
    if (response.status === 408 || response.status >= 500) throw providerError("unavailable", "The operational model provider is unavailable.");
    throw providerError("rejected", "The operational model provider rejected the request.");
  }
  return { response, raw };
}

async function readBoundedResponse(response) {
  if (!response || typeof response.text !== "function") throw providerError("unavailable", "The operational model provider is unavailable.");
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw providerError("invalid_response", "The operational model response exceeded the safe limit.");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw providerError("invalid_response", "The operational model response exceeded the safe limit.");
  }
  return raw;
}

function buildProvenance({
  provider,
  model,
  adapter,
  providerRequestId,
  raw,
  body,
  usage,
  startedAt,
  completedAt,
  latencyMs,
  finishReason,
  responseStatus
}) {
  return {
    version: PROVIDER_VERSION,
    provider,
    requestedModel: model,
    adapter,
    providerRequestIdHash: hash(providerRequestId),
    providerResponseHash: hash(raw),
    requestHash: hash(JSON.stringify(body)),
    usage,
    latencyMs,
    finishReason,
    responseStatus,
    startedAt,
    completedAt,
    toolCallCount: 0,
    executionAuthority: false,
    externalActionAuthorized: false
  };
}

function normalizeChatUsage(usage, outputLimit) {
  const inputTokens = boundedInteger(usage?.prompt_tokens, 0, 10_000_000, 0);
  const outputTokens = boundedInteger(usage?.completion_tokens, 0, outputLimit, 0);
  const totalTokens = boundedInteger(usage?.total_tokens, 0, 20_000_000, inputTokens + outputTokens);
  if (totalTokens !== inputTokens + outputTokens) throw providerError("invalid_response", "The operational model returned inconsistent usage.");
  const cachedTokens = boundedInteger(usage?.prompt_tokens_details?.cached_tokens, 0, inputTokens, 0);
  return { inputTokens, outputTokens, cachedTokens, totalTokens };
}

function normalizeResponsesUsage(usage, outputLimit) {
  const inputTokens = boundedInteger(usage?.input_tokens, 0, 10_000_000, 0);
  const outputTokens = boundedInteger(usage?.output_tokens, 0, outputLimit, 0);
  const totalTokens = boundedInteger(usage?.total_tokens, 0, 20_000_000, inputTokens + outputTokens);
  if (totalTokens !== inputTokens + outputTokens) throw providerError("invalid_response", "The operational model returned inconsistent usage.");
  const cachedTokens = boundedInteger(usage?.input_tokens_details?.cached_tokens, 0, inputTokens, 0);
  return { inputTokens, outputTokens, cachedTokens, totalTokens };
}

function responseFinishReason(value) {
  if (value?.status === "completed") return "stop";
  throw providerError("invalid_response", "OpenAI did not finish cleanly.");
}

function extractOpenAiOutputText(value) {
  if (typeof value?.output_text === "string") return value.output_text;
  for (const item of Array.isArray(value?.output) ? value.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  return "";
}

function rejectToolCalls(value) {
  const serialized = JSON.stringify(value);
  if (/"(?:tool_calls|function_call)"\s*:/.test(serialized)) {
    throw providerError("invalid_response", "The operational model attempted a tool call.");
  }
}

function boundedSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  parentSignal?.addEventListener?.("abort", abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", abort);
    }
  };
}

function assertProviderConfig(model, fetchImpl, timeoutMs) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(String(model || ""))) throw new Error("Operational model is invalid.");
  if (typeof fetchImpl !== "function") throw new Error("Operational provider fetch client is invalid.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 45_000) throw new Error("Operational provider timeout is invalid.");
}

function requiredCredential(value, provider) {
  const key = String(value || "").trim();
  if (key.length < 20 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error(`${provider} operational credential is unavailable.`);
  }
  return key;
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  if (number < min || number > max) throw providerError("invalid_response", "The operational model returned an out-of-bounds value.");
  return number;
}

function parseJson(value, message) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    throw providerError("invalid_response", message);
  }
}

function elapsedMs(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 50_000) : 0;
}

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function providerError(code, message) {
  const error = new Error(message);
  error.operationalProviderError = true;
  error.code = code;
  return error;
}
