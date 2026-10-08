import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_NOTE_RELEASE, APPROVED_NOTES_ENABLED as LEGACY_NOTES_ENABLED } from "./approved-note-release.mjs";
import { PDF_UPLOAD_RELEASE, PDF_UPLOADS_ENABLED } from "./pdf-upload-release.mjs";
import {
  CHANCE_RUN_ACTION_TYPES,
  CHANCE_RUN_ALLOWED_CONTACT_FIELDS,
  CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES,
  CHANCE_RUN_EXCLUDED_FILE_NUMBERS,
  CHANCE_RUN_FILE_COUNT,
  CHANCE_RUN_POLICY,
  CHANCE_LEGACY_ISOLATION,
  CHANCE_LEGACY_ISOLATION_ENTRIES,
  EXPECTED_BRIDGE_BUILD,
  EXPECTED_OPERATOR_CAPABILITIES,
  assertExecutionReceiptAttestation,
  assertReconciliationReceiptAttestation,
  assertRestartBoundary,
  assertRunPolicyAttestation,
  scopedOperations
} from "./scope.mjs";

const RECOVERY_BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPROVED_NOTES_ENABLED = LEGACY_NOTES_ENABLED || PDF_UPLOADS_ENABLED;
const ACTIVE_RELEASE = PDF_UPLOADS_ENABLED ? PDF_UPLOAD_RELEASE : APPROVED_NOTE_RELEASE;

