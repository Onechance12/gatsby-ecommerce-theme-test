import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CHANCE_OPERATOR_PDF_ALLOWED_ACTION_TYPES, CHANCE_OPERATOR_NOTES_ALLOWED_ACTION_TYPES,
  CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS, loadChanceOperatorRunManifest } from "./operations/thresher-policy.js";
import { PDF_UPLOAD_TYPE, pdfHash, assertPdfPlan, assertPdfReceipt } from "../integrations/jobnimbus-operator/mcp/pdf-upload-contract.mjs";

// Synthetic bytes only. This tests immutable transport/approval, not PDF layout.
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
const TOKEN = "fixture-pdf-operator-token-12345678901234567890";
const OWNER = "fc95a213f70e4c9daddc5fa366be9941";
const operation = (overrides = {}) => ({ type: PDF_UPLOAD_TYPE, payload: {
  query: "#2739", filename: "Reviewed-letter.pdf", contentType: "application/pdf",
  sizeBytes: PDF.length, sha256: pdfHash(PDF), contentBase64: PDF.toString("base64"), isPrivate: false, ...overrides
} });

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "approved-pdf-test-"));
  const state = { reserves: 0, puts: 0, completes: 0, contactIndexes: 0, records: [], bytes: new Map(), mode: "normal", body: null };
  const contacts = [2739, 2741, 2628].map((number) => ({ number, jnid: `contact-${number}`,
    record_type_name: "Insurance", display_name: "Synthetic Client", owners: [{ id: OWNER }],
    is_active: true, is_archived: false, is_closed: false, is_deleted: false, status_name: "Ready for PA Review" }));
  const api = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const readBody = async () => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); };
    if (url.pathname === "/contacts") { state.contactIndexes++; return json(200, { contacts, count: contacts.length }); }
    const contact = contacts.find((r) => url.pathname === `/contacts/${r.jnid}`);
    if (contact) return json(200, contact);
    if (url.pathname === "/files") {
      const filter = JSON.parse(url.searchParams.get("filter") || "{}");
      const [field, id] = Object.entries(filter.must?.[0]?.term || {})[0] || [];
      let rows = state.records.filter((row) => field === "related.id" && row.related.some((r) => r.id === id));
      if (state.mode === "wrong_inventory") rows = [{ jnid: "other-file-doc", related: [{ id: "other-file" }] }];
      return json(200, { files: rows.slice(Number(url.searchParams.get("from") || 0)), count: rows.length });
    }
    if (url.pathname === "/files/v1/uploads/url") {
      state.reserves++;
      state.body = JSON.parse((await readBody()).toString());
      const id = state.mode === "reused_id" ? "existing-file-id" : `created-doc-${state.reserves}`;
      state.reservationId = id;
      if (state.mode === "reserve_timeout") return req.socket.destroy();
      return json(200, { data: { jnid: state.mode === "missing_id" ? undefined : id,
        url: state.mode === "evil_url" ? "https://evil.example/upload" : `http://127.0.0.1:${api.address().port}/storage/${id}` } });
    }
    if (url.pathname.startsWith("/storage/") && req.method === "PUT") {
      state.puts++;
      state.bytes.set(url.pathname.split("/").at(-1), await readBody());
      if (state.mode === "put_timeout") return req.socket.destroy();
      res.writeHead(200); return res.end();
    }
    if (/\/files\/v1\/uploads\/[^/]+\/complete/.test(url.pathname)) {
      state.completes++;
      const id = url.pathname.split("/").at(-2);
      state.records.push({ jnid: id, name: state.body.filename, size: state.body.sizeBytes,
        is_private: state.body.isPrivate, related: state.body.related.map((id) => ({ id })) });
      if (state.mode === "complete_timeout") return req.socket.destroy();
      return json(200, { data: { jnid: id } });
    }
    const record = state.records.find((row) => url.pathname === `/files/${row.jnid}`);
    if (record) return json(200, { ...record,
      ...(state.mode === "wrong_file" ? { related: [{ id: "contact-2741" }] } : {}),
      ...(state.mode === "wrong_privacy" ? { is_private: true } : {}) });
    if (url.pathname.startsWith("/download/")) {
      const bytes = state.bytes.get(url.pathname.split("/").at(-1));
      if (!bytes) return json(404, { error: "Fixture missing" });
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(state.mode === "wrong_bytes" ? Buffer.from("changed") : bytes);
    }
    return json(404, { error: "Fixture route missing" });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const input = { schemaVersion: 1, id: options.old ? "chance-58-files-notes-v1" : "chance-58-files-pdf-v1",
    operatorScope: "assigned", expiresAt: "2099-01-01T00:00:00.000Z",
    files: [...contacts.slice(0, 2).map((r) => ({ number: String(r.number), fileId: r.jnid })),
      ...Array.from({ length: 56 }, (_, i) => ({ number: String(4000 + i), fileId: `fixture-file-${i}` }))],
    excludedFileNumbers: ["2628"], allowedActionTypes: [...(options.old ? CHANCE_OPERATOR_NOTES_ALLOWED_ACTION_TYPES : CHANCE_OPERATOR_PDF_ALLOWED_ACTION_TYPES)],
    allowedContactFields: [...CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS] };
  const manifest = loadChanceOperatorRunManifest(input);
  const runPolicy = { id: manifest.id, sha256: manifest.sha256 };
  const base = `http://127.0.0.1:${api.address().port}`;
  const child = spawn(process.execPath, ["src/server.js"], { cwd: process.cwd(), env: {
    PATH: process.env.PATH, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
    JOBNIMBUS_BRIDGE_TOKEN: "fixture-shared-token", CODEX_MAC_OPERATOR_TOKEN: TOKEN,
    JOBNIMBUS_API_BASE_URL: base, JOBNIMBUS_FILE_BASE_URL: `${base}/download`, PDF_UPLOAD_TEST_API_BASE: base,
    JOBNIMBUS_API_KEY: "fixture-key", MEMORY_ROOT: root, REQUIRE_CHANCE_RUN_POLICY: "true",
    CHANCE_OPERATOR_RUN_MANIFEST_JSON: JSON.stringify(input), BRIDGE_ALLOW_WRITES: "true", ALLOW_GOOGLE_USER_AUTH: "false",
    ...(options.failLedgerAt ? { ACTION_BATCH_LEDGER_TEST_FAIL_AT: String(options.failLedgerAt) } : {})
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; }); child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await new Promise((resolve) => api.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(ready, true, logs);
  const request = async (route, body, token = TOKEN) => {
    const result = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  return { state, root, contacts, request,
    prepare: (operations) => request("/ops/action-batch", { runPolicy, operations, execute: false }),
    execute: (operations, plan) => request("/ops/action-batch", { runPolicy, operations, execute: true,
      approvalDigest: plan.approvalDigest, approvalChallenge: plan.approvalChallenge }) };
}

test("PDF capability requires a new manifest; old manifest and direct route remain blocked", async (t) => {
  const f = await fixture(t, { old: true });
  assert.equal((await f.prepare([operation()])).status, 400);
  assert.equal((await f.request("/jobnimbus/upload-file", { ...operation().payload, execute: true })).status, 403);
  assert.equal(f.state.reserves, 0);
});

test("PDF plan and receipt bind exact bytes, privacy, client; no bytes in plan or durable ledgers", async (t) => {
  const f = await fixture(t);
  const ops = [operation()];
  const plan = await f.prepare(ops);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assertPdfPlan(plan.body, ops);
  assert.equal(f.state.reserves, 0);
  for (const change of [{ filename: "Changed.pdf" }, { query: "#2741" }, { isPrivate: true }]) {
    assert.equal((await f.execute([operation(change)], plan.body)).status, 409);
  }
  assert.equal(f.state.reserves, 0);
  const result = await f.execute(ops, plan.body);
  assert.equal(result.body.mode, "executed", JSON.stringify(result.body));
  const receipt = result.body.batch.completed[0].receipt;
  assertPdfReceipt(receipt, ops[0].payload);
  assert.equal(receipt.fileId, "contact-2739");
  assert.equal(receipt.externalId, "created-doc-1");
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], [1, 1, 1]);
  const detail = await f.request("/ops/action-batch-receipts", { batchId: result.body.batch.id });
  assertPdfReceipt(detail.body.receipt.completed[0].receipt, ops[0].payload);
  for (const value of [plan.body, result.body, detail.body,
    await readFile(path.join(f.root, "bridge", "action-batches.json"), "utf8"),
    await readFile(path.join(f.root, "bridge", "action-approvals.json"), "utf8")]) {
    assert.equal(JSON.stringify(value).includes(ops[0].payload.contentBase64), false);
    assert.equal(JSON.stringify(value).includes("fixture-key"), false);
  }
  assert.equal((await f.prepare(ops)).status, 409);
  assert.equal((await f.prepare([operation({ filename: "Different.pdf" })])).status, 409);
  assert.notEqual((await f.execute(ops, plan.body)).body.mode, "executed");
  assert.equal(f.state.reserves, 1);
  assert.equal(f.state.contactIndexes, 0);
});

