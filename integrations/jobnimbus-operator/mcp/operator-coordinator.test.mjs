import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_NOTES_ENABLED } from "./approved-note-release.mjs";

import { createOperatorCoordinator } from "./operator-coordinator.mjs";
import {
  CHANCE_RUN_ACTION_TYPES,
  CHANCE_RUN_ALLOWED_CONTACT_FIELDS,
  CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES,
  CHANCE_RUN_FILE_COUNT,
  CHANCE_RUN_POLICY,
  CHANCE_LEGACY_ISOLATION,
  CHANCE_LEGACY_ISOLATION_ENTRIES,
  EXPECTED_BRIDGE_BUILD,
  EXPECTED_OPERATOR_CAPABILITIES
} from "./scope.mjs";

const FUTURE = "2099-09-23T05:00:00.000Z";
const NOW = Date.parse("2090-01-01T00:00:00.000Z");
const HISTORICAL_IDS = Object.freeze(
  CHANCE_LEGACY_ISOLATION_ENTRIES.map((entry) => entry.batchId)
);
const HISTORICAL_ROW_SHA256 = Object.freeze(
  CHANCE_LEGACY_ISOLATION_ENTRIES.map((entry) => entry.rawRowSha256)
);
const RECOVERY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_RECOVERY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLAIM_APPROVAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CLAIM_PLAN_DIGEST = "1".repeat(64);
const CLAIM_INPUT = Object.freeze({
  query: "#2787",
  goal: "file_new_claim",
  retryOfCallId: "call-ended-2787",
  stormTime: "3:15 PM",
  overrides: Object.freeze({
    coverageTermStatus: "carrier_lookup_required",
    damageDetails: Object.freeze(["Roof hail damage"])
  })
});
const OPERATIONS = [{
  type: "jobnimbus.update_contact",
  payload: {
    query: "#2739",
    fields: { cf_date_1: "2026-05-28" }
  }
}];
const SEND_OPERATIONS = [{
  type: "gmail.send_existing_draft",
  payload: {
    query: "2739",
    draftId: "draft-reviewed-1"
  }
}];

function runPolicy() {
  return {
    available: true,
    enforced: true,
    id: CHANCE_RUN_POLICY.id,
    sha256: CHANCE_RUN_POLICY.sha256,
    expiresAt: FUTURE,
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
    backwardStageMovesAllowed: false,
    stageEvidenceRequired: true
  };
}

function whoamiFixture() {
  return {
    authenticated: true,
    identity: {
      type: "codex_operator_token",
      subject: "codex-mac-operator",
      email: "",
      name: "Codex Mac Operator",
      role: "codex_operator",
      hostedDomain: "",
      scopes: [
        "client_evidence:read",
        "company_exact_file:read",
        "approval_batches:prepare_execute",
        "retell_claim_filing:prepare_execute_review"
      ],
      jobNimbusOwnerId: "owner-1",
      jobNimbusScope: "assigned",
      quoLineConfigured: true
    },
    operatorAccess: {
      defaultScope: "chance_assigned",
      companyExactFileScope: true,
      companyWideIndexOrSweep: false,
      assignedBatchMaxFiles: 5,
      assignedMultiFileActionTypes: [
        "jobnimbus.update_contact",
        "jobnimbus.update_status",
        "jobnimbus.ensure_current_task"
      ],
      assignedMultiFileExecution: "sequential_fail_stop_no_rollback",
      chanceRunPolicy: runPolicy(),
      actionReceiptRecovery: { status: "ready", error: "" },
      companyBatchMaxFiles: 1,
      claimFilingSingleFileOnly: true,
      claimFilingWritebackAllowed: false,
      claimFilingSupportedGoals: ["file_new_claim", "find_existing_claim"],
      callApprovalChallenge: "short_lived_identity_bound_single_use",
      actionPath: "approval_batch_plus_retell_claim_filing"
    }
  };
}

function runtimeFixture() {
  return {
    brain: {
      advisory: "configured",
      availability: "configured",
      clientMemory: "disabled",
      execution: "disabled",
      fallback: "disabled",
      legacyClientMemoryWrites: "disabled",
      persistence: "configured",
      snapshotSafety: "migration_required"
    },
    connectors: {
      carrierFollowUp: "configured",
      claimFiling: "configured",
      clientCoordinator: "configured",
      gmail: "configured",
      googleCalendar: "configured",
      googleOAuth: "configured",
      jobNimbus: "configured",
      quo: "configured",
      realtimeVoice: "configured"
    },
    controls: {
      actionBatchOnly: "disabled",
      automaticEmailOrTextSending: "disabled",
      changedPayloadInvalidatesApproval: "enabled",
      claimFilingApprovalLane: "enabled",
      directEffectRoutes: "disabled",
      exactDryRunDigestRequired: "enabled",
      explicitChanceApprovalRequired: "enabled",
      jobNimbusWritesActionBatchOnly: "enabled",
      modelCanExecute: "disabled",
      roleEnforcement: "enabled",
      schedulingFailClosed: "enabled",
      shortLivedSingleUseChallengeRequired: "enabled"
    },
    gates: {
      carrierFollowUpCalls: "disabled",
      claimFilingCalls: "enabled",
      clientCoordinatorAppointmentCalls: "disabled",
      clientCoordinatorExpandedCalls: "disabled",
      externalWrites: "enabled",
      gmailSend: "disabled",
      hcnActionExecution: "disabled",
      quoSend: "disabled",
      realtimeVoiceCalls: "disabled"
    },
    configurationDrift: {
      scope: "release_critical_effect_gates",
      monitoredKeys: [
        "ALLOW_CARRIER_FOLLOWUP_CALLS",
        "ALLOW_CLIENT_COORDINATOR_CALLS",
        "ALLOW_GMAIL_SEND",
        "ALLOW_LEGACY_CLIENT_MEMORY_WRITES",
        "ALLOW_QUO_SEND",
        "ALLOW_RETELL_CLAIM_CALLS",
        "ALLOW_RETELL_CALLS",
        "ALLOW_VOICE_CALLS",
        "BRIDGE_ALLOW_WRITES",
        "HCN_ACTION_EXECUTION_ENABLED"
      ],
      status: "aligned",
      differences: [],
      unknown: []
    }
  };
}

function sessionFixture() {
  return {
    schemaVersion: "hcn.platform.session.v1",
    generatedAt: "2090-01-01T00:00:00.000Z",
    authenticated: true,
    build: {
      ...EXPECTED_BRIDGE_BUILD,
      buildId: "build-1",
      deployId: "deploy-1",
      runtime: {
        name: "node",
        version: "24.0.0",
        platform: "linux",
        architecture: "x64"
      }
    },
    identity: {
      authentication: "authenticated",
      type: "codex_operator",
      role: "codex_operator",
      jobNimbusScope: "assigned",
      gmailMode: "exact_assigned_file_evidence"
    },
    authorizedCapabilities: [...EXPECTED_OPERATOR_CAPABILITIES],
    runtime: runtimeFixture(),
    descriptorHash: `sha256:${"a".repeat(64)}`
  };
}

function claimConfigurationFixture() {
  return {
    mode: "read_only",
    ready: true,
    agentConfigured: true,
    fromNumberConfigured: true,
    callbackWebhookAvailable: true,
    callbackPacketRestoration: "full_approved_packet",
    guardedEndCredentialConfigured: true,
    guardedEndCredentialIsolated: true,
    inboundWebhookCredentialConfigured: true,
    inboundWebhookCredentialIsolated: true,
    inboundWebhookAuthentication:
      "dedicated_url_token_plus_retell_hmac_sha256_raw_body_timestamp",
    inboundFallbackAgentUnset: true,
    phoneNumberMatches: true,
    inboundWebhookUrlMatches: true,
    inboundAgentRoutingMatches: true,
    expectedPhoneConfigDigest: "3".repeat(64),
    livePhoneConfigDigest: "3".repeat(64),
    guardedEndAuthorizationMatches: true,
    agentPublished: true,
    llmPublished: true,
    agentVersion: 3,
    llmVersion: 8,
    agentConfigDigest: "4".repeat(64),
    promptMatches: true,
    toolsMatch: true,
    toolNames: ["press_digit", "request_guarded_end_call"],
    expectedToolNames: ["press_digit", "request_guarded_end_call"],
    dtmfPressDigitAvailable: true,
    guardedEndCallAvailable: true,
    analysisSchemaMatches: true,
    analysisFields: ["outcome", "claim_number"],
    timezoneMatches: true,
    expectedConfigDigest: "2".repeat(64),
    liveConfigDigest: "2".repeat(64),
    approvalModel:
      "fresh_single_file_digest_plus_short_lived_identity_bound_single_use_challenge",
    writebackRequiresSeparateApproval: true,
    automaticJobNimbusWriteback: false,
    instruction: "The live Retell carrier agent is ready."
  };
}

