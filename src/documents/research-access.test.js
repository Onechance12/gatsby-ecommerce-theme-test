import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { createDocumentResearchService, DOCUMENT_RESEARCH_ROUTES, validateResearchOriginal } from "./research-access.js";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const PDF = Buffer.from("%PDF-1.7\nsynthetic fixture only\n%%EOF\n");
const ESX_MIME = "application/vnd.xactware.esx";
function grant(overrides = {}) {
  return {
    enabled: true, grantId: "grant-fixture", companyId: "tenant-fixture",
    issuedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 86400000).toISOString(),
    limits: { pageSize: 2, maxPages: 10, maxDocuments: 20, maxOriginals: 5, maxBytesPerFile: 4096, maxTotalBytes: 16384 },
    excludedFileNumbers: ["2628"], ...overrides
  };
}
function document(id = "doc-1", overrides = {}) {
  return {
    id, companyId: "tenant-fixture", name: "carrier-estimate.pdf", mimeType: "application/pdf", size: PDF.length,
    version: "version-1", updatedAt: "2026-09-01T12:00:00Z", createdAt: "2026-08-01T12:00:00Z", fileIds: ["file-1"],
    private: false, deleted: false, permissionDenied: false, ...overrides
  };
}
function parent(overrides = {}) {
  return { id: "file-1", companyId: "tenant-fixture", number: "1234", carrier: "Synthetic Carrier", private: false, deleted: false, permissionDenied: false, ...overrides };
}
function setup({ rows = [document()], policy = grant(), methods = {}, clock = () => NOW } = {}) {
  const calls = [];
  const provider = {
    listDocuments: async ({ offset, limit }) => ({ rows: rows.slice(offset, offset + limit), total: rows.length }),
    getDocument: async (id) => rows.find((row) => row.id === id),
    getParent: async () => parent(),
    downloadDocument: async () => ({ bytes: PDF, contentType: "application/pdf", contentLength: PDF.length }),
    ...methods
  };
  for (const key of Object.keys(provider)) {
    const operation = provider[key];
    provider[key] = async (...args) => { calls.push({ key, args }); return operation(...args); };
  }
  return { service: createDocumentResearchService({ grant: policy, provider, now: clock }), calls, rows };
}
async function original(service, page) {
  return service.original({ runId: page.runId, documentId: page.documents[0].documentId, fileId: page.documents[0].fileId });
}

test("disabled service remains inert and has an exact route surface", async () => {
  const { service, calls } = setup();
  const disabled = createDocumentResearchService();
  assert.equal(disabled.session().ready, false);
  await assert.rejects(disabled.inventory({}), /disabled/);
  for (const route of DOCUMENT_RESEARCH_ROUTES) {
    const [method, path] = route.split(" ");
    assert.equal(disabled.routeAllowed(method, path), true);
  }
  for (const [method, path] of [["POST", "/ops/action-batch"], ["GET", "/jobnimbus/search"], ["POST", "/gmail/send"], ["POST", "/quo/send"], ["POST", "/claim-filing/call"], ["GET", "/document-research/session?admin=true"], ["POST", "/document-research/session"]]) {
    assert.equal(service.routeAllowed(method, path), false);
  }
  assert.deepEqual(calls, []);
});

test("grant validates lifetime, identifiers, exclusions and immutable limits", () => {
  assert.throws(() => setup({ policy: grant({ expiresAt: new Date(NOW + 8 * 86400000).toISOString() }) }), /seven days/);
  assert.throws(() => setup({ policy: grant({ companyId: "" }) }), /company id/);
  assert.throws(() => setup({ policy: grant({ limits: { maxBytesPerFile: 1000000000 } }) }), /maxBytesPerFile/);
  assert.throws(() => setup({ policy: grant({ arbitraryScope: "all" }) }), /unsupported input/);
  const policy = grant({ excludedFileNumbers: [] });
  const { service } = setup({ policy });
  policy.limits.pageSize = 999;
  const session = service.session();
  assert.equal(session.limits.pageSize, 2);
  assert.deepEqual(session.excludedFileNumbers, ["2628"]);
  assert.match(session.grant.sha256, /^[a-f0-9]{64}$/);
  session.limits.pageSize = 123;
  assert.equal(service.session().limits.pageSize, 2);
});

