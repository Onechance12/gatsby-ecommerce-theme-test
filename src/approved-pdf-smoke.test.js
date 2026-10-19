import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CHANCE_OPERATOR_PDF_ALLOWED_ACTION_TYPES, CHANCE_OPERATOR_NOTES_ALLOWED_ACTION_TYPES,
  CHANCE_OPERATOR_LIVE_ASSIGNED_POLICY_ID, CHANCE_OPERATOR_QUO_SMS_ALLOWED_ACTION_TYPES,
  CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS, loadChanceOperatorRunManifest } from "./operations/thresher-policy.js";
import { PDF_UPLOAD_TYPE, pdfHash, assertPdfPlan, assertPdfReceipt } from "../integrations/jobnimbus-operator/mcp/pdf-upload-contract.mjs";
import { pdfResolutionSource, validPdfReceiptResolution, assertPdfResolutionReceipt, assertPdfDiagnostic } from "../integrations/jobnimbus-operator/mcp/pdf-receipt-resolution.mjs";

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
  const state = { reserves: 0, puts: 0, completes: 0, metadataGets: 0, contactIndexes: 0, records: [], bytes: new Map(), mode: "normal", body: null };
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
      if (state.mode === "wrong_file") rows = rows.map((row) => ({ ...row, related: [{ id: "contact-2741" }] }));
      if (state.mode === "wrong_privacy") rows = rows.map((row) => ({ ...row, is_private: !state.body.isPrivate }));
      if (state.mode === "metadata_timeout" && state.records.length) return req.socket.destroy();
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
    // The undocumented single-file metadata route must never be used. A
    // successful upload still cannot be verified through this HTML response.
    if (/^\/files\/[^/]+$/.test(url.pathname)) {
      state.metadataGets++;
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html>Not a metadata API</html>");
    }
    if (url.pathname.startsWith("/download/")) {
      if (state.mode === "download_untrusted") {
        res.writeHead(302, { location: "https://api3.jobnimbus.com/private?signature=fixture-secret" });
        return res.end();
      }
      if (state.mode === "download_http_failure") return json(403, { error: "private provider body https://private.example/?signature=fixture-secret" });
      const bytes = state.bytes.get(url.pathname.split("/").at(-1));
      if (!bytes) return json(404, { error: "Fixture missing" });
      state.afterDownload?.();
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
  let input = { schemaVersion: 1, id: options.old ? "chance-58-files-notes-v1" : "chance-58-files-pdf-v1",
    operatorScope: "assigned", expiresAt: "2099-01-01T00:00:00.000Z",
    files: [...contacts.slice(0, 2).map((r) => ({ number: String(r.number), fileId: r.jnid })),
      ...Array.from({ length: 56 }, (_, i) => ({ number: String(4000 + i), fileId: `fixture-file-${i}` }))],
    excludedFileNumbers: ["2628"], allowedActionTypes: [...(options.old ? CHANCE_OPERATOR_NOTES_ALLOWED_ACTION_TYPES : CHANCE_OPERATOR_PDF_ALLOWED_ACTION_TYPES)],
    allowedContactFields: [...CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS] };
  if (options.live) {
    const { files, ...baseInput } = input;
    input = { ...baseInput, schemaVersion: 2, id: CHANCE_OPERATOR_LIVE_ASSIGNED_POLICY_ID,
      assignmentMode: "live_assigned", assignmentOwnerId: OWNER,
      allowedActionTypes: [...CHANCE_OPERATOR_QUO_SMS_ALLOWED_ACTION_TYPES] };
  }
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
  return { state, root, contacts, request, runPolicy, logs: () => logs,
    prepare: (operations) => request("/ops/action-batch", { runPolicy, operations, execute: false }),
    execute: (operations, plan) => request("/ops/action-batch", { runPolicy, operations, execute: true,
      approvalDigest: plan.approvalDigest, approvalChallenge: plan.approvalChallenge }) };
}

test("live-assigned PDF uses fresh exact ownership without a frozen file roster", async (t) => {
  const f = await fixture(t, { live: true });
  const ops = [operation()];
  const plan = await f.prepare(ops);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const result = await f.execute(ops, plan.body);
  assert.equal(result.body.mode, "executed", JSON.stringify(result.body));
  assertPdfReceipt(result.body.batch.completed[0].receipt, ops[0].payload);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], [1, 1, 1]);
  assert.equal(f.state.metadataGets, 0);
});

