import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createResearchCoordinator, loadResearchPin, RESEARCH_ROUTES, validateResearchPin } from "./research-coordinator.mjs";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => structuredClone(value);

function pin() {
  return {
    companyId: "synthetic-company",
    grant: { id: "synthetic-grant", sha256: "a".repeat(64), issuedAt: "2026-09-05T11:00:00.000Z", expiresAt: "2026-09-12T11:00:00.000Z" },
    build: { service: "jobnimbus-chatgpt-bridge", sourceCommit: "b".repeat(40), sourceCommitTrust: "provider_attested", attested: true },
    excludedFileNumbers: ["2628"],
    limits: { pageSize: 2, maxPages: 3, maxDocuments: 6, maxOriginals: 3, maxBytesPerFile: 4096, maxTotalBytes: 8192 },
    retention: { expiresAt: "2026-09-12T11:00:00.000Z" }
  };
}

function document(documentId = "document-1", overrides = {}) {
  return {
    documentId, fileId: "file-1", fileNumber: "9991", carrier: "Synthetic Carrier",
    name: "Carrier estimate.pdf", mimeType: "application/pdf", size: PDF.length,
    revision: sha(Buffer.from(documentId)), createdAt: null, updatedAt: null,
    classification: "estimate_scope_candidate", sourceRole: "unverified", sourceRoleEvidence: "unverified", ...overrides
  };
}

function binding(pinned = pin()) {
  return { companyId: pinned.companyId, grantId: pinned.grant.id, grantSha256: pinned.grant.sha256, runId: "run-1" };
}

function page(documents = [document()], overrides = {}) {
  return {
    ...binding(), documents, nextCursor: null, complete: true, stopReason: "complete", declaredTotal: null,
    counts: { providerRows: documents.length, uniqueDocuments: documents.length, eligible: documents.filter(item => item.classification !== "ambiguous_pdf").length,
      excluded: 0, unsupported: 0, ambiguous: documents.filter(item => item.classification === "ambiguous_pdf").length, unreviewed: 0, duplicates: 0, pages: 1 },
    snapshot: { startedAt: "2026-09-05T12:00:00.000Z", providerVersion: null, consistentSnapshot: false }, ...overrides
  };
}

function original(doc = document(), bytes = PDF) {
  const { carrier, size, createdAt, updatedAt, ...metadata } = doc;
  return { ...binding(), ...metadata, contentBase64: bytes.toString("base64"), sha256: sha(bytes), byteLength: bytes.length };
}

async function harness(t, options = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "jobnimbus-research-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pinned = options.pin ?? pin();
  const h = {
    directory, cacheRoot: path.join(directory, "research"), calls: [], now: NOW,
    session: { ready: true, readOnly: true, effects: false, profile: "document_research_token",
      identity: { type: "document_research_token", subject: "codex-document-research" }, ...clone(pinned),
      allowedRoutes: [...RESEARCH_ROUTES], companyWideIndexOrSweep: false },
    pages: [page()], original: original()
  };
  h.coordinator = createResearchCoordinator({
    grant: pinned, cacheRoot: h.cacheRoot, now: () => h.now,
    researchRequest: async (method, route, body) => {
      h.calls.push({ method, route, body: clone(body) });
      if (route === "/document-research/session") return clone(h.session);
      if (route === "/document-research/inventory") return clone(h.pages.shift());
      if (route === "/document-research/original") return clone(h.original);
      throw new Error("Synthetic transport rejects all other routes");
    }
  });
  return h;
}

const request = { runId: "run-1", documentId: "document-1", fileId: "file-1" };

test("absent research pin disables access without creating files", async () => {
  assert.equal(await loadResearchPin(undefined, NOW), null);
  assert.equal(await loadResearchPin("", NOW), null);
});

test("local pin requires private owned regular file and exact grant", async t => {
  const h = await harness(t);
  const filename = path.join(h.directory, "pin.json");
  await writeFile(filename, JSON.stringify(pin()), { mode: 0o600 });
  assert.deepEqual(await loadResearchPin(filename, NOW), pin());
  await chmod(filename, 0o644);
  await assert.rejects(loadResearchPin(filename, NOW), /0600/);
  await chmod(filename, 0o600);
  await symlink(filename, path.join(h.directory, "link.json"));
  await assert.rejects(loadResearchPin(path.join(h.directory, "link.json"), NOW), /symlink/);
  await assert.rejects(loadResearchPin("relative.json", NOW), /absolute/);
});