test("expired and future grants refuse provider dispatch", async () => {
  for (const clock of [() => NOW + 2 * 86400000, () => NOW - 86400000]) {
    const { service, calls } = setup({ clock });
    assert.equal(service.session().ready, false);
    await assert.rejects(service.inventory({}), /expired/);
    assert.deepEqual(calls, []);
  }
});

test("inventory returns minimal cumulative, paginated metadata and opaque bound cursors", async () => {
  const { service, calls } = setup({ rows: [document("a"), document("b"), document("c")] });
  const first = await service.inventory({});
  assert.equal(first.complete, false);
  assert.equal(first.stopReason, "more_pages");
  assert.match(first.nextCursor, /^[a-f0-9]{64}$/);
  assert.equal(first.documents.length, 2);
  assert.equal(first.documents[0].sourceRole, "unverified");
  assert.equal(first.snapshot.consistentSnapshot, false);
  assert.equal(first.documents[0].email, undefined);
  await assert.rejects(service.inventory({ cursor: "untrusted" }), /invalid.*cursor/);
  const last = await service.inventory({ cursor: first.nextCursor });
  assert.equal(last.runId, first.runId);
  assert.equal(last.complete, true);
  assert.equal(last.stopReason, "complete");
  assert.equal(last.nextCursor, null);
  assert.equal(last.counts.providerRows, 3);
  assert.equal(last.counts.eligible, 3);
  await assert.rejects(service.inventory({ cursor: first.nextCursor }), /consumed/);
  const fresh = await service.inventory({});
  assert.notEqual(fresh.runId, first.runId);
  assert.equal(fresh.counts.pages, 1);
  assert.equal(calls.filter((call) => call.key === "listDocuments").length, 3);
});

test("no total requires an empty page; short pages do not imply completeness", async () => {
  const { service } = setup({ methods: { listDocuments: async ({ offset }) => ({ rows: offset === 0 ? [document()] : [] }) } });
  const first = await service.inventory({});
  assert.equal(first.complete, false);
  assert.equal((await service.inventory({ cursor: first.nextCursor })).complete, true);
});

test("document and request caps return explicit partial coverage", async () => {
  for (const [limits, reason] of [[{ maxDocuments: 2 }, "document_limit"], [{ maxPages: 1 }, "page_limit"]]) {
    const { service } = setup({ rows: [document("a"), document("b"), document("c")], policy: grant({ limits: { ...grant().limits, ...limits } }) });
    const page = await service.inventory({});
    assert.equal(page.complete, false);
    assert.equal(page.nextCursor, null);
    assert.equal(page.stopReason, reason);
    assert.equal(page.declaredTotal, 3);
  }
});

test("inconsistent totals, disappearing totals, duplicates and source-version changes invalidate run", async () => {
  for (const second of [
    { rows: [document("b")], total: 4 },
    { rows: [document("b")] },
    { rows: [document("a")], total: 2 },
    { rows: [document("b")], total: 2, version: "changed" },
    { rows: [], total: 2 }
  ]) {
    const { service } = setup({ methods: { listDocuments: async ({ offset }) => offset === 0 ? { rows: [document("a")], total: 2 } : second } });
    const first = await service.inventory({});
    await assert.rejects(service.inventory({ cursor: first.nextCursor }), /total|duplicate|version/);
    await assert.rejects(original(service, first), /invalid inventory/);
  }
});

test("malformed and excessive provider pages fail closed", async () => {
  for (const page of [{ rows: null }, { rows: [document(), document("b"), document("c")] }, { rows: [document()], total: "1" }, { rows: [null] }]) {
    const { service } = setup({ methods: { listDocuments: async () => page } });
    await assert.rejects(service.inventory({}), /malformed|invalid/);
  }
});