test("operator pins one immutable manifest, exact release actions, and one claim-call lane", () => {
  assert.deepEqual(CHANCE_RUN_POLICY, {
    id: APPROVED_NOTES_ENABLED ? ACTIVE_RELEASE.policyId : "chance-58-files-v1",
    sha256: APPROVED_NOTES_ENABLED ? ACTIVE_RELEASE.policySha256 : "40c8a7d418d9349b0b3315b693ce70486040092dcef250043f3397dc10a1c458"
  });
  assert.deepEqual(CHANCE_RUN_ACTION_TYPES, [
    "jobnimbus.update_contact",
    "jobnimbus.update_status",
    "jobnimbus.ensure_current_task",
    "gmail.create_draft",
    "gmail.send_existing_draft",
    ...(APPROVED_NOTES_ENABLED ? ["jobnimbus.create_note"] : []),
    ...(PDF_UPLOADS_ENABLED ? ["jobnimbus.upload_pdf"] : [])
  ]);
  assert.equal(CHANCE_RUN_ACTION_TYPES.includes("gmail.send"), false);
  assert.equal(CHANCE_RUN_ACTION_TYPES.includes("jobnimbus.update_task"), false);
  assert.equal(Object.isFrozen(CHANCE_RUN_POLICY), true);
  assert.equal(Object.isFrozen(CHANCE_RUN_ACTION_TYPES), true);
  assert.equal(CHANCE_RUN_FILE_COUNT, 58);
  assert.deepEqual(CHANCE_RUN_EXCLUDED_FILE_NUMBERS, ["2628"]);
  assert.equal(Object.isFrozen(CHANCE_RUN_EXCLUDED_FILE_NUMBERS), true);
  assert.equal(CHANCE_RUN_ALLOWED_CONTACT_FIELDS.length, 18);
  assert.equal(Object.isFrozen(CHANCE_RUN_ALLOWED_CONTACT_FIELDS), true);
  assert.deepEqual(CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES, [
    "jobnimbus_activity",
    "gmail_message",
    "quo_message"
  ]);
  assert.equal(Object.isFrozen(CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES), true);
  assert.deepEqual(EXPECTED_BRIDGE_BUILD, {
    service: "jobnimbus-chatgpt-bridge",
    apiVersion: "v1",
    schemaVersion: "0.1.0",
    sourceCommit: APPROVED_NOTES_ENABLED ? ACTIVE_RELEASE.bridgeCommit : "49465dded1707d5be6c019fd99de0baa90393c10",
    sourceCommitTrust: "provider_attested",
    attested: true
  });
  assert.equal(Object.isFrozen(EXPECTED_BRIDGE_BUILD), true);
  assert.deepEqual(EXPECTED_OPERATOR_CAPABILITIES.filter((value) => (
    value.includes("action_batch") || value.includes("run_policy")
  )), [
    "operations.action_batch.process",
    "operations.action_batch_receipts.read",
    "operations.action_batch_receipts.reconcile",
    "operations.run_policy.read"
  ]);
  assert.equal(EXPECTED_OPERATOR_CAPABILITIES.some((value) => value.includes(".send")), false);
  assert.deepEqual(EXPECTED_OPERATOR_CAPABILITIES.filter((value) => value.startsWith("claims.filing.")), [
    "claims.filing.call.place",
    "claims.filing.callbacks.read",
    "claims.filing.configuration.review",
    "claims.filing.prepare",
    "claims.filing.result.review"
  ]);
  assert.equal(EXPECTED_OPERATOR_CAPABILITIES.includes("claims.filing.writeback.process"), false);
  assert.equal(EXPECTED_OPERATOR_CAPABILITIES.includes("voice.call.place"), false);
  assert.deepEqual(CHANCE_LEGACY_ISOLATION, {
    id: "chance-58-prelock-receipts-v1",
    entryCount: 6,
    classification: "legacy_historical_attention_nonblocking",
    reasonCode: "pre_scope_receipt_unrecoverable_manual_risk_acceptance",
    entries: CHANCE_LEGACY_ISOLATION_ENTRIES
  });
  assert.equal(Object.isFrozen(CHANCE_LEGACY_ISOLATION), true);
  assert.equal(Object.isFrozen(CHANCE_LEGACY_ISOLATION_ENTRIES), true);
  assert.deepEqual(CHANCE_LEGACY_ISOLATION_ENTRIES, [
    {
      batchId: "bfd19ab5-0ec1-44fd-9c4c-e004870b26b2",
      rawRowSha256: "3589bf8066d9d1a734df1379a2cd8fec57bc6200e6758c19fd9a5d54e8f7b1ad"
    },
    {
      batchId: "7bbecc58-74ff-43be-ab60-462588c0f1b3",
      rawRowSha256: "dd99036b5dfd5d027bdcb4daf105989554d89db8c2872e3c203b27848befec79"
    },
    {
      batchId: "88993b24-dec4-4b95-b207-84ed282edc63",
      rawRowSha256: "6b15e43c7318bdb301ab2141e5d4911edc2b61c71bc6daf6d0e8604432401493"
    },
    {
      batchId: "62290621-12d8-4778-9c02-c3e18f7c583c",
      rawRowSha256: "4fada12c7f13ec6be04fb816042b7bb2d1e7d8e54417a77afc251380c8b45c8a"
    },
    {
      batchId: "08fb7310-5c11-4030-9ed2-b80733197c0a",
      rawRowSha256: "72f8d9461e16e9209e3fd09d3c530361dc447b1587888a65d2d40f84ef9a6ea7"
    },
    {
      batchId: "6ea93648-23bf-47b9-97a9-6106a092b335",
      rawRowSha256: "1b05c555209e0a44b26284a63699337299e0d5bcea63bd6be56a685d0b06a013"
    }
  ]);
  assert.equal(
    CHANCE_LEGACY_ISOLATION_ENTRIES.every((entry) => (
      Object.isFrozen(entry)
      && /^[a-f0-9-]{36}$/.test(entry.batchId)
      && /^[a-f0-9]{64}$/.test(entry.rawRowSha256)
    )),
    true
  );
});