// Synthetic-only fixture. Never edit a real receipt to create a recovery case.
async function privateMismatch(t, options = {}) {
  const f = await fixture(t, { live: true, ...options });
  const ops = [operation({ isPrivate: true })];
  const plan = await f.prepare(ops);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  f.state.mode = "wrong_privacy";
  const attempted = await f.execute(ops, plan.body);
  assert.equal(attempted.body.mode, "partial_failure");
  const batchId = attempted.body.batch.id;
  const quarantined = await f.request("/ops/action-batch-reconcile", { batchId });
  assert.equal(quarantined.body.mode, "manual_quarantined");
  f.state.records[0].is_private = false;
  f.state.mode = "normal";
  const actualPath = path.join(f.root, "bridge", "action-batches.json");
  return { ...f, batchId, ops, uploadPlan: plan.body, ledgerPath: actualPath,
    diagnose: (overrides = {}) => f.request("/ops/action-batch-receipts", {
      batchId, runPolicy: f.runPolicy, pdfDiagnostic: { query: "#2739", documentId: "created-doc-1" }, ...overrides
    }),
    resolution: { query: "#2739", documentId: "created-doc-1", acceptedIsPrivate: false },
    recovery: (resolution, approval) => f.request("/ops/action-batch-reconcile", {
      batchId, resolution, runPolicy: f.runPolicy, execute: Boolean(approval),
      ...(approval ? { approvalDigest: approval.approvalDigest, approvalChallenge: approval.approvalChallenge } : {})
    }) };
}

test("PDF diagnosis separates privacy from byte verification without changing the receipt or creating an approval", async (t) => {
  const f = await privateMismatch(t);
  const indexesBefore = f.state.contactIndexes;
  const before = await readFile(f.ledgerPath, "utf8");
  const approvalsPath = path.join(f.root, "bridge", "action-approvals.json");
  const approvalsBefore = await readFile(approvalsPath, "utf8");
  const counts = [f.state.reserves, f.state.puts, f.state.completes];
  const result = await f.diagnose();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertPdfDiagnostic(result.body, { batchId: f.batchId, query: "#2739", documentId: "created-doc-1" });
  assert.equal(result.body.originalMetadata.isPrivate, true);
  assert.equal(result.body.observedIsPrivate, false);
  assert.equal(result.body.metadataChecks.privacy_matches, false);
  assert.equal(result.body.download.contentVerified, true);
  assert.equal(result.body.approvalRequired, false);
  assert.equal(result.body.fileHoldReleased, false);
  assert.equal(result.body.approvalDigest, undefined);
  assert.equal(await readFile(f.ledgerPath, "utf8"), before);
  assert.equal(await readFile(approvalsPath, "utf8"), approvalsBefore);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], counts);
  assert.equal(f.state.contactIndexes, indexesBefore, "An exact receipt diagnosis must not re-enumerate the client book");
});

test("PDF diagnosis reports a precise blocked redirect without retry, signed URL disclosure or receipt writes", async (t) => {
  const f = await privateMismatch(t);
  const before = await readFile(f.ledgerPath, "utf8");
  const counts = [f.state.reserves, f.state.puts, f.state.completes];
  f.state.mode = "download_untrusted";
  const result = await f.diagnose();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertPdfDiagnostic(result.body, { batchId: f.batchId, query: "#2739", documentId: "created-doc-1" });
  assert.equal(result.body.download.status, "blocked");
  assert.equal(result.body.download.diagnostic.urlRejection, "disallowed_hostname");
  assert.equal(result.body.download.diagnostic.hostCategory, "jobnimbus_api3");
  assert.equal(result.body.download.diagnostic.hop, 1);
  for (const secret of ["signature", "fixture-secret", "https://", "private?"]) assert.equal(JSON.stringify(result.body).includes(secret), false);
  assert.equal(await readFile(f.ledgerPath, "utf8"), before);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], counts);
});

test("PDF diagnosis rejects wrong file, candidate authority overrides and policy before provider download", async (t) => {
  const f = await privateMismatch(t);
  const before = await readFile(f.ledgerPath, "utf8");
  const counts = [f.state.reserves, f.state.puts, f.state.completes];
  for (const patch of [
    { pdfDiagnostic: { query: "#2741", documentId: "created-doc-1" } },
    { pdfDiagnostic: { query: "#2628", documentId: "created-doc-1" } },
    { pdfDiagnostic: { query: "#2739", documentId: "created-doc-1", acceptedIsPrivate: false } },
    { execute: true }, { runPolicy: { ...f.runPolicy, sha256: "f".repeat(64) } }
  ]) assert.ok([400, 409].includes((await f.diagnose(patch)).status));
  assert.equal(await readFile(f.ledgerPath, "utf8"), before);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], counts);
});

