import assert from "node:assert/strict";
import test from "node:test";
import { createPdfUploadTransport, trustedPdfStorageUrl, pdfStorageUrlPolicy, PdfProviderError } from "./pdf-upload-transport.js";
import { PDF_MAX_BYTES } from "../../integrations/jobnimbus-operator/mcp/pdf-upload-contract.mjs";

test("upload transport permits only HTTPS provider/storage URLs and no embedded credentials", () => {
  for (const url of ["https://bucket.s3.amazonaws.com/file", "https://bucket.s3.us-west-2.amazonaws.com/file", "https://s3-us-west-2.amazonaws.com/bucket/file", "https://app.jobnimbus.com/files/id"]) {
    assert.equal(trustedPdfStorageUrl(url), true, url);
  }
  for (const url of ["http://app.jobnimbus.com/file", "http://127.0.0.1:1234/file", "https://localhost/file", "https://app.jobnimbus.com.evil.example/file",
    "file:///etc/passwd", "https://user:password@bucket.s3.amazonaws.com/key", "https://bucket.s3.amazonaws.com:8443/file", "https://example.com/file"]) {
    assert.equal(trustedPdfStorageUrl(url), false, url);
  }
  assert.throws(() => createPdfUploadTransport({ apiKey: "fixture", fileBase: "https://bucket.s3.amazonaws.com" }));
  assert.throws(() => createPdfUploadTransport({ apiKey: "fixture", fileApiBase: "https://app.jobnimbus.com" }));
});

test("the exact files host is allowed for reads only, with unchanged URL restrictions", () => {
  const url = "https://files.jobnimbus.com/file?signature=fixture-secret";
  assert.equal(pdfStorageUrlPolicy(url, { operation: "read" }).allowed, true);
  assert.equal(pdfStorageUrlPolicy(url, { operation: "read" }).hostCategory, "jobnimbus_files");
  for (const operation of [undefined, "put", "reserve", "complete", "GET"]) {
    assert.equal(pdfStorageUrlPolicy(url, { operation }).allowed, false, String(operation));
    assert.equal(trustedPdfStorageUrl(url, { operation }), false, String(operation));
  }
  for (const rejected of [
    "http://files.jobnimbus.com/file", "https://files.jobnimbus.com:8443/file",
    "https://user:secret@files.jobnimbus.com/file", "https://files.jobnimbus.com/file#fragment",
    "https://files.jobnimbus.com.evil.example/file", "https://other.files.jobnimbus.com/file",
    "https://api3.jobnimbus.com/file", "https://other.jobnimbus.com/file"
  ]) assert.equal(pdfStorageUrlPolicy(rejected, { operation: "read" }).allowed, false, rejected);
});

test("PDF reads follow the exact files host without forwarding or restoring credentials", async () => {
  const calls = [];
  const targets = ["https://files.jobnimbus.com/file?signature=fixture-secret", "/file?signature=next", "https://bucket.s3.amazonaws.com/file"];
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length <= targets.length
      ? new Response(null, { status: 302, headers: { location: targets[calls.length - 1] } })
      : new Response("verified bytes");
  } });
  assert.equal((await transport.readBytes("provider-doc-1")).toString(), "verified bytes");
  assert.deepEqual(calls.map(({ options }) => options.headers.authorization), ["Bearer fixture-secret", undefined, undefined, undefined]);
  assert.ok(calls.every(({ options }) => options.method === "GET" && options.redirect === "manual"));
});

test("files-host PUTs fail before any request and cannot be accepted from a reservation", async () => {
  let calls = 0;
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async () => {
    calls++;
    return Response.json({ data: { jnid: "provider-doc-1", url: "https://files.jobnimbus.com/upload" } });
  } });
  await assert.rejects(transport.put("https://files.jobnimbus.com/upload", Buffer.from("pdf")), safeFailure("untrusted_destination", { operation: "put" }));
  assert.equal(calls, 0);
  await assert.rejects(transport.reserve({ filename: "test.pdf" }), safeFailure("invalid_reservation", { operation: "reserve" }));
  assert.equal(calls, 1);
});

test("a permitted files-host read cannot redirect to a new untrusted host", async () => {
  let calls = 0;
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: calls === 1
      ? "https://files.jobnimbus.com/file?signature=fixture-secret" : "https://hostile.example/private" } });
  } });
  await assert.rejects(transport.readBytes("provider-doc-1"), safeFailure("untrusted_destination", { operation: "read", hop: 2, urlRejection: "disallowed_hostname" }));
  assert.equal(calls, 2);
});

test("files-host reads retain byte limits and safe HTTP failure diagnostics", async () => {
  for (const oversized of [false, true]) {
    let calls = 0;
    const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: "https://files.jobnimbus.com/private?signature=fixture-secret" } });
      return oversized ? new Response(Buffer.alloc(PDF_MAX_BYTES + 1)) : new Response("hostile private body", { status: 403 });
    } });
    await assert.rejects(transport.readBytes("provider-doc-1"), safeFailure(oversized ? "body_too_large" : "http_status", {
      operation: "read", destination: "storage", hop: 1, ...(oversized ? {} : { upstreamStatus: 403 })
    }));
    assert.equal(calls, 2);
  }
});

