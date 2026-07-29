import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedJsonProviderError,
  fetchBoundedJson
} from "./bounded-json.js";

test("bounded provider JSON disables redirects and accepts objects or arrays", async () => {
  const observed = [];
  const object = await fetchBoundedJson(
    async (_url, options) => {
      observed.push(options);
      return jsonResponse({ ok: true });
    },
    "https://provider.example/object"
  );
  const array = await fetchBoundedJson(
    async () => jsonResponse([{ id: "one" }]),
    "https://provider.example/array"
  );

  assert.deepEqual(object, { ok: true });
  assert.deepEqual(array, [{ id: "one" }]);
  assert.equal(observed[0].redirect, "error");
  assert.ok(observed[0].signal instanceof AbortSignal);
});

test("provider failures expose only a stable code and status", async () => {
  const secret = "provider-secret-body-must-not-leak";
  await assert.rejects(
    fetchBoundedJson(
      async () => new Response(secret, {
        status: 403,
        headers: { "content-type": "text/plain" }
      }),
      "https://provider.example/failure",
      {},
      { errorCode: "FIXTURE_PROVIDER_FAILED" }
    ),
    (error) => {
      assert.ok(error instanceof BoundedJsonProviderError);
      assert.equal(error.code, "FIXTURE_PROVIDER_FAILED");
      assert.equal(error.statusCode, 403);
      assert.doesNotMatch(error.message, /secret|provider-secret-body/i);
      assert.doesNotMatch(JSON.stringify(error), /provider-secret-body/i);
      return true;
    }
  );
});

test("non-JSON, invalid JSON, oversized bodies, and scalar JSON fail closed", async () => {
  for (const response of [
    new Response("not json", {
      headers: { "content-type": "text/plain" }
    }),
    new Response("{", {
      headers: { "content-type": "application/json" }
    }),
    jsonResponse("scalar"),
    jsonResponse({ value: "x".repeat(2048) })
  ]) {
    await assert.rejects(
      fetchBoundedJson(
        async () => response,
        "https://provider.example/invalid",
        {},
        {
          maxBytes: 256,
          errorCode: "FIXTURE_PROVIDER_FAILED"
        }
      ),
      (error) =>
        error instanceof BoundedJsonProviderError
        && error.code === "FIXTURE_PROVIDER_FAILED"
    );
  }
});

test("provider requests have a bounded deadline", async () => {
  await assert.rejects(
    fetchBoundedJson(
      async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true }
          );
        }),
      "https://provider.example/slow",
      {},
      {
        timeoutMs: 100,
        errorCode: "FIXTURE_PROVIDER_FAILED"
      }
    ),
    (error) =>
      error instanceof BoundedJsonProviderError
      && error.code === "FIXTURE_PROVIDER_FAILED"
      && error.statusCode === 504
  );
});

test("HTTP, redirect, oversize, and timeout failures redact provider details", async () => {
  const secret = "SECRET-ADVERSARIAL-PROVIDER-DETAIL";
  const cases = [
    {
      name: "HTTP",
      expectedStatus: 404,
      run: () =>
        fetchBoundedJson(
          async () =>
            new Response(JSON.stringify({ error: secret }), {
              status: 404,
              headers: { "content-type": "application/json" }
            }),
          "https://provider.example/http-secret",
          {},
          { errorCode: "ADVERSARIAL_PROVIDER_FAILED" }
        )
    },
    {
      name: "redirect",
      expectedStatus: 502,
      run: () =>
        fetchBoundedJson(
          async (_url, options) => {
            assert.equal(options.redirect, "error");
            throw new TypeError(`redirect rejected: ${secret}`);
          },
          "https://provider.example/redirect-secret",
          {},
          { errorCode: "ADVERSARIAL_PROVIDER_FAILED" }
        )
    },
    {
      name: "oversize",
      expectedStatus: 502,
      run: () =>
        fetchBoundedJson(
          async () => jsonResponse({ secret, padding: "x".repeat(2048) }),
          "https://provider.example/oversize-secret",
          {},
          {
            maxBytes: 256,
            errorCode: "ADVERSARIAL_PROVIDER_FAILED"
          }
        )
    },
    {
      name: "timeout",
      expectedStatus: 504,
      run: () =>
        fetchBoundedJson(
          async (_url, { signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error(`abort detail: ${secret}`)),
                { once: true }
              );
            }),
          "https://provider.example/timeout-secret",
          {},
          {
            timeoutMs: 100,
            errorCode: "ADVERSARIAL_PROVIDER_FAILED"
          }
        )
    }
  ];

  for (const scenario of cases) {
    await assert.rejects(
      scenario.run(),
      (error) => {
        assert.ok(
          error instanceof BoundedJsonProviderError,
          `${scenario.name} must use the bounded provider error`
        );
        assert.equal(error.code, "ADVERSARIAL_PROVIDER_FAILED");
        assert.equal(error.statusCode, scenario.expectedStatus);
        assert.equal(error.message, "Provider request failed.");
        assert.doesNotMatch(String(error), /SECRET-ADVERSARIAL/i);
        assert.doesNotMatch(JSON.stringify(error), /SECRET-ADVERSARIAL/i);
        return true;
      }
    );
  }
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