test("PDF diagnosis refuses a document deleted during byte readback and leaves all history unchanged", async (t) => {
  const f = await privateMismatch(t);
  const before = await readFile(f.ledgerPath, "utf8");
  f.state.afterDownload = () => { f.state.records[0].is_deleted = true; };
  const result = await f.diagnose();
  assert.equal(result.status, 409);
  assert.match(result.body.error, /candidate changed/);
  assert.equal(await readFile(f.ledgerPath, "utf8"), before);
});

test("read-only PDF resolution exposes safe transport diagnostics without releasing or modifying a receipt", async (t) => {
  const f = await privateMismatch(t);
  const before = await readFile(f.ledgerPath, "utf8");
  const counts = [f.state.reserves, f.state.puts, f.state.completes];
  f.state.mode = "download_http_failure";
  const result = await f.recovery(f.resolution);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /reason=http_status/);
  assert.match(result.body.error, /operation=read/);
  assert.match(result.body.error, /upstreamStatus=403/);
  assert.equal(await readFile(f.ledgerPath, "utf8"), before);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], counts);
  for (let i = 0; i < 20 && !f.logs().includes('"type":"pdf_provider_failure"'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const diagnostic = f.logs().split("\n").find((line) => line.includes('"type":"pdf_provider_failure"'));
  assert.deepEqual(JSON.parse(diagnostic), { type: "pdf_provider_failure", reason: "http_status", operation: "read", destination: "storage", hop: 0, upstreamStatus: 403 });
  for (const secret of ["private provider body", "private.example", "signature=fixture-secret"]) {
    assert.equal(JSON.stringify(result.body).includes(secret), false);
    assert.equal(diagnostic.includes(secret), false);
  }
});

test("new exact approval accepts only existing nonprivate PDF and preserves every original receipt field", async (t) => {
  const f = await privateMismatch(t);
  const counts = [f.state.reserves, f.state.puts, f.state.completes];
  const originalRows = JSON.parse(await readFile(f.ledgerPath, "utf8"));
  const original = originalRows.find((row) => row.id === f.batchId);
  const beforeSource = pdfResolutionSource(original);
  const followUp = [{ type: "jobnimbus.update_contact", payload: { query: "#2739", fields: { cf_string_7: "Synthetic adjuster" } } }];
  const blockedBefore = await f.prepare(followUp);
  assert.equal(blockedBefore.status, 409);
  const plan = await f.recovery(f.resolution);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.proof.originalMetadata.isPrivate, true);
  assert.equal(plan.body.proof.acceptedMetadata.isPrivate, false);
  assert.equal(plan.body.proof.sourceRowSha256, beforeSource.sourceRowSha256);
  assert.equal(plan.body.proof.identityProvenance, "preserved_reservation_id");
  assert.equal(plan.body.proof.providerWrites, false);
  const result = await f.recovery(f.resolution, plan.body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertPdfResolutionReceipt(result.body, plan.body);
  const savedRows = JSON.parse(await readFile(f.ledgerPath, "utf8"));
  const saved = savedRows.find((row) => row.id === f.batchId);
  assert.equal(validPdfReceiptResolution(saved), true);
  const { pdfReceiptResolution, ...unchanged } = saved;
  assert.deepEqual(unchanged, original);
  assert.equal(saved.status, "manual_quarantined");
  const detail = await f.request("/ops/action-batch-receipts", { batchId: f.batchId });
  assert.equal(detail.body.receipt.fileHoldReleased, true);
  assert.equal(detail.body.receipt.pdfReceiptResolutionValid, true);
  const nextPlan = await f.prepare(followUp);
  assert.equal(nextPlan.status, 200, JSON.stringify(nextPlan.body));
  assert.equal((await f.recovery(f.resolution, plan.body)).status, 409);
  assert.equal((await f.prepare([operation({ filename: "Other.pdf" })])).status, 409);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], counts);
});