function attestedResponse(overrides = {}) {
  return {
    ready: true,
    bridgeBootId: "boot-1",
    recoveryBoundary: {
      status: "ready",
      error: null
    },
    receipts: {
      total: 1,
      unresolvedCount: 1,
      unresolvedBatchIds: [RECOVERY_BATCH_ID],
      reconciliationEligibleCount: 1,
      reconciliationEligibleBatchIds: [RECOVERY_BATCH_ID],
      hardBlockedCount: 0,
      hardBlockedBatchIds: []
    },
    runPolicy: {
      available: true,
      enforced: true,
      id: CHANCE_RUN_POLICY.id,
      sha256: CHANCE_RUN_POLICY.sha256,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      fileCount: CHANCE_RUN_FILE_COUNT,
      excludedFileNumbers: ["2628"],
      allowedActionTypes: [...CHANCE_RUN_ACTION_TYPES],
      allowedContactFields: [...CHANCE_RUN_ALLOWED_CONTACT_FIELDS],
      allowedStageEvidenceSources: [...CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES],
      taskCompletionAllowed: false,
      outboundSendAllowed: false,
      existingDraftSendAllowed: true,
      rawGmailSendAllowed: false,
      noteCreationAllowed: APPROVED_NOTES_ENABLED,
      ...(APPROVED_NOTES_ENABLED ? { noteMentionsAllowed: false, noteMentionRequestsAllowed: true, noteCreationSoleOperation: true } : {}),
      ...(PDF_UPLOADS_ENABLED ? {
        pdfUploadAllowed: true,
        pdfUploadSoleOperation: true,
        pdfUploadContentReadbackRequired: true,
        pdfUploadMaxBytes: 8388608
      } : {}),
      backwardStageMovesAllowed: false,
      stageEvidenceRequired: true,
      ...overrides
    }
  };
}

test("full restart attestation requires exact roster and safety surface", () => {
  assert.equal(
    assertRunPolicyAttestation(attestedResponse(), {
      requireReady: true,
      requireFullSurface: true
    }).id,
    CHANCE_RUN_POLICY.id
  );
  assert.throws(
    () => assertRunPolicyAttestation(attestedResponse({
      excludedFileNumbers: ["2628", "9999"]
    }), { requireFullSurface: true }),
    /sole excluded file/i
  );
  assert.throws(
    () => assertRunPolicyAttestation(attestedResponse({
      allowedActionTypes: [...CHANCE_RUN_ACTION_TYPES, "gmail.send"]
    }), { requireFullSurface: true }),
    /pinned operator actions/i
  );
  assert.throws(
    () => assertRunPolicyAttestation(attestedResponse({
      allowedContactFields: [...CHANCE_RUN_ALLOWED_CONTACT_FIELDS, "is_closed"]
    }), { requireFullSurface: true }),
    /pinned safe fields/i
  );
  assert.throws(
    () => assertRunPolicyAttestation(attestedResponse({
      allowedStageEvidenceSources: [
        ...CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES,
        "quo_call"
      ]
    }), { requireFullSurface: true }),
    /pinned provider sources/i
  );
  assert.throws(
    () => assertRunPolicyAttestation(attestedResponse({ outboundSendAllowed: true }), {
      requireFullSurface: true
    }),
    /safety flags/i
  );
});

test("action attestation accepts the compact pinned policy and rejects expiry", () => {
  const compact = attestedResponse();
  delete compact.runPolicy.excludedFileNumbers;
  delete compact.runPolicy.allowedActionTypes;
  delete compact.runPolicy.allowedContactFields;
  delete compact.runPolicy.allowedStageEvidenceSources;
  delete compact.runPolicy.taskCompletionAllowed;
  delete compact.runPolicy.outboundSendAllowed;
  delete compact.runPolicy.existingDraftSendAllowed;
  delete compact.runPolicy.rawGmailSendAllowed;
  delete compact.runPolicy.noteCreationAllowed;
  delete compact.runPolicy.backwardStageMovesAllowed;
  delete compact.runPolicy.stageEvidenceRequired;
  assert.equal(assertRunPolicyAttestation(compact).id, CHANCE_RUN_POLICY.id);
  assert.throws(
    () => assertRunPolicyAttestation(attestedResponse({
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    })),
    /exact live 58-file/i
  );
  assert.throws(
    () => assertRunPolicyAttestation(attestedResponse({ expiresAt: "invalid" })),
    /exact live 58-file/i
  );
});

