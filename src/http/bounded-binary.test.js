import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedBinaryProviderError,
  fetchBoundedBinary
} from "./bounded-binary.js";

test("bounded binary fetch disables redirects, requests identity, and hashes exact bytes", async () => {
  const expected = Buffer.from("bounded fixture bytes", "utf8");
  const observed = [];
  const result = await fetchBoundedBinary(
    async (_url, options) => {
      observed.push(options);
      return new Response(expected, {
        headers: {
          "content-type": "application/pdf",
          "content-length": String(expected.byteLength)
        }
      });
    },
    "https://provider.example/files/fixed"
  );
  assert.deepEqual(result.bytes, expected);
  assert.equal(result.contentLength, expected.byteLength);
  assert.equal(
    result.contentSha256,
    "1076bd16a46ac9cc508087506a408d6d5a83ea1ffe629ea3462dd62371dff035"
  );
  assert.equal(observed[0].method, "GET");
  assert.equal(observed[0].redirect, "error");
  assert.equal(observed[0].headers.get("accept-encoding"), "identity");
  assert.ok(observed[0].signal instanceof AbortSignal);
});

test("bounded binary fetch rejects encoded, oversized, truncated, and empty bodies", async () => {
  const cases = [
    new Response(Buffer.from("encoded"), {
      headers: { "content-encoding": "gzip" }
    }),
    new Response(Buffer.alloc(512), {
      headers: { "content-length": "512" }
    }),
    new Response(Buffer.from("short"), {
      headers: { "content-length": "20" }
    }),
    new Response(Buffer.alloc(0))
  ];
  for (const response of cases) {
    await assert.rejects(
      fetchBoundedBinary(
        async () => response,
        "https://provider.example/files/fixed",
        {},
        { maxBytes: 256, errorCode: "FIXTURE_BINARY_FAILED" }
      ),
      (error) =>
        error instanceof BoundedBinaryProviderError
        && error.code === "FIXTURE_BINARY_FAILED"
    );
  }
});

test("bounded binary fetch cancels an oversized advertised body before reading it", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    }
  });
  await assert.rejects(
    fetchBoundedBinary(
      async () => new Response(body, {
        headers: { "content-length": "257" }
      }),
      "https://provider.example/files/fixed",
      {},
      { maxBytes: 256, errorCode: "FIXTURE_BINARY_FAILED" }
    ),
    (error) =>
      error instanceof BoundedBinaryProviderError
      && error.code === "FIXTURE_BINARY_FAILED"
  );
  assert.equal(cancelled, true);
});

test("bounded binary failures redact provider bodies and enforce the deadline", async () => {
  const secret = "PROVIDER-BODY-SECRET";
  await assert.rejects(
    fetchBoundedBinary(
      async () => new Response(secret, { status: 403 }),
      "https://provider.example/files/fixed",
      {},
      { errorCode: "FIXTURE_BINARY_FAILED" }
    ),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.doesNotMatch(String(error), /PROVIDER-BODY-SECRET/);
      return true;
    }
  );
  await assert.rejects(
    fetchBoundedBinary(
      async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      }),
      "https://provider.example/files/fixed",
      {},
      { timeoutMs: 100, errorCode: "FIXTURE_BINARY_FAILED" }
    ),
    (error) => error.statusCode === 504
  );
});