test("historically missing reservation ID stays missing; new plan explicitly binds the unique live candidate", async (t) => {
  const f = await privateMismatch(t);
  const rows = JSON.parse(await readFile(f.ledgerPath, "utf8"));
  const row = rows.find((item) => item.id === f.batchId);
  delete row.manualQuarantine.providerDocumentId;
  await writeFile(f.ledgerPath, JSON.stringify(rows));
  const original = structuredClone(row);
  const plan = await f.recovery(f.resolution);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.proof.identityProvenance, "human_selected_live_candidate_no_durable_reservation_id");
  const executed = await f.recovery(f.resolution, plan.body);
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  const saved = JSON.parse(await readFile(f.ledgerPath, "utf8")).find((item) => item.id === f.batchId);
  const { pdfReceiptResolution, ...unchanged } = saved;
  assert.deepEqual(unchanged, original);
  assert.equal(Object.hasOwn(unchanged.manualQuarantine, "providerDocumentId"), false);
});

for (const scenario of ["wrong_bytes", "wrong_file", "duplicate", "private", "missing_privacy", "missing_size", "wrong_name", "reassigned", "closed", "moved_after_plan", "changed_source", "moved_during_read", "reassigned_during_read"]) {
  test(`PDF disposition ${scenario}: no hold release and no provider effects`, async (t) => {
    const f = await privateMismatch(t);
    const counts = [f.state.reserves, f.state.puts, f.state.completes];
    const plan = await f.recovery(f.resolution);
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    if (scenario === "wrong_bytes" || scenario === "wrong_file") f.state.mode = scenario;
    if (scenario === "duplicate") f.state.records.push({ ...f.state.records[0], jnid: "duplicate-doc-2" });
    if (scenario === "private") f.state.records[0].is_private = true;
    if (scenario === "missing_privacy") delete f.state.records[0].is_private;
    if (scenario === "missing_size") delete f.state.records[0].size;
    if (scenario === "wrong_name") f.state.records[0].name = "Changed.pdf";
    if (scenario === "reassigned") f.contacts[0].owners = [{ id: "another-owner" }];
    if (scenario === "closed") f.contacts[0].is_closed = true;
    if (scenario === "moved_after_plan") f.state.records[0].related = [{ id: "contact-2741" }];
    if (scenario === "moved_during_read") f.state.afterDownload = () => { f.state.records[0].related = [{ id: "contact-2741" }]; };
    if (scenario === "reassigned_during_read") f.state.afterDownload = () => { f.contacts[0].owners = [{ id: "another-owner" }]; };
    if (scenario === "changed_source") {
      const rows = JSON.parse(await readFile(f.ledgerPath, "utf8"));
      rows.find((row) => row.id === f.batchId).manualQuarantine.reason = "Changed synthetic audit history";
      await writeFile(f.ledgerPath, JSON.stringify(rows));
    }
    const failed = await f.recovery(f.resolution, plan.body);
    assert.notEqual(failed.status, 200, JSON.stringify(failed.body));
    const saved = JSON.parse(await readFile(f.ledgerPath, "utf8")).find((row) => row.id === f.batchId);
    assert.equal(validPdfReceiptResolution(saved), false);
    assert.equal(saved.pdfReceiptResolution, undefined);
    assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], counts);
  });
}

test("upload approval cannot approve a disposition; failed proof consumes the new server challenge", async (t) => {
  const f = await privateMismatch(t);
  const plan = await f.recovery(f.resolution);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const oldApproval = await f.recovery(f.resolution, { ...plan.body, approvalChallenge: f.uploadPlan.approvalChallenge });
  assert.equal(oldApproval.status, 409);
  f.state.records[0].is_private = true;
  assert.equal((await f.recovery(f.resolution, plan.body)).status, 409);
  f.state.records[0].is_private = false;
  const repeated = await f.recovery(f.resolution, plan.body);
  assert.equal(repeated.status, 409);
  assert.match(repeated.body.error, /consumed/);
  assert.equal((await f.recovery({ ...f.resolution, execute: true })).status, 400);
  assert.equal((await f.recovery({ ...f.resolution, acceptedIsPrivate: true })).status, 400);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], [1, 1, 1]);
});

test("failed internal disposition storage retains the original hold and consumes approval", async (t) => {
  const f = await privateMismatch(t, { failLedgerAt: 6 });
  const before = await readFile(f.ledgerPath, "utf8");
  const plan = await f.recovery(f.resolution);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const failed = await f.recovery(f.resolution, plan.body);
  assert.notEqual(failed.status, 200);
  assert.equal(await readFile(f.ledgerPath, "utf8"), before);
  assert.equal((await f.recovery(f.resolution, plan.body)).status, 409);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], [1, 1, 1]);
});