test("restart boundary requires a bridge boot and complete unresolved IDs", () => {
  const fullyReady = attestedResponse();
  fullyReady.receipts.unresolvedCount = 0;
  fullyReady.receipts.unresolvedBatchIds = [];
  fullyReady.receipts.reconciliationEligibleCount = 0;
  fullyReady.receipts.reconciliationEligibleBatchIds = [];
  assert.deepEqual(assertRestartBoundary(fullyReady), {
    bridgeBootId: "boot-1",
    ready: true,
    unresolvedCount: 0,
    unresolvedBatchIds: [],
    reconciliationEligibleCount: 0,
    reconciliationEligibleBatchIds: [],
    hardBlockedCount: 0,
    hardBlockedBatchIds: []
  });
  const recovery = attestedResponse();
  recovery.ready = false;
  assert.deepEqual(assertRestartBoundary(recovery), {
    bridgeBootId: "boot-1",
    ready: false,
    unresolvedCount: 1,
    unresolvedBatchIds: [RECOVERY_BATCH_ID],
    reconciliationEligibleCount: 1,
    reconciliationEligibleBatchIds: [RECOVERY_BATCH_ID],
    hardBlockedCount: 0,
    hardBlockedBatchIds: []
  });
  const missingBoot = attestedResponse();
  delete missingBoot.bridgeBootId;
  assert.throws(() => assertRestartBoundary(missingBoot), /boot identifier/i);
  const blockedRecovery = attestedResponse();
  blockedRecovery.ready = false;
  blockedRecovery.recoveryBoundary = {
    status: "blocked",
    error: "startup recovery failed"
  };
  assert.throws(
    () => assertRestartBoundary(blockedRecovery),
    /recovery boundary is not ready and error-free/i
  );
  const malformedRecovery = attestedResponse();
  malformedRecovery.ready = false;
  malformedRecovery.recoveryBoundary = ["ready"];
  assert.throws(
    () => assertRestartBoundary(malformedRecovery),
    /recovery boundary is not ready and error-free/i
  );
  const incomplete = attestedResponse();
  incomplete.receipts.unresolvedCount = 2;
  assert.throws(() => assertRestartBoundary(incomplete), /receipt boundary/i);
  const blankId = attestedResponse();
  blankId.ready = false;
  blankId.receipts.unresolvedBatchIds = [""];
  assert.throws(() => assertRestartBoundary(blankId), /receipt boundary/i);
  const unexplainedNotReady = attestedResponse();
  unexplainedNotReady.ready = false;
  unexplainedNotReady.receipts.unresolvedCount = 0;
  unexplainedNotReady.receipts.unresolvedBatchIds = [];
  unexplainedNotReady.receipts.reconciliationEligibleCount = 0;
  unexplainedNotReady.receipts.reconciliationEligibleBatchIds = [];
  assert.throws(
    () => assertRestartBoundary(unexplainedNotReady),
    /reason other than unresolved receipts/i
  );
  assert.throws(
    () => assertRestartBoundary(attestedResponse()),
    /ready while unresolved receipts remain/i
  );
  const hardBlocked = attestedResponse();
  hardBlocked.ready = false;
  hardBlocked.recoveryBoundary = {
    status: "blocked",
    error: "manual quarantine requires human resolution"
  };
  hardBlocked.receipts.reconciliationEligibleCount = 0;
  hardBlocked.receipts.reconciliationEligibleBatchIds = [];
  hardBlocked.receipts.hardBlockedCount = 1;
  hardBlocked.receipts.hardBlockedBatchIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
  hardBlocked.receipts.hardBlockedSummaries = [{
    batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    rawRowSha256: "a".repeat(64),
    status: "manual_quarantined",
    principalBound: true,
    principalMatchesCurrent: true,
    operationCount: 1,
    completedCount: 0,
    currentPresent: false,
    completed: [],
    notAttempted: [],
    files: [],
    runPolicy: { present: true, matchesCurrent: true },
    recovery: { phase: "manual_quarantine", reasonCode: "unknown", fileScopedQuarantine: false },
    scope: "global"
  }];
  assert.throws(
    () => assertRestartBoundary(hardBlocked),
    /hard-blocked receipt batches/i
  );
});

