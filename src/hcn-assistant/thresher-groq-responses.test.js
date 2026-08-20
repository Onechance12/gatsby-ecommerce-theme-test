import assert from "node:assert/strict";
import test from "node:test";

import {
  THRESHER_GROQ_RESPONSES_URL,
  createThresherGroqResponsesClient
} from "./thresher-groq-responses.js";
import { THRESHER_AI_MODEL } from "./thresher-ai-runtime.js";

const API_KEY = ["gsk", "hcn-thresher-fixture-key", "1234567890"].join("_");

test("Thresher AI adapter uses only the fixed Groq endpoint and model", async () => {
  const requests = [];
  const client = createThresherGroqResponsesClient({
    apiKey: API_KEY,
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
  assert.equal(requests[0].url, THRESHER_GROQ_RESPONSES_URL);
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(
    requests[0].options.headers.authorization,
    `Bearer ${API_KEY}`
  );
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, THRESHER_AI_MODEL);
  assert.equal(Object.hasOwn(body, "tool_choice"), false);
  assert.equal(Object.hasOwn(body, "tools"), false);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(Object.hasOwn(body, "store"), false);
  assert.equal(body.max_output_tokens, 1600);
  assert.deepEqual(body.reasoning, { effort: "low" });
  for (const forbidden of [
    "stream",
    "store",
    "previous_response_id",
    "conversation",
    "background",
    "include",
    "prompt"
  ]) {
    assert.equal(Object.hasOwn(body, forbidden), false);
  }
});

test("Thresher AI adapter forwards the single-tool required first round", async () => {
  let providerBody;
  const client = createThresherGroqResponsesClient({
    apiKey: API_KEY,
    reasoningEffort: "medium",
    maxOutputTokens: 1600,
    fetchImpl: async (_url, options) => {
      providerBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        status: "completed",
        output: [{
          type: "function_call",
          call_id: "call_review",
          name: "review_file",
          arguments: JSON.stringify({
            file_ref: `subject_${"a".repeat(32)}`
          })
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const reviewTool = {
    type: "function",
    name: "review_file",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    }
  };

  await client({
    ...fixedRequest(),
    tools: [reviewTool],
    tool_choice: "required"
  });

  assert.equal(providerBody.tool_choice, "required");
  assert.deepEqual(providerBody.tools, [reviewTool]);
});

test("Thresher AI adapter rejects caller-selected provider state or model", async () => {
  let fetchCount = 0;
  const client = createThresherGroqResponsesClient({
    apiKey: API_KEY,
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
  await assert.rejects(
    () => client({
      ...fixedRequest(),
      tool_choice: "required",
      tools: []
    }),
    /fixed HCN contract/
  );
  for (const tools of [null, { name: "review_file" }]) {
    await assert.rejects(
      () => client({
        ...fixedRequest(),
        tool_choice: "required",
        tools
      }),
      /fixed HCN contract/
    );
  }
  await assert.rejects(
    () => client({
      ...fixedRequest(),
      tool_choice: "none"
    }),
    /fixed HCN contract/
  );
  assert.equal(fetchCount, 0);
});

test("Thresher AI adapter rejects built-in or remote provider tools", async () => {
  let fetchCount = 0;
  const client = createThresherGroqResponsesClient({
    apiKey: API_KEY,
    reasoningEffort: "medium",
    maxOutputTokens: 1600,
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error("must not fetch");
    }
  });

  for (const tool of [
    { type: "browser_search" },
    { type: "code_interpreter" },
    { type: "mcp", server_url: "https://example.com/mcp" }
  ]) {
    await assert.rejects(
      () => client({
        ...fixedRequest(),
        tools: [tool],
        tool_choice: "auto"
      }),
      /fixed HCN contract/
    );
  }
  assert.equal(fetchCount, 0);
});

test("Thresher AI adapter exposes only a generic bounded provider error", async () => {
  const client = createThresherGroqResponsesClient({
    apiKey: API_KEY,
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
      assert.equal(error.code, "THRESHER_AI_PROVIDER_FAILED");
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
    model: THRESHER_AI_MODEL,
    instructions: "Use fresh HCN evidence.",
    input: [{ role: "user", content: "Work my files." }],
    parallel_tool_calls: false,
    store: false,
    max_output_tokens: 1600
  };
}