test("authenticated PDF download follows bounded safe redirects without forwarding bearer", async () => {
  const calls = [];
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://bucket.s3.amazonaws.com/file?signature=fixture" } })
      : new Response("expected bytes");
  } });
  assert.equal((await transport.readBytes("provider-doc-1")).toString(), "expected bytes");
  assert.equal(calls[0].options.headers.authorization, "Bearer fixture-secret");
  assert.deepEqual(calls[1].options.headers, {});
  assert.ok(calls.every((call) => call.options.redirect === "manual"));
});

test("same-origin JobNimbus redirects retain authentication until the storage hop", async () => {
  const calls = [];
  const targets = ["/files/provider-doc-1?download=1", "https://bucket.s3.amazonaws.com/file?signature=private", "/file?signature=next"];
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (calls.length <= targets.length) return new Response(null, { status: 302, headers: { location: targets[calls.length - 1] } });
    return new Response("verified bytes");
  } });
  assert.equal((await transport.readBytes("provider-doc-1")).toString(), "verified bytes");
  assert.deepEqual(calls.map(({ options }) => options.headers.authorization), ["Bearer fixture-secret", "Bearer fixture-secret", undefined, undefined]);
});

test("cross-origin JobNimbus and storage round-trips never restore stripped credentials", async () => {
  for (const target of ["https://api.jobnimbus.com/files/id", "https://bucket.s3.amazonaws.com/file", "https://files.jobnimbus.com/file"]) {
    const calls = [];
    const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const location = [target, "https://app.jobnimbus.com/files/id", "/files/id?download=1"][calls.length - 1];
      return location ? new Response(null, { status: 307, headers: { location } }) : new Response("bytes");
    } });
    await transport.readBytes("provider-doc-1");
    assert.deepEqual(calls.map(({ options }) => options.headers.authorization), ["Bearer fixture-secret", undefined, undefined, undefined]);
  }
});

const safeFailure = (reason, expected = {}) => (error) => {
  assert.ok(error instanceof PdfProviderError);
  assert.equal(error.statusCode, 409);
  assert.equal(error.diagnostic.reason, reason);
  for (const [key, value] of Object.entries(expected)) assert.equal(error.diagnostic[key], value);
  for (const secret of ["fixture-secret", "private", "signature", "amazonaws", "https://", "Bearer", "hostile"]) {
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.message.includes(secret), false);
  }
  return true;
};

test("HTTP failures preserve only safe status, hop and destination diagnostics", async () => {
  let calls = 0;
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 302, headers: { location: "https://bucket.s3.amazonaws.com/private?signature=fixture-secret" } })
      : new Response("hostile private provider body Bearer fixture-secret", { status: 403 });
  } });
  await assert.rejects(transport.readBytes("provider-doc-1"), safeFailure("http_status", { upstreamStatus: 403, hop: 1, destination: "storage", operation: "read" }));
  assert.equal(calls, 2);
});

test("network, abort and streaming failures never echo raw exceptions", async () => {
  for (const [reason, fetchImpl] of [
    ["network_failure", async () => { throw new Error("hostile private https://secret?signature=fixture-secret"); }],
    ["timeout", async () => { throw new DOMException("private fixture-secret", "AbortError"); }],
    ["read_failure", async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private fixture-secret")); } }))]
  ]) {
    const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl });
    await assert.rejects(transport.readBytes("provider-doc-1"), safeFailure(reason, { hop: 0, destination: "jobnimbus" }));
  }
});

test("missing or malformed redirect locations, bodies and invalid IDs fail closed", async () => {
  for (const headers of [{}, { location: "https://[hostile private" }]) {
    const transport = createPdfUploadTransport({ apiKey: "fixture", fetchImpl: async () => new Response(null, { status: 302, headers }) });
    await assert.rejects(transport.readBytes("provider-doc-1"), safeFailure("invalid_redirect"));
  }
  const transport = createPdfUploadTransport({ apiKey: "fixture", fetchImpl: async () => new Response(null) });
  await assert.rejects(transport.readBytes("provider-doc-1"), safeFailure("missing_body"));
  assert.throws(() => transport.readBytes("../private?signature=fixture-secret"), safeFailure("invalid_provider_id"));
  assert.throws(() => transport.complete("../private"), safeFailure("invalid_provider_id", { operation: "complete" }));
});

test("PUT redirects are rejected with no follow-up request", async () => {
  for (const location of ["https://app.jobnimbus.com/files/private", "https://files.jobnimbus.com/private"]) {
    let calls = 0;
    const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 307, headers: { location } });
    } });
    await assert.rejects(transport.put("https://bucket.s3.amazonaws.com/file", Buffer.from("pdf")), safeFailure("redirect_not_allowed", { operation: "put", destination: "storage" }));
    assert.equal(calls, 1);
  }
});