for (const scenario of ["other_quarantine", "global_hold", "foreign_principal", "invalid_intent", "forged_resolution"]) {
  test(`PDF disposition does not bypass ${scenario}`, async (t) => {
    const f = await privateMismatch(t);
    const rows = JSON.parse(await readFile(f.ledgerPath, "utf8"));
    const row = rows.find((item) => item.id === f.batchId);
    if (scenario === "other_quarantine" || scenario === "global_hold") {
      const other = structuredClone(row); other.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      if (scenario === "global_hold") { other.manualQuarantine.fileIds = []; other.recovery.fileScopedQuarantine = false; }
      rows.push(other);
    }
    if (scenario === "foreign_principal") row.principalHash = "a".repeat(64);
    if (scenario === "invalid_intent") row.intents[0].reconciliation.filename = "Tampered.pdf";
    if (scenario === "forged_resolution") row.pdfReceiptResolution = { fileHoldReleased: true };
    await writeFile(f.ledgerPath, JSON.stringify(rows));
    const before = await readFile(f.ledgerPath, "utf8");
    const plan = await f.recovery(f.resolution);
    assert.equal(plan.status, 409, JSON.stringify(plan.body));
    assert.equal(await readFile(f.ledgerPath, "utf8"), before);
    assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], [1, 1, 1]);
  });
}

test("live-assigned PDF rechecks assignment before reserving upload bytes", async (t) => {
  const f = await fixture(t, { live: true });
  const ops = [operation()];
  const plan = await f.prepare(ops);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  f.contacts[0].owners = [{ id: "another-synthetic-owner" }];
  assert.notEqual((await f.execute(ops, plan.body)).status, 200);
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], [0, 0, 0]);
});

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

for (const scenario of ["reserve_timeout", "missing_id", "evil_url", "put_timeout", "complete_timeout", "metadata_timeout", "wrong_file", "wrong_bytes", "wrong_privacy", "receipt_failure", "provider_id_failure"]) {
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
    if (["complete_timeout", "metadata_timeout", "wrong_file", "wrong_bytes", "wrong_privacy", "receipt_failure"].includes(scenario)) {
      assert.equal(recovered.body.outcome, "applied_verified", JSON.stringify(recovered.body));
      assertPdfReceipt(recovered.body.receipt.completed[0].receipt, ops[0].payload);
    } else {
      assert.equal(recovered.body.outcome, "unknown_file_quarantined", JSON.stringify(recovered.body));
    }
    assert.notEqual((await f.execute(ops, plan.body)).body.mode, "executed");
    assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], before);
    assert.equal(f.state.metadataGets, 0);
    assert.equal(f.state.reserves, 1);
  });
}

test("privacy mismatch keeps its document ID and precise diagnosis; existing quarantine never replays", async (t) => {
  const f = await fixture(t);
  const ops = [operation()];
  const plan = await f.prepare(ops);
  assert.equal(plan.status, 200);
  f.state.mode = "wrong_privacy";
  const attempted = await f.execute(ops, plan.body);
  assert.equal(attempted.body.mode, "partial_failure");
  const counts = [f.state.reserves, f.state.puts, f.state.completes];
  const recovered = await f.request("/ops/action-batch-reconcile", { batchId: attempted.body.batch.id });
  assert.equal(recovered.body.outcome, "unknown_file_quarantined");
  assert.equal(recovered.body.receipt.manualQuarantine.providerDocumentId, "created-doc-1");
  assert.match(recovered.body.receipt.manualQuarantine.reason, /privacy_matches/);
  const detail = await f.request("/ops/action-batch-receipts", { batchId: attempted.body.batch.id });
  assert.equal(detail.body.receipt.manualQuarantine.providerDocumentId, "created-doc-1");
  const review = await f.request("/jobnimbus/document-review", { query: "#2739", documentQuery: "created-doc-1" });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.deepEqual(review.body.providerMetadata.privacyFields, [{ field: "is_private", valueType: "boolean", value: true }]);
  assert.equal(review.body.providerMetadata.diagnosticOnly, true);
  assert.equal(review.body.providerMetadata.receiptResolved, false);
  f.state.mode = "normal";
  // Synthetic-only regression: an already quarantined row remains a no-op
  // even if the provider later appears to match. No runtime retry is added.
  const blocked = await f.request("/ops/action-batch-reconcile", { batchId: attempted.body.batch.id });
  assert.equal(blocked.body.mode, "verified_noop");
  assert.equal(blocked.body.receipt.status, "manual_quarantined");
  assert.deepEqual([f.state.reserves, f.state.puts, f.state.completes], counts);
});
