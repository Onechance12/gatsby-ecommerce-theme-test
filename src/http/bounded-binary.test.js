import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedBinaryProviderError,
  fetchBoundedBinary,
  fetchJobNimbusBinary
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

const initialUrl = "https://app.jobnimbus.com/files/synthetic-file";
const cdnUrl = "https://files.jobnimbus.com/synthetic.pdf?signature=fixture-private";

test("JobNimbus accepts one fixed CDN hop, drops credentials, and shares the deadline and budget", async () => {
  for (const status of [302, 303, 307, 308]) {
    const calls = [], bytes = Buffer.from("bounded fixture bytes");
    let consumed = 0, canceled = false;
    const result = await fetchJobNimbusBinary(async (url, options) => {
      calls.push({ url, options });
      assert.equal(consumed, calls.length, "charge immediately before each provider request");
      return calls.length === 1
        ? new Response(new ReadableStream({ cancel() { canceled = true; } }), { status, headers: { location: cdnUrl } })
        : new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    }, status === 303 ? initialUrl.replace("/files/", "/api1/files/") : initialUrl, {
      headers: { authorization: "Bearer fixture-private", cookie: "fixture-private", "x-api-key": "fixture-private" },
      referrer: "https://app.jobnimbus.com/private"
    }, { consumeRequest() { consumed++; } });
    assert.equal(calls.length, 2); assert.equal(consumed, 2); assert(canceled);
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[0].options.headers.get("authorization"), "Bearer fixture-private");
    assert.equal(calls[1].url, cdnUrl); assert.equal(calls[1].options.redirect, "error");
    assert.equal(calls[1].options.signal, calls[0].options.signal);
    assert.equal(calls[1].options.credentials, "omit");
    assert.equal(calls[1].options.referrer, undefined);
    assert.deepEqual([...calls[1].options.headers.entries()].sort(), [["accept", "application/octet-stream"], ["accept-encoding", "identity"]]);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.contentSha256, "1076bd16a46ac9cc508087506a408d6d5a83ea1ffe629ea3462dd62371dff035");
  }
});

test("JobNimbus direct bytes use one request; unsupported initial origins never receive credentials", async () => {
  let calls = 0, consumed = 0;
  const provider = async () => { calls++; return new Response("synthetic"); };
  await fetchJobNimbusBinary(provider, initialUrl, {}, { consumeRequest() { consumed++; } });
  assert.equal(calls, 1); assert.equal(consumed, 1);
  for (const url of ["https://evil.example/files/id", "https://app.jobnimbus.com:444/files/id", "http://app.jobnimbus.com/files/id", "https://user@app.jobnimbus.com/files/id", "https://app.jobnimbus.com/files/id?token=private", "https://app.jobnimbus.com/files/id#", "https://app.jobnimbus.com/other/id"]) {
    await assert.rejects(fetchJobNimbusBinary(provider, url, {}, { consumeRequest() { consumed++; } }), error => error.failureReason === "initial_target_rejected");
  }
  assert.equal(calls, 1); assert.equal(consumed, 1);
});

test("JobNimbus rejects unsupported CDN targets before a second request", async () => {
  const targets = [null, "/relative", "http://files.jobnimbus.com/a", "https://files.jobnimbus.com:444/a",
    "https://evil.example/a", "https://files.jobnimbus.com.evil.example/a", "https://sub.files.jobnimbus.com/a",
    "https://127.0.0.1/a", "https://user:private@files.jobnimbus.com/a", "https://@files.jobnimbus.com/a",
    "https://files.jobnimbus.com/a#", "https://files.jobnimbus.com/a#private", "https://%66iles.jobnimbus.com/a",
    "https://files.jobnimbus.com\\@evil.example/a"];
  for (const target of targets) {
    let calls = 0, consumed = 0, canceled = false;
    await assert.rejects(fetchJobNimbusBinary(async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), {
        status: 302, headers: target === null ? {} : { location: target }
      });
    }, initialUrl, {}, { consumeRequest() { consumed++; } }), error => {
      assert.equal(error.failureReason, "redirect_target_rejected");
      assert.doesNotMatch(JSON.stringify(error), /private|evil|jobnimbus/);
      return true;
    });
    assert.equal(calls, 1); assert.equal(consumed, 1); assert(canceled);
  }
});