test("pins reject expiry, overlong grants, missing exclusions, unsupported rights and excessive limits", () => {
  for (const mutate of [
    value => { value.grant.expiresAt = "2026-09-05T11:30:00.000Z"; },
    value => { value.grant.issuedAt = "2026-09-01T11:00:00.000Z"; },
    value => { value.grant.issuedAt = "2026-09-06T11:00:00.000Z"; },
    value => { value.excludedFileNumbers = []; },
    value => { value.effects = true; },
    value => { value.build.attested = false; },
    value => { value.build.sourceCommit = "main"; },
    value => { value.limits.maxBytesPerFile = 100 * 1024 * 1024; },
    value => { value.retention.expiresAt = "2026-09-13T11:00:00.000Z"; }
  ]) {
    const value = pin(); mutate(value);
    assert.throws(() => validateResearchPin(value, NOW), /Document research refused/);
  }
});

for (const [label, mutate] of [
  ["operational identity", value => { value.identity.type = "mac_operator_token"; }],
  ["wrong subject", value => { value.identity.subject = "codex-mac-operator"; }],
  ["wrong company", value => { value.companyId = "other"; }],
  ["wrong grant", value => { value.grant.sha256 = "c".repeat(64); }],
  ["wrong build", value => { value.build.sourceCommit = "d".repeat(40); }],
  ["enabled effects", value => { value.effects = true; }],
  ["extra mutation route", value => { value.allowedRoutes.push("POST /ops/action-batch"); }],
  ["removed exclusion", value => { value.excludedFileNumbers = []; }],
  ["missing readonly", value => { value.readOnly = false; }],
  ["unattested extra capability", value => { value.capabilities = ["gmail.send"]; }]
]) test(`attestation rejects ${label} before inventory dispatch`, async t => {
  const h = await harness(t); mutate(h.session);
  await assert.rejects(h.coordinator.inventory(), /Document research refused/);
  assert.deepEqual(h.calls.map(call => call.route), ["/document-research/session"]);
  assert.deepEqual(await readdir(h.directory), []);
});

test("inventory accepts cumulative pagination and records a truthful complete result", async t => {
  const h = await harness(t);
  h.pages = [page([document()], { nextCursor: "opaque-first", complete: false, stopReason: "more_pages" }),
    page([document("document-2")], { counts: { providerRows: 2, uniqueDocuments: 2, eligible: 2, excluded: 0, unsupported: 0, ambiguous: 0, unreviewed: 0, duplicates: 0, pages: 2 } })];
  const first = await h.coordinator.inventory();
  assert.equal(first.complete, false);
  assert.equal((await h.coordinator.inventory({ cursor: first.nextCursor })).complete, true);
  assert.deepEqual(h.calls.map(call => call.route), ["/document-research/session", "/document-research/inventory", "/document-research/session", "/document-research/inventory"]);
  assert.deepEqual(await readdir(h.directory), []);
});

test("empty and capped inventories preserve completeness distinctions", async t => {
  const h = await harness(t);
  h.pages = [page([]), page([], { complete: false, stopReason: "page_limit" })];
  assert.equal((await h.coordinator.inventory()).complete, true);
  assert.equal((await h.coordinator.inventory()).complete, false);
});

for (const [label, mutate] of [
  ["wrong company", value => { value.companyId = "wrong-company"; }],
  ["wrong grant", value => { value.grantId = "wrong-grant"; }],
  ["excluded file", value => { value.documents[0].fileNumber = "2628"; }],
  ["source URL", value => { value.documents[0].sourceUrl = "https://invalid.example/original"; }],
  ["bad revision", value => { value.documents[0].revision = "unknown"; }],
  ["hidden omissions", value => { value.counts.eligible = 2; value.counts.uniqueDocuments = 2; value.counts.providerRows = 2; }],
  ["inconsistent totals", value => { value.counts.providerRows = 2; }],
  ["false completion", value => { value.stopReason = "page_limit"; }],
  ["false consistent snapshot", value => { value.snapshot.consistentSnapshot = true; }],
  ["unsupported document MIME", value => { value.documents[0].mimeType = "text/html"; }]
]) test(`inventory rejects ${label}`, async t => {
  const h = await harness(t); mutate(h.pages[0]);
  await assert.rejects(h.coordinator.inventory(), /Document research refused/);
  assert.deepEqual(await readdir(h.directory), []);
});