test("unknown/private/deleted visibility, excluded file and wrong-company facts cannot export originals", async () => {
  for (const flags of [{ private: true }, { deleted: true }, { permissionDenied: true }, { private: undefined }]) {
    const { service, calls } = setup({ rows: [document("a", flags)] });
    const page = await service.inventory({});
    assert.equal(page.documents.length, 0);
    assert.equal(page.counts.excluded, 1);
    assert.equal(calls.filter((call) => call.key === "getParent").length, 0);
  }
  for (const parentOverride of [{ number: "2628" }, { private: true }, { deleted: undefined }]) {
    const { service } = setup({ methods: { getParent: async () => parent(parentOverride) } });
    assert.equal((await service.inventory({})).documents.length, 0);
  }
  for (const methods of [{ getParent: async () => parent({ companyId: "another-tenant" }) }, { listDocuments: async () => ({ rows: [document("a", { companyId: "another-tenant" })] }) }]) {
    await assert.rejects(setup({ methods }).service.inventory({}), /company/);
  }
});

test("unrelated types are counted, ambiguous bindings/purpose are not downloadable", async () => {
  const rows = [
    document("photo", { name: "roof.jpg", mimeType: "image/jpeg" }),
    document("policy", { name: "policy-estimate.pdf" }),
    document("multi", { fileIds: ["file-1", "file-2"] }),
    document("ambiguous", { name: "document.pdf" })
  ];
  const { service } = setup({ rows, policy: grant({ limits: { ...grant().limits, pageSize: 10 } }) });
  const page = await service.inventory({});
  assert.equal(page.counts.unsupported, 2);
  assert.equal(page.counts.ambiguous, 2);
  assert.equal(page.documents.length, 1);
  await assert.rejects(original(service, page), /ambiguous document/);
});

test("strict input fields and exact original identifiers reject generic access", async () => {
  const { service, calls } = setup();
  for (const input of [{ url: "https://example.invalid" }, { cursor: null }, { operatorScope: "company" }]) {
    await assert.rejects(service.inventory(input), /input|cursor/);
  }
  assert.deepEqual(calls, []);
  const page = await service.inventory({});
  for (const input of [
    { runId: page.runId, documentId: "unknown", fileId: "file-1" },
    { runId: page.runId, documentId: "doc-1", fileId: "other" },
    { runId: "other", documentId: "doc-1", fileId: "file-1" },
    { runId: page.runId, documentId: "doc-1", fileId: "file-1", url: "https://example.invalid" }
  ]) await assert.rejects(service.original(input), /bound|run|input/);
  assert.equal(calls.filter((call) => call.key === "downloadDocument").length, 0);
});

test("original returns checked bytes and immutable identity/revision/hash", async () => {
  const { service, calls } = setup();
  const page = await service.inventory({});
  const result = await original(service, page);
  assert.equal(result.documentId, "doc-1");
  assert.equal(result.revision, page.documents[0].revision);
  assert.equal(result.byteLength, PDF.length);
  assert.deepEqual(Buffer.from(result.contentBase64, "base64"), PDF);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.find((call) => call.key === "downloadDocument").args, ["doc-1", { maxBytes: 4096 }]);
});

test("changed, deleted, relinked and wrong-document originals fail before download", async () => {
  for (const changed of [{ version: "new" }, { private: true }, { deleted: true }, { fileIds: ["other"] }, { id: "different" }]) {
    const { service, calls } = setup({ methods: { getDocument: async () => document("doc-1", changed) } });
    const page = await service.inventory({});
    await assert.rejects(original(service, page), /changed|unavailable|relinked/);
    assert.equal(calls.filter((call) => call.key === "downloadDocument").length, 0);
  }
});

test("expiry during a provider read and mutation during download release no bytes", async () => {
  let clock = NOW;
  const first = setup({ clock: () => clock, methods: { getDocument: async () => { clock += 2 * 86400000; return document(); } } });
  const page = await first.service.inventory({});
  await assert.rejects(original(first.service, page), /expired/);
  let reads = 0;
  const second = setup({ methods: { getDocument: async () => document("doc-1", { version: ++reads > 1 ? "changed" : "version-1" }) } });
  await assert.rejects(original(second.service, await second.service.inventory({})), /changed during/);
});