test("invalid/mixed/wrong-scope PDFs have zero provider effects", async (t) => {
  const f = await fixture(t);
  for (const ops of [
    [operation(), operation({ query: "#2741" })], [operation(), { type: "jobnimbus.create_note", payload: { query: "#2739", note: "No mixing" } }],
    ...[{ query: "#2628" }, { query: "#9999" }, { query: "Synthetic Client" }, { filename: "../secret.pdf" },
      { isPrivate: "false" }, { sha256: "a".repeat(64) }, { contentBase64: "data:application/pdf;base64,AAAA" },
      { description: "extra" }, { overwrite: true }, { related: ["contact-2741"] }, { operatorScope: "company" }].map((change) => [operation(change)])
  ]) assert.notEqual((await f.prepare(ops)).status, 200, JSON.stringify(ops.map((op) => Object.keys(op.payload))));
  f.contacts[0].is_active = false;
  assert.notEqual((await f.prepare([operation()])).status, 200);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], [0, 0, 0]);
});

test("fresh inventory or ownership changes invalidate approval before reservation", async (t) => {
  const f = await fixture(t);
  const plan = await f.prepare([operation()]);
  f.state.records.push({ jnid: "existing-file-id", name: "Other.pdf", related: [{ id: "contact-2739" }] });
  assert.equal((await f.execute([operation()], plan.body)).status, 409);
  f.state.records = [];
  f.contacts[0].owners = [{ id: "other-owner" }];
  assert.notEqual((await f.execute([operation()], plan.body)).status, 200);
  assert.equal(f.state.reserves, 0);
});