test("JobNimbus rejects extra redirects and enforces both provider budget charges", async () => {
  let calls = 0, charged = 0;
  const redirect = async () => { calls++; return new Response(null, { status: 302, headers: { location: cdnUrl } }); };
  await assert.rejects(fetchJobNimbusBinary(redirect, initialUrl, {}, { consumeRequest() { charged++; } }), error => error.failureReason === "redirect_limit");
  assert.equal(calls, 2); assert.equal(charged, 2);
  for (const allowed of [0, 1]) {
    calls = 0; charged = 0;
    await assert.rejects(fetchJobNimbusBinary(redirect, initialUrl, {}, { consumeRequest() {
      if (charged >= allowed) throw new Error("fixture budget"); charged++;
    } }), error => error.failureReason === "request_budget_exceeded");
    assert.equal(calls, allowed); assert.equal(charged, allowed);
  }
  calls = 0;
  await assert.rejects(fetchJobNimbusBinary(async () => {
    calls++; return new Response(null, { status: 301, headers: { location: cdnUrl } });
  }, initialUrl, {}, { consumeRequest() {} }), error => error.failureReason === "upstream_http");
  assert.equal(calls, 1);
});

test("JobNimbus keeps body limits, encoding rejection, safe failures and a shared deadline after redirect", async () => {
  for (const [response, expected] of [
    [new Response("encoded", { headers: { "content-encoding": "gzip" } }), "encoding_rejected"],
    [new Response("short", { headers: { "content-length": "257" } }), "length_invalid"],
    [new Response("short", { headers: { "content-length": "20" } }), "length_invalid"],
    [new Response(Buffer.alloc(257)), "byte_limit"],
    [new Response("provider-private", { status: 403 }), "upstream_http"]
  ]) {
    let calls = 0;
    await assert.rejects(fetchJobNimbusBinary(async () => ++calls === 1
      ? new Response(null, { status: 302, headers: { location: cdnUrl } }) : response,
    initialUrl, {}, { maxBytes: 256, consumeRequest() {} }), error => error.failureReason === expected);
    assert.equal(calls, 2);
  }
  let calls = 0, firstSignal;
  await assert.rejects(fetchJobNimbusBinary(async (_url, options) => {
    if (++calls === 1) {
      firstSignal = options.signal;
      await new Promise(resolve => setTimeout(resolve, 40));
      return new Response(null, { status: 302, headers: { location: cdnUrl } });
    }
    assert.equal(options.signal, firstSignal);
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("provider-private")), { once: true }));
  }, initialUrl, {}, { timeoutMs: 100, consumeRequest() {} }), error => {
    assert.equal(error.failureReason, "deadline_exceeded"); assert.equal(error.statusCode, 504);
    assert.doesNotMatch(JSON.stringify(error), /provider-private|signature/); return true;
  });
  assert.equal(calls, 2);
});

test("loopback initial fixture requires explicit test mode and exact injected origin", async () => {
  const previous = process.env.NODE_ENV;
  let calls = 0;
  const provider = async () => { calls++; return new Response("synthetic"); };
  const url = "http://127.0.0.1:12345/download/synthetic";
  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(fetchJobNimbusBinary(provider, url, {}, { testInitialOrigin: "http://127.0.0.1:12345", consumeRequest() {} }));
    process.env.NODE_ENV = "test";
    await assert.rejects(fetchJobNimbusBinary(provider, url, {}, { consumeRequest() {} }));
    for (const testInitialOrigin of ["https://evil.example", "http://localhost:12345", "http://127.0.0.1:22222"]) {
      await assert.rejects(fetchJobNimbusBinary(provider, url, {}, { testInitialOrigin, consumeRequest() {} }));
    }
    assert.equal(calls, 0);
    await fetchJobNimbusBinary(provider, url, {}, { testInitialOrigin: "http://127.0.0.1:12345", consumeRequest() {} });
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
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