test("diagnostic construction cannot emit unreviewed strings or unsafe numbers", () => {
  const error = new PdfProviderError("private fixture-secret", { operation: "hostile", destination: "https://private", hop: Infinity, upstreamStatus: "private" });
  safeFailure("network_failure")(error);
  assert.deepEqual(error.diagnostic, { reason: "network_failure", operation: "read", destination: "untrusted" });
  assert.equal(Object.isFrozen(error.diagnostic), true);
});

test("destination diagnosis separates URL causes and known host families without expanding trust", () => {
  for (const [url, reason, category] of [
    ["not a URL", "malformed_url", undefined],
    ["https://private:fixture-secret@app.jobnimbus.com/file", "embedded_credentials", "jobnimbus_app"],
    ["https://app.jobnimbus.com/file#private", "fragment", "jobnimbus_app"],
    ["http://app.jobnimbus.com/file", "insecure_protocol", "jobnimbus_app"],
    ["https://app.jobnimbus.com:8443/file", "non_default_port", "jobnimbus_app"],
    ["https://api3.jobnimbus.com/file", "disallowed_hostname", "jobnimbus_api3"],
    ["https://files.jobnimbus.com/file", "disallowed_hostname", "jobnimbus_files"],
    ["https://bucket.s3.dualstack.us-east-1.amazonaws.com/private?signature=fixture-secret", "disallowed_hostname", "s3_dualstack"],
    ["https://distribution.cloudfront.net/private?signature=fixture-secret", "disallowed_hostname", "cloudfront"],
    ["https://private.evil.example/file", "disallowed_hostname", "other"]
  ]) {
    const policy = pdfStorageUrlPolicy(url);
    assert.equal(policy.allowed, false);
    assert.equal(policy.urlRejection, reason);
    assert.equal(policy.hostCategory, category);
    assert.equal(trustedPdfStorageUrl(url), false);
    for (const secret of ["fixture-secret", "private", "signature", "evil.example", "https://"]) assert.equal(JSON.stringify(policy).includes(secret), false);
  }
  assert.equal(pdfStorageUrlPolicy("https://app.jobnimbus.com/one?token=first").hostFingerprint,
    pdfStorageUrlPolicy("https://app.jobnimbus.com/two?token=second").hostFingerprint);
});

test("blocked redirect diagnostics preserve the specific cause without requesting the rejected destination", async () => {
  let calls = 0;
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://bucket.s3.dualstack.us-east-1.amazonaws.com/private?signature=fixture-secret" } });
  } });
  await assert.rejects(transport.readBytes("provider-doc-1"), safeFailure("untrusted_destination", {
    urlRejection: "disallowed_hostname", hostCategory: "s3_dualstack", hop: 1
  }));
  assert.equal(calls, 1);
});

test("provider redirects to untrusted destinations stop without a second request", async () => {
  let calls = 0;
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/metadata" } });
  } });
  await assert.rejects(transport.readBytes("provider-doc-1"), safeFailure("untrusted_destination", { destination: "untrusted", hop: 1 }));
  assert.equal(calls, 1);
});

test("PUT never redirects or leaks the provider credential; errors never echo provider bodies", async () => {
  const calls = [];
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response("private provider body secret", { status: 403 });
  } });
  await assert.rejects(transport.put("https://bucket.s3.amazonaws.com/file", Buffer.from("pdf")), (error) => {
    assert.equal(error.message.includes("secret"), false); return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, undefined);
});

test("read limits and redirect limits stop with no retry", async () => {
  const oversized = createPdfUploadTransport({ apiKey: "fixture", fetchImpl: async () => new Response(Buffer.alloc(PDF_MAX_BYTES + 1)) });
  await assert.rejects(oversized.readBytes("provider-doc-1"), safeFailure("body_too_large"));
  let calls = 0;
  const looping = createPdfUploadTransport({ apiKey: "fixture", fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: "https://bucket.s3.amazonaws.com/file" } });
  } });
  await assert.rejects(looping.readBytes("provider-doc-1"), safeFailure("redirect_limit", { hop: 3 }));
  assert.equal(calls, 4);
});

test("file reservation rejects an unsafe storage URL or missing provider ID", async () => {
  for (const data of [{ jnid: "provider-doc-1", url: "https://evil.example/upload" }, { url: "https://bucket.s3.amazonaws.com/file" }]) {
    let calls = 0;
    const transport = createPdfUploadTransport({ apiKey: "fixture", fetchImpl: async () => {
      calls++; return Response.json({ data });
    } });
    await assert.rejects(transport.reserve({ filename: "test.pdf" }), safeFailure("invalid_reservation", { operation: "reserve" }));
    assert.equal(calls, 1);
  }
});