test("length, signature and byte budgets are enforced, including provider overrun", async () => {
  for (const downloaded of [
    { bytes: Buffer.alloc(4097), contentType: "application/pdf" },
    { bytes: PDF, contentType: "text/html" },
    { bytes: PDF, contentType: "application/pdf", contentLength: PDF.length + 1 },
    { bytes: Buffer.from("not a pdf"), contentType: "application/pdf" }
  ]) {
    const { service } = setup({ methods: { downloadDocument: async () => downloaded } });
    await assert.rejects(original(service, await service.inventory({})), /byte|signature/);
  }
  const { service } = setup({ policy: grant({ limits: { ...grant().limits, maxOriginals: 1 } }) });
  const page = await service.inventory({});
  await original(service, page);
  await assert.rejects(original(service, page), /budget exhausted/);
});

test("operations are serialized while a fresh inventory may replace the active run", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = setup({ methods: { listDocuments: async () => { await gate; return { rows: [], total: 0 }; } } });
  const first = service.inventory({});
  await assert.rejects(service.inventory({}), /in progress/);
  release();
  const previous = await first;
  const next = await service.inventory({});
  assert.notEqual(next.runId, previous.runId);
  assert.equal(next.counts.pages, 1);
});

test("a fresh run invalidates old cursors/original bindings and freshly reads its own original", async () => {
  const { service, calls } = setup({ rows: [document("a"), document("b"), document("c")] });
  const first = await service.inventory({});
  const next = await service.inventory({});
  assert.notEqual(next.runId, first.runId);
  assert.notEqual(next.nextCursor, first.nextCursor);
  const before = calls.length;
  await assert.rejects(service.inventory({ cursor: first.nextCursor }), /invalid.*cursor/);
  await assert.rejects(original(service, first), /invalid inventory run/);
  assert.equal(calls.length, before);
  const result = await original(service, next);
  assert.equal(result.runId, next.runId);
  assert.equal(result.documentId, "a");
  assert.equal(calls.filter(call => call.key === "getDocument").length, 2);
  assert.equal(calls.filter(call => call.key === "downloadDocument").length, 1);
});

test("fresh inventories cannot reset cumulative page quota, including empty completed runs", async () => {
  const { service, calls } = setup({ rows: [], policy: grant({ limits: { ...grant().limits, maxPages: 2 } }) });
  for (let i = 0; i < 2; i++) {
    const page = await service.inventory({});
    assert.equal(page.complete, true);
    assert.equal(page.counts.pages, 1);
  }
  const before = calls.length;
  await assert.rejects(service.inventory({}), /inventory page budget exhausted/);
  assert.equal(calls.length, before);
  assert.equal(calls.filter(call => call.key === "listDocuments").length, 2);
});

test("fresh inventories cannot reset cumulative row quota and shrink the final request", async () => {
  const { service, calls } = setup({ rows: [document("a"), document("b"), document("c")],
    policy: grant({ limits: { ...grant().limits, maxDocuments: 3 } }) });
  const first = await service.inventory({});
  assert.equal(first.counts.providerRows, 2);
  assert.equal(first.stopReason, "more_pages");
  const next = await service.inventory({});
  assert.equal(next.counts.providerRows, 1);
  assert.equal(next.counts.pages, 1);
  assert.equal(next.complete, false);
  assert.equal(next.stopReason, "document_limit");
  assert.equal(next.nextCursor, null);
  assert.deepEqual(calls.filter(call => call.key === "listDocuments").map(call => call.args[0]), [{ offset: 0, limit: 2 }, { offset: 0, limit: 1 }]);
  const before = calls.length;
  await assert.rejects(service.inventory({}), /inventory document budget exhausted/);
  assert.equal(calls.length, before);
});

