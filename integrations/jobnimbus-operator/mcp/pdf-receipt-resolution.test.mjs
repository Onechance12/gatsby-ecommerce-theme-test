import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDF_RESOLUTION_KIND, validatePdfResolutionInput, pdfResolutionSource, pdfResolutionProof,
  pdfResolutionDigest, resolutionHash, validPdfReceiptResolution, assertPdfResolutionPlan,
  assertPdfResolutionReceipt, validatePdfDiagnosticInput, assertPdfDiagnostic, PDF_DIAGNOSTIC_CHECKS } from "./pdf-receipt-resolution.mjs";
import { PDF_UPLOAD_TYPE } from "./pdf-upload-contract.mjs";
import { PDF_RECEIPT_RESOLUTION_ENABLED, createOperatorCoordinator } from "./operator-coordinator.mjs";
import { validatePdfReceiptResolutionRelease } from "./pdf-receipt-resolution-release.mjs";

const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST = { batchId: BATCH, query: "#990001", documentId: "synthetic-document-1", acceptedIsPrivate: false };
const metadata = { filename: "Synthetic-LOR.pdf", contentType: "application/pdf", isPrivate: true, sizeBytes: 250, sha256: "c".repeat(64) };
function sourceRow() {
  const stable = { index: 0, type: PDF_UPLOAD_TYPE, fileId: "contact-synthetic-alpha", fileNumber: "990001",
    reconciliation: { ...metadata, beforeIds: ["previous-document"] } };
  return { schemaVersion: 2, id: BATCH, bootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    approvalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", failedAt: 0,
    principalHash: "d".repeat(64), operatorScope: "assigned", approvalDigest: "e".repeat(64),
    operationCount: 1, fileCount: 1, batchMode: "assigned_single_file_v2", status: "manual_quarantined",
    runPolicyId: "chance-live-assigned-sms-v1", runPolicySha256: "a".repeat(64),
    files: [{ id: stable.fileId, number: 990001, operationIndexes: [0], operationTypes: [PDF_UPLOAD_TYPE] }],
    intents: [{ ...stable, intentDigest: resolutionHash({ version: 1, stable }) }], completed: [], notAttempted: [],
    manualQuarantine: { index: 0, type: PDF_UPLOAD_TYPE, scope: "file", reasonCode: "provider_state_unprovable",
      fileId: stable.fileId, fileNumber: stable.fileNumber, fileIds: [stable.fileId], fileNumbers: [stable.fileNumber],
      quarantinedAt: "2026-10-16T18:00:00Z" },
    recovery: { fileScopedQuarantine: true, resolvedOutcome: "unknown_file_quarantined", automaticRetryAllowed: false } };
}
function boundary(row = sourceRow()) {
  return { bridgeBootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runPolicyId: row.runPolicyId,
    runPolicySha256: row.runPolicySha256, principalHash: row.principalHash };
}
function plan(row = sourceRow(), binding = boundary(row)) {
  const proof = pdfResolutionProof(row, REQUEST);
  return { mode: "pdf_resolution_plan", displayComplete: true, proof, boundary: binding,
    file: { id: proof.fileId, number: 990001, name: "Synthetic Client" }, approvalDigest: pdfResolutionDigest(proof, binding) };
}
function receipt(prepared = plan()) {
  const resolution = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: PDF_RESOLUTION_KIND,
    proof: prepared.proof, boundary: prepared.boundary, approvalDigest: prepared.approvalDigest,
    approvalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", resolvedAt: "2026-10-16T19:00:00Z" };
  resolution.resolutionSha256 = resolutionHash(resolution);
  return { mode: "pdf_resolution_verified", resolution, fileHoldReleased: true, providerWrites: false,
    originalReceiptStatus: "manual_quarantined", originalUploadReplayAllowed: false };
}

const DIAGNOSTIC_REQUEST = { batchId: BATCH, query: REQUEST.query, documentId: REQUEST.documentId };
function diagnosticResponse() {
  const row = sourceRow();
  const source = pdfResolutionSource(row);
  return { mode: "pdf_receipt_diagnostic", batchId: BATCH, fileId: source.file.id, fileNumber: source.file.number,
    documentId: REQUEST.documentId, sourceRowSha256: source.sourceRowSha256, sourceIntentDigest: source.intent.intentDigest,
    identityProvenance: "human_selected_live_candidate_no_durable_reservation_id", originalMetadata: source.metadata,
    observedIsPrivate: false, metadataChecks: Object.fromEntries(PDF_DIAGNOSTIC_CHECKS.map((key) => [key, key !== "privacy_matches"])),
    download: { status: "blocked", contentVerified: false, diagnostic: { reason: "untrusted_destination", operation: "read", destination: "untrusted",
      hop: 1, urlRejection: "disallowed_hostname", hostCategory: "jobnimbus_api3", hostFingerprint: "f".repeat(64) } },
    readOnly: true, providerWrites: false, receiptWrites: false, approvalRequired: false, fileHoldReleased: false, originalUploadReplayAllowed: false };
}