test("inventory rejects arbitrary parameters and foreign cursors without any request", async t => {
  const h = await harness(t);
  for (const input of [{ url: "https://invalid.example" }, { profile: "operator" }, { cursor: "invented" }, [], null]) {
    await assert.rejects(h.coordinator.inventory(input), /Document research refused/);
  }
  assert.equal(h.calls.length, 0);
});

test("inventory rejects repeated pages and cursor replay", async t => {
  const h = await harness(t);
  h.pages = [page([document()], { nextCursor: "next", complete: false, stopReason: "more_pages" }),
    page([document()], { counts: { providerRows: 2, uniqueDocuments: 2, eligible: 2, excluded: 0, unsupported: 0, ambiguous: 0, unreviewed: 0, duplicates: 0, pages: 2 } })];
  await h.coordinator.inventory();
  await assert.rejects(h.coordinator.inventory({ cursor: "next" }), /repeated a document/);
  const calls = h.calls.length;
  await assert.rejects(h.coordinator.inventory({ cursor: "foreign" }), /cursor/);
  assert.equal(h.calls.length, calls);
});

test("original requires exact current inventory and forbids ambiguous PDFs", async t => {
  const h = await harness(t);
  await assert.rejects(h.coordinator.original(request), /current local inventory/);
  h.pages = [page([document("document-1", { classification: "ambiguous_pdf" })])];
  await h.coordinator.inventory();
  await assert.rejects(h.coordinator.original(request), /inventory-only/);
  assert.equal(h.calls.filter(call => call.route.endsWith("/original")).length, 0);
});

test("wrong file/run/document IDs and arbitrary original parameters cause no original dispatch", async t => {
  const h = await harness(t); await h.coordinator.inventory();
  for (const input of [ { ...request, fileId: "other" }, { ...request, runId: "other" }, { ...request, documentId: "other" },
    { ...request, url: "https://invalid.example" }, { ...request, documentId: "../escape" } ]) {
    await assert.rejects(h.coordinator.original(input), /Document research refused/);
  }
  assert.equal(h.calls.filter(call => call.route.endsWith("/original")).length, 0);
});

for (const [label, mutate] of [
  ["wrong file", value => { value.fileId = "other"; }],
  ["wrong company", value => { value.companyId = "other"; }],
  ["wrong grant", value => { value.grantSha256 = "d".repeat(64); }],
  ["changed revision", value => { value.revision = "d".repeat(64); }],
  ["wrong hash", value => { value.sha256 = "e".repeat(64); }],
  ["wrong length", value => { value.byteLength += 1; }],
  ["invalid base64", value => { value.contentBase64 = "???"; }],
  ["noncanonical base64", value => { value.contentBase64 += "\n"; }],
  ["source URL", value => { value.downloadUrl = "https://invalid.example/token"; }],
  ["changed source role", value => { value.sourceRole = "carrier_approved"; }],
  ["HTML as PDF", value => { const bytes = Buffer.from("<html>pretend this is a PDF!</html>"); value.contentBase64 = bytes.toString("base64"); value.byteLength = bytes.length; value.sha256 = sha(bytes); }]
]) test(`original rejects ${label} before cache materialization`, async t => {
  const h = await harness(t);
  if (label === "HTML as PDF") h.pages[0].documents[0].size = null;
  await h.coordinator.inventory(); mutate(h.original);
  await assert.rejects(h.coordinator.original(request), /Document research refused/);
  assert.deepEqual(await readdir(h.directory), []);
});

test("verified PDF is immutable, private, hash-bound and does not expose base64 or provider URLs", async t => {
  const h = await harness(t); await h.coordinator.inventory();
  const result = await h.coordinator.original(request);
  assert.equal(result.sha256, sha(PDF));
  assert.equal(result.byteLength, PDF.length);
  assert.equal(result.contentBase64, undefined);
  assert.equal(result.retention.expiresAt, pin().retention.expiresAt);
  assert.deepEqual(await readFile(result.localPath), PDF);
  assert.equal((await lstat(result.localPath)).mode & 0o777, 0o600);
  let directory = path.dirname(result.localPath);
  while (directory.startsWith(h.cacheRoot)) {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    directory = path.dirname(directory);
  }
  assert.equal((await lstat(path.join(path.dirname(result.localPath), "manifest.json"))).mode & 0o777, 0o600);
  const before = h.calls.length;
  await assert.rejects(h.coordinator.original(request), /already requested/);
  assert.equal(h.calls.length, before);
});

