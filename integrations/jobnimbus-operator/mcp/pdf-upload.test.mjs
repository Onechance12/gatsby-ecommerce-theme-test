import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { PDF_UPLOAD_TYPE, PDF_MAX_BYTES, pdfHash, validatePdfPayload, assertPdfPlan, assertPdfReceipt, pdfProviderBody } from "./pdf-upload-contract.mjs";
import { PDF_UPLOADS_ENABLED, PDF_UPLOAD_RELEASE, validatePdfRelease } from "./pdf-upload-release.mjs";
import { readLocalPdf } from "./local-pdf.mjs";
import { createOperatorCoordinator } from "./operator-coordinator.mjs";

const PDF = Buffer.from("%PDF-1.4\nSynthetic upload contract fixture.\n%%EOF\n");
const payload = (patch = {}) => ({ query: "#2739", filename: "Reviewed.pdf", contentType: "application/pdf",
  sizeBytes: PDF.length, sha256: pdfHash(PDF), isPrivate: false, contentBase64: PDF.toString("base64"), ...patch });
const operations = (patch) => [{ type: PDF_UPLOAD_TYPE, payload: payload(patch) }];
const plan = (input = payload()) => {
  const { metadata } = validatePdfPayload(input);
  return { mode: "dry_run", batchMode: "assigned_single_file_v2", fileCount: 1, operationCount: 1,
    displayComplete: true, executionSemantics: "sequential_fail_stop_no_rollback",
    files: [{ id: "contact-2739", number: "2739", operationIndexes: [0], operationTypes: [PDF_UPLOAD_TYPE] }],
    operations: [{ type: PDF_UPLOAD_TYPE, plan: { mode: "dry_run", file: { id: "contact-2739", number: "2739" },
      plan: { endpoint: "/files/v1/uploads/url", ...metadata, beforeIds: [], body: pdfProviderBody("contact-2739", metadata) } } }] };
};

test("PDF activation requires complete reviewed pins and the inactive candidate stays closed", async () => {
  assert.equal(PDF_UPLOADS_ENABLED, validatePdfRelease(PDF_UPLOAD_RELEASE));
  const inactive = { ...PDF_UPLOAD_RELEASE, enabled: false, policySha256: "", bridgeCommit: "" };
  assert.equal(validatePdfRelease(inactive), false);
  for (const patch of [{ enabled: true }, { enabled: true, policySha256: "a".repeat(64) }, { enabled: true, policyId: "arbitrary" }]) {
    assert.throws(() => validatePdfRelease({ ...inactive, ...patch }));
  }
  const coordinator = createOperatorCoordinator({ version: "fixture", bridgeRequest: () => { throw new Error("MUST NOT CONNECT"); } });
  if (!PDF_UPLOADS_ENABLED) await assert.rejects(coordinator.planPdfUpload({}), /not activated/);
  await assert.rejects(coordinator.executePdfUpload("x"), /No current/);
});

test("PDF payload strictly binds content, exact file, metadata, MIME, bounds and no overrides", () => {
  assert.deepEqual(validatePdfPayload(payload()).bytes, PDF);
  for (const change of [{ query: "#2628" }, { query: "customer" }, { filename: "../file.pdf" }, { filename: "wrong.txt" },
    { filename: "tricky\n.pdf" }, { contentType: "text/html" }, { isPrivate: "false" }, { sizeBytes: PDF_MAX_BYTES + 1 },
    { sizeBytes: PDF.length + 1 }, { sha256: "b".repeat(64) }, { contentBase64: "AAAA==" },
    { contentBase64: PDF.toString("base64") + "\n" }, { contentBase64: "" }, { fileId: "other-client" },
    { url: "https://evil.example" }, { execute: true }, { operatorScope: "company" }]) {
    assert.throws(() => validatePdfPayload(payload(change)));
  }
  for (const content of ["<html>not PDF</html>", "%PDF-1.4\nno final marker"]) {
    const bytes = Buffer.from(content);
    assert.throws(() => validatePdfPayload(payload({ contentBase64: bytes.toString("base64"), sizeBytes: bytes.length, sha256: pdfHash(bytes) })));
  }
});

test("full-size PDF framing remains bounded without regex recursion", () => {
  const bytes = Buffer.alloc(PDF_MAX_BYTES, 32);
  bytes.write("%PDF-1.4\n"); bytes.write("%%EOF\n", bytes.length - 6);
  assert.equal(validatePdfPayload(payload({ sizeBytes: bytes.length, sha256: pdfHash(bytes), contentBase64: bytes.toString("base64") })).bytes.length, PDF_MAX_BYTES);
});

test("local snapshot accepts one regular PDF and rejects symlinks, devices, directories and URLs", async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "local-pdf-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.pdf");
  await writeFile(file, PDF);
  const input = { query: "#2739", path: file, filename: "Reviewed.pdf", isPrivate: false };
  assert.deepEqual(await readLocalPdf(input), payload());
  const linked = path.join(root, "link.pdf"); await symlink(file, linked);
  for (const source of [linked, root, "/dev/null", "relative.pdf", "https://example.com/file.pdf"]) {
    await assert.rejects(readLocalPdf({ ...input, path: source }));
  }
  await assert.rejects(readLocalPdf({ ...input, command: "anything" }));
});