test("execution receipt is bound to policy and the one approved digest", () => {
  const operations = [{
    type: "jobnimbus.update_contact",
    payload: { query: "#2739", fields: { city: "Dallas" } }
  }];
  const options = { operations, bridgeBootId: "boot-1" };
  const response = {
    mode: "executed",
    batch: {
      schemaVersion: 2,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      principalHash: "c".repeat(64),
      operatorScope: "assigned",
      bootId: "boot-1",
      status: "completed",
      operationCount: 1,
      batchMode: "assigned_single_file_v2",
      runPolicyId: CHANCE_RUN_POLICY.id,
      runPolicySha256: CHANCE_RUN_POLICY.sha256,
      runPolicyExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      approvalDigest: "digest-1",
      fileCount: 1,
      files: [{
        id: "contact-2739",
        number: "2739",
        operationIndexes: [0],
        operationTypes: [operations[0].type]
      }],
      intents: [{
        index: 0,
        type: operations[0].type,
        fileId: "contact-2739",
        fileNumber: "2739",
        reconciliation: { after: { city: "Dallas" } },
        intentDigest: "d".repeat(64)
      }],
      completed: [{
        index: 0,
        type: operations[0].type,
        status: "executed",
        receipt: {
          mode: "executed",
          fileId: "contact-2739",
          fileNumber: "2739",
          verifiedByReadback: true
        }
      }],
      notAttempted: [],
      completedAt: new Date().toISOString()
    }
  };
  assert.equal(
    assertExecutionReceiptAttestation(response, "digest-1", options).approvalDigest,
    "digest-1"
  );
  assert.throws(
    () => assertExecutionReceiptAttestation(response, "digest-2", options),
    /approved digest/i
  );
  assert.throws(
    () => assertExecutionReceiptAttestation({
      ...response,
      batch: { ...response.batch, runPolicySha256: "wrong" }
    }, "digest-1", options),
    /exact live boot, operator, and run policy/i
  );
  assert.throws(
    () => assertExecutionReceiptAttestation({
      ...response,
      batch: { ...response.batch, runPolicyExpiresAt: "invalid" }
    }, "digest-1", options),
    /exact live boot, operator, and run policy/i
  );
  const unconfirmed = structuredClone(response);
  unconfirmed.batch.completed[0].receipt.verifiedByReadback = false;
  assert.throws(
    () => assertExecutionReceiptAttestation(unconfirmed, "digest-1", options),
    /provider readback confirmation/i
  );

  const sendOperations = [{
    type: "gmail.send_existing_draft",
    payload: { query: "2739", draftId: "draft-reviewed-1" }
  }];
  const sendResponse = structuredClone(response);
  sendResponse.batch.files[0].operationTypes = ["gmail.send_existing_draft"];
  sendResponse.batch.intents[0].type = "gmail.send_existing_draft";
  sendResponse.batch.intents[0].reconciliation = { draftId: "draft-reviewed-1" };
  sendResponse.batch.completed[0].type = "gmail.send_existing_draft";
  Object.assign(sendResponse.batch.completed[0].receipt, {
    externalId: "sent-message-1",
    sourceDraftId: "draft-reviewed-1",
    sourceDraftRetention: "retained_for_separate_cleanup"
  });
  assert.equal(
    assertExecutionReceiptAttestation(sendResponse, "digest-1", {
      operations: sendOperations,
      bridgeBootId: "boot-1"
    }).status,
    "completed"
  );
  const unboundSendReceipt = structuredClone(sendResponse);
  unboundSendReceipt.batch.completed[0].receipt.sourceDraftId = "different-draft";
  assert.throws(
    () => assertExecutionReceiptAttestation(unboundSendReceipt, "digest-1", {
      operations: sendOperations,
      bridgeBootId: "boot-1"
    }),
    /does not prove the exact approved source draft/i
  );
});

