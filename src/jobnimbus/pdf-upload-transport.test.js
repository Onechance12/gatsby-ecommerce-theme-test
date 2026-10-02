import assert from "node:assert/strict";
import test from "node:test";
import { createPdfUploadTransport, trustedPdfStorageUrl } from "./pdf-upload-transport.js";
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

test("provider redirects to untrusted destinations stop without a second request", async () => {
  let calls = 0;
  const transport = createPdfUploadTransport({ apiKey: "fixture-secret", fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/metadata" } });
  } });
  await assert.rejects(transport.readBytes("provider-doc-1"), /provider request failed/i);
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
  await assert.rejects(oversized.readBytes("provider-doc-1"));
  let calls = 0;
  const looping = createPdfUploadTransport({ apiKey: "fixture", fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: "https://bucket.s3.amazonaws.com/file" } });
  } });
  await assert.rejects(looping.readBytes("provider-doc-1"));
  assert.equal(calls, 4);
});

test("file reservation rejects an unsafe storage URL or missing provider ID", async () => {
  for (const data of [{ jnid: "provider-doc-1", url: "https://evil.example/upload" }, { url: "https://bucket.s3.amazonaws.com/file" }]) {
    let calls = 0;
    const transport = createPdfUploadTransport({ apiKey: "fixture", fetchImpl: async () => {
      calls++; return Response.json({ data });
    } });
    await assert.rejects(transport.reserve({ filename: "test.pdf" }));
    assert.equal(calls, 1);
  }
});
