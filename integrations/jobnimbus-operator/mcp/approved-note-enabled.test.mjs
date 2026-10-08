import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { approvedNoteMentionIntent } from "./approved-note-release.mjs";

// Synthetic source-only release: never touches real pins, credentials, or APIs.
test("activated candidate validates exact note intent, readback and notification truth", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "operator-note-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await readFile(new URL("./approved-note-release.mjs", import.meta.url), "utf8");
  await writeFile(path.join(directory, "approved-note-release.mjs"), release
    .replace(/enabled: (?:false|true)/, "enabled: true")
    .replace(/policySha256: "[a-f0-9]*"/, `policySha256: "${"a".repeat(64)}"`)
    .replace(/bridgeCommit: "[a-f0-9]*"/, `bridgeCommit: "${"b".repeat(40)}"`));
  await copyFile(new URL("./scope.mjs", import.meta.url), path.join(directory, "scope.mjs"));
  // This fixture deliberately tests the note-only candidate, regardless of
  // whether the parent package is the later coordinated PDF release.
  const pdfRelease = await readFile(new URL("./pdf-upload-release.mjs", import.meta.url), "utf8");
  await writeFile(path.join(directory, "pdf-upload-release.mjs"), pdfRelease
    .replace(/enabled: (?:false|true)/, "enabled: false"));
  await copyFile(new URL("./pdf-upload-contract.mjs", import.meta.url), path.join(directory, "pdf-upload-contract.mjs"));
  const scope = await import(pathToFileURL(path.join(directory, "scope.mjs")));
  for (const note of ["Paused due to license.", "Check received. @RichardR Please review."]) {
  await t.test(note.includes("@") ? "canonical Richard mention request" : "plain note", () => {
  const mentionIntent = approvedNoteMentionIntent(note);
  const operations = [{ type: "jobnimbus.create_note", payload: { query: "#2745", note } }];
  assert.equal(scope.CHANCE_RUN_POLICY.id, "chance-58-files-notes-v1");
  assert.equal(scope.CHANCE_RUN_ACTION_TYPES.length, 6);
  assert.equal(scope.scopedOperations(operations, "assigned")[0].payload.note, note);
  const policy = {
    available: true, enforced: true, ...scope.CHANCE_RUN_POLICY,
    expiresAt: new Date(Date.now() + 60000).toISOString(), fileCount: 58,
    excludedFileNumbers: ["2628"], allowedActionTypes: [...scope.CHANCE_RUN_ACTION_TYPES],
    allowedContactFields: [...scope.CHANCE_RUN_ALLOWED_CONTACT_FIELDS],
    allowedStageEvidenceSources: [...scope.CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES],
    taskCompletionAllowed: false, outboundSendAllowed: false, existingDraftSendAllowed: true,
    rawGmailSendAllowed: false, noteCreationAllowed: true, noteMentionsAllowed: false,
    noteMentionRequestsAllowed: true,
    noteCreationSoleOperation: true, backwardStageMovesAllowed: false, stageEvidenceRequired: true
  };
  scope.assertRunPolicyAttestation({ ready: true, runPolicy: policy }, { requireFullSurface: true });
  assert.throws(() => scope.assertRunPolicyAttestation({ ready: true, runPolicy: { ...policy, noteMentionsAllowed: true } }, { requireFullSurface: true }));
  assert.throws(() => scope.assertRunPolicyAttestation({ ready: true, runPolicy: { ...policy, noteMentionRequestsAllowed: false } }, { requireFullSurface: true }));
  const noteSha256 = createHash("sha256").update(note).digest("hex");
  const response = {
    mode: "executed",
    batch: {
      schemaVersion: 2, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", principalHash: "c".repeat(64),
      operatorScope: "assigned", bootId: "test-boot", status: "completed", operationCount: 1,
      batchMode: "assigned_single_file_v2", runPolicyId: scope.CHANCE_RUN_POLICY.id,
      runPolicySha256: scope.CHANCE_RUN_POLICY.sha256,
      runPolicyExpiresAt: policy.expiresAt, approvalDigest: "test-digest", fileCount: 1,
      files: [{ id: "test-contact-2745", number: "2745", operationIndexes: [0], operationTypes: ["jobnimbus.create_note"] }],
      intents: [{ index: 0, type: "jobnimbus.create_note", fileId: "test-contact-2745", fileNumber: "2745", reconciliation: { noteSha256, ...mentionIntent }, intentDigest: "d".repeat(64) }],
      completed: [{ index: 0, type: "jobnimbus.create_note", status: "executed", receipt: {
        mode: "executed", fileId: "test-contact-2745", fileNumber: "2745", verifiedByReadback: true,
        externalId: "test-provider-note", noteSha256, ...mentionIntent, mentionsVerified: false, accountingNotified: false
      } }],
      notAttempted: [], completedAt: new Date().toISOString()
    }
  };
  const options = { operations, bridgeBootId: "test-boot" };
  scope.assertExecutionReceiptAttestation(response, "test-digest", options);
  for (const patch of [
    { noteSha256: "e".repeat(64) }, { externalId: "" }, { accountingNotified: true },
    { mentionsVerified: true }, { verifiedByReadback: false }, { fileId: "different-file" },
    { mentionRequested: !mentionIntent.mentionRequested },
    { intendedRecipient: { id: "wrong-user", displayName: "Richard R", tag: "@RichardR" } }
  ]) {
    const invalid = structuredClone(response);
    Object.assign(invalid.batch.completed[0].receipt, patch);
    assert.throws(() => scope.assertExecutionReceiptAttestation(invalid, "test-digest", options));
  }
  for (const patch of [{ noteSha256: "e".repeat(64) }, { mentionRequested: !mentionIntent.mentionRequested }, { intendedRecipient: undefined }]) {
    const invalid = structuredClone(response);
    Object.assign(invalid.batch.intents[0].reconciliation, patch);
    assert.throws(() => scope.assertExecutionReceiptAttestation(invalid, "test-digest", options));
  }
  assert.throws(() => scope.assertExecutionReceiptAttestation(response, "test-digest", {
    ...options, operations: [{ type: "jobnimbus.create_note", payload: { query: "#2745", note: `${note} Changed.` } }]
  }));
  const reconciled = {
    mode: "reconciled", outcome: "applied_verified",
    receipt: {
      batchId: response.batch.id, status: "completed", batchMode: "assigned_single_file_v2",
      operatorScope: "assigned", current: null, operationCount: 1, fileCount: 1,
      files: [{ number: "2745", operationIndexes: [0], operationTypes: ["jobnimbus.create_note"] }],
      intents: [{ index: 0, type: "jobnimbus.create_note", fileNumber: "2745", intentDigest: "d".repeat(64), noteSha256, ...mentionIntent }],
      completedCount: 1, completed: structuredClone(response.batch.completed), notAttempted: [],
      automaticRetryAllowed: false, freshApprovalRequired: false, approvalDigest: "test-digest",
      runPolicyId: scope.CHANCE_RUN_POLICY.id, runPolicySha256: scope.CHANCE_RUN_POLICY.sha256
    }
  };
  scope.assertReconciliationReceiptAttestation(reconciled, response.batch.id);
  for (const hash of [undefined, "e".repeat(64)]) {
    const invalid = structuredClone(reconciled);
    invalid.receipt.intents[0].noteSha256 = hash;
    assert.throws(() => scope.assertReconciliationReceiptAttestation(invalid, response.batch.id));
  }
  for (const target of ["intent", "receipt"]) {
    for (const patch of [
      { mentionRequested: !mentionIntent.mentionRequested },
      { intendedRecipient: undefined },
      { intendedRecipient: { id: "wrong-user", displayName: "Richard R", tag: "@RichardR" } }
    ]) {
      const invalid = structuredClone(reconciled);
      Object.assign(target === "intent" ? invalid.receipt.intents[0] : invalid.receipt.completed[0].receipt, patch);
      assert.throws(() => scope.assertReconciliationReceiptAttestation(invalid, response.batch.id));
    }
  }
  });
  }
});