test("PDF diagnosis input has no approval, privacy-acceptance or execution authority", () => {
  assert.deepEqual(validatePdfDiagnosticInput(DIAGNOSTIC_REQUEST), DIAGNOSTIC_REQUEST);
  for (const patch of [{ acceptedIsPrivate: false }, { execute: true }, { operatorScope: "company" }, { query: "#2628" }, { documentId: "bad" }]) {
    assert.throws(() => validatePdfDiagnosticInput({ ...DIAGNOSTIC_REQUEST, ...patch }));
  }
  assertPdfDiagnostic(diagnosticResponse(), DIAGNOSTIC_REQUEST);
  for (const mutate of [
    (r) => { r.fileHoldReleased = true; }, (r) => { r.approvalRequired = true; }, (r) => { r.providerWrites = true; },
    (r) => { r.receiptWrites = true; }, (r) => { r.approvalDigest = "a".repeat(64); },
    (r) => { r.download.contentVerified = true; }, (r) => { r.fileNumber = "990002"; },
    (r) => { r.download.diagnostic.url = "https://private.example/?token=secret"; },
    (r) => { r.download.diagnostic.hostCategory = "private.example"; },
    (r) => { r.download.diagnostic.operation = "put"; },
    (r) => { r.metadataChecks.privacy_matches = true; }
  ]) { const result = diagnosticResponse(); mutate(result); assert.throws(() => assertPdfDiagnostic(result, DIAGNOSTIC_REQUEST)); }
});

test("resolution activation stays independent; inactive candidate cannot connect or execute", async () => {
  const coordinator = createOperatorCoordinator({ version: "synthetic", bridgeRequest: () => { throw new Error("MUST NOT CONNECT"); } });
  if (!PDF_RECEIPT_RESOLUTION_ENABLED) await assert.rejects(coordinator.planPdfReceiptResolution(REQUEST), /not activated/);
  if (!PDF_RECEIPT_RESOLUTION_ENABLED) await assert.rejects(coordinator.diagnosePdfReceipt(DIAGNOSTIC_REQUEST), /not activated/);
  await assert.rejects(coordinator.executePdfReceiptResolution("unknown"), /No unconsumed/);
});

test("resolution activation rejects incomplete pins and mismatch with the cumulative active release", () => {
  const candidate = { enabled: true, bridgeCommit: "b".repeat(40), policyId: "chance-live-assigned-sms-v1", policySha256: "a".repeat(64) };
  const build = { sourceCommit: candidate.bridgeCommit }, policy = { id: candidate.policyId, sha256: candidate.policySha256 };
  assert.equal(validatePdfReceiptResolutionRelease({ enabled: false }, {}, {}), false);
  assert.equal(validatePdfReceiptResolutionRelease(candidate, build, policy), true);
  for (const patch of [{ bridgeCommit: "" }, { policySha256: "" }, { policyId: "company" }, { enabled: "true" }, { bridgeCommit: "f".repeat(40) }]) {
    assert.throws(() => validatePdfReceiptResolutionRelease({ ...candidate, ...patch }, build, policy));
  }
  assert.throws(() => validatePdfReceiptResolutionRelease(candidate, { sourceCommit: "f".repeat(40) }, policy));
  assert.throws(() => validatePdfReceiptResolutionRelease(candidate, build, { ...policy, sha256: "f".repeat(64) }));
});

test("resolution input admits only one exact file/candidate and explicit existing nonprivate acceptance", () => {
  assert.deepEqual(validatePdfResolutionInput(REQUEST), REQUEST);
  for (const patch of [{ batchId: "other" }, { query: "#2628" }, { query: "name" }, { documentId: "" },
    { acceptedIsPrivate: true }, { acceptedIsPrivate: "false" }, { execute: true }, { isPrivate: false },
    { operatorScope: "company" }, { contentBase64: "no" }, { approvalChallenge: "override" }]) {
    assert.throws(() => validatePdfResolutionInput({ ...REQUEST, ...patch }));
  }
});