function reconciliationResponse(overrides = {}) {
  return {
    mode: "reconciled",
    outcome: "applied_verified",
    receipt: {
      batchId: "11111111-1111-4111-8111-111111111111",
      status: "completed",
      batchMode: "assigned_single_file_v2",
      operatorScope: "assigned",
      current: null,
      operationCount: 1,
      fileCount: 1,
      files: [{
        number: "2739",
        operationIndexes: [0],
        operationTypes: ["jobnimbus.update_contact"]
      }],
      intents: [{
        index: 0,
        type: "jobnimbus.update_contact",
        fileNumber: "2739",
        intentDigest: "a".repeat(64)
      }],
      completedCount: 1,
      completed: [{
        index: 0,
        type: "jobnimbus.update_contact",
        status: "executed",
        receipt: {
          mode: "recovered_verified",
          fileNumber: "2739",
          verifiedByReadback: true
        }
      }],
      notAttempted: [],
      automaticRetryAllowed: false,
      freshApprovalRequired: false,
      approvalDigest: "digest-1",
      runPolicyId: CHANCE_RUN_POLICY.id,
      runPolicySha256: CHANCE_RUN_POLICY.sha256
    },
    ...overrides
  };
}

function manualQuarantineResponse(overrides = {}) {
  return {
    mode: "manual_quarantined",
    outcome: "unknown_file_quarantined",
    receipt: {
      batchId: "11111111-1111-4111-8111-111111111111",
      status: "manual_quarantined",
      batchMode: "assigned_single_file_v2",
      operatorScope: "assigned",
      current: null,
      operationCount: 1,
      fileCount: 1,
      files: [{
        number: "2739",
        operationIndexes: [0],
        operationTypes: ["jobnimbus.update_status"]
      }],
      intents: [{
        index: 0,
        type: "jobnimbus.update_status",
        fileNumber: "2739",
        intentDigest: "b".repeat(64)
      }],
      completedCount: 0,
      completed: [],
      notAttempted: [],
      automaticRetryAllowed: false,
      freshApprovalRequired: false,
      approvalDigest: "digest-1",
      runPolicyId: CHANCE_RUN_POLICY.id,
      runPolicySha256: CHANCE_RUN_POLICY.sha256,
      manualQuarantine: {
        index: 0,
        scope: "file",
        type: "jobnimbus.update_status",
        fileNumber: "2739",
        fileNumbers: ["2739"],
        reasonCode: "provider_state_unprovable",
        reason: "The exact provider file can no longer be resolved.",
        quarantinedAt: "2026-08-23T12:34:56.000Z"
      }
    },
    ...overrides
  };
}

function multiFileManualQuarantineResponse() {
  const response = manualQuarantineResponse();
  response.receipt.batchMode = "assigned_multi_v1";
  response.receipt.operationCount = 2;
  response.receipt.fileCount = 2;
  response.receipt.files = [{
    number: "2739",
    operationIndexes: [0],
    operationTypes: ["jobnimbus.update_status"]
  }, {
    number: "2740",
    operationIndexes: [1],
    operationTypes: ["jobnimbus.update_contact"]
  }];
  response.receipt.intents = [{
    index: 0,
    type: "jobnimbus.update_status",
    fileNumber: "2739",
    intentDigest: "b".repeat(64)
  }, {
    index: 1,
    type: "jobnimbus.update_contact",
    fileNumber: "2740",
    intentDigest: "c".repeat(64)
  }];
  response.receipt.notAttempted = [{
    index: 1,
    type: "jobnimbus.update_contact",
    fileNumber: "2740",
    status: "not_attempted"
  }];
  response.receipt.manualQuarantine = {
    ...response.receipt.manualQuarantine,
    scope: "files",
    type: "unknown",
    fileNumber: "",
    fileNumbers: ["2739", "2740"],
    reasonCode: "immutable_intent_invalid"
  };
  return response;
}