test("provider page failures reserve process page/row budgets across fresh runs", async () => {
  const { service, calls } = setup({ policy: grant({ limits: { ...grant().limits, maxDocuments: 4 } }),
    methods: { listDocuments: async () => { throw new Error("synthetic unavailable"); } } });
  for (let i = 0; i < 2; i++) {
    const page = await service.inventory({});
    assert.equal(page.stopReason, "provider_unavailable");
    assert.equal(page.counts.pages, 0);
    assert.equal(page.counts.providerRows, 0);
  }
  await assert.rejects(service.inventory({}), /inventory document budget exhausted/);
  assert.equal(calls.filter(call => call.key === "listDocuments").length, 2);
});

test("received but excluded or unreviewed rows still consume the process inventory budget", async () => {
  for (const methods of [{}, { getParent: async () => { throw new Error("synthetic parent unavailable"); } }]) {
    const { service, calls } = setup({
      rows: [document("a", Object.keys(methods).length ? {} : { private: true }), document("b", { private: true })],
      policy: grant({ limits: { ...grant().limits, maxDocuments: 2 } }), methods
    });
    const result = await service.inventory({});
    assert.equal(result.documents.length, 0);
    if (Object.keys(methods).length) {
      assert.equal(result.counts.unreviewed, 1);
      assert.equal(result.counts.providerRows, 1);
    } else assert.equal(result.counts.excluded, 2);
    const before = calls.length;
    await assert.rejects(service.inventory({}), /inventory document budget exhausted/);
    assert.equal(calls.length, before);
  }
});

test("fresh inventories preserve original attempt and byte quotas", async () => {
  for (const limits of [{ maxOriginals: 1 }, { maxTotalBytes: PDF.length, maxBytesPerFile: PDF.length }]) {
    const { service, calls } = setup({ policy: grant({ limits: { ...grant().limits, ...limits } }) });
    await original(service, await service.inventory({}));
    const next = await service.inventory({});
    const before = calls.length;
    await assert.rejects(original(service, next), /original retrieval budget exhausted/);
    assert.equal(calls.length, before);
    assert.equal(calls.filter(call => call.key === "downloadDocument").length, 1);
  }
});

test("provider failures preserve partial inventory counts and invalidate retrieval", async () => {
  const { service } = setup({ methods: {
    listDocuments: async ({ offset }) => {
      if (offset) throw new Error("provider failure with private content that must not escape");
      return { rows: [document()], total: 2 };
    }
  } });
  const first = await service.inventory({});
  const partial = await service.inventory({ cursor: first.nextCursor });
  assert.equal(partial.complete, false);
  assert.equal(partial.stopReason, "provider_unavailable");
  assert.equal(partial.nextCursor, null);
  assert.equal(partial.counts.eligible, 1);
  assert.equal(JSON.stringify(partial).includes("private content"), false);
  await assert.rejects(original(service, first), /invalid inventory/);
  const parentFailure = setup({ methods: { getParent: async () => { throw new Error("unavailable"); } } });
  const failedParentPage = await parentFailure.service.inventory({});
  assert.equal(failedParentPage.counts.uniqueDocuments, 1);
  assert.equal(failedParentPage.counts.unreviewed, 1);
  assert.equal(failedParentPage.counts.ambiguous, 0);
  assert.equal(failedParentPage.documents.length, 0);
});

test("rate limiting preserves only safe retry metadata and performs no retry", async () => {
  const { service, calls } = setup({ methods: { listDocuments: async () => {
    throw Object.assign(new Error("sensitive upstream response"), { statusCode: 429, retryAfterSeconds: 60, providerUrl: "secret" });
  } } });
  const page = await service.inventory({});
  assert.deepEqual(page.error, { code: "provider_unavailable", status: 429, retryAfterSeconds: 60 });
  assert.equal(page.complete, false);
  assert.equal(calls.length, 1);
});