function claimCommunicationReviewFixture() {
  return {
    generatedAt: "2090-01-01T00:00:00.000Z",
    owner: { id: "owner-1", name: "Chance Pearson" },
    scope: "chance_assigned_file",
    query: "#2787",
    complete: false,
    packets: [{
      complete: false,
      file: {
        id: "contact-2787",
        number: "2787",
        name: "Ronald",
        status: "Ready for PA Review",
        address: "100 Fixture Way, Dallas, TX 75001",
        carrier: "USAA",
        policyNumber: "POL-2787",
        claimNumber: "",
        dateOfLoss: "06/01/2026"
      },
      liveJobNimbus: {
        recentActivities: [],
        openTasks: [],
        operationalDocuments: [],
        coverage: {
          schemaVersion: 1,
          mode: "complete",
          complete: true,
          providerScanComplete: true,
          readLimit: 5000,
          activities: { availableCount: 0, returnedCount: 0, omittedCount: 0 },
          openTasks: { availableCount: 0, returnedCount: 0, omittedCount: 0 },
          operationalDocuments: { availableCount: 0, returnedCount: 0, omittedCount: 0 }
        }
      },
      gmail: {
        status: "fresh",
        query: "fixture exact-file query",
        messages: [],
        threads: [],
        coverage: {
          providerScanComplete: true,
          search: {
            complete: false,
            scannedMessages: 0,
            returnedMessages: 0,
            withheldMessages: 0,
            readLimit: 15,
            hasMore: false,
            windowDays: 3650,
            limitationCodes: ["bounded_history_window"]
          },
          returnedThreadCount: 0,
          reviewedThreadCount: 0,
          omittedThreadCount: 0,
          limitationCodes: ["bounded_history_window"]
        }
      },
      quo: {
        status: "partial",
        phone: "+12145550199",
        messageCount: 0,
        callCount: 0,
        timeline: [],
        transcripts: [],
        transcriptCoverage: {
          mode: "complete_bounded_review", complete: true, callCount: 0, reviewedCallCount: 0,
          omittedCallCount: 0, missingSpeechTranscripts: 0, returnedTranscriptCount: 0
        },
        completeness: {
          complete: true,
          reasons: [],
          lineCount: 1,
          pagesScanned: 2,
          returnedCount: 0
        },
        coverage: {
          searchScope: "homeowner_phone_only",
          carrierConversationsSearched: false,
          transcriptReviewRequested: true,
          returnedTranscriptCount: 0,
          omittedTimelineItems: 0,
          complete: false
        }
      }
    }]
  };
}

function policyFixture() {
  const historicalSummaries = HISTORICAL_IDS.map((batchId, index) => {
    const pendingVerification = index === HISTORICAL_IDS.length - 1;
    return {
      batchId,
      rawRowSha256: HISTORICAL_ROW_SHA256[index],
      status: pendingVerification ? "completed_pending_verification" : "partial_failure",
      principalBound: false,
      principalMatchesCurrent: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      operationCount: 1,
      batchMode: "",
      completedCount: pendingVerification ? 1 : 0,
      completed: pendingVerification
        ? [{
            index: 0,
            type: "gmail.create_draft",
            status: "executed",
            fileNumber: "2739",
            receipt: {
              mode: "executed",
              verifiedByReadback: true,
              deliveryStatus: "",
              deliveryConfirmed: null,
              manualVerificationRequired: true
            }
          }]
        : [],
      failedAt: null,
      notAttempted: [],
      currentPresent: false,
      files: [],
      runPolicy: { present: false, matchesCurrent: false },
      recovery: { phase: "", reasonCode: "", fileScopedQuarantine: false },
      scope: "global"
    };
  });
  return {
    mode: "read_only",
    bridgeBootId: "boot-1",
    recoveryBoundary: { status: "ready", error: "" },
    runPolicy: runPolicy(),
    receipts: {
      total: HISTORICAL_IDS.length,
      unresolvedCount: 0,
      unresolvedBatchIds: [],
      reconciliationEligibleCount: 0,
      reconciliationEligibleBatchIds: [],
      hardBlockedCount: 0,
      hardBlockedBatchIds: [],
      hardBlockedSummaries: [],
      attentionCount: HISTORICAL_IDS.length,
      attentionBatchIds: [...HISTORICAL_IDS],
      historicalAttentionCount: HISTORICAL_IDS.length,
      historicalAttentionBatchIds: [...HISTORICAL_IDS],
      historicalAttentionSummaries: historicalSummaries
    },
    legacyIsolation: {
      configured: true,
      valid: true,
      id: CHANCE_LEGACY_ISOLATION.id,
      runPolicyId: CHANCE_RUN_POLICY.id,
      runPolicySha256: CHANCE_RUN_POLICY.sha256,
      entryCount: CHANCE_LEGACY_ISOLATION.entryCount,
      errorCode: "",
      error: "",
      classification: CHANCE_LEGACY_ISOLATION.classification,
      reasonCode: CHANCE_LEGACY_ISOLATION.reasonCode,
      neverReplay: true,
      freshReadRequired: true
    },
    ready: true
  };
}

function hardBlockedSummary(batchId) {
  return {
    batchId,
    rawRowSha256: "c".repeat(64),
    status: "manual_quarantined",
    principalBound: true,
    principalMatchesCurrent: true,
    createdAt: "2090-01-01T00:00:00.000Z",
    updatedAt: "2090-01-01T00:00:01.000Z",
    operationCount: 1,
    batchMode: "assigned_single_file_v2",
    completedCount: 0,
    completed: [],
    failedAt: null,
    notAttempted: [],
    currentPresent: false,
    files: [{ number: "2739", operationTypes: ["jobnimbus.update_contact"] }],
    runPolicy: { present: true, matchesCurrent: true },
    recovery: {
      phase: "manual_quarantine",
      reasonCode: "provider_state_unprovable",
      fileScopedQuarantine: false
    },
    scope: "global"
  };
}

function enterRecovery(h, batchId = RECOVERY_ID) {
  h.state.policy.ready = false;
  h.state.policy.receipts = {
    ...h.state.policy.receipts,
    total: HISTORICAL_IDS.length + 1,
    unresolvedCount: 1,
    unresolvedBatchIds: [batchId],
    reconciliationEligibleCount: 1,
    reconciliationEligibleBatchIds: [batchId]
  };
}

function syncClaimJobNimbusCoverage(review) {
  const live = review.packets[0].liveJobNimbus;
  for (const [key, rows] of [
    ["activities", live.recentActivities],
    ["openTasks", live.openTasks],
    ["operationalDocuments", live.operationalDocuments]
  ]) {
    live.coverage[key] = { availableCount: rows.length, returnedCount: rows.length, omittedCount: 0 };
  }
}

function syncClaimGmailSearchCounts(review) {
  const gmail = review.packets[0].gmail;
  gmail.coverage.search.scannedMessages = gmail.messages.length;
  gmail.coverage.search.returnedMessages = gmail.messages.length;
}

function harness() {
  const state = {
    whoami: whoamiFixture(),
    session: sessionFixture(),
    policy: policyFixture(),
    claimConfiguration: claimConfigurationFixture(),
    claimCommunicationReview: claimCommunicationReviewFixture(),
    beforeClaimPrepare: null,
    mutateExecutionResponse: null,
    mutateClaimPlan: null,
    mutateClaimResponse: null
  };
  const requests = [];
  const approvals = new Map();
  const bridgeRequest = async (method, pathname, body) => {
    requests.push({ method, pathname, body: structuredClone(body) });
    if (method === "GET" && pathname === "/auth/whoami") {
      return structuredClone(state.whoami);
    }
    if (method === "GET" && pathname === "/api/v1/session") {
      return structuredClone(state.session);
    }
    if (method === "GET" && pathname === "/ops/run-policy") {
      return structuredClone(state.policy);
    }
    if (method === "POST" && pathname === "/ops/action-batch") {
      if (body.execute === true) {
        const type = body.operations[0].type;
        const executionResponse = {
          mode: "executed",
          batch: {
            schemaVersion: 2,
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            approvalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            principalHash: "e".repeat(64),
            operatorScope: "assigned",
            bootId: state.policy.bridgeBootId,
            status: "completed",
            createdAt: "2090-01-01T00:00:00.000Z",
            operationCount: 1,
            batchMode: "assigned_single_file_v2",
            runPolicyId: CHANCE_RUN_POLICY.id,
            runPolicySha256: CHANCE_RUN_POLICY.sha256,
            runPolicyExpiresAt: FUTURE,
            approvalDigest: body.approvalDigest,
            fileCount: 1,
            files: [{
              id: "contact-2739",
              number: "2739",
              operationIndexes: [0],
              operationTypes: [type]
            }],
            intents: [{
              index: 0,
              type,
              fileId: "contact-2739",
              fileNumber: "2739",
              reconciliation: { after: { cf_date_1: "2026-05-28" } },
              intentDigest: "f".repeat(64)
            }],
            completed: [{
              index: 0,
              type,
              status: "executed",
              receipt: {
                mode: "executed",
                fileId: "contact-2739",
                fileNumber: "2739",
                verifiedByReadback: true
              }
            }],
            notAttempted: [],
            completedAt: "2090-01-01T00:00:01.000Z"
          }
        };
        if (type === "gmail.send_existing_draft") {
          Object.assign(executionResponse.batch.completed[0].receipt, {
            externalId: "sent-message-1",
            sourceDraftId: body.operations[0].payload.draftId,
            sourceDraftRetention: "retained_for_separate_cleanup"
          });
        }
        state.mutateExecutionResponse?.(executionResponse);
        return executionResponse;
      }
      return {
        mode: "dry_run",
        approvalDigest: "digest-1",
        approvalChallenge: "secret-one-use-challenge",
        approvalExpiresAt: FUTURE,
        displayComplete: true,
        runPolicy: structuredClone(state.policy.runPolicy),
        plan: [{ index: 0, type: OPERATIONS[0].type }]
      };
    }
    if (method === "POST" && pathname === "/claim-filing/configuration") {
      return structuredClone(state.claimConfiguration);
    }
    if (method === "POST" && pathname === "/ops/review-chance-files") {
      return structuredClone(state.claimCommunicationReview);
    }
    if (method === "POST" && pathname === "/claim-filing/prepare") {
      await state.beforeClaimPrepare?.();
      const response = {
        mode: "dry_run",
        approvalRequired: true,
        file: { id: "contact-2787", number: "2787", name: "Ronald" },
        readiness: { ready: true, blockers: [] },
        configurationAttested: true,
        agentVersion: 3,
        agentConfigDigest: "4".repeat(64),
        callbackPacketDigest: "5".repeat(64),
        packet: {
          goal: body.goal,
          damageEvidenceSource: "approved_override",
          damageSummary: ["Roof hail damage"],
          verifiedFileFacts: {
            coverageTermStatus: body.overrides?.coverageTermStatus || "carrier_lookup_required",
            priorPolicyLookupInstruction: "Give the available policy number only when asked. If the carrier cannot locate it, provide the insured name and property address as requested."
          }
        },
        callPlan: {
          dynamicVariables: {
            damageDetails: "Roof hail damage",
            coverageTermStatus: body.overrides?.coverageTermStatus || "carrier_lookup_required",
            priorPolicyLookupInstruction: "Give the available policy number only when asked. If the carrier cannot locate it, provide the insured name and property address as requested."
          }
        },
        planDigest: CLAIM_PLAN_DIGEST,
        approvalChallenge: "retell-secret-one-use-challenge",
        approvalExpiresAt: FUTURE,
        batchClaims: [],
        request: { to: "+18005550100" }
      };
      state.mutateClaimPlan?.(response);
      return response;
    }
    if (method === "POST" && pathname === "/claim-filing/call") {
      const response = {
        mode: "executed",
        file: { id: "contact-2787", number: "2787", name: "Ronald" },
        planDigest: body.planDigest,
        callId: "call-retell-2787",
        callStatus: "registered",
        automaticJobNimbusWriteback: false,
        automaticChanceBrainWriteback: false
      };
      state.mutateClaimResponse?.(response);
      return response;
    }
    if (method === "POST" && pathname === "/claim-filing/result") {
      return {
        mode: "read_only",
        file: { id: "contact-2787", number: "2787", name: "Ronald" },
        callChain: [{ callId: body.callId, direction: "outbound" }],
        call: { callId: body.callId, callStatus: "ended", transcript: "Carrier filed claim." },
        extracted: { outcome: "claim_filed", claimNumber: "CLM-2787" },
        proposedWriteback: { fields: { claimNumber: "CLM-2787" } },
        writebackDigest: "3".repeat(64),
        approvalRequired: true
      };
    }
    if (method === "POST" && pathname === "/claim-filing/callbacks") {
      return {
        mode: "read_only",
        callbackTtlHours: 72,
        count: 1,
        callbacks: [{
          originalCallId: "call-retell-2787",
          fileNumber: "2787",
          contactId: "contact-2787",
          carrier: "USAA",
          callbackPacketStatus: "matched"
        }]
      };
    }
    if (method === "POST" && pathname === "/ops/action-batch-reconcile") {
      state.policy.receipts.unresolvedBatchIds =
        state.policy.receipts.unresolvedBatchIds.filter((id) => id !== body.batchId);
      state.policy.receipts.reconciliationEligibleBatchIds =
        state.policy.receipts.reconciliationEligibleBatchIds.filter((id) => id !== body.batchId);
      state.policy.receipts.hardBlockedBatchIds =
        state.policy.receipts.hardBlockedBatchIds.filter((id) => id !== body.batchId);
      state.policy.receipts.unresolvedCount = state.policy.receipts.unresolvedBatchIds.length;
      state.policy.receipts.reconciliationEligibleCount =
        state.policy.receipts.reconciliationEligibleBatchIds.length;
      state.policy.receipts.hardBlockedCount = state.policy.receipts.hardBlockedBatchIds.length;
      state.policy.ready = state.policy.receipts.unresolvedCount === 0;
      return {
        mode: "reconciled",
        outcome: "applied_verified",
        receipt: {
          batchId: body.batchId,
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
          approvalDigest: "recovered-digest",
          runPolicyId: CHANCE_RUN_POLICY.id,
          runPolicySha256: CHANCE_RUN_POLICY.sha256
        }
      };
    }
    throw new Error(`Unexpected request: ${method} ${pathname}`);
  };
  return {
    state,
    requests,
    approvals,
    coordinator: createOperatorCoordinator({
      bridgeRequest,
      version: "test-plugin",
      approvals,
      now: () => NOW,
      newApprovalId: () => CLAIM_APPROVAL_ID
    })
  };
}