test("cache symlinks are refused without writing originals through them", async t => {
  const h = await harness(t); await h.coordinator.inventory();
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "jobnimbus-research-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, h.cacheRoot);
  await assert.rejects(h.coordinator.original(request), /symlink-free/);
  assert.deepEqual(await readdir(outside), []);
});

test("expiry blocks reads before dispatch and does not renew a grant", async t => {
  const h = await harness(t); await h.coordinator.inventory();
  h.now = Date.parse(pin().grant.expiresAt);
  const before = h.calls.length;
  await assert.rejects(h.coordinator.original(request), /expired/);
  assert.equal(h.calls.length, before);
  assert.deepEqual(await readdir(h.directory), []);
});

test("byte limits stop acquisition before original request", async t => {
  const h = await harness(t);
  h.pages[0].documents[0].size = pin().limits.maxBytesPerFile + 1;
  await h.coordinator.inventory();
  await assert.rejects(h.coordinator.original(request), /download bound/);
  assert.equal(h.calls.filter(call => call.route.endsWith("/original")).length, 0);
});

test("invalid original attempts consume budget and cannot be retried", async t => {
  const h = await harness(t); await h.coordinator.inventory();
  h.original.sha256 = "f".repeat(64);
  await assert.rejects(h.coordinator.original(request), /SHA-256/);
  const before = h.calls.length;
  await assert.rejects(h.coordinator.original(request), /already requested/);
  assert.equal(h.calls.length, before);
});

test("research coordinator exposes only attestation and two fixed business reads", async t => {
  const h = await harness(t);
  assert.deepEqual(Object.keys(h.coordinator).sort(), ["inventory", "original", "verifySession"]);
  await h.coordinator.inventory(); await h.coordinator.original(request);
  assert(h.calls.every(call => RESEARCH_ROUTES.includes(`${call.method} ${call.route}`)));
});

// Optional cross-package tests are explicitly bound to a local bridge source
// module. They inject synthetic provider methods and never invoke live APIs.
const bridgeModule = process.env.JOBNIMBUS_DOCUMENT_RESEARCH_TEST_BRIDGE_MODULE;
const crossOptions = { skip: !bridgeModule };

async function crossHarness(t, { rows, methods = {} } = {}) {
  assert(path.isAbsolute(bridgeModule), "integration requires an explicit absolute local module path");
  const { createDocumentResearchService } = await import(pathToFileURL(bridgeModule).href);
  const h = await harness(t);
  const p = pin();
  const providerRows = rows ?? ["one", "two", "three"].map(documentId => ({
    id: documentId, companyId: p.companyId, name: "Carrier estimate.pdf", mimeType: "application/pdf", size: PDF.length,
    version: "synthetic-version-1", createdAt: "", updatedAt: "1788619200", fileIds: ["file-1"],
    private: false, deleted: false, permissionDenied: false
  }));
  const calls = [];
  const provider = {
    listDocuments: async ({ offset, limit }) => ({ rows: providerRows.slice(offset, offset + limit), total: providerRows.length }),
    getDocument: async documentId => providerRows.find(row => row.id === documentId),
    getParent: async () => ({ id: "file-1", companyId: p.companyId, number: "9991", carrier: "", private: false, deleted: false, permissionDenied: false }),
    downloadDocument: async () => ({ bytes: PDF, contentType: "application/pdf", contentLength: PDF.length }),
    ...methods
  };
  for (const [name, operation] of Object.entries(provider)) provider[name] = async (...args) => { calls.push(name); return operation(...args); };
  const service = createDocumentResearchService({
    grant: { enabled: true, grantId: p.grant.id, companyId: p.companyId, issuedAt: p.grant.issuedAt,
      expiresAt: p.grant.expiresAt, limits: p.limits, excludedFileNumbers: p.excludedFileNumbers },
    provider, now: () => NOW
  });
  const session = service.session();
  const localPin = { ...p, grant: session.grant };
  const build = { ...p.build, apiVersion: "v1", schemaVersion: "0.1.0", buildId: "synthetic-build", deployId: "synthetic-deploy", runtime: "node" };
  h.coordinator = createResearchCoordinator({ grant: localPin, cacheRoot: h.cacheRoot, now: () => NOW,
    researchRequest: async (method, route, input) => {
      assert(service.routeAllowed(method, route));
      if (route === "/document-research/session") return { ...service.session(), build };
      if (route === "/document-research/inventory") return service.inventory(input);
      if (route === "/document-research/original") return service.original(input);
      throw new Error("No other route exists in the synthetic transport");
    }
  });
  return { ...h, service, calls, rows: providerRows };
}