test("interrupted downloads consume reserved volume and cannot evade total budget", async () => {
  const { service, calls } = setup({
    policy: grant({ limits: { ...grant().limits, maxBytesPerFile: 4096, maxTotalBytes: 4096 } }),
    methods: { downloadDocument: async () => { throw new Error("stream interrupted"); } }
  });
  const page = await service.inventory({});
  await assert.rejects(original(service, page), /provider is unavailable/);
  await assert.rejects(original(service, page), /budget exhausted/);
  assert.equal(calls.filter((call) => call.key === "downloadDocument").length, 1);
});

test("parent exclusion or privacy changes during download release no original", async () => {
  for (const changed of [{ number: "2628" }, { private: true }, { deleted: true }]) {
    let downloaded = false;
    const { service } = setup({ methods: {
      getParent: async () => parent(downloaded ? changed : {}),
      downloadDocument: async () => { downloaded = true; return { bytes: PDF, contentType: "application/pdf" }; }
    } });
    await assert.rejects(original(service, await service.inventory({})), /parent changed/);
  }
});

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip({ name = "estimate.xml", content = Buffer.from("<XactimateDoc/>") , compressed = false, flags = 0 } = {}) {
  const filename = Buffer.from(name), packed = compressed ? deflateRawSync(content) : content;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(compressed ? 8 : 0, 8);
  local.writeUInt32LE(crc(content), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(compressed ? 8 : 0, 10);
  central.writeUInt32LE(crc(content), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + packed.length, 16);
  return Buffer.concat([local, filename, packed, central, filename, end]);
}
test("ESX internal provenance and validated stored/deflated XML originals", async () => {
  for (const compressed of [false, true]) {
    const bytes = zip({ compressed });
    validateResearchOriginal(bytes, ESX_MIME, "application/octet-stream");
    const row = document("esx", { name: "estimate.esx", mimeType: "application/octet-stream", size: bytes.length });
    const { service } = setup({ rows: [row], methods: { downloadDocument: async () => ({ bytes, contentType: "application/zip" }) } });
    const page = await service.inventory({});
    assert.equal(page.documents[0].sourceRole, "internal");
    assert.equal(page.documents[0].sourceRoleEvidence, "owner_confirmed");
    assert.equal((await original(service, page)).mimeType, ESX_MIME);
  }
});

test("ESX refuses traversal, encryption, entities, unsafe containers and bombs", () => {
  for (const bytes of [
    zip({ name: "../estimate.xml" }), zip({ name: "/estimate.xml" }), zip({ name: "C:\\estimate.xml" }),
    zip({ flags: 1 }), zip({ name: "readme.txt" }),
    zip({ content: Buffer.from('<!DOCTYPE x [<!ENTITY x SYSTEM "https://example.invalid/">]><x/>') }),
    zip({ content: Buffer.from('<!DOCTYPE x><x/>', "utf16le") }),
    zip({ compressed: true, content: Buffer.alloc(2 * 1024 * 1024, 65) }),
    Buffer.from("not a zip")
  ]) assert.throws(() => validateResearchOriginal(bytes, ESX_MIME, "application/zip"), /unsafe ESX/);
  const badCrc = zip(); badCrc[30 + "estimate.xml".length] ^= 1;
  assert.throws(() => validateResearchOriginal(badCrc, ESX_MIME, "application/zip"), /unsafe ESX/);
  const badSize = zip(); badSize.writeUInt32LE(0xffffffff, 22);
  assert.throws(() => validateResearchOriginal(badSize, ESX_MIME, "application/zip"), /unsafe ESX/);
});

test("HTML-as-PDF, unsupported MIME and missing EOF are rejected", () => {
  for (const [bytes, mime, actual] of [
    [Buffer.from("<html>error</html>"), "application/pdf", "application/pdf"],
    [Buffer.from("%PDF-1.7\ntruncated"), "application/pdf", "application/pdf"],
    [PDF, "application/pdf", "application/octet-stream"],
    [zip(), ESX_MIME, "text/html"]
  ]) assert.throws(() => validateResearchOriginal(bytes, mime, actual), /signature|content type/);
});
