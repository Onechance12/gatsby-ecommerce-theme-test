import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_OPENAI_RESPONSES_URL,
  createHcnOpenAIResponsesClient
} from "./openai-responses.js";

const API_KEY = ["sk", "hcn-assistant-fixture-key", "1234567890"].join("-");
const MODEL = "gpt-5.6-terra";

test("HCN provider adapter uses only the fixed Responses endpoint and store:false", async () => {
  const requests = [];
  const client = createHcnOpenAIResponsesClient({
    apiKey: API_KEY,
    model: MODEL,
    reasoningEffort: "low",
    maxOutputTokens: 1600,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "Ready."
          }]
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const response = await client(fixedRequest());
  assert.equal(response.output[0].type, "message");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, HCN_OPENAI_RESPONSES_URL);
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(
    requests[0].options.headers.authorization,
    `Bearer ${API_KEY}`
  );
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.max_output_tokens, 1600);
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(Object.hasOwn(body, "previous_response_id"), false);
  assert.equal(Object.hasOwn(body, "conversation"), false);
  assert.equal(Object.hasOwn(body, "background"), false);
});

test("HCN provider adapter rejects caller-selected provider state before fetch", async () => {
  let fetchCount = 0;
  const client = createHcnOpenAIResponsesClient({
    apiKey: API_KEY,
    model: MODEL,
    reasoningEffort: "low",
    maxOutputTokens: 1600,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("must not fetch");
    }
  });

  await assert.rejects(
    () => client({
      ...fixedRequest(),
      previous_response_id: "resp_attacker"
    }),
    /fixed fields/
  );
  await assert.rejects(
    () => client({
      ...fixedRequest(),
      model: "attacker-selected-model"
    }),
    /fixed HCN contract/
  );
  assert.equal(fetchCount, 0);
});

test("HCN provider adapter exposes only a generic bounded provider error", async () => {
  const client = createHcnOpenAIResponsesClient({
    apiKey: API_KEY,
    model: MODEL,
    reasoningEffort: "low",
    maxOutputTokens: 1600,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({
        error: {
          message: "provider-secret-body-must-not-leak"
        }
      }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await assert.rejects(
    () => client(fixedRequest()),
    (error) => {
      assert.equal(error.code, "HCN_ASSISTANT_PROVIDER_FAILED");
      assert.equal(error.statusCode, 401);
      assert.equal(error.message, "Provider request failed.");
      assert.doesNotMatch(
        error.message,
        /provider-secret-body-must-not-leak|fixture-key/
      );
      return true;
    }
  );
});

function fixedRequest() {
  return {
    model: MODEL,
    instructions: "Use fresh HCN evidence.",
    input: [{ role: "user", content: "Work my files." }],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    max_output_tokens: 1600
  };
}