test("source validation requires immutable sole-PDF file quarantine, not global/history/current/completed intent", () => {
  assert.equal(pdfResolutionSource(sourceRow()).metadata.isPrivate, true);
  for (const mutate of [
    (r) => { r.current = { status: "executing" }; }, (r) => { r.status = "completed"; },
    (r) => { r.completed = [{}]; }, (r) => { r.notAttempted = [{}]; },
    (r) => { r.operationCount = 2; }, (r) => { r.fileCount = 2; }, (r) => { r.operatorScope = "company"; },
    (r) => { r.manualQuarantine.scope = "global"; }, (r) => { r.manualQuarantine.fileIds.push("other-file"); },
    (r) => { r.manualQuarantine.fileNumbers = ["990002"]; }, (r) => { r.manualQuarantine.reasonCode = "immutable_intent_invalid"; },
    (r) => { r.intents[0].reconciliation.sha256 = "f".repeat(64); },
    (r) => { r.intents[0].reconciliation.beforeIds.push("new-id"); },
    (r) => { r.intents[0].intentDigest = "f".repeat(64); },
    (r) => { r.files[0].operationTypes = ["gmail.create_draft"]; },
    (r) => { r.recovery.fileScopedQuarantine = false; }, (r) => { r.manualQuarantine.providerDocumentId = "bad"; }
  ]) { const row = sourceRow(); mutate(row); assert.throws(() => pdfResolutionSource(row)); }
  const row = sourceRow();
  assert.throws(() => pdfResolutionProof(row, { ...REQUEST, documentId: "previous-document" }));
  row.manualQuarantine.providerDocumentId = "another-document";
  assert.throws(() => pdfResolutionProof(row, REQUEST));
});

test("resolution leaves historical missing ID explicit and hashes every unchanged original field", () => {
  const row = sourceRow();
  const prepared = plan(row);
  assert.equal(prepared.proof.identityProvenance, "human_selected_live_candidate_no_durable_reservation_id");
  const saved = receipt(prepared);
  row.pdfReceiptResolution = saved.resolution;
  assert.equal(validPdfReceiptResolution(row), true);
  const { pdfReceiptResolution, ...original } = row;
  assert.deepEqual(original, sourceRow());
  for (const mutate of [
    (r) => { r.status = "completed"; }, (r) => { r.manualQuarantine.reason = "silently changed"; },
    (r) => { r.intents[0].reconciliation.isPrivate = false; },
    (r) => { r.pdfReceiptResolution.proof.acceptedMetadata.isPrivate = true; },
    (r) => { r.pdfReceiptResolution.boundary.principalHash = "1".repeat(64); },
    (r) => { r.pdfReceiptResolution.proof.providerWrites = true; },
    (r) => { r.pdfReceiptResolution.approvalDigest = "1".repeat(64); },
    (r) => { r.pdfReceiptResolution.resolutionSha256 = "1".repeat(64); },
    (r) => { r.pdfReceiptResolution.extra = "not reviewed"; }
  ]) { const changed = structuredClone(row); mutate(changed); assert.equal(validPdfReceiptResolution(changed), false); }
});

test("native display and completion validation reject altered proof, privacy, provenance, boundary and receipt", () => {
  assertPdfResolutionPlan(plan(), REQUEST, boundary());
  assertPdfResolutionReceipt(receipt(), plan());
  for (const mutate of [
    (r) => { r.proof.acceptedMetadata.isPrivate = true; }, (r) => { r.proof.originalMetadata.isPrivate = false; },
    (r) => { r.proof.fileNumber = "990002"; }, (r) => { r.proof.identityProvenance = "historical_id_restored"; },
    (r) => { r.proof.uniqueCandidate = false; }, (r) => { r.proof.accessChanged = true; },
    (r) => { r.proof.originalUploadReplayAllowed = true; }, (r) => { r.proof.extra = "hidden"; },
    (r) => { r.file.id = "another-file"; }, (r) => { r.boundary.bridgeBootId = "other-boot"; },
    (r) => { r.approvalDigest = "f".repeat(64); }, (r) => { r.displayComplete = false; }
  ]) { const changed = plan(); mutate(changed); assert.throws(() => assertPdfResolutionPlan(changed, REQUEST, boundary())); }
  for (const mutate of [
    (r) => { r.resolution.proof.contentVerified = false; }, (r) => { r.providerWrites = true; },
    (r) => { r.originalReceiptStatus = "completed"; }, (r) => { r.originalUploadReplayAllowed = true; },
    (r) => { r.fileHoldReleased = false; }, (r) => { r.resolution.approvalDigest = "1".repeat(64); },
    (r) => { r.resolution.resolutionSha256 = "1".repeat(64); }
  ]) { const changed = receipt(); mutate(changed); assert.throws(() => assertPdfResolutionReceipt(changed, plan())); }
});