test("manual reconciliation is bound to one batch and the pinned policy", () => {
  const batchId = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    assertReconciliationReceiptAttestation(
      reconciliationResponse(),
      batchId
    ).batchId,
    batchId
  );
  assert.equal(
    assertReconciliationReceiptAttestation({
      ...reconciliationResponse(),
      mode: "verified_noop",
      outcome: undefined
    }, batchId).status,
    "completed"
  );
  assert.throws(
    () => assertReconciliationReceiptAttestation(
      reconciliationResponse({
        receipt: {
          ...reconciliationResponse().receipt,
          runPolicySha256: "wrong"
        }
      }),
      batchId
    ),
    /pinned run policy/i
  );
  assert.throws(
    () => assertReconciliationReceiptAttestation(
      reconciliationResponse({
        receipt: { ...reconciliationResponse().receipt, current: { index: 1 } }
      }),
      batchId
    ),
    /structurally incomplete or unsafe/i
  );
  assert.throws(
    () => assertReconciliationReceiptAttestation(
      reconciliationResponse(),
      "22222222-2222-4222-8222-222222222222"
    ),
    /different batch/i
  );
  const unresolvedNoop = reconciliationResponse();
  unresolvedNoop.mode = "verified_noop";
  unresolvedNoop.receipt.status = "partial_failure";
  unresolvedNoop.receipt.current = {
    index: 0,
    type: "gmail.create_draft",
    status: "reconciliation_required"
  };
  assert.throws(
    () => assertReconciliationReceiptAttestation(unresolvedNoop, batchId),
    /structurally incomplete or unsafe/i
  );
  const malformedArrays = reconciliationResponse();
  malformedArrays.receipt.completed = "forged";
  malformedArrays.receipt.notAttempted = { unexpected: true };
  assert.throws(
    () => assertReconciliationReceiptAttestation(malformedArrays, batchId),
    /structurally incomplete or unsafe/i
  );
});

test("unknown exact file reconciliation accepts only a complete manual quarantine", () => {
  const batchId = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    assertReconciliationReceiptAttestation(
      manualQuarantineResponse(),
      batchId
    ).manualQuarantine.fileNumber,
    "2739"
  );
  assert.equal(
    assertReconciliationReceiptAttestation(
      manualQuarantineResponse({
        receipt: {
          ...manualQuarantineResponse().receipt,
          manualQuarantine: {
            ...manualQuarantineResponse().receipt.manualQuarantine,
            reasonCode: "immutable_intent_invalid"
          }
        }
      }),
      batchId
    ).manualQuarantine.scope,
    "file"
  );
  assert.deepEqual(
    assertReconciliationReceiptAttestation(
      multiFileManualQuarantineResponse(),
      batchId
    ).manualQuarantine.fileNumbers,
    ["2739", "2740"]
  );
  assert.deepEqual(
    assertReconciliationReceiptAttestation(
      manualQuarantineResponse({
        receipt: {
          ...manualQuarantineResponse().receipt,
          manualQuarantine: {
            ...manualQuarantineResponse().receipt.manualQuarantine,
            scope: "global",
            type: "unknown",
            fileNumber: "",
            fileNumbers: [],
            reasonCode: "immutable_intent_invalid"
          }
        }
      }),
      batchId
    ).manualQuarantine.fileNumbers,
    []
  );
  for (const response of [
    manualQuarantineResponse({ outcome: "not_applied_verified" }),
    manualQuarantineResponse({
      receipt: { ...manualQuarantineResponse().receipt, status: "partial" }
    }),
    manualQuarantineResponse({
      receipt: { ...manualQuarantineResponse().receipt, current: { index: 0 } }
    })
  ]) {
    assert.throws(
      () => assertReconciliationReceiptAttestation(response, batchId),
      /invalid manual-quarantine outcome|structurally incomplete or unsafe/i
    );
  }
  for (const manualQuarantine of [
    null,
    { ...manualQuarantineResponse().receipt.manualQuarantine, index: -1 },
    { ...manualQuarantineResponse().receipt.manualQuarantine, scope: "unknown" },
    { ...manualQuarantineResponse().receipt.manualQuarantine, type: 7 },
    { ...manualQuarantineResponse().receipt.manualQuarantine, fileNumber: 2739 },
    (() => {
      const value = { ...manualQuarantineResponse().receipt.manualQuarantine };
      delete value.fileNumbers;
      return value;
    })(),
    { ...manualQuarantineResponse().receipt.manualQuarantine, fileNumbers: [] },
    { ...manualQuarantineResponse().receipt.manualQuarantine, fileNumbers: ["2739", "2739"] },
    { ...manualQuarantineResponse().receipt.manualQuarantine, fileNumbers: ["2740"] },
    {
      ...manualQuarantineResponse().receipt.manualQuarantine,
      scope: "files",
      type: "unknown",
      fileNumber: "",
      fileNumbers: ["2739"],
      reasonCode: "provider_state_unprovable"
    },
    { ...manualQuarantineResponse().receipt.manualQuarantine, reasonCode: "unknown" },
    { ...manualQuarantineResponse().receipt.manualQuarantine, reason: 7 },
    { ...manualQuarantineResponse().receipt.manualQuarantine, quarantinedAt: "yesterday" }
  ]) {
    assert.throws(
      () => assertReconciliationReceiptAttestation(
        manualQuarantineResponse({
          receipt: { ...manualQuarantineResponse().receipt, manualQuarantine }
        }),
        batchId
      ),
      /incomplete manual-quarantine record|not bound to its immutable file descriptor/i
    );
  }
});

