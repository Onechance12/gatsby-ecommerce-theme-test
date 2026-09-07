import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentResearchProvider } from "./research-provider.js";

const doc = {
  jnid: "doc-1", customer: "tenant", filename: "Estimate.pdf", content_type: "application/pdf",
  size: 20, date_updated: 123, is_private: false, is_active: true, is_archived: false,
  related: [{ id: "file-1", type: "contact", name: "DO NOT EXPORT" }],
  created_by_name: "DO NOT EXPORT", owners: ["DO NOT EXPORT"]
};
const json = (value, options = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...options });

test("research provider is fixed GET-only, minimal and explicitly tenant-bound", async () => {
  const calls = [];
  const p = createDocumentResearchProvider({ apiKey: "fixture-only", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json(url.includes("/contacts/")
      ? { ...doc, jnid: "file-1", number: 2000, email: "private@example.test", cf_string_1: "Carrier" }
      : url.includes("?") ? { files: [doc], total: 1 } : doc);
  } });
  const page = await p.listDocuments({ offset: 0, limit: 10 });
  assert.equal(page.rows[0].companyId, "tenant");
  assert.deepEqual(page.rows[0].fileIds, ["file-1"]);
  assert.equal(page.total, 1);
  assert.equal((await p.getDocument("doc-1")).id, "doc-1");
  const parent = await p.getParent("file-1");
  assert.equal(parent.number, "2000");
  assert.equal(parent.carrier, "Carrier");
  assert.doesNotMatch(JSON.stringify({ page, parent }), /DO NOT EXPORT|private@example/);
  for (const { url, options } of calls) {
    assert.ok(url.startsWith("https://app.jobnimbus.com/api1/"));
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.body, undefined);
    assert.ok(options.signal);
  }
});

test("research provider never infers tenant/visibility and preserves ambiguous relationships", async () => {
  const p = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async () => json({ ...doc, customer: null,
    is_private: undefined, related: [...doc.related, { id: "job-2", type: "job" }] }) });
  const value = await p.getDocument("doc-1");
  assert.equal(value.companyId, "");
  assert.equal(value.private, true);
  assert.deepEqual(value.fileIds, ["file-1", ""]);
});

test("primary and related contact bindings cannot conceal a second file", async () => {
  for (const [primary, expected] of [[{ id: "file-2", type: "contact" }, ["file-1", "file-2"]],
    [{ id: "job-2", type: "job" }, ["file-1", ""]]]) {
    const p = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async () => json({ ...doc, primary }) });
    assert.deepEqual((await p.getDocument("doc-1")).fileIds, expected);
  }
});

test("research provider rejects arbitrary endpoints, missing credentials and arbitrary IDs before dispatch", async () => {
  for (const apiBase of ["https://evil.example/api", "https://app.jobnimbus.com/api1/", "http://127.0.0.1:12/api", "https://app.jobnimbus.com/api1?token=x"]) {
    assert.throws(() => createDocumentResearchProvider({ apiKey: "fixture", apiBase }));
  }
  assert.throws(() => createDocumentResearchProvider({ apiKey: "" }));
  let count = 0;
  const p = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async () => { count++; throw new Error("NO"); } });
  for (const id of ["../files", "https://evil.test", "id?query", "", " a "]) await assert.rejects(p.getDocument(id));
  for (const args of [{ offset: -1, limit: 1 }, { offset: 10000, limit: 1 }, { offset: 9999, limit: 2 }, { offset: 0, limit: 501 }]) {
    await assert.rejects(p.listDocuments(args));
  }
  assert.equal(count, 0);
});

test("research provider rejects ambiguous envelopes, bad totals, oversized pages and wrong IDs", async () => {
  for (const payload of [{ files: [], data: [] }, { files: [doc], total: "1" }, { files: [doc, doc], total: 2 }, { files: null }, { files: [], total: -1 }]) {
    const p = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async () => json(payload) });
    await assert.rejects(p.listDocuments({ offset: 0, limit: 1 }));
  }
  const p = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async () => json(doc) });
  await assert.rejects(p.getDocument("different"));
});

test("research downloads are bounded while streaming and do not follow redirects", async () => {
  const buffer = Buffer.from("%PDF-1.7\nsynthetic\n%%EOF");
  let count = 0;
  const p = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async (url, options) => {
    count++;
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "GET");
    assert.equal(url, "https://app.jobnimbus.com/files/doc-1");
    return new Response(buffer, { headers: { "content-type": "application/pdf", "content-length": String(buffer.length) } });
  } });
  assert.deepEqual((await p.downloadDocument("doc-1", { maxBytes: 100 })).bytes, buffer);
  await assert.rejects(p.downloadDocument("doc-1", { maxBytes: 10 }), /size/);
  for (const [body, headers] of [[buffer, {}], [buffer, { "content-length": "1" }], ["", {}]]) {
    const limited = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async () => new Response(body, { headers }) });
    await assert.rejects(limited.downloadDocument("doc-1", { maxBytes: 10 }));
  }
  const redirect = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }) });
  await assert.rejects(redirect.downloadDocument("doc-1", { maxBytes: 100 }));
  assert.equal(count, 2);
});

test("research provider honors Retry-After without another provider dispatch or response disclosure", async () => {
  let count = 0;
  const p = createDocumentResearchProvider({ apiKey: "fixture", fetchImpl: async () => {
    count++; return new Response("secret provider content", { status: 429, headers: { "retry-after": "60" } });
  } });
  await assert.rejects(p.listDocuments({ offset: 0, limit: 1 }), (e) => !e.message.includes("secret"));
  await assert.rejects(p.listDocuments({ offset: 0, limit: 1 }));
  assert.equal(count, 1);
});