async function enabled(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "enabled-pdf-resolution-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["scope.mjs", "communications-sweep-release.mjs", "gmail-rejected-review-release.mjs", "operator-coordinator.mjs", "pdf-receipt-resolution.mjs", "reviewed-claim-packet.mjs",
    "approved-note-release.mjs", "approved-note-plan.mjs", "pdf-upload-release.mjs", "pdf-upload-contract.mjs", "local-pdf.mjs", "quo-sms-contract.mjs"]) {
    await copyFile(new URL(`./${name}`, import.meta.url), path.join(root, name));
  }
  for (const name of ["quo-sms-release.mjs", "pdf-receipt-resolution-release.mjs"]) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
    const value = { enabled: true, policyId: "chance-live-assigned-sms-v1", policySha256: "a".repeat(64), bridgeCommit: "b".repeat(40),
      ...(name === "quo-sms-release.mjs" ? { assignmentMode: "live_assigned", assignmentOwnerId: "synthetic-owner" } : {}) };
    await writeFile(path.join(root, name), source.replace(/export const (QUO_SMS_RELEASE|PDF_RECEIPT_RESOLUTION_RELEASE) = Object.freeze\(\{[\s\S]*?\}\);/,
      (_, constant) => `export const ${constant} = Object.freeze(${JSON.stringify(value)});`));
  }
  const source = await readFile(new URL("./operator-coordinator.test.mjs", import.meta.url), "utf8");
  const cut = source.indexOf('\ntest("verified session');
  assert.ok(cut > 0);
  await writeFile(path.join(root, "fixtures.mjs"), source.slice(0, cut)
    + '\nconst originalRunPolicy = runPolicy; runPolicy = () => ({...originalRunPolicy(),schemaVersion:2,assignmentMode:"live_assigned",assignmentOwnerId:"synthetic-owner",freshAssignmentRequired:true,noteCreationAllowed:true,noteMentionsAllowed:false,noteMentionRequestsAllowed:true,noteCreationSoleOperation:true,pdfUploadAllowed:true,pdfUploadSoleOperation:true,pdfUploadContentReadbackRequired:true,pdfUploadMaxBytes:8388608,quoSmsAllowed:true,quoSmsSoleOperation:true,quoSmsExactSenderRequired:true,quoSmsProviderReadbackRequired:true,quoSmsDuplicateProtectionRequired:true});\nexport {whoamiFixture,sessionFixture,policyFixture};');
  const fixtures = await import(pathToFileURL(path.join(root, "fixtures.mjs")));
  const { createOperatorCoordinator: create } = await import(pathToFileURL(path.join(root, "operator-coordinator.mjs")));
  const state = { whoami: fixtures.whoamiFixture(), session: fixtures.sessionFixture(), policy: fixtures.policyFixture(),
    now: Date.parse("2090-01-01T00:00:00Z"), mutatePlan: null, mutateReceipt: null, mutateDiagnostic: null, failExecute: false };
  state.whoami.identity.jobNimbusOwnerId = "synthetic-owner";
  const requests = [], approvals = new Map();
  let prepared;
  const coordinator = create({ version: "synthetic", approvals, now: () => state.now, bridgeRequest: async (method, route, body) => {
    requests.push({ method, route, body: structuredClone(body) });
    if (method === "GET") return structuredClone(route === "/auth/whoami" ? state.whoami : route === "/api/v1/session" ? state.session : state.policy);
    if (route === "/ops/action-batch-receipts") {
      assert.deepEqual(body, { batchId: BATCH, pdfDiagnostic: { query: REQUEST.query, documentId: REQUEST.documentId },
        runPolicy: { id: "chance-live-assigned-sms-v1", sha256: "a".repeat(64) } });
      const result = diagnosticResponse(); state.mutateDiagnostic?.(result); return structuredClone(result);
    }
    assert.equal(route, "/ops/action-batch-reconcile");
    if (!body.execute) {
      const row = sourceRow();
      const identity = state.whoami.identity;
      row.principalHash = createHashForIdentity(identity);
      const binding = { ...boundary(row), bridgeBootId: state.policy.bridgeBootId };
      prepared = { ...plan(row, binding), approvalChallenge: "hidden-synthetic-challenge",
        approvalExpiresAt: new Date(state.now + 60_000).toISOString() };
      state.mutatePlan?.(prepared);
      return structuredClone(prepared);
    }
    if (state.failExecute) throw new Error("Synthetic uncertain internal storage result");
    const result = receipt(prepared); state.mutateReceipt?.(result); return structuredClone(result);
  } });
  return { state, requests, approvals, coordinator };
}
function createHashForIdentity(identity) {
  // resolutionHash hashes JSON; the existing identity boundary hashes raw UTF8.
  return rawIdentityHash([identity.type || "", identity.subject || "", (identity.email || "").toLowerCase(), identity.role || ""].join("|"));
}
import { createHash } from "node:crypto";
const rawIdentityHash = (text) => createHash("sha256").update(text).digest("hex");