test("assigned lane overwrites caller-supplied company scope without mutating input", () => {
  const input = [{
    type: "jobnimbus.update_status",
    payload: { query: "2739", status: "Negotiating", operatorScope: "company" }
  }];
  const original = structuredClone(input);
  const result = scopedOperations(input, "assigned");
  assert.equal(result[0].payload.operatorScope, "assigned");
  assert.deepEqual(input, original);
});

test("company lane overwrites caller-supplied assigned scope", () => {
  const result = scopedOperations([{
    type: "jobnimbus.update_status",
    payload: { query: "3901", status: "Negotiating", operatorScope: "assigned" }
  }], "company");
  assert.equal(result[0].payload.operatorScope, "company");
});

test("unknown operator lane is rejected", () => {
  assert.throws(() => scopedOperations([], "unknown"), /assigned or company/i);
});

test("operation payload cannot override approval or policy controls", () => {
  assert.throws(() => scopedOperations([{
    type: "jobnimbus.update_contact",
    payload: { query: "2739", runPolicy: { id: "different" } }
  }], "assigned"), /control fields/i);
  assert.throws(() => scopedOperations([{
    type: "jobnimbus.update_contact",
    payload: { query: "2739", approvalChallenge: "leak" }
  }], "assigned"), /control fields/i);
});

test("existing-draft send is one exact assigned operation before scope injection", () => {
  const operation = {
    type: "gmail.send_existing_draft",
    payload: { query: "2739", draftId: "draft-reviewed-1" }
  };
  const scoped = scopedOperations([operation], "assigned");
  assert.deepEqual(scoped[0].payload, {
    query: "2739",
    draftId: "draft-reviewed-1",
    operatorScope: "assigned"
  });
  assert.throws(
    () => scopedOperations([operation], "company"),
    /sole assigned-file operation/i
  );
  assert.throws(
    () => scopedOperations([operation, {
      type: "jobnimbus.update_contact",
      payload: { query: "2739", fields: { city: "Dallas" } }
    }], "assigned"),
    /sole assigned-file operation/i
  );
  assert.throws(
    () => scopedOperations([{
      ...operation,
      payload: { ...operation.payload, body: "raw content" }
    }], "assigned"),
    /exactly \{query,draftId\}/i
  );
});