function actionPosts(h) {
  return h.requests.filter((request) => (
    request.method === "POST" && request.pathname === "/ops/action-batch"
  ));
}

function reconcilePosts(h) {
  return h.requests.filter((request) => (
    request.method === "POST" && request.pathname === "/ops/action-batch-reconcile"
  ));
}

function claimPosts(h, pathname) {
  return h.requests.filter((request) => (
    request.method === "POST" && request.pathname === pathname
  ));
}

test("verified session binds the exact build, Mac identity, policy, runtime, and recovery boundary", async () => {
  const h = harness();
  const result = await h.coordinator.verifiedBridgeSession();
  assert.equal(result.ready, true);
  assert.equal(result.operatorBoundaryAttested, true);
  assert.equal(result.recoveryBoundaryAttested, true);
  assert.equal(result.recoveryAllowed, false);
  assert.equal(result.localPlugin.pinnedBridgeBuild.sourceCommit, EXPECTED_BRIDGE_BUILD.sourceCommit);
  assert.deepEqual(result.localPlugin.pinnedLegacyIsolation, CHANCE_LEGACY_ISOLATION);
  assert.equal(result.approvalBoundary.bridgeBootId, "boot-1");
  assert.deepEqual(result.approvalBoundary.build, h.state.session.build);
  assert.deepEqual(result.approvalBoundary.runtime, h.state.session.runtime);
  assert.deepEqual(result.approvalBoundary.runPolicy, h.state.policy.runPolicy);
  assert.deepEqual(result.approvalBoundary.legacyIsolation, h.state.policy.legacyIsolation);
  assert.deepEqual(result.approvalBoundary.operatorIdentity, h.state.whoami.identity);
  assert.deepEqual(result.approvalBoundary.operatorAccess, h.state.whoami.operatorAccess);
});

test("plan performs no action POST for missing, mismatched, or unattested bridge builds", async (t) => {
  const mutations = {
    "missing build": (session) => { delete session.build; },
    "wrong service": (session) => { session.build.service = "lookalike"; },
    "wrong source commit": (session) => { session.build.sourceCommit = EXPECTED_BRIDGE_BUILD.sourceCommit === "b".repeat(40) ? "a".repeat(40) : "b".repeat(40); },
    "declared source": (session) => { session.build.sourceCommitTrust = "declared"; },
    "unattested source": (session) => { session.build.attested = false; }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const h = harness();
      mutate(h.state.session);
      await assert.rejects(
        h.coordinator.planActionBatch(OPERATIONS),
        /not ready for normal work|provider-attested/i
      );
      assert.equal(actionPosts(h).length, 0);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("plan performs no action POST for the wrong operator identity", async () => {
  const h = harness();
  h.state.whoami.identity.subject = "codex-hp-operator";
  await assert.rejects(
    h.coordinator.planActionBatch(OPERATIONS),
    /dedicated authenticated Mac operator/i
  );
  assert.equal(actionPosts(h).length, 0);
});

test("plan performs no action POST for inconsistent whoami receipt recovery", async () => {
  const h = harness();
  h.state.whoami.operatorAccess.actionReceiptRecovery = {
    status: "failed",
    error: "durable receipt startup failed"
  };
  await assert.rejects(
    h.coordinator.planActionBatch(OPERATIONS),
    /dedicated Mac operator access boundary/i
  );
  assert.equal(actionPosts(h).length, 0);
});

test("plan performs no action POST for manifest or recovery-boundary drift", async (t) => {
  const mutations = {
    "manifest hash": (policy) => { policy.runPolicy.sha256 = "f".repeat(64); },
    "file count": (policy) => { policy.runPolicy.fileCount = 59; },
    "excluded roster": (policy) => { policy.runPolicy.excludedFileNumbers.push("9999"); },
    "action surface": (policy) => { policy.runPolicy.allowedActionTypes.push("gmail.send"); },
    "contact fields": (policy) => { policy.runPolicy.allowedContactFields.push("is_closed"); },
    "evidence sources": (policy) => {
      policy.runPolicy.allowedStageEvidenceSources.push("quo_call");
    },
    "recovery startup error": (policy) => {
      policy.ready = false;
      policy.recoveryBoundary = { status: "blocked", error: "startup failed" };
    }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const h = harness();
      mutate(h.state.policy);
      await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /not ready|manifest|surface|boundary/i);
      assert.equal(actionPosts(h).length, 0);
    });
  }
});

test("plan performs no action POST for missing or altered historical isolation", async (t) => {
  const mutations = {
    "missing isolation": (policy) => { delete policy.legacyIsolation; },
    "invalid isolation": (policy) => { policy.legacyIsolation.valid = false; },
    "wrong isolation ID": (policy) => { policy.legacyIsolation.id = "lookalike"; },
    "wrong entry count": (policy) => { policy.legacyIsolation.entryCount = 5; },
    "replay permitted": (policy) => { policy.legacyIsolation.neverReplay = false; },
    "fresh reads not required": (policy) => {
      policy.legacyIsolation.freshReadRequired = false;
    },
    "duplicate historical ID": (policy) => {
      policy.receipts.historicalAttentionBatchIds[1] =
        policy.receipts.historicalAttentionBatchIds[0];
    },
    "unrecognized but well-formed historical ID": (policy) => {
      const replacement = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      policy.receipts.historicalAttentionBatchIds[0] = replacement;
      policy.receipts.historicalAttentionSummaries[0].batchId = replacement;
    },
    "missing historical summary": (policy) => {
      policy.receipts.historicalAttentionSummaries.pop();
    },
    "unsafe historical summary": (policy) => {
      policy.receipts.historicalAttentionSummaries[0].principalBound = true;
    },
    "missing historical row fingerprint": (policy) => {
      delete policy.receipts.historicalAttentionSummaries[0].rawRowSha256;
    },
    "unrecognized but well-formed historical row fingerprint": (policy) => {
      policy.receipts.historicalAttentionSummaries[0].rawRowSha256 = "f".repeat(64);
    },
    "duplicate historical row fingerprint": (policy) => {
      policy.receipts.historicalAttentionSummaries[1].rawRowSha256 =
        policy.receipts.historicalAttentionSummaries[0].rawRowSha256;
    },
    "historical receipt also classified as unresolved": (policy) => {
      policy.ready = false;
      policy.receipts.unresolvedCount = 1;
      policy.receipts.unresolvedBatchIds = [HISTORICAL_IDS[0]];
      policy.receipts.reconciliationEligibleCount = 1;
      policy.receipts.reconciliationEligibleBatchIds = [HISTORICAL_IDS[0]];
    }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const h = harness();
      mutate(h.state.policy);
      await assert.rejects(
        h.coordinator.planActionBatch(OPERATIONS),
        /historical isolation|six-receipt/i
      );
      assert.equal(actionPosts(h).length, 0);
    });
  }
});