test("native recovery retains hidden challenge, exact boundary and one-use approval across a user turn", async (t) => {
  const f = await enabled(t);
  const prepared = await f.coordinator.planPdfReceiptResolution(REQUEST);
  assert.equal(prepared.approvalChallenge, undefined);
  const result = await f.coordinator.executePdfReceiptResolution(prepared.approvalDigest, f.approvals.get(prepared.approvalDigest)?.approvalId);
  assertPdfResolutionReceipt(result, prepared);
  assert.equal(f.requests.filter((r) => r.body?.execute).length, 1);
  assert.equal(f.approvals.size, 0);
  await assert.rejects(f.coordinator.executePdfReceiptResolution(prepared.approvalDigest, f.approvals.get(prepared.approvalDigest)?.approvalId), /No unconsumed/);
});

test("native PDF diagnosis preserves the pending approval and uses only the read-only receipt route", async (t) => {
  const f = await enabled(t);
  const prepared = await f.coordinator.planPdfReceiptResolution(REQUEST);
  const before = [...f.approvals.keys()];
  const result = await f.coordinator.diagnosePdfReceipt(DIAGNOSTIC_REQUEST);
  assertPdfDiagnostic(result, DIAGNOSTIC_REQUEST);
  assert.deepEqual([...f.approvals.keys()], before);
  assert.equal(f.requests.filter((r) => r.route === "/ops/action-batch-receipts").length, 1);
  assert.equal(f.requests.filter((r) => r.body?.execute === true).length, 0);
  await f.coordinator.executePdfReceiptResolution(prepared.approvalDigest, f.approvals.get(prepared.approvalDigest)?.approvalId);
});

test("native PDF diagnosis rejects hostile or authority-bearing response fields", async (t) => {
  const f = await enabled(t);
  f.state.mutateDiagnostic = (result) => { result.download.diagnostic.url = "https://private.example/?secret=unsafe"; };
  await assert.rejects(f.coordinator.diagnosePdfReceipt(DIAGNOSTIC_REQUEST), /incomplete, changed/);
  assert.equal(f.approvals.size, 0);
  assert.equal(f.requests.filter((r) => r.body?.execute).length, 0);
});

for (const scenario of ["restart", "newer_plan", "expired", "boot", "build", "policy", "runtime", "bad_receipt", "unknown"]) {
  test(`native recovery lifecycle ${scenario} never retries an effect`, async (t) => {
    const f = await enabled(t);
    const prepared = await f.coordinator.planPdfReceiptResolution(REQUEST);
    if (scenario === "restart") await f.coordinator.restartVerifiedBridgeSession();
    if (scenario === "newer_plan") await assert.rejects(f.coordinator.planPdfReceiptResolution({ ...REQUEST, acceptedIsPrivate: true }));
    if (scenario === "expired") f.state.now += 61_000;
    if (scenario === "boot") f.state.policy.bridgeBootId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    if (scenario === "build") f.state.session.build.sourceCommit = "f".repeat(40);
    if (scenario === "policy") f.state.policy.runPolicy.sha256 = "f".repeat(64);
    if (scenario === "runtime") f.state.session.runtime.gates.gmailSend = "enabled";
    if (scenario === "bad_receipt") f.state.mutateReceipt = (r) => { r.providerWrites = true; };
    if (scenario === "unknown") f.state.failExecute = true;
    if (["restart", "newer_plan"].includes(scenario)) {
      await f.coordinator.executePdfReceiptResolution(prepared.approvalDigest, prepared.approvalId);
      assert.equal(f.requests.filter(r => r.body?.execute).length, 1);
      return;
    }
    await assert.rejects(f.coordinator.executePdfReceiptResolution(prepared.approvalDigest, f.approvals.get(prepared.approvalDigest)?.approvalId));
    assert.equal(f.approvals.size, 0);
    const posts = f.requests.filter((r) => r.body?.execute).length;
    assert.equal(posts, ["bad_receipt", "unknown"].includes(scenario) ? 1 : 0);
    await assert.rejects(f.coordinator.executePdfReceiptResolution(prepared.approvalDigest, f.approvals.get(prepared.approvalDigest)?.approvalId));
    assert.equal(f.requests.filter((r) => r.body?.execute).length, posts);
  });
}