for (const scenario of ["reserve_timeout", "missing_id", "evil_url", "put_timeout", "complete_timeout", "wrong_file", "wrong_bytes", "wrong_privacy", "receipt_failure", "provider_id_failure"]) {
  test(`PDF ${scenario}: fail-stop and read-only recovery, never reupload`, async (t) => {
    const f = await fixture(t, { failLedgerAt: scenario === "receipt_failure" ? 4 : scenario === "provider_id_failure" ? 3 : 0 });
    const ops = [operation()];
    const plan = await f.prepare(ops);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    f.state.mode = scenario;
    const result = await f.execute(ops, plan.body);
    assert.equal(result.body.mode, "partial_failure", JSON.stringify(result.body));
    assert.equal(result.body.batch.completed.length, 0);
    const before = [f.state.reserves, f.state.puts, f.state.completes];
    f.state.mode = "normal";
    const recovered = await f.request("/ops/action-batch-reconcile", { batchId: result.body.batch.id });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    if (["complete_timeout", "wrong_file", "wrong_bytes", "wrong_privacy", "receipt_failure"].includes(scenario)) {
      assert.equal(recovered.body.outcome, "applied_verified", JSON.stringify(recovered.body));
      assertPdfReceipt(recovered.body.receipt.completed[0].receipt, ops[0].payload);
    } else {
      assert.equal(recovered.body.outcome, "unknown_file_quarantined", JSON.stringify(recovered.body));
    }
    assert.notEqual((await f.execute(ops, plan.body)).body.mode, "executed");
    assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], before);
    assert.equal(f.state.reserves, 1);
  });
}