test("plan performs no action POST when required capabilities are missing or an effect capability appears", async (t) => {
  await t.test("missing receipt capability", async () => {
    const h = harness();
    h.state.session.authorizedCapabilities = h.state.session.authorizedCapabilities.filter(
      (value) => value !== "operations.action_batch_receipts.read"
    );
    await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /capability surface/i);
    assert.equal(actionPosts(h).length, 0);
  });
  await t.test("direct JobNimbus note capability", async () => {
    const h = harness();
    h.state.session.authorizedCapabilities.push("jobnimbus.notes.create");
    await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /capability surface/i);
    assert.equal(actionPosts(h).length, 0);
  });
  await t.test("Gmail send capability", async () => {
    const h = harness();
    h.state.session.authorizedCapabilities.push("gmail.drafts.send");
    await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /capability surface/i);
    assert.equal(actionPosts(h).length, 0);
  });
  await t.test("call capability", async () => {
    const h = harness();
    h.state.session.authorizedCapabilities.push("voice.call.place");
    await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /capability surface/i);
    assert.equal(actionPosts(h).length, 0);
  });
});

test("plan performs no action POST for unsafe runtime controls or missing connectors", async (t) => {
  const mutations = {
    "action batch only re-enabled": (runtime) => { runtime.controls.actionBatchOnly = "enabled"; },
    "automatic outbound enabled": (runtime) => {
      runtime.controls.automaticEmailOrTextSending = "enabled";
    },
    "changed payload accepted": (runtime) => {
      runtime.controls.changedPayloadInvalidatesApproval = "disabled";
    },
    "claim filing approval lane disabled": (runtime) => {
      runtime.controls.claimFilingApprovalLane = "disabled";
    },
    "JobNimbus action-batch boundary disabled": (runtime) => {
      runtime.controls.jobNimbusWritesActionBatchOnly = "disabled";
    },
    "direct effect routes enabled": (runtime) => { runtime.controls.directEffectRoutes = "enabled"; },
    "dry-run digest disabled": (runtime) => {
      runtime.controls.exactDryRunDigestRequired = "disabled";
    },
    "explicit approval disabled": (runtime) => {
      runtime.controls.explicitChanceApprovalRequired = "disabled";
    },
    "single-use challenge disabled": (runtime) => {
      runtime.controls.shortLivedSingleUseChallengeRequired = "disabled";
    },
    "JobNimbus unconfigured": (runtime) => { runtime.connectors.jobNimbus = "unconfigured"; },
    "Gmail unconfigured": (runtime) => { runtime.connectors.gmail = "unconfigured"; },
    "Retell claim filing unconfigured": (runtime) => {
      runtime.connectors.claimFiling = "unconfigured";
    },
    "external writes disabled": (runtime) => { runtime.gates.externalWrites = "disabled"; },
    "unknown enabled runtime gate": (runtime) => {
      runtime.gates.unrecognizedDirectMutationGate = "enabled";
    },
    "unknown release-critical drift key": (runtime) => {
      runtime.configurationDrift.unknown = ["UNRECOGNIZED_DIRECT_MUTATION_GATE"];
    },
    "legacy client-memory writes enabled": (runtime) => {
      runtime.brain.legacyClientMemoryWrites = "enabled";
      runtime.configurationDrift.status = "detected";
      runtime.configurationDrift.differences = [{
        key: "ALLOW_LEGACY_CLIENT_MEMORY_WRITES",
        checkedIn: "disabled",
        runtime: "enabled"
      }];
    }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const h = harness();
      mutate(h.state.session.runtime);
      await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /not ready|runtime|required/i);
      assert.equal(actionPosts(h).length, 0);
    });
  }
});

test("plan requires only the claim-filing call gate and blocks every other effect gate", async (t) => {
  for (const gate of [
    "carrierFollowUpCalls",
    "clientCoordinatorAppointmentCalls",
    "clientCoordinatorExpandedCalls",
    "gmailSend",
    "hcnActionExecution",
    "quoSend",
    "realtimeVoiceCalls"
  ]) {
    await t.test(gate, async () => {
      const h = harness();
      h.state.session.runtime.gates[gate] = "enabled";
      await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /claim-filing-only effect boundary/i);
      assert.equal(actionPosts(h).length, 0);
    });
  }
  await t.test("claimFilingCalls disabled", async () => {
    const h = harness();
    h.state.session.runtime.gates.claimFilingCalls = "disabled";
    await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /claim-filing-only effect boundary/i);
    assert.equal(actionPosts(h).length, 0);
  });
});

test("recovery-only unresolved receipts block planning before the action POST", async () => {
  const h = harness();
  enterRecovery(h);
  const verification = await h.coordinator.verifiedBridgeSession();
  assert.equal(verification.ready, false);
  assert.equal(verification.recoveryBoundaryAttested, true);
  assert.equal(verification.recoveryAllowed, true);
  await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /not ready for normal work/i);
  assert.equal(actionPosts(h).length, 0);
});

test("hard-blocked receipts remain attested but prohibit recovery, planning, and action POSTs", async () => {
  const h = harness();
  h.state.policy.ready = false;
  h.state.policy.receipts = {
    ...h.state.policy.receipts,
    total: HISTORICAL_IDS.length + 1,
    unresolvedCount: 1,
    unresolvedBatchIds: [OTHER_RECOVERY_ID],
    reconciliationEligibleCount: 0,
    reconciliationEligibleBatchIds: [],
    hardBlockedCount: 1,
    hardBlockedBatchIds: [OTHER_RECOVERY_ID],
    hardBlockedSummaries: [hardBlockedSummary(OTHER_RECOVERY_ID)]
  };
  const verification = await h.coordinator.verifiedBridgeSession();
  assert.equal(verification.ready, false);
  assert.equal(verification.operatorBoundaryAttested, true);
  assert.equal(verification.recoveryBoundaryAttested, true);
  assert.equal(verification.recoveryAllowed, false);
  assert.deepEqual(
    verification.unresolvedReceiptBoundary.hardBlockedBatchIds,
    [OTHER_RECOVERY_ID]
  );
  assert.match(verification.instruction, /HARD STOP/i);
  await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /not ready for normal work/i);
  assert.equal(actionPosts(h).length, 0);
});

test("reconciliation freshly attests one exact eligible nonhistorical receipt", async (t) => {
  await t.test("pinned historical receipt is rejected before any bridge request", async () => {
    const h = harness();
    h.approvals.set("old-plan", { challenge: "must-clear" });
    await assert.rejects(
      h.coordinator.reconcileActionBatch(HISTORICAL_IDS[0]),
      /historical attention.*never eligible/i
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.approvals.size, 0);
  });

  await t.test("normal ready session cannot reconcile", async () => {
    const h = harness();
    await assert.rejects(
      h.coordinator.reconcileActionBatch(RECOVERY_ID),
      /only in an attested recovery-only session/i
    );
    assert.equal(reconcilePosts(h).length, 0);
  });

  await t.test("unattested build cannot reconcile", async () => {
    const h = harness();
    enterRecovery(h);
    h.state.session.build.attested = false;
    await assert.rejects(
      h.coordinator.reconcileActionBatch(RECOVERY_ID),
      /reconciliation boundary is not attested/i
    );
    assert.equal(reconcilePosts(h).length, 0);
  });

  await t.test("unlisted receipt cannot reconcile", async () => {
    const h = harness();
    enterRecovery(h);
    await assert.rejects(
      h.coordinator.reconcileActionBatch(OTHER_RECOVERY_ID),
      /not one of the exact currently unresolved/i
    );
    assert.equal(reconcilePosts(h).length, 0);
  });

  await t.test("hard-blocked receipt cannot reconcile", async () => {
    const h = harness();
    h.state.policy.ready = false;
    h.state.policy.receipts = {
      ...h.state.policy.receipts,
      total: HISTORICAL_IDS.length + 1,
      unresolvedCount: 1,
      unresolvedBatchIds: [OTHER_RECOVERY_ID],
      reconciliationEligibleCount: 0,
      reconciliationEligibleBatchIds: [],
      hardBlockedCount: 1,
      hardBlockedBatchIds: [OTHER_RECOVERY_ID],
      hardBlockedSummaries: [hardBlockedSummary(OTHER_RECOVERY_ID)]
    };
    await assert.rejects(
      h.coordinator.reconcileActionBatch(OTHER_RECOVERY_ID),
      /hard-blocked.*never be reconciled/i
    );
    assert.equal(reconcilePosts(h).length, 0);
  });

  await t.test("eligible recovery re-attests then posts once and clears stale plans", async () => {
    const h = harness();
    enterRecovery(h);
    h.approvals.set("old-plan", { challenge: "must-clear" });
    const response = await h.coordinator.reconcileActionBatch(RECOVERY_ID);
    assert.equal(response.mode, "reconciled");
    assert.equal(reconcilePosts(h).length, 1);
    assert.deepEqual(reconcilePosts(h)[0].body, { batchId: RECOVERY_ID });
    assert.deepEqual(
      h.requests.slice(0, 3).map(({ method, pathname }) => `${method} ${pathname}`).sort(),
      ["GET /api/v1/session", "GET /auth/whoami", "GET /ops/run-policy"].sort()
    );
    assert.equal(h.approvals.size, 0);
  });
});

