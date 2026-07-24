import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiOperationalProvider,
  createZaiOperationalProvider,
  OPENAI_RESPONSES_URL,
  ZAI_CHAT_COMPLETIONS_URL
} from "./operationalAdvisoryProvider.js";

const output = {
  summary: "One evidence-backed loop is open.",
  primaryLoopId: "loop_fixture",
  recommendedAction: "Prepare the next action for Chance's approval.",
  rationale: "The supplied source shows the required confirmation is missing.",
  uncertainties: ["The homeowner response is unknown."],
  sourceIds: ["jobnimbus-task:fixture"],
  requiresSeparateApproval: true
};

test("Z.AI adapter uses the fixed endpoint, disables thinking, exposes no tools, and returns hashed provenance", async () => {
  const requests = [];
  const provider = createZaiOperationalProvider({
    apiKey: "fixture-zai-key-1234567890",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        id: "provider-sensitive-request-id",
        model: "glm-4.7-flash",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(output) }
        }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 55,
          total_tokens: 175,
          prompt_tokens_details: { cached_tokens: 20 }
        }
      });
    },
    clock: sequence(100, 145),
    now: dateSequence("2026-07-24T12:00:00.000Z", "2026-07-24T12:00:00.045Z")
  });

  const result = await provider.generate({
    systemPrompt: "Return one JSON advisory.",
    userPayload: { sources: [{ id: "jobnimbus-task:fixture" }] },
    outputSchema: {},
    maxOutputTokens: 900
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, ZAI_CHAT_COMPLETIONS_URL);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, "glm-4.7-flash");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.tools, undefined);
  assert.equal(body.stream, false);
  assert.deepEqual(result.output, output);
  assert.equal(result.provenance.provider, "zai");
  assert.equal(result.provenance.toolCallCount, 0);
  assert.equal(result.provenance.executionAuthority, false);
  assert.equal(result.provenance.externalActionAuthorized, false);
  assert.deepEqual(result.provenance.usage, {
    inputTokens: 120,
    outputTokens: 55,
    cachedTokens: 20,
    totalTokens: 175
  });
  assert.equal(result.provenance.latencyMs, 45);
  assert.match(result.provenance.providerRequestIdHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("provider-sensitive-request-id"), false);
  assert.equal(JSON.stringify(result).includes("fixture-zai-key"), false);
});

test("Z.AI adapter fails closed on tool calls and unexpected models", async () => {
  for (const payload of [
    {
      id: "request-1",
      model: "glm-4.7-flash",
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(output), tool_calls: [] }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    },
    {
      id: "request-2",
      model: "unexpected-model",
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(output) }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    }
  ]) {
    const provider = createZaiOperationalProvider({
      apiKey: "fixture-zai-key-1234567890",
      fetchImpl: async () => jsonResponse(payload)
    });
    await assert.rejects(() => provider.generate({
      systemPrompt: "Return JSON.",
      userPayload: { sources: [] }
    }), /tool call|unexpected model/i);
  }
});

test("OpenAI remains an optional provider adapter with strict structured output and no tools", async () => {
  let request;
  const provider = createOpenAiOperationalProvider({
    apiKey: "fixture-openai-key-1234567890",
    fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return jsonResponse({
        id: "response-fixture",
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(output) }]
        }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          total_tokens: 140,
          input_tokens_details: { cached_tokens: 0 }
        }
      });
    }
  });
  const schema = { type: "object", additionalProperties: true };
  const result = await provider.generate({
    systemPrompt: "Return JSON.",
    userPayload: { sources: [] },
    outputSchema: schema
  });

  assert.equal(request.url, OPENAI_RESPONSES_URL);
  assert.equal(request.body.store, false);
  assert.equal(request.body.tools, undefined);
  assert.equal(request.body.text.format.strict, true);
  assert.deepEqual(request.body.text.format.schema, schema);
  assert.deepEqual(result.output, output);
  assert.equal(result.provenance.provider, "openai");
  assert.equal(result.provenance.externalActionAuthorized, false);
});

function jsonResponse(value, status = 200) {
  const raw = JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: { get: () => String(Buffer.byteLength(raw)) },
    text: async () => raw
  };
}

function sequence(...values) {
  return () => values.shift();
}

function dateSequence(...values) {
  return () => new Date(values.shift());
}