test("plan refuses every materially altered display; receipts require verified bytes", () => {
  assertPdfPlan(plan(), operations());
  for (const mutate of [
    (r) => { r.operations[0].plan.plan.sha256 = "c".repeat(64); },
    (r) => { r.operations[0].plan.plan.filename = "Changed.pdf"; },
    (r) => { r.operations[0].plan.plan.body.related = ["wrong-client"]; },
    (r) => { r.operations[0].plan.file.id = "wrong-client"; },
    (r) => { r.files[0].number = "2741"; },
    (r) => { r.operations[0].plan.plan.body.isPrivate = true; },
    (r) => { r.operations[0].plan.plan.contentBase64 = "not for chat"; },
    (r) => { r.operations.push(r.operations[0]); },
    (r) => { r.displayComplete = false; }
  ]) { const value = plan(); mutate(value); assert.throws(() => assertPdfPlan(value, operations())); }
  const expected = validatePdfPayload(payload()).metadata;
  const receipt = { ...expected, externalId: "provider-doc-1", contentVerified: true, verifiedByReadback: true };
  assertPdfReceipt(receipt, expected);
  for (const patch of [{ externalId: "" }, { contentVerified: false }, { sha256: "d".repeat(64) }, { isPrivate: true }, { verifiedByReadback: false }]) {
    assert.throws(() => assertPdfReceipt({ ...receipt, ...patch }, expected));
  }
});

async function enabledCandidate(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "enabled-pdf-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ["scope.mjs", "operator-coordinator.mjs", "approved-note-release.mjs", "approved-note-plan.mjs", "pdf-upload-contract.mjs", "local-pdf.mjs"]) {
    await copyFile(new URL(`./${file}`, import.meta.url), path.join(root, file));
  }
  const release = await readFile(new URL("./pdf-upload-release.mjs", import.meta.url), "utf8");
  await writeFile(path.join(root, "pdf-upload-release.mjs"), release.replace("enabled: false", "enabled: true")
    .replace('policySha256: ""', `policySha256: "${"a".repeat(64)}"`).replace('bridgeCommit: ""', `bridgeCommit: "${"b".repeat(40)}"`));
  // Reuse the established full boot/build/identity/runtime/legacy fixtures;
  // register none of that file's tests and never contact a real bridge.
  const source = await readFile(new URL("./operator-coordinator.test.mjs", import.meta.url), "utf8");
  const cut = source.indexOf('\ntest("verified session');
  assert.ok(cut > 0);
  await writeFile(path.join(root, "fixtures.mjs"), source.slice(0, cut)
    .replace('import { APPROVED_NOTES_ENABLED } from "./approved-note-release.mjs";', "const APPROVED_NOTES_ENABLED = true;")
    + `\nconst originalRunPolicy = runPolicy; runPolicy = () => ({...originalRunPolicy(), pdfUploadAllowed:true, pdfUploadSoleOperation:true, pdfUploadContentReadbackRequired:true, pdfUploadMaxBytes:8388608});\nexport {whoamiFixture,sessionFixture,policyFixture};`);
  const fixtures = await import(pathToFileURL(path.join(root, "fixtures.mjs")));
  const scope = await import(pathToFileURL(path.join(root, "scope.mjs")));
  const { createOperatorCoordinator: create } = await import(pathToFileURL(path.join(root, "operator-coordinator.mjs")));
  const state = { whoami: fixtures.whoamiFixture(), session: fixtures.sessionFixture(), policy: fixtures.policyFixture(), corruptPlan: null, corruptReceipt: null, now: Date.now() };
  const requests = [];
  const approvals = new Map();
  const coordinator = create({ version: "synthetic", approvals, now: () => state.now, bridgeRequest: async (method, route, body) => {
    requests.push({ method, route, body: structuredClone(body) });
    if (method === "GET") return structuredClone(route === "/auth/whoami" ? state.whoami : route === "/api/v1/session" ? state.session : state.policy);
    const original = { ...body.operations[0].payload }; delete original.operatorScope;
    const metadata = validatePdfPayload(original).metadata;
    if (!body.execute) {
      const result = { ...plan(original), runPolicy: state.policy.runPolicy, approvalDigest: "1".repeat(64),
        approvalChallenge: "hidden-challenge", approvalExpiresAt: new Date(state.now + 60000).toISOString() };
      state.corruptPlan?.(result); return result;
    }
    const result = { mode: "executed", batch: { schemaVersion: 2, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", principalHash: "c".repeat(64), operatorScope: "assigned",
      bootId: state.policy.bridgeBootId, status: "completed", operationCount: 1, fileCount: 1,
      batchMode: "assigned_single_file_v2", runPolicyId: scope.CHANCE_RUN_POLICY.id, runPolicySha256: scope.CHANCE_RUN_POLICY.sha256,
      runPolicyExpiresAt: "2099-01-01T00:00:00Z", approvalDigest: body.approvalDigest, files: plan(original).files,
      intents: [{ index: 0, type: PDF_UPLOAD_TYPE, fileId: "contact-2739", fileNumber: "2739", reconciliation: { ...metadata, beforeIds: [] }, intentDigest: "d".repeat(64) }],
      completed: [{ index: 0, type: PDF_UPLOAD_TYPE, status: "executed", receipt: { mode: "executed", ...metadata,
        fileId: "contact-2739", fileNumber: "2739", externalId: "provider-doc-1", verifiedByReadback: true, contentVerified: true } }],
      notAttempted: [], completedAt: new Date().toISOString() } };
    state.corruptReceipt?.(result); return result;
  } });
  const file = path.join(root, "source.pdf"); await writeFile(file, PDF);
  const input = { query: "#2739", path: file, filename: "Reviewed.pdf", isPrivate: false };
  return { state, requests, approvals, coordinator, input, scope };
}