test("happy plan stores the full attested boundary and strips the local challenge", async () => {
  const h = harness();
  const response = await h.coordinator.planActionBatch(OPERATIONS);
  assert.equal(response.approvalDigest, "digest-1");
  assert.equal(Object.hasOwn(response, "approvalChallenge"), false);
  assert.equal(actionPosts(h).length, 1);
  const pending = h.approvals.get("digest-1");
  assert.equal(typeof pending.attestedBoundary, "string");
  const boundary = JSON.parse(pending.attestedBoundary);
  assert.equal(boundary.bridgeBootId, "boot-1");
  assert.deepEqual(boundary.build, h.state.session.build);
  assert.deepEqual(boundary.runtime, h.state.session.runtime);
  assert.deepEqual(boundary.runPolicy, h.state.policy.runPolicy);
  assert.deepEqual(boundary.legacyIsolation, h.state.policy.legacyIsolation);
  assert.equal(boundary.historicalAttention.count, HISTORICAL_IDS.length);
  assert.deepEqual(boundary.historicalAttention.batchIds, [...HISTORICAL_IDS].sort());
});

test("starting any newer planning attempt invalidates the prior local approval", async () => {
  const h = harness();
  await h.coordinator.planActionBatch(OPERATIONS);
  assert.equal(h.approvals.has("digest-1"), true);
  h.state.session.build.attested = false;
  await assert.rejects(h.coordinator.planActionBatch(OPERATIONS), /not ready for normal work/i);
  assert.equal(h.approvals.size, 0);
  await assert.rejects(
    h.coordinator.executeActionBatch("digest-1", OPERATIONS, "assigned"),
    /No unconsumed local approval plan/i
  );
  assert.equal(actionPosts(h).length, 1);
});

