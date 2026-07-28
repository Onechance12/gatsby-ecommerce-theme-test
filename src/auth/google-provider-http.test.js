import assert from "node:assert/strict";
import test from "node:test";

import {
  GOOGLE_PROVIDER_ENDPOINTS,
  GoogleProviderHttpError,
  fetchBoundedProviderJson,
  resolveGoogleProviderEndpoint
} from "./google-provider-http.js";

test("production provider endpoints are pinned to exact reviewed Google URLs", () => {
  for (const [kind, endpoint] of Object.entries(GOOGLE_PROVIDER_ENDPOINTS)) {
    assert.equal(resolveGoogleProviderEndpoint(kind, ""), endpoint);
    assert.equal(resolveGoogleProviderEndpoint(kind, endpoint), endpoint);
  }
  for (const endpoint of [
    "http://oauth2.googleapis.com/token",
    "https://oauth2.googleapis.com.evil.example/token",
    "https://oauth2.googleapis.com/token?next=https://evil.example",
    "https://user:pass@oauth2.googleapis.com/token",
    "https://127.0.0.1:9443/token"
  ]) {
    assert.throws(
      () => resolveGoogleProviderEndpoint("token", endpoint),
      /reviewed Google HTTPS URL|canonical URL/
    );
  }
});

test("only explicit 127.0.0.1 test endpoints can bypass provider pinning", () => {
  assert.equal(
    resolveGoogleProviderEndpoint(
      "token",
      "http://127.0.0.1:18888/token",
      { allowLoopbackForTests: true }
    ),
    "http://127.0.0.1:18888/token"
  );
  for (const endpoint of [
    "http://localhost:18888/token",
    "http://[::1]:18888/token",
    "http://10.0.0.1/token",
    "http://169.254.169.254/token"
  ]) {
    assert.throws(
      () => resolveGoogleProviderEndpoint(
        "token",
        endpoint,
        { allowLoopbackForTests: true }
      ),
      /reviewed Google HTTPS URL/
    );
  }
});

test("provider fetch disables redirects and returns only bounded JSON", async () => {
  let observed;
  const result = await fetchBoundedProviderJson(
    async (_url, options) => {
      observed = options;
      return jsonResponse({ access_token: "fixture" });
    },
    GOOGLE_PROVIDER_ENDPOINTS.token,
    { method: "POST" }
  );
  assert.equal(observed.redirect, "error");
  assert.ok(observed.signal instanceof AbortSignal);
  assert.deepEqual(result.payload, { access_token: "fixture" });
});

test("provider fetch rejects redirects, non-JSON, oversized bodies, and timeouts", async () => {
  await assert.rejects(
    fetchBoundedProviderJson(
      async () => new Response("redirect", {
        status: 302,
        headers: {
          location: "https://evil.example",
          "content-type": "text/plain"
        }
      }),
      GOOGLE_PROVIDER_ENDPOINTS.token
    ),
    GoogleProviderHttpError
  );
  await assert.rejects(
    fetchBoundedProviderJson(
      async () => new Response("not-json", {
        headers: { "content-type": "text/plain" }
      }),
      GOOGLE_PROVIDER_ENDPOINTS.token
    ),
    /unexpected response format/
  );
  await assert.rejects(
    fetchBoundedProviderJson(
      async () => jsonResponse({ value: "x".repeat(2048) }),
      GOOGLE_PROVIDER_ENDPOINTS.token,
      {},
      { maxBytes: 256 }
    ),
    /exceeded the allowed size/
  );
  await assert.rejects(
    fetchBoundedProviderJson(
      async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      }),
      GOOGLE_PROVIDER_ENDPOINTS.token,
      {},
      { timeoutMs: 100 }
    ),
    /timed out/
  );
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