test("activated local snapshot executes only approved bytes, reattests, consumes once, and never prints content", async (t) => {
  const f = await enabledCandidate(t);
  const result = await f.coordinator.planPdfUpload(f.input);
  assert.equal(JSON.stringify(result).includes(PDF.toString("base64")), false);
  assert.equal(JSON.stringify(result).includes("hidden-challenge"), false);
  await writeFile(f.input.path, Buffer.from("changed local file after approval"));
  const executed = await f.coordinator.executePdfUpload(result.approvalDigest);
  assertPdfReceipt(executed.batch.completed[0].receipt, payload());
  const posts = f.requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.operations[0].payload.contentBase64, PDF.toString("base64"));
  assert.equal(f.requests.filter((r) => r.method === "GET").length, 6);
  assert.equal(f.approvals.size, 0);
  await assert.rejects(f.coordinator.executePdfUpload(result.approvalDigest));
});

for (const scenario of ["boot_changed", "expanded_capabilities", "expired", "restart", "invalid_new_plan", "wrong_display", "wrong_receipt", "wrong_receipt_file_id"]) {
  test(`activated PDF ${scenario} fails closed and consumes the approval`, async (t) => {
    const f = await enabledCandidate(t);
    if (scenario === "wrong_display") f.state.corruptPlan = (r) => { r.operations[0].plan.plan.sha256 = "b".repeat(64); };
    if (scenario === "wrong_display") {
      await assert.rejects(f.coordinator.planPdfUpload(f.input)); assert.equal(f.approvals.size, 0); return;
    }
    const result = await f.coordinator.planPdfUpload(f.input);
    if (scenario === "boot_changed") f.state.policy.bridgeBootId = "boot-2";
    if (scenario === "expanded_capabilities") f.state.session.authorizedCapabilities.push("jobnimbus.documents.upload");
    if (scenario === "expired") f.state.now += 61000;
    if (scenario === "restart") await f.coordinator.restartVerifiedBridgeSession();
    if (scenario === "invalid_new_plan") await assert.rejects(f.coordinator.planPdfUpload({ ...f.input, path: "/missing.pdf" }));
    if (scenario === "wrong_receipt") f.state.corruptReceipt = (r) => { r.batch.completed[0].receipt.sha256 = "e".repeat(64); };
    if (scenario === "wrong_receipt_file_id") f.state.corruptReceipt = (r) => { r.batch.files[0].id = "wrong-file-id"; };
    await assert.rejects(f.coordinator.executePdfUpload(result.approvalDigest));
    assert.equal(f.approvals.size, 0);
    assert.equal(f.requests.filter((r) => r.body?.execute).length, scenario.startsWith("wrong_receipt") ? 1 : 0);
  });
}

test("activated scope verifies receipt recovery hashes and rejects mixed or wrong-file input", async (t) => {
  const f = await enabledCandidate(t);
  assert.equal(f.scope.CHANCE_RUN_ACTION_TYPES.length, 7);
  assert.throws(() => f.scope.scopedOperations([...operations(), ...operations()], "assigned"));
  assert.throws(() => f.scope.scopedOperations(operations(), "company"));
  const planned = await f.coordinator.planPdfUpload(f.input);
  const executed = await f.coordinator.executePdfUpload(planned.approvalDigest);
  const batch = executed.batch;
  const result = { mode: "reconciled", outcome: "applied_verified", receipt: {
    batchId: batch.id, status: "completed", batchMode: batch.batchMode, operatorScope: "assigned", current: null,
    operationCount: 1, fileCount: 1, files: batch.files, completedCount: 1, completed: batch.completed,
    intents: [{ index: 0, type: PDF_UPLOAD_TYPE, fileNumber: "2739", intentDigest: "d".repeat(64), ...validatePdfPayload(payload()).metadata }],
    notAttempted: [], automaticRetryAllowed: false, freshApprovalRequired: false,
    approvalDigest: planned.approvalDigest, runPolicyId: batch.runPolicyId, runPolicySha256: batch.runPolicySha256
  } };
  f.scope.assertReconciliationReceiptAttestation(result, batch.id);
  result.receipt.intents[0].sha256 = "e".repeat(64);
  assert.throws(() => f.scope.assertReconciliationReceiptAttestation(result, batch.id));
});