test("execute consumes approval and performs no execute POST after boot, build, policy, or runtime drift", async (t) => {
  const mutations = {
    "boot changed": (state) => { state.policy.bridgeBootId = "boot-2"; },
    "deployment build changed": (state) => { state.session.build.deployId = "deploy-2"; },
    "provider source commit changed": (state) => {
      state.session.build.sourceCommit = EXPECTED_BRIDGE_BUILD.sourceCommit === "b".repeat(40) ? "a".repeat(40) : "b".repeat(40);
    },
    "policy changed": (state) => { state.policy.runPolicy.expiresAt = "2099-09-24T05:00:00.000Z"; },
    "historical isolation summary changed": (state) => {
      state.policy.receipts.historicalAttentionSummaries[0].updatedAt =
        "2026-08-02T00:00:00.000Z";
    },
    "dedicated JobNimbus owner changed": (state) => {
      state.whoami.identity.jobNimbusOwnerId = "different-owner";
    },
    "runtime changed": (state) => { state.session.runtime.connectors.quo = "unconfigured"; }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const h = harness();
      await h.coordinator.planActionBatch(OPERATIONS);
      mutate(h.state);
      await assert.rejects(
        h.coordinator.executeActionBatch("digest-1", OPERATIONS, "assigned"),
        /(?:boundary changed|not ready for normal work).*local approval was consumed/i
      );
      assert.equal(actionPosts(h).length, 1);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("execute performs no execute POST when receipts make the re-attested session recovery-only", async () => {
  const h = harness();
  await h.coordinator.planActionBatch(OPERATIONS);
  h.state.policy.ready = false;
  h.state.policy.receipts = {
    ...h.state.policy.receipts,
    total: HISTORICAL_IDS.length + 1,
    unresolvedCount: 1,
    unresolvedBatchIds: [RECOVERY_ID],
    reconciliationEligibleCount: 1,
    reconciliationEligibleBatchIds: [RECOVERY_ID]
  };
  await assert.rejects(
    h.coordinator.executeActionBatch("digest-1", OPERATIONS, "assigned"),
    /not ready for normal work.*local approval was consumed/i
  );
  assert.equal(actionPosts(h).length, 1);
  assert.equal(h.approvals.size, 0);
});

test("execute never reports success from an incomplete or ambiguous receipt", async (t) => {
  const mutations = {
    "skeletal batch": (response) => {
      response.batch = {
        runPolicyId: CHANCE_RUN_POLICY.id,
        runPolicySha256: CHANCE_RUN_POLICY.sha256,
        runPolicyExpiresAt: FUTURE,
        approvalDigest: "digest-1"
      };
    },
    "wrong execution boot": (response) => { response.batch.bootId = "boot-elsewhere"; },
    "missing file descriptors": (response) => { delete response.batch.files; },
    "missing immutable intents": (response) => { delete response.batch.intents; },
    "unconfirmed provider readback": (response) => {
      response.batch.completed[0].receipt.verifiedByReadback = false;
    },
    "terminal response retains current action": (response) => {
      response.batch.current = {
        index: 0,
        type: OPERATIONS[0].type,
        fileId: "contact-2739",
        fileNumber: "2739",
        status: "reconciliation_required"
      };
    }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const h = harness();
      await h.coordinator.planActionBatch(OPERATIONS);
      h.state.mutateExecutionResponse = mutate;
      await assert.rejects(
        h.coordinator.executeActionBatch("digest-1", OPERATIONS, "assigned"),
        /execution receipt|provider readback|terminal execution.*local approval was consumed/i
      );
      assert.equal(actionPosts(h).length, 2);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("happy execute re-attests unchanged boundary and posts the hidden challenge exactly once", async () => {
  const h = harness();
  await h.coordinator.planActionBatch(OPERATIONS);
  const response = await h.coordinator.executeActionBatch(
    "digest-1",
    OPERATIONS,
    "assigned"
  );
  assert.equal(response.mode, "executed");
  const posts = actionPosts(h);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.execute, false);
  assert.equal(posts[1].body.execute, true);
  assert.equal(posts[1].body.approvalDigest, "digest-1");
  assert.equal(posts[1].body.approvalChallenge, "secret-one-use-challenge");
  assert.equal(h.approvals.size, 0);
});

test("existing-draft send plans and executes only the unchanged sole operation", async () => {
  const h = harness();
  const plan = await h.coordinator.planActionBatch(SEND_OPERATIONS);
  assert.equal(plan.approvalDigest, "digest-1");
  const planPost = actionPosts(h)[0];
  assert.deepEqual(planPost.body.operations, [{
    type: "gmail.send_existing_draft",
    payload: {
      query: "2739",
      draftId: "draft-reviewed-1",
      operatorScope: "assigned"
    }
  }]);

  const response = await h.coordinator.executeActionBatch(
    "digest-1",
    SEND_OPERATIONS,
    "assigned"
  );
  assert.equal(response.mode, "executed");
  assert.equal(response.batch.completed[0].receipt.externalId, "sent-message-1");
  assert.equal(response.batch.completed[0].receipt.sourceDraftId, "draft-reviewed-1");
  assert.equal(
    response.batch.completed[0].receipt.sourceDraftRetention,
    "retained_for_separate_cleanup"
  );
  assert.equal(actionPosts(h).length, 2);
  assert.equal(h.approvals.size, 0);
});

test("existing-draft send approval is consumed when the draft id changes", async () => {
  const h = harness();
  await h.coordinator.planActionBatch(SEND_OPERATIONS);
  await assert.rejects(
    h.coordinator.executeActionBatch("digest-1", [{
      ...SEND_OPERATIONS[0],
      payload: { ...SEND_OPERATIONS[0].payload, draftId: "different-draft" }
    }], "assigned"),
    /differ from the reviewed plan.*approval was consumed/i
  );
  assert.equal(actionPosts(h).length, 1);
  assert.equal(h.approvals.size, 0);
});

test("Retell plan is one-file, freshly attested, configuration-pinned, and challenge-sanitized", async () => {
  const h = harness();
  const response = await h.coordinator.planClaimFilingCall(CLAIM_INPUT);

  assert.equal(response.approvalId, CLAIM_APPROVAL_ID);
  assert.equal(response.planDigest, CLAIM_PLAN_DIGEST);
  assert.equal(Object.hasOwn(response, "approvalChallenge"), false);
  assert.equal(response.communicationPreflight.ready, true);
  assert.match(response.communicationPreflight.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(response.communicationPreflight.stopSignals, []);
  assert.deepEqual(response.communicationPreflight.limitationCodes, [
    "bounded_history_window",
    "quo_carrier_conversations_not_searched",
    "quo_homeowner_phone_history_only"
  ]);
  assert.deepEqual(response.approvedInput, {
    ...CLAIM_INPUT,
    includeCarrierBatch: false
  });
  assert.equal(claimPosts(h, "/ops/review-chance-files").length, 1);
  assert.deepEqual(claimPosts(h, "/ops/review-chance-files")[0].body, {
    query: "#2787",
    limit: 1,
    activeOnly: false,
    includeGmail: true,
    includeQuo: true,
    includeQuoTranscripts: true,
    includeCompleteJobNimbusEvidence: true,
    includeCompleteCommunicationEvidence: true,
    communicationDays: 3650,
    gmailLimit: 15,
    gmailThreadLimit: 5,
    quoLimit: 50
  });
  assert.equal(claimPosts(h, "/claim-filing/configuration").length, 1);
  assert.equal(claimPosts(h, "/claim-filing/prepare").length, 1);
  assert.deepEqual(claimPosts(h, "/claim-filing/prepare")[0].body, {
    ...CLAIM_INPUT,
    includeCarrierBatch: false
  });
  const pending = h.approvals.get(CLAIM_APPROVAL_ID);
  assert.equal(pending.kind, "claim_filing_call");
  assert.equal(pending.challenge, "retell-secret-one-use-challenge");
  assert.equal(pending.planDigest, CLAIM_PLAN_DIGEST);
  assert.equal(pending.fileNumber, "2787");
  assert.equal(typeof pending.attestedBoundary, "string");
  assert.equal(typeof pending.configuration, "string");
  assert.equal(pending.communicationDigest, response.communicationPreflight.digest);
});

test("Retell planning fails closed when exact-file Gmail or Quo review is unavailable or incomplete", async (t) => {
  const cases = [
    ["gmail_not_fresh", review => { review.packets[0].gmail.status = "error"; }],
    ["gmail_provider_scan_incomplete", review => { review.packets[0].gmail.coverage.providerScanComplete = false; }],
    ["quo_not_reviewed", review => { review.packets[0].quo.status = "error"; }],
    ["quo_provider_scan_incomplete", review => { review.packets[0].quo.completeness.complete = false; }],
    ["quo_transcripts_not_requested", review => { review.packets[0].quo.coverage.transcriptReviewRequested = false; }],
    ["quo_timeline_preview_incomplete", review => { review.packets[0].quo.coverage.omittedTimelineItems = 1; }],
    ["file_mismatch", review => { review.packets[0].file.number = "2760"; }]
  ];
  for (const [code, mutate] of cases) {
    await t.test(code, async () => {
      const h = harness();
      mutate(h.state.claimCommunicationReview);
      await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), new RegExp(code));
      assert.equal(claimPosts(h, "/ops/review-chance-files").length, 1);
      assert.equal(claimPosts(h, "/claim-filing/configuration").length, 0);
      assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("Retell planning rejects incomplete or unproven JobNimbus history before any call plan", async (t) => {
  const cases = [
    ["missing coverage", live => { delete live.coverage; }],
    ["unknown coverage version", live => { live.coverage.schemaVersion = 2; }],
    ["ordinary preview", live => { live.coverage.mode = "preview"; }],
    ["provider scan incomplete", live => { live.coverage.providerScanComplete = false; }],
    ["packet incomplete", live => { live.coverage.complete = false; }],
    ["unknown provider bound", live => { delete live.coverage.readLimit; }],
    ["older activity omitted", live => {
      live.recentActivities = Array.from({ length: 30 }, (_, i) => ({ id: `routine-${i}`, note: "Routine work." }));
      live.coverage.activities = { availableCount: 31, returnedCount: 30, omittedCount: 1 };
    }],
    ["open task omitted", live => { live.coverage.openTasks.availableCount = 1; live.coverage.openTasks.omittedCount = 1; }],
    ["document omitted", live => { live.coverage.operationalDocuments.availableCount = 1; live.coverage.operationalDocuments.omittedCount = 1; }],
    ["missing count", live => { delete live.coverage.activities.availableCount; }],
    ["negative count", live => { live.coverage.activities.omittedCount = -1; }],
    ["coerced count", live => { live.coverage.activities.omittedCount = "0"; }],
    ["returned count mismatch", live => { live.coverage.activities.returnedCount = 1; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const h = harness();
      mutate(h.state.claimCommunicationReview.packets[0].liveJobNimbus);
      await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), /jobnimbus_.*incomplete/);
      assert.equal(claimPosts(h, "/claim-filing/configuration").length, 0);
      assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("Retell planning independently rejects withheld or unknown Gmail search coverage", async (t) => {
  const cases = [
    ["withheld search message despite no next page", gmail => {
      gmail.coverage.search.scannedMessages = 1;
      gmail.coverage.search.withheldMessages = 1;
    }],
    ["missing search coverage", gmail => { delete gmail.coverage.search; }],
    ["missing withheld count", gmail => { delete gmail.coverage.search.withheldMessages; }],
    ["coerced withheld count", gmail => { gmail.coverage.search.withheldMessages = "0"; }],
    ["negative withheld count", gmail => { gmail.coverage.search.withheldMessages = -1; }],
    ["provider has another page", gmail => { gmail.coverage.search.hasMore = true; }],
    ["unknown pagination", gmail => { delete gmail.coverage.search.hasMore; }],
    ["scanned count mismatch", gmail => { gmail.coverage.search.scannedMessages = 1; }],
    ["returned count mismatch", gmail => { gmail.coverage.search.returnedMessages = 1; }],
    ["search body truncated", gmail => { gmail.coverage.search.truncatedMessages = 1; }],
    ["unknown body truncation", gmail => { gmail.coverage.search.truncatedMessages = null; }],
    ["unreviewed thread", gmail => { gmail.coverage.returnedThreadCount = 1; gmail.coverage.omittedThreadCount = 1; }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const h = harness();
      mutate(h.state.claimCommunicationReview.packets[0].gmail);
      await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), /gmail_provider_scan_incomplete/);
      assert.equal(claimPosts(h, "/claim-filing/configuration").length, 0);
      assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("Retell checks older JobNimbus activities and open task text, not just a recent preview", async (t) => {
  for (const source of ["older activity", "open task"]) {
    await t.test(source, async () => {
      const h = harness();
      const live = h.state.claimCommunicationReview.packets[0].liveJobNimbus;
      live.recentActivities = Array.from({ length: 30 }, (_, i) => ({ id: `routine-${i}`, note: "Routine work." }));
      if (source === "older activity") {
        live.recentActivities.push({ id: "old-claim", type: "Note", note: "Claim was filed. Claim number: ABC-12345" });
      } else {
        live.openTasks.push({ id: "carrier-task", title: "Carrier follow-up", description: "Claim was filed. Claim number: ABC-12345" });
      }
      syncClaimJobNimbusCoverage(h.state.claimCommunicationReview);
      await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), /claim_already_filed|claim_number_present_in_evidence/);
      assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("Retell validates Gmail thread coverage independently of the top-level scan flag", async (t) => {
  const cases = [
    ["fully reviewed thread", () => {}, true],
    ["withheld thread message", thread => { thread.coverage.withheldMessages = 1; }, false],
    ["missing thread coverage", thread => { delete thread.coverage; }, false],
    ["missing withheld count", thread => { delete thread.coverage.withheldMessages; }, false],
    ["omitted message", thread => { thread.coverage.omittedMessages = 1; }, false],
    ["truncated provider body", thread => { thread.coverage.truncatedMessages = 1; }, false],
    ["unknown provider truncation", thread => { thread.coverage.truncatedMessages = null; }, false],
    ["truncated display preview", thread => { thread.coverage.previewTruncatedMessages = 1; }, false],
    ["returned count mismatch", thread => { thread.coverage.returnedMessages = 0; }, false]
  ];
  for (const [name, mutate, ready] of cases) {
    await t.test(name, async () => {
      const h = harness();
      const gmail = h.state.claimCommunicationReview.packets[0].gmail;
      const message = { id: "message-1", threadId: "thread-1", text: "Routine homeowner message." };
      gmail.messages.push(message);
      syncClaimGmailSearchCounts(h.state.claimCommunicationReview);
      gmail.coverage.returnedThreadCount = 1;
      gmail.coverage.reviewedThreadCount = 1;
      gmail.threads.push({
        id: "thread-1",
        messageCount: 1,
        messages: [message],
        coverage: {
          hasMore: false, scannedMessages: 1, returnedMessages: 1, withheldMessages: 0,
          omittedMessages: 0, previewTruncatedMessages: 0
        }
      });
      mutate(gmail.threads[0]);
      if (ready) {
        const plan = await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
        assert.equal(plan.communicationPreflight.ready, true);
      } else {
        await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), /gmail_provider_scan_incomplete/);
        assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
        assert.equal(h.approvals.size, 0);
      }
    });
  }
});

test("Retell existing-claim lookup does not bypass complete-history admission", async () => {
  const h = harness();
  delete h.state.claimCommunicationReview.packets[0].liveJobNimbus.coverage;
  await assert.rejects(
    h.coordinator.planClaimFilingCall({ ...CLAIM_INPUT, goal: "find_existing_claim" }),
    /jobnimbus_provider_scan_incomplete/
  );
  assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
  assert.equal(h.approvals.size, 0);
});

test("Retell new-claim planning stops on strong prior-filing communication evidence", async () => {
  const h = harness();
  h.state.claimCommunicationReview.packets[0].liveJobNimbus.recentActivities.push({
    id: "activity-filed",
    type: "Note",
    note: "Claim was filed and the carrier assigned a desk adjuster."
  });
  syncClaimJobNimbusCoverage(h.state.claimCommunicationReview);
  await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), error => {
    assert.match(error.message, /claim_already_filed/);
    assert.match(error.message, /adjuster_already_assigned/);
    assert.doesNotMatch(error.message, /Claim was filed/);
    return true;
  });
  assert.equal(claimPosts(h, "/claim-filing/configuration").length, 0);
  assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
  assert.equal(h.approvals.size, 0);
});

test("Retell new-claim stop signals recognize real attempts without treating negative or estimator language as filed claims", async (t) => {
  const blocked = [
    ["verb-first filed claim", "I filed a claim and then the adjuster called.", /claim_already_filed/],
    ["failed carrier filing attempt", "Called to file a claim twice, but the carrier could not locate active coverage.", /prior_claim_filing_attempt/],
    ["carrier inspection", "The carrier inspection is scheduled for Friday.", /claim_inspection_already_scheduled/],
    ["real claim number", "Claim number: ABC-12345", /claim_number_present_in_evidence/]
  ];
  for (const [name, note, expected] of blocked) {
    await t.test(name, async () => {
      const h = harness();
      h.state.claimCommunicationReview.packets[0].liveJobNimbus.recentActivities.push({
        id: `activity-${name}`,
        type: "Note",
        note
      });
      syncClaimJobNimbusCoverage(h.state.claimCommunicationReview);
      await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), expected);
      assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
    });
  }

  const allowed = [
    "Claim not filed.",
    "No claim has been filed.",
    "Estimate inspection scheduled.",
    "Claim number missing.",
    "Waiting for the homeowner to call back."
  ];
  for (const note of allowed) {
    await t.test(note, async () => {
      const h = harness();
      h.state.claimCommunicationReview.packets[0].liveJobNimbus.recentActivities.push({
        id: `activity-${note}`,
        type: "Note",
        note
      });
      syncClaimJobNimbusCoverage(h.state.claimCommunicationReview);
      const response = await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
      assert.equal(response.communicationPreflight.ready, true);
      assert.equal(claimPosts(h, "/claim-filing/prepare").length, 1);
    });
  }
});

test("Retell existing-claim lookup may proceed after the same communication review", async () => {
  const h = harness();
  const input = { ...CLAIM_INPUT, goal: "find_existing_claim" };
  h.state.claimCommunicationReview.packets[0].liveJobNimbus.recentActivities.push({
    id: "activity-existing",
    type: "Note",
    note: "Carrier confirmed an existing claim but the number is not recorded."
  });
  syncClaimJobNimbusCoverage(h.state.claimCommunicationReview);
  h.state.mutateClaimPlan = response => {
    response.packet.goal = "find_existing_claim";
  };
  const response = await h.coordinator.planClaimFilingCall(input);
  assert.equal(response.communicationPreflight.ready, true);
  assert.equal(response.packet.goal, "find_existing_claim");
});

test("Retell plan rejects excluded, nonnumeric, batched, unsupported, and control-bearing inputs before bridge access", async (t) => {
  const cases = [
    [{ ...CLAIM_INPUT, query: "#2628" }, /excluded/i],
    [{ ...CLAIM_INPUT, query: "Ronald" }, /numeric JobNimbus file number/i],
    [{ ...CLAIM_INPUT, includeCarrierBatch: true }, /single-file only/i],
    [{ ...CLAIM_INPUT, goal: "status_follow_up" }, /only file_new_claim or find_existing_claim/i],
    [{ ...CLAIM_INPUT, execute: true }, /unsupported.*execute/i],
    [{ ...CLAIM_INPUT, approvalChallenge: "secret" }, /unsupported.*approvalChallenge/i],
    [{ ...CLAIM_INPUT, overrides: { surprise: "unsafe" } }, /unsupported.*surprise/i],
    [{ ...CLAIM_INPUT, overrides: { coverageTermStatus: "probably_active" } }, /coverageTermStatus/i],
    [{ ...CLAIM_INPUT, overrides: { carrier: { name: "Allstate" } } }, /overrides\.carrier must be a string/i],
    [{ ...CLAIM_INPUT, overrides: { damageDetails: {} } }, /damageDetails must be/i]
  ];
  for (const [input, pattern] of cases) {
    await t.test(pattern.source, async () => {
      const h = harness();
      h.approvals.set("old", { challenge: "must-clear" });
      await assert.rejects(h.coordinator.planClaimFilingCall(input), pattern);
      assert.equal(h.requests.length, 0);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("Retell plan stops before preparation when the live agent configuration is not ready", async () => {
  const h = harness();
  h.state.claimConfiguration.ready = false;
  h.state.claimConfiguration.instruction = "Do not place a claim call.";
  await assert.rejects(
    h.coordinator.planClaimFilingCall(CLAIM_INPUT),
    /live Retell claim-filing agent is not ready/i
  );
  assert.equal(claimPosts(h, "/claim-filing/configuration").length, 1);
  assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
  assert.equal(h.approvals.size, 0);
});

test("Retell plan diagnoses every failed check without granting approval or exposing payloads", async (t) => {
  const cases = [
    ["not_dry_run", r => { r.mode = "executed"; }],
    ["approval_not_required", r => { r.approvalRequired = false; }],
    ["file_not_ready", r => { r.readiness.ready = false; }],
    ["configuration_not_attested", r => { r.configurationAttested = false; }],
    ["invalid_agent_version", r => { r.agentVersion = null; }],
    ["invalid_agent_version", r => { r.agentVersion = -1; }],
    ["invalid_agent_digest", r => { r.agentConfigDigest = "bad"; }],
    ["invalid_callback_digest", r => { r.callbackPacketDigest = "bad"; }],
    ["invalid_plan_digest", r => { r.planDigest = "bad"; }],
    ["missing_approval_challenge", r => { r.approvalChallenge = ""; }],
    ["invalid_or_expired_approval", r => { r.approvalExpiresAt = "bad"; }],
    ["invalid_or_expired_approval", r => { r.approvalExpiresAt = new Date(NOW).toISOString(); }],
    ["missing_file_id", r => { r.file.id = ""; }],
    ["file_mismatch", r => { r.file.number = "2760"; }],
    ["excluded_file", r => { r.file.number = "2628"; }],
    ["goal_mismatch", r => { r.packet.goal = "find_existing_claim"; }],
    ["multiple_claims", r => { r.batchClaims = [{}]; }],
    ["invalid_coverage_status", r => { delete r.packet.verifiedFileFacts.coverageTermStatus; }],
    ["coverage_status_not_bound", r => { r.callPlan.dynamicVariables.coverageTermStatus = "verified_in_force"; }],
    ["approved_coverage_status_changed", r => {
      r.packet.verifiedFileFacts.coverageTermStatus = "verified_in_force";
      r.callPlan.dynamicVariables.coverageTermStatus = "verified_in_force";
    }],
    ["missing_policy_lookup_instruction", r => { r.packet.verifiedFileFacts.priorPolicyLookupInstruction = ""; }],
    ["policy_lookup_instruction_not_bound", r => {
      r.callPlan.dynamicVariables.priorPolicyLookupInstruction = "Different instruction";
    }],
    ["damage_not_explicitly_approved", r => { r.packet.damageEvidenceSource = "inferred_review_only"; }],
    ["damage_details_not_bound", r => { r.callPlan.dynamicVariables.damageDetails = "Missing"; }]
  ];
  for (const [code, mutate] of cases) {
    await t.test(code, async () => {
      const h = harness();
      h.state.mutateClaimPlan = mutate;
      await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), error => {
        assert.match(error.message, new RegExp(code));
        assert.doesNotMatch(error.message, /retell-secret-one-use-challenge/);
        return true;
      });
      assert.equal(h.approvals.size, 0);
      assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
    });
  }
});

test("Retell missing carrier number gives safe actionable guidance", async () => {
  const h = harness();
  h.state.mutateClaimPlan = r => {
    r.readiness = { ready: false, blockers: ["no filing phone for this carrier", "private arbitrary payload"] };
    r.configurationAttested = false;
    r.approvalChallenge = "";
  };
  await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), error => {
    assert.match(error.message, /Supply carrierPhone from verified carrier or policy evidence/);
    assert.doesNotMatch(error.message, /private arbitrary payload|retell-secret/);
    return true;
  });
  assert.equal(h.approvals.size, 0);
  assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
});

test("Retell execution consumes local approval before exact-input validation", async () => {
  const h = harness();
  await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
  await assert.rejects(
    h.coordinator.executeClaimFilingCall(
      CLAIM_APPROVAL_ID,
      CLAIM_PLAN_DIGEST,
      { ...CLAIM_INPUT, stormTime: "4:00 PM" }
    ),
    /differs from the reviewed plan.*approval was consumed/i
  );
  assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
  assert.equal(h.approvals.size, 0);
  await assert.rejects(
    h.coordinator.executeClaimFilingCall(CLAIM_APPROVAL_ID, CLAIM_PLAN_DIGEST, CLAIM_INPUT),
    /No unconsumed local Retell approval plan/i
  );
});

test("Retell execution fails closed before calling on bridge or live-agent drift", async (t) => {
  await t.test("bridge boot drift", async () => {
    const h = harness();
    await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
    h.state.policy.bridgeBootId = "boot-2";
    await assert.rejects(
      h.coordinator.executeClaimFilingCall(CLAIM_APPROVAL_ID, CLAIM_PLAN_DIGEST, CLAIM_INPUT),
      /boundary changed.*Nothing was called.*approval was consumed/i
    );
    assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
  });

  await t.test("published Retell configuration drift", async () => {
    const h = harness();
    await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
    h.state.claimConfiguration.llmVersion += 1;
    await assert.rejects(
      h.coordinator.executeClaimFilingCall(CLAIM_APPROVAL_ID, CLAIM_PLAN_DIGEST, CLAIM_INPUT),
      /live Retell prompt, tools, schema, publication, or callback configuration changed.*approval was consumed/i
    );
    assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
  });
});

test("Retell execution consumes approval when exact-file communication evidence changes", async () => {
  const h = harness();
  await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
  h.state.claimCommunicationReview.packets[0].gmail.messages.push({
    id: "gmail-new-evidence",
    threadId: "thread-new-evidence",
    subject: "New file evidence",
    snippet: "A new exact-file message arrived after approval."
  });
  syncClaimGmailSearchCounts(h.state.claimCommunicationReview);
  await assert.rejects(
    h.coordinator.executeClaimFilingCall(CLAIM_APPROVAL_ID, CLAIM_PLAN_DIGEST, CLAIM_INPUT),
    /evidence changed after call approval.*Nothing was called.*approval was consumed/i
  );
  assert.equal(claimPosts(h, "/ops/review-chance-files").length, 2);
  assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
  assert.equal(h.approvals.size, 0);
});

test("Retell execution consumes approval when fresh communication review gains a stop signal", async () => {
  const h = harness();
  await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
  h.state.claimCommunicationReview.packets[0].gmail.messages.push({
    id: "gmail-carrier-receipt",
    threadId: "thread-carrier-receipt",
    subject: "Claim receipt",
    snippet: "We received the claim and a desk adjuster was assigned."
  });
  syncClaimGmailSearchCounts(h.state.claimCommunicationReview);
  await assert.rejects(
    h.coordinator.executeClaimFilingCall(CLAIM_APPROVAL_ID, CLAIM_PLAN_DIGEST, CLAIM_INPUT),
    /carrier_claim_receipt|adjuster_already_assigned/i
  );
  assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
  assert.equal(h.approvals.size, 0);
});

test("Retell execution consumes approval if JobNimbus history or Gmail search becomes incomplete", async (t) => {
  const cases = [
    ["older activity withheld", review => {
      review.packets[0].liveJobNimbus.coverage.activities = { availableCount: 1, returnedCount: 0, omittedCount: 1 };
    }, /jobnimbus_.*incomplete/],
    ["Gmail search withholds a message", review => {
      review.packets[0].gmail.coverage.search.scannedMessages = 1;
      review.packets[0].gmail.coverage.search.withheldMessages = 1;
    }, /gmail_provider_scan_incomplete/]
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const h = harness();
      await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
      mutate(h.state.claimCommunicationReview);
      await assert.rejects(
        h.coordinator.executeClaimFilingCall(CLAIM_APPROVAL_ID, CLAIM_PLAN_DIGEST, CLAIM_INPUT),
        expected
      );
      assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
      assert.equal(h.approvals.size, 0);
    });
  }
});

test("Retell execution binds older full-history records and rechecks them before calling", async () => {
  const h = harness();
  const review = h.state.claimCommunicationReview;
  review.packets[0].liveJobNimbus.recentActivities = Array.from({ length: 31 }, (_, i) => ({
    id: `activity-${i}`, type: "Note", note: "Routine work."
  }));
  syncClaimJobNimbusCoverage(review);
  const plan = await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
  assert.equal(plan.communicationPreflight.evidenceCounts.jobNimbusActivities, 31);
  review.packets[0].liveJobNimbus.recentActivities[30].note = "An older exact-file note was corrected.";
  await assert.rejects(
    h.coordinator.executeClaimFilingCall(CLAIM_APPROVAL_ID, CLAIM_PLAN_DIGEST, CLAIM_INPUT),
    /evidence changed after call approval.*Nothing was called.*approval was consumed/i
  );
  assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
  assert.equal(h.approvals.size, 0);
});

test("Retell evidence approval tolerates Gmail transport-token rotation but rejects material attachment changes", async (t) => {
  const cases = [
    ["download tokens only", { attachmentId: "new-token", attachmentRef: "new-read-reference" }, true],
    ["filename", { filename: "different.pdf" }, false],
    ["MIME type", { mimeType: "image/png" }, false],
    ["byte size", { size: 501 }, false],
    ["MIME path", { partPath: "0.2" }, false]
  ];
  for (const [name, mutation, ready] of cases) await t.test(name, async () => {
    const h = harness();
    const gmail = h.state.claimCommunicationReview.packets[0].gmail;
    const attachment = { attachmentId: "old-token", attachmentRef: "old-read-reference", filename: "review.pdf",
      mimeType: "application/pdf", size: 500, partId: "1", partPath: "0.1" };
    const message = { id: "stable-message", threadId: "stable-thread", subject: "Routine update", text: "Routine update", attachments: [attachment] };
    gmail.messages = [message];
    gmail.threads = [{ id: "stable-thread", messages: [message], coverage: {
      hasMore: false, scannedMessages: 1, returnedMessages: 1, withheldMessages: 0,
      omittedMessages: 0, previewTruncatedMessages: 0
    } }];
    syncClaimGmailSearchCounts(h.state.claimCommunicationReview);
    gmail.coverage.returnedThreadCount = 1;
    gmail.coverage.reviewedThreadCount = 1;
    await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
    Object.assign(attachment, mutation);
    const execute = () => h.coordinator.executeClaimFilingCall(CLAIM_APPROVAL_ID, CLAIM_PLAN_DIGEST, CLAIM_INPUT);
    if (ready) {
      assert.equal((await execute()).mode, "executed");
      assert.equal(claimPosts(h, "/claim-filing/call").length, 1);
    } else {
      await assert.rejects(execute, /evidence changed after call approval/i);
      assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
    }
    assert.equal(h.approvals.size, 0);
  });
});

test("Retell admission accepts only attested, count-consistent other-file Gmail exclusions", async (t) => {
  const mutations = [
    ["proved other file", () => {}, true],
    ["missing classification version", coverage => { delete coverage.schemaVersion; }, false],
    ["unverified exclusions", coverage => { coverage.scopeVerificationComplete = false; }, false],
    ["invalid pagination", coverage => { coverage.paginationValid = false; }, false],
    ["coerced exclusion count", coverage => { coverage.excludedOtherFileMessages = "1"; }, false],
    ["count mismatch", coverage => { coverage.scannedMessages = 2; }, false]
  ];
  for (const [name, mutate, ready] of mutations) await t.test(name, async () => {
    const h = harness();
    const coverage = h.state.claimCommunicationReview.packets[0].gmail.coverage.search;
    Object.assign(coverage, { schemaVersion: 2, mode: "complete_bounded_review", paginationValid: true,
      scopeVerificationComplete: true, scannedMessages: 1, excludedOtherFileMessages: 1 });
    mutate(coverage);
    if (ready) assert.equal((await h.coordinator.planClaimFilingCall(CLAIM_INPUT)).communicationPreflight.ready, true);
    else {
      await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), /gmail_provider_scan_incomplete/);
      assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
      assert.equal(h.approvals.size, 0);
    }
  });
});

test("Retell admission does not trust a transcript completeness flag without complete call evidence", async (t) => {
  const mutations = [
    ["missing coverage", quo => { delete quo.transcriptCoverage; }],
    ["preview mode", quo => { quo.transcriptCoverage.mode = "preview"; }],
    ["omitted older call", quo => { quo.transcriptCoverage.omittedCallCount = 1; }],
    ["missing speech transcript", quo => { quo.transcriptCoverage.missingSpeechTranscripts = 1; }],
    ["unreviewed recording", quo => {
      quo.timeline.push({ id: "old-recording", type: "call", status: "completed", durationSec: 60 });
      Object.assign(quo.transcriptCoverage, { callCount: 1, reviewedCallCount: 1 });
    }],
    ["nonmember transcript", quo => {
      quo.transcripts.push({ callId: "other-call", status: "completed", dialogue: [{ text: "Unrelated" }] });
      quo.transcriptCoverage.returnedTranscriptCount = 1;
    }]
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const h = harness();
    mutate(h.state.claimCommunicationReview.packets[0].quo);
    await assert.rejects(h.coordinator.planClaimFilingCall(CLAIM_INPUT), /quo_transcript_review_incomplete/);
    assert.equal(claimPosts(h, "/claim-filing/prepare").length, 0);
    assert.equal(h.approvals.size, 0);
  });
});

test("happy Retell execution posts the exact approved input and hidden challenge once", async () => {
  const h = harness();
  await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
  const response = await h.coordinator.executeClaimFilingCall(
    CLAIM_APPROVAL_ID,
    CLAIM_PLAN_DIGEST,
    CLAIM_INPUT
  );
  assert.equal(response.mode, "executed");
  assert.equal(response.callId, "call-retell-2787");
  assert.equal(Object.hasOwn(response, "approvalChallenge"), false);
  assert.equal(claimPosts(h, "/ops/review-chance-files").length, 2);
  const posts = claimPosts(h, "/claim-filing/call");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, {
    ...CLAIM_INPUT,
    includeCarrierBatch: false,
    execute: true,
    planDigest: CLAIM_PLAN_DIGEST,
    approvalChallenge: "retell-secret-one-use-challenge"
  });
  assert.equal(h.approvals.size, 0);
  assert.equal(h.requests.some((request) => request.pathname === "/claim-filing/writeback"), false);
});

test("new action or Retell planning and restart invalidate the other lane's local approval", async () => {
  const h = harness();
  await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
  assert.equal(h.approvals.has(CLAIM_APPROVAL_ID), true);
  await h.coordinator.planActionBatch(OPERATIONS);
  assert.equal(h.approvals.has(CLAIM_APPROVAL_ID), false);
  assert.equal(h.approvals.has("digest-1"), true);
  await h.coordinator.planClaimFilingCall(CLAIM_INPUT);
  assert.equal(h.approvals.has("digest-1"), false);
  assert.equal(h.approvals.has(CLAIM_APPROVAL_ID), true);
  await h.coordinator.restartVerifiedBridgeSession();
  assert.equal(h.approvals.size, 0);
});

test("a newer cross-lane plan prevents an older in-flight Retell plan from becoming approvable", async () => {
  const h = harness();
  let releasePrepare;
  let markPrepareEntered;
  const prepareEntered = new Promise((resolve) => { markPrepareEntered = resolve; });
  const prepareRelease = new Promise((resolve) => { releasePrepare = resolve; });
  h.state.beforeClaimPrepare = async () => {
    markPrepareEntered();
    await prepareRelease;
  };

  const olderRetellPlan = h.coordinator.planClaimFilingCall(CLAIM_INPUT);
  await prepareEntered;
  await h.coordinator.planActionBatch(OPERATIONS);
  releasePrepare();

  await assert.rejects(olderRetellPlan, /newer plan.*superseded/i);
  assert.equal(h.approvals.has(CLAIM_APPROVAL_ID), false);
  assert.equal(h.approvals.has("digest-1"), true);
});

test("Retell configuration, result, and callbacks are attested read-only paths even during receipt recovery", async () => {
  const h = harness();
  enterRecovery(h);
  const configuration = await h.coordinator.readClaimFilingConfiguration();
  const result = await h.coordinator.reviewClaimFilingCallResult("call-retell-2787");
  const callbacks = await h.coordinator.listPendingClaimCallbacks();

  assert.equal(configuration.mode, "read_only");
  assert.equal(result.mode, "read_only");
  assert.equal(callbacks.mode, "read_only");
  assert.equal(callbacks.count, 1);
  assert.equal(claimPosts(h, "/claim-filing/result").length, 1);
  assert.equal(claimPosts(h, "/claim-filing/callbacks").length, 1);
  assert.equal(claimPosts(h, "/claim-filing/call").length, 0);
  assert.equal(h.requests.some((request) => request.pathname === "/claim-filing/writeback"), false);
});