test("actual bridge service -> coordinator paginated inventory -> immutable PDF cache", crossOptions, async t => {
  const h = await crossHarness(t);
  await h.coordinator.verifySession();
  const first = await h.coordinator.inventory();
  assert.equal(first.complete, false);
  assert.equal(first.declaredTotal, 3);
  const last = await h.coordinator.inventory({ cursor: first.nextCursor });
  assert.equal(last.complete, true);
  const selected = first.documents[0];
  const saved = await h.coordinator.original({ runId: first.runId, documentId: selected.documentId, fileId: selected.fileId });
  assert.deepEqual(await readFile(saved.localPath), PDF);
  assert.equal(saved.sourceRole, "unverified");
  assert.equal(h.calls.filter(name => name === "downloadDocument").length, 1);
  assert(h.calls.every(name => ["listDocuments", "getDocument", "getParent", "downloadDocument"].includes(name)));
});

test("actual bridge service partial rate-limit result remains partial with no local original", crossOptions, async t => {
  const h = await crossHarness(t, { methods: { listDocuments: async () => {
    throw Object.assign(new Error("synthetic upstream private message"), { statusCode: 429, retryAfterSeconds: 60 });
  } } });
  const result = await h.coordinator.inventory();
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, "provider_unavailable");
  assert.deepEqual(result.error, { code: "provider_unavailable", status: 429, retryAfterSeconds: 60 });
  assert.equal(result.counts.pages, 0);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(await readdir(h.directory), []);
});

test("actual bridge service preserves unreviewed parent failures and rejects changed originals", crossOptions, async t => {
  const failed = await crossHarness(t, { methods: { getParent: async () => { throw new Error("synthetic provider unavailable"); } } });
  const partial = await failed.coordinator.inventory();
  assert.equal(partial.counts.unreviewed, 1);
  assert.equal(partial.complete, false);
  assert.deepEqual(await readdir(failed.directory), []);
  const h = await crossHarness(t);
  const first = await h.coordinator.inventory();
  h.rows[0].version = "synthetic-version-2";
  await assert.rejects(h.coordinator.original({ runId: first.runId, documentId: first.documents[0].documentId, fileId: first.documents[0].fileId }), /changed|metadata|revision/);
  assert.deepEqual(await readdir(h.directory), []);
  assert.equal(h.calls.filter(name => name === "downloadDocument").length, 0);
});

function esxFixture() {
  const name = Buffer.from("estimate.xml");
  const bytes = Buffer.from("<Estimate><Scope>synthetic only</Scope></Estimate>");
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

test("actual bridge validated ESX remains internal owner-confirmed opaque original", crossOptions, async t => {
  const bytes = esxFixture();
  const h = await crossHarness(t, {
    rows: [{ id: "internal-estimate", companyId: pin().companyId, name: "Internal estimate.esx", mimeType: "application/vnd.xactware.esx", size: bytes.length,
      version: "1", createdAt: "", updatedAt: "", fileIds: ["file-1"], private: false, deleted: false, permissionDenied: false }],
    methods: { downloadDocument: async () => ({ bytes, contentType: "application/zip", contentLength: bytes.length }) }
  });
  const inventory = await h.coordinator.inventory();
  const doc = inventory.documents[0];
  const saved = await h.coordinator.original({ runId: inventory.runId, documentId: doc.documentId, fileId: doc.fileId });
  assert.equal(saved.sourceRole, "internal");
  assert.equal(saved.sourceRoleEvidence, "owner_confirmed");
  assert.deepEqual(await readFile(saved.localPath), bytes);
  assert.deepEqual((await readdir(path.dirname(saved.localPath))).sort(), ["manifest.json", "original.esx"]);
});
