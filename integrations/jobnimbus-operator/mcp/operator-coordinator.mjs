import { randomUUID } from "node:crypto";
import { assertApprovedNotePlan } from "./approved-note-plan.mjs";
import { assertPdfPlan, PDF_UPLOAD_TYPE } from "./pdf-upload-contract.mjs";
import { PDF_UPLOADS_ENABLED } from "./pdf-upload-release.mjs";
import { readLocalPdf } from "./local-pdf.mjs";

import {
  CHANCE_RUN_ACTION_TYPES,
  CHANCE_RUN_ALLOWED_CONTACT_FIELDS,
  CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES,
  CHANCE_RUN_EXCLUDED_FILE_NUMBERS,
  CHANCE_RUN_FILE_COUNT,
  CHANCE_LEGACY_ISOLATION,
  CHANCE_RUN_POLICY,
  EXPECTED_BRIDGE_BUILD,
  approvalBoundary,
  assertDedicatedMacOperatorIdentity,
  assertExecutionReceiptAttestation,
  assertLegacyIsolationAttestation,
  assertPlatformSessionAttestation,
  assertReconciliationReceiptAttestation,
  assertRestartBoundary,
  assertRunPolicyAttestation,
  scopedOperations
} from "./scope.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function stripApprovalSecrets(value) {
  if (Array.isArray(value)) return value.map(stripApprovalSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "approvalChallenge")
      .map(([key, item]) => [key, stripApprovalSecrets(item)])
  );
}

function requireReadyForNormalWork(verification) {
  if (
    verification?.ready !== true
    || verification?.operatorBoundaryAttested !== true
    || verification?.recoveryBoundaryAttested !== true
    || verification?.recoveryAllowed === true
  ) {
    const detail = String(
      verification?.attestationError || verification?.instruction || ""
    ).trim();
    throw new Error(
      `The exact bridge boot/build/policy/runtime boundary is not ready for normal work${
        detail ? `: ${detail}` : "."
      }`
    );
  }
  if (!verification.approvalBoundary) {
    throw new Error("The bridge omitted the local approval attestation boundary.");
  }
  return verification.approvalBoundary;
}

const PINNED_LEGACY_BATCH_IDS = new Set(
  CHANCE_LEGACY_ISOLATION.entries.map((entry) => entry.batchId)
);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const CLAIM_FILING_GOALS = new Set(["file_new_claim", "find_existing_claim"]);
const CLAIM_FILING_COVERAGE_TERM_STATUSES = new Set([
  "verified_in_force",
  "carrier_lookup_required",
  "blocked_conflict"
]);
const CLAIM_FILING_OVERRIDE_STRING_KEYS = Object.freeze([
  "insuredName",
  "propertyAddress",
  "carrier",
  "policyNumber",
  "claimNumber",
  "dateOfLoss",
  "causeOfLoss",
  "mortgageCompany",
  "stormTime",
  "occupancy",
  "damageDiscovered",
  "propertyStories",
  "roofAccessibility",
  "damagedRooms",
  "damagedRoomCount",
  "contractorPhone",
  "injuries",
  "homeLivable",
  "temporaryRepairs",
  "contractorHired",
  "damageOpening",
  "policyCoverageStart",
  "policyCoverageEnd"
]);
const CLAIM_FILING_OVERRIDE_KEYS = new Set([
  ...CLAIM_FILING_OVERRIDE_STRING_KEYS,
  "coverageTermStatus",
  "damageDetails"
]);
const CLAIM_FILING_OPTIONAL_STRING_KEYS = Object.freeze([
  "to",
  "carrierPhone",
  "retryOfCallId",
  "stormTime",
  "occupancy",
  "damageDiscovered",
  "propertyStories",
  "roofAccessibility",
  "damagedRooms",
  "damagedRoomCount",
  "contractorPhone",
  "injuries",
  "homeLivable",
  "temporaryRepairs",
  "contractorHired"
]);
const CLAIM_FILING_INPUT_KEYS = new Set([
  "query",
  "goal",
  "includeCarrierBatch",
  "overrides",
  ...CLAIM_FILING_OPTIONAL_STRING_KEYS
]);

function normalizedClaimFileQuery(value) {
  const number = String(value || "").trim().replace(/^#/, "");
  if (!/^\d+$/.test(number)) {
    throw new Error("Retell claim filing requires one exact numeric JobNimbus file number.");
  }
  if (CHANCE_RUN_EXCLUDED_FILE_NUMBERS.includes(number)) {
    throw new Error(`#${number} is excluded from the locked Chance run and cannot be called.`);
  }
  return `#${number}`;
}

function normalizedClaimFilingInput(input = {}) {
  if (
    !input
    || typeof input !== "object"
    || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new Error("Retell claim filing requires one exact input object.");
  }
  const unknownKeys = Object.keys(input).filter((key) => !CLAIM_FILING_INPUT_KEYS.has(key));
  if (unknownKeys.length) {
    throw new Error(`Unsupported Retell claim-filing input keys: ${unknownKeys.sort().join(", ")}.`);
  }
  if (input.includeCarrierBatch !== undefined && input.includeCarrierBatch !== false) {
    throw new Error("Retell claim filing is single-file only; includeCarrierBatch must be false.");
  }
  const goal = String(input.goal || "file_new_claim").trim();
  if (!CLAIM_FILING_GOALS.has(goal)) {
    throw new Error("Retell claim filing supports only file_new_claim or find_existing_claim.");
  }
  const normalized = {
    query: normalizedClaimFileQuery(input.query),
    goal,
    includeCarrierBatch: false
  };
  for (const key of CLAIM_FILING_OPTIONAL_STRING_KEYS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string") {
      throw new Error(`${key} must be a string when supplied.`);
    }
    normalized[key] = input[key];
  }
  if (input.overrides !== undefined) {
    if (
      !input.overrides
      || typeof input.overrides !== "object"
      || Array.isArray(input.overrides)
      || Object.getPrototypeOf(input.overrides) !== Object.prototype
    ) {
      throw new Error("overrides must be an exact object when supplied.");
    }
    const unknownOverrideKeys = Object.keys(input.overrides)
      .filter((key) => !CLAIM_FILING_OVERRIDE_KEYS.has(key));
    if (unknownOverrideKeys.length) {
      throw new Error(
        `Unsupported Retell claim-filing override keys: ${unknownOverrideKeys.sort().join(", ")}.`
      );
    }
    const overrides = {};
    for (const key of CLAIM_FILING_OVERRIDE_STRING_KEYS) {
      if (input.overrides[key] === undefined) continue;
      if (typeof input.overrides[key] !== "string") {
        throw new Error(`overrides.${key} must be a string when supplied.`);
      }
      overrides[key] = input.overrides[key];
    }
    if (input.overrides.coverageTermStatus !== undefined) {
      if (!CLAIM_FILING_COVERAGE_TERM_STATUSES.has(input.overrides.coverageTermStatus)) {
        throw new Error(
          "overrides.coverageTermStatus must be verified_in_force, carrier_lookup_required, or blocked_conflict."
        );
      }
      overrides.coverageTermStatus = input.overrides.coverageTermStatus;
    }
    if (input.overrides.damageDetails !== undefined) {
      const details = input.overrides.damageDetails;
      if (typeof details === "string" && details.trim()) {
        overrides.damageDetails = details;
      } else if (
        Array.isArray(details)
        && details.length > 0
        && details.every((item) => typeof item === "string" && item.trim())
      ) {
        overrides.damageDetails = [...details];
      } else {
        throw new Error(
          "overrides.damageDetails must be a non-empty string or array of non-empty strings."
        );
      }
    }
    normalized.overrides = overrides;
  }
  return normalized;
}

function exactFileNumber(value) {
  return String(value || "").trim().replace(/^#/, "");
}

function assertClaimFilingConfiguration(response, { requireReady = false } = {}) {
  if (
    response?.mode !== "read_only"
    || response?.agentConfigured !== true
    || response?.fromNumberConfigured !== true
    || response?.callbackWebhookAvailable !== true
    || response?.callbackPacketRestoration !== "full_approved_packet"
    || response?.guardedEndCredentialConfigured !== true
    || response?.guardedEndCredentialIsolated !== true
    || response?.inboundWebhookCredentialConfigured !== true
    || response?.inboundWebhookCredentialIsolated !== true
    || response?.inboundWebhookAuthentication
      !== "dedicated_url_token_plus_retell_hmac_sha256_raw_body_timestamp"
    || response?.inboundFallbackAgentUnset !== true
    || response?.phoneNumberMatches !== true
    || response?.inboundWebhookUrlMatches !== true
    || response?.inboundAgentRoutingMatches !== true
    || !/^[a-f0-9]{64}$/.test(String(response?.expectedPhoneConfigDigest || ""))
    || response?.livePhoneConfigDigest !== response?.expectedPhoneConfigDigest
    || response?.guardedEndAuthorizationMatches !== true
    || response?.dtmfPressDigitAvailable !== true
    || response?.guardedEndCallAvailable !== true
    || response?.promptMatches !== true
    || response?.toolsMatch !== true
    || response?.analysisSchemaMatches !== true
    || response?.timezoneMatches !== true
    || response?.agentPublished !== true
    || response?.llmPublished !== true
    || !Number.isInteger(response?.agentVersion)
    || response.agentVersion < 0
    || !Number.isInteger(response?.llmVersion)
    || response.llmVersion < 0
    || !SHA256.test(String(response?.agentConfigDigest || ""))
    || !SHA256.test(String(response?.expectedConfigDigest || ""))
    || response?.liveConfigDigest !== response?.expectedConfigDigest
    || response?.approvalModel
      !== "fresh_single_file_digest_plus_short_lived_identity_bound_single_use_challenge"
    || response?.writebackRequiresSeparateApproval !== true
    || response?.automaticJobNimbusWriteback !== false
  ) {
    throw new Error("The live Retell claim-filing configuration omitted a required safety attestation.");
  }
  if (requireReady && response.ready !== true) {
    const instruction = String(response?.instruction || "").trim();
    throw new Error(
      `The live Retell claim-filing agent is not ready${instruction ? `: ${instruction}` : "."}`
    );
  }
  return response;
}

function assertClaimPlan(response, input, now) {
  const fileNumber = exactFileNumber(response?.file?.number);
  const requestedFileNumber = exactFileNumber(input.query);
  const expiresAt = Date.parse(String(response?.approvalExpiresAt || ""));
  const packetFacts = response?.packet?.verifiedFileFacts || {};
  const dynamicVariables = response?.callPlan?.dynamicVariables || {};
  const coverageStatus = String(packetFacts.coverageTermStatus || "");
  const approvedCoverageStatus = String(input?.overrides?.coverageTermStatus || "");
  const lookupInstruction = String(packetFacts.priorPolicyLookupInstruction || "");
  const damageDetails = String(dynamicVariables.damageDetails || "").trim();
  const coverageChecks = input.goal === "file_new_claim" ? [
    [!CLAIM_FILING_COVERAGE_TERM_STATUSES.has(coverageStatus), "invalid_coverage_status"],
    [dynamicVariables.coverageTermStatus !== coverageStatus, "coverage_status_not_bound"],
    [Boolean(approvedCoverageStatus) && approvedCoverageStatus !== coverageStatus, "approved_coverage_status_changed"],
    [coverageStatus === "blocked_conflict", "coverage_conflict_not_blocked"],
    [
      coverageStatus === "carrier_lookup_required"
      && (!lookupInstruction || /^missing/i.test(lookupInstruction)),
      "missing_policy_lookup_instruction"
    ],
    [
      coverageStatus === "carrier_lookup_required"
      && dynamicVariables.priorPolicyLookupInstruction !== lookupInstruction,
      "policy_lookup_instruction_not_bound"
    ],
    [response?.packet?.damageEvidenceSource !== "approved_override", "damage_not_explicitly_approved"],
    [!damageDetails || /^missing/i.test(damageDetails), "damage_details_not_bound"]
  ] : [];
  // Report failed checks, never raw bridge payloads or approval secrets.
  const failures = [
    [response?.mode !== "dry_run", "not_dry_run"],
    [response?.approvalRequired !== true, "approval_not_required"],
    [response?.readiness?.ready !== true, "file_not_ready"],
    [response?.configurationAttested !== true, "configuration_not_attested"],
    [!Number.isInteger(response?.agentVersion) || response.agentVersion < 0, "invalid_agent_version"],
    [!SHA256.test(String(response?.agentConfigDigest || "")), "invalid_agent_digest"],
    [!SHA256.test(String(response?.callbackPacketDigest || "")), "invalid_callback_digest"],
    [!SHA256.test(String(response?.planDigest || "")), "invalid_plan_digest"],
    [!String(response?.approvalChallenge || "").trim(), "missing_approval_challenge"],
    [!Number.isFinite(expiresAt) || expiresAt <= now, "invalid_or_expired_approval"],
    [!String(response?.file?.id || "").trim(), "missing_file_id"],
    [fileNumber !== requestedFileNumber, "file_mismatch"],
    [CHANCE_RUN_EXCLUDED_FILE_NUMBERS.includes(fileNumber), "excluded_file"],
    [response?.packet?.goal !== input.goal, "goal_mismatch"],
    [Array.isArray(response?.batchClaims) && response.batchClaims.length !== 0, "multiple_claims"],
    ...coverageChecks
  ].filter(([failed]) => failed).map(([, code]) => code);
  if (failures.length) {
    const missingPhone = Array.isArray(response?.readiness?.blockers)
      && response.readiness.blockers.includes("no filing phone for this carrier");
    const guidance = missingPhone
      ? " No filing phone for this carrier. Supply carrierPhone from verified carrier or policy evidence and prepare again."
      : "";
    throw new Error(`The bridge did not return a complete ready single-file Retell claim plan. Failed checks: ${failures.join(", ")}.${guidance} No call was placed and no approval was created.`);
  }
  return { fileNumber, expiresAt };
}

function assertClaimExecutionResponse(response, pending) {
  const mode = String(response?.mode || "");
  const fileNumber = exactFileNumber(response?.file?.number);
  if (
    !["executed", "duplicate_prevented"].includes(mode)
    || String(response?.planDigest || "") !== pending.planDigest
    || fileNumber !== pending.fileNumber
    || CHANCE_RUN_EXCLUDED_FILE_NUMBERS.includes(fileNumber)
    || !String(response?.callId || "").trim()
    || !String(response?.callStatus || "").trim()
    || response?.automaticJobNimbusWriteback !== false
    || response?.automaticChanceBrainWriteback !== false
  ) {
    throw new Error("The Retell call response is not bound to the exact approved file and plan digest.");
  }
  return response;
}

export function createOperatorCoordinator({
  bridgeRequest,
  version,
  approvals = new Map(),
  now = () => Date.now(),
  newApprovalId = () => randomUUID()
} = {}) {
  if (typeof bridgeRequest !== "function") {
    throw new TypeError("createOperatorCoordinator requires bridgeRequest.");
  }
  const localVersion = String(version || "").trim();
  if (!localVersion) {
    throw new TypeError("createOperatorCoordinator requires the plugin version.");
  }
  if (typeof newApprovalId !== "function") {
    throw new TypeError("createOperatorCoordinator requires an approval ID generator.");
  }
  let approvalGeneration = 0;

  function invalidateLocalApprovals() {
    approvals.clear();
    approvalGeneration += 1;
    return approvalGeneration;
  }

  function requireCurrentApprovalGeneration(generation) {
    if (generation !== approvalGeneration) {
      throw new Error(
        "A newer plan, restart check, or reconciliation superseded this local approval attempt."
      );
    }
  }

  async function verifiedBridgeSession() {
    const [whoami, session, policy] = await Promise.all([
      bridgeRequest("GET", "/auth/whoami"),
      bridgeRequest("GET", "/api/v1/session"),
      bridgeRequest("GET", "/ops/run-policy")
    ]);

    let attestationError = "";
    let restartBoundary = null;
    let boundary = null;
    try {
      assertDedicatedMacOperatorIdentity(whoami);
      assertPlatformSessionAttestation(session);
      assertLegacyIsolationAttestation(policy);
      restartBoundary = assertRestartBoundary(policy, { allowHardBlocked: true });
      boundary = approvalBoundary({ whoami, session, policy, restartBoundary });
    } catch (error) {
      attestationError = error instanceof Error ? error.message : String(error);
    }

    const operatorBoundaryAttested = !attestationError;
    const recoveryBoundaryAttested = operatorBoundaryAttested;
    const unresolvedBatchIds = restartBoundary?.unresolvedBatchIds || [];
    const unresolvedCount = restartBoundary?.unresolvedCount || 0;
    const reconciliationEligibleBatchIds = restartBoundary?.reconciliationEligibleBatchIds || [];
    const hardBlockedBatchIds = restartBoundary?.hardBlockedBatchIds || [];
    const hardBlockedCount = restartBoundary?.hardBlockedCount || 0;
    const requiresRecovery = unresolvedCount > 0;
    const recoveryAllowed = recoveryBoundaryAttested
      && requiresRecovery
      && hardBlockedCount === 0
      && canonical([...reconciliationEligibleBatchIds].sort())
        === canonical([...unresolvedBatchIds].sort());
    const ready = operatorBoundaryAttested
      && restartBoundary?.ready === true
      && !requiresRecovery;

    return {
      ready,
      operatorBoundaryAttested,
      recoveryBoundaryAttested,
      recoveryAllowed,
      attestationError,
      approvalBoundary: boundary,
      localPlugin: {
        version: localVersion,
        pinnedBridgeBuild: EXPECTED_BRIDGE_BUILD,
        pinnedRunPolicy: CHANCE_RUN_POLICY,
        pinnedLegacyIsolation: CHANCE_LEGACY_ISOLATION,
        fileCount: CHANCE_RUN_FILE_COUNT,
        excludedFileNumbers: CHANCE_RUN_EXCLUDED_FILE_NUMBERS,
        allowedActionTypes: CHANCE_RUN_ACTION_TYPES,
        allowedContactFields: CHANCE_RUN_ALLOWED_CONTACT_FIELDS,
        allowedStageEvidenceSources: CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES
      },
      whoami,
      session,
      policy,
      unresolvedReceiptBoundary: {
        count: unresolvedCount,
        batchIds: unresolvedBatchIds,
        reconciliationEligibleCount: restartBoundary?.reconciliationEligibleCount || 0,
        reconciliationEligibleBatchIds,
        hardBlockedCount,
        hardBlockedBatchIds,
        requiresReview: requiresRecovery
      },
      instruction: !operatorBoundaryAttested
        ? `STOP: ${attestationError || "the operator boundary is not attested."} Do not plan, execute, or reconcile actions.`
        : hardBlockedCount > 0
          ? "HARD STOP: one or more durable receipts are hard-blocked. Read their sanitized details, do not reconcile them, and do not plan or execute normal work."
        : requiresRecovery
          ? "RECOVERY ONLY: read and manually reconcile every listed batch, then rerun bridge_restart_verify and require ready:true. Do not plan or retry actions yet."
          : "The local plugin and remote bridge agree on the exact build, runtime, and 58-file run manifest."
    };
  }

  async function restartVerifiedBridgeSession() {
    invalidateLocalApprovals();
    return verifiedBridgeSession();
  }

  function requireAttestedReadBoundary(verification) {
    if (
      verification?.operatorBoundaryAttested !== true
      || verification?.recoveryBoundaryAttested !== true
      || !verification?.approvalBoundary
    ) {
      const detail = String(verification?.attestationError || "").trim();
      throw new Error(
        `The exact bridge boundary is not attested for this read${detail ? `: ${detail}` : "."}`
      );
    }
    return verification.approvalBoundary;
  }

  async function readClaimFilingConfiguration({ requireReady = false } = {}) {
    const verification = await verifiedBridgeSession();
    if (requireReady) requireReadyForNormalWork(verification);
    else requireAttestedReadBoundary(verification);
    const response = await bridgeRequest("POST", "/claim-filing/configuration", {});
    return assertClaimFilingConfiguration(response, { requireReady });
  }

  async function planClaimFilingCall(input) {
    // Action-batch and claim-call plans share a single local approval slot.
    // Any newer plan attempt invalidates every older hidden challenge.
    const generation = invalidateLocalApprovals();
    const normalizedInput = normalizedClaimFilingInput(input);
    const verification = await verifiedBridgeSession();
    requireCurrentApprovalGeneration(generation);
    const attestedBoundary = requireReadyForNormalWork(verification);
    const configuration = assertClaimFilingConfiguration(
      await bridgeRequest("POST", "/claim-filing/configuration", {}),
      { requireReady: true }
    );
    requireCurrentApprovalGeneration(generation);
    const response = await bridgeRequest(
      "POST",
      "/claim-filing/prepare",
      normalizedInput
    );
    requireCurrentApprovalGeneration(generation);
    const { fileNumber, expiresAt } = assertClaimPlan(response, normalizedInput, now());
    const approvalId = String(newApprovalId() || "").trim();
    if (!UUID.test(approvalId) || approvals.has(approvalId)) {
      throw new Error("The local operator could not issue a unique one-use Retell approval ID.");
    }
    const planDigest = String(response.planDigest);
    approvals.set(approvalId, {
      kind: "claim_filing_call",
      challenge: String(response.approvalChallenge),
      input: canonical(normalizedInput),
      planDigest,
      fileNumber,
      attestedBoundary: canonical(attestedBoundary),
      configuration: canonical(configuration),
      generation,
      expiresAt
    });
    return {
      ...stripApprovalSecrets(response),
      approvalId,
      approvedInput: normalizedInput
    };
  }

  async function executeClaimFilingCall(approvalId, planDigest, input) {
    const exactApprovalId = String(approvalId || "").trim();
    const pending = approvals.get(exactApprovalId);
    if (!pending || pending.kind !== "claim_filing_call") {
      throw new Error(
        "No unconsumed local Retell approval plan exists for this approval ID. Prepare a fresh single-file plan."
      );
    }
    approvals.delete(exactApprovalId);

    try {
      const normalizedInput = normalizedClaimFilingInput(input);
      if (pending.expiresAt <= now()) {
        throw new Error("The Retell approval plan expired. Prepare and review a fresh plan.");
      }
      if (
        String(planDigest || "") !== pending.planDigest
        || canonical(normalizedInput) !== pending.input
      ) {
        throw new Error(
          "The requested Retell file, goal, overrides, or plan digest differs from the reviewed plan. Nothing was called."
        );
      }

      const verification = await verifiedBridgeSession();
      requireCurrentApprovalGeneration(pending.generation);
      const currentBoundary = requireReadyForNormalWork(verification);
      if (pending.attestedBoundary !== canonical(currentBoundary)) {
        throw new Error(
          "The bridge boot/build/policy/runtime boundary changed after call approval. Nothing was called."
        );
      }
      const configuration = assertClaimFilingConfiguration(
        await bridgeRequest("POST", "/claim-filing/configuration", {}),
        { requireReady: true }
      );
      requireCurrentApprovalGeneration(pending.generation);
      if (pending.configuration !== canonical(configuration)) {
        throw new Error(
          "The live Retell prompt, tools, schema, publication, or callback configuration changed after approval. Nothing was called."
        );
      }

      const response = await bridgeRequest("POST", "/claim-filing/call", {
        ...normalizedInput,
        execute: true,
        planDigest: pending.planDigest,
        approvalChallenge: pending.challenge
      });
      assertClaimExecutionResponse(response, pending);
      return stripApprovalSecrets(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} The local Retell approval was consumed; review the call ledger/result before any retry.`
      );
    }
  }

  async function reviewClaimFilingCallResult(callId) {
    const exactCallId = String(callId || "").trim();
    if (!exactCallId) throw new Error("Claim result review requires one exact Retell call ID.");
    const verification = await verifiedBridgeSession();
    requireAttestedReadBoundary(verification);
    const response = await bridgeRequest("POST", "/claim-filing/result", {
      callId: exactCallId
    });
    const fileNumber = exactFileNumber(response?.file?.number);
    const chain = Array.isArray(response?.callChain) ? response.callChain : [];
    if (
      !["pending", "read_only"].includes(String(response?.mode || ""))
      || !/^\d+$/.test(fileNumber)
      || CHANCE_RUN_EXCLUDED_FILE_NUMBERS.includes(fileNumber)
      || !chain.some((call) => String(call?.callId || "") === exactCallId)
    ) {
      throw new Error("The Retell result is not bound to the requested in-scope claim call.");
    }
    return stripApprovalSecrets(response);
  }

  async function listPendingClaimCallbacks() {
    const verification = await verifiedBridgeSession();
    requireAttestedReadBoundary(verification);
    const response = await bridgeRequest("POST", "/claim-filing/callbacks", {});
    const callbacks = Array.isArray(response?.callbacks) ? response.callbacks : null;
    if (
      response?.mode !== "read_only"
      || callbacks === null
      || response?.count !== callbacks.length
      || callbacks.some((callback) => {
        const fileNumber = exactFileNumber(callback?.fileNumber);
        return !/^\d+$/.test(fileNumber)
          || CHANCE_RUN_EXCLUDED_FILE_NUMBERS.includes(fileNumber)
          || !String(callback?.contactId || "").trim()
          || !String(callback?.originalCallId || "").trim();
      })
    ) {
      throw new Error("The bridge returned an incomplete or out-of-scope pending-callback list.");
    }
    return stripApprovalSecrets(response);
  }

  async function planActionBatch(operations, operatorScope = "assigned") {
    if (operatorScope !== "assigned") {
      throw new Error("Company-scope mutations are disabled during the locked Chance 58-file run.");
    }

    // There is only one current plan in this MCP process. Starting another
    // planning attempt invalidates every older local challenge, even when the
    // replacement attempt later fails closed.
    const generation = invalidateLocalApprovals();

    // This check is intentionally inside the action helper. Calling the public
    // restart tool earlier is not a substitute for a fresh pre-POST attestation.
    const verification = await verifiedBridgeSession();
    requireCurrentApprovalGeneration(generation);
    const attestedBoundary = requireReadyForNormalWork(verification);
    const boundOperations = scopedOperations(operations, operatorScope);
    const response = await bridgeRequest("POST", "/ops/action-batch", {
      operatorScope,
      runPolicy: CHANCE_RUN_POLICY,
      operations: boundOperations,
      execute: false
    });
    requireCurrentApprovalGeneration(generation);
    const digest = String(response?.approvalDigest || "");
    const challenge = String(response?.approvalChallenge || "");
    if (!digest || !challenge) {
      throw new Error("The bridge did not return a complete approval plan.");
    }
    if (response?.displayComplete !== true) {
      throw new Error("The bridge did not certify that the approval display is complete.");
    }
    assertRunPolicyAttestation(response, { requireFullSurface: true });
    assertApprovedNotePlan(response, operations, operatorScope, { enabled: CHANCE_RUN_ACTION_TYPES.includes("jobnimbus.create_note") });
    assertPdfPlan(response, operations);
    const expiresAt = Date.parse(String(response?.approvalExpiresAt || ""));
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw new Error("The bridge did not return a live approval expiry. Nothing was approved.");
    }
    approvals.set(digest, {
      kind: "action_batch",
      challenge,
      operations: canonical(operations),
      ...(operations[0]?.type === PDF_UPLOAD_TYPE ? { pdfFileId: response.files[0].id } : {}),
      operatorScope,
      runPolicy: canonical(CHANCE_RUN_POLICY),
      attestedBoundary: canonical(attestedBoundary),
      generation,
      expiresAt
    });
    return stripApprovalSecrets(response);
  }

  async function executeActionBatch(approvalDigest, operations, expectedScope) {
    const pending = approvals.get(approvalDigest);
    if (!pending || pending.kind !== "action_batch") {
      throw new Error(
        "No unconsumed local approval plan exists for this digest. Prepare a fresh plan."
      );
    }
    approvals.delete(approvalDigest);

    try {
      if (pending.expiresAt <= now()) {
        throw new Error("The approval plan expired. Prepare and review a fresh plan.");
      }
      if (
        pending.operatorScope !== expectedScope
        || pending.runPolicy !== canonical(CHANCE_RUN_POLICY)
        || pending.operations !== canonical(operations)
      ) {
        throw new Error(
          "The requested operations or operator scope differ from the reviewed plan. Nothing was executed."
        );
      }

      // A successful plan never authorizes a later boot, build, policy, runtime,
      // identity, or capability boundary. Re-attest immediately before the POST.
      const verification = await verifiedBridgeSession();
      requireCurrentApprovalGeneration(pending.generation);
      const currentBoundary = requireReadyForNormalWork(verification);
      if (pending.attestedBoundary !== canonical(currentBoundary)) {
        throw new Error(
          "The bridge boot/build/policy/runtime boundary changed after approval. Nothing was executed."
        );
      }

      const boundOperations = scopedOperations(operations, expectedScope);
      const response = await bridgeRequest("POST", "/ops/action-batch", {
        operatorScope: expectedScope,
        runPolicy: CHANCE_RUN_POLICY,
        operations: boundOperations,
        execute: true,
        approvalDigest,
        approvalChallenge: pending.challenge
      });
      if (pending.pdfFileId && (response?.batch?.files?.length !== 1
        || response.batch.files[0].id !== pending.pdfFileId)) {
        throw new Error("PDF receipt target differs from the approved provider file ID. Reconcile before retrying.");
      }
      assertExecutionReceiptAttestation(response, approvalDigest, {
        operations,
        bridgeBootId: currentBoundary.bridgeBootId
      });
      return stripApprovalSecrets(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} The local approval was consumed; read the batch receipts before any retry.`
      );
    }
  }

  async function reconcileActionBatch(batchId) {
    // A receipt recovery changes the executable boundary. It must invalidate
    // every older plan even when admission rejects this reconciliation.
    invalidateLocalApprovals();
    const exactBatchId = String(batchId || "").trim();
    if (!UUID.test(exactBatchId)) {
      throw new Error("Reconciliation requires one exact UUID batch ID.");
    }
    if (PINNED_LEGACY_BATCH_IDS.has(exactBatchId)) {
      throw new Error(
        "This batch is pinned historical attention and is never eligible for reconciliation or replay."
      );
    }

    // Reconciliation may update only receipt metadata, but it still requires
    // a fresh exact build/policy/runtime attestation and one currently eligible
    // unresolved receipt. A prior restart check is not sufficient.
    const verification = await verifiedBridgeSession();
    if (
      verification?.operatorBoundaryAttested !== true
      || verification?.recoveryBoundaryAttested !== true
    ) {
      const detail = String(verification?.attestationError || "").trim();
      throw new Error(
        `The exact reconciliation boundary is not attested${detail ? `: ${detail}` : "."}`
      );
    }
    const receiptBoundary = verification.unresolvedReceiptBoundary;
    if (receiptBoundary?.hardBlockedBatchIds?.includes(exactBatchId)) {
      throw new Error("This receipt is hard-blocked and must never be reconciled.");
    }
    if (verification.recoveryAllowed !== true) {
      throw new Error(
        "Reconciliation is allowed only in an attested recovery-only session with no hard-blocked receipts."
      );
    }
    if (
      !receiptBoundary?.batchIds?.includes(exactBatchId)
      || !receiptBoundary?.reconciliationEligibleBatchIds?.includes(exactBatchId)
    ) {
      throw new Error(
        "This batch is not one of the exact currently unresolved, reconciliation-eligible receipts."
      );
    }

    const response = await bridgeRequest("POST", "/ops/action-batch-reconcile", {
      batchId: exactBatchId
    });
    assertReconciliationReceiptAttestation(response, exactBatchId);
    const postVerification = await verifiedBridgeSession();
    if (
      postVerification?.operatorBoundaryAttested !== true
      || postVerification?.recoveryBoundaryAttested !== true
      || canonical(postVerification.approvalBoundary)
        !== canonical(verification.approvalBoundary)
    ) {
      throw new Error(
        "The bridge boot/build/policy/runtime boundary changed during reconciliation. Read the exact receipt and do not retry."
      );
    }
    const postReceipts = postVerification.unresolvedReceiptBoundary;
    const manualScope = String(response?.receipt?.manualQuarantine?.scope || "");
    const remainsHardBlocked = response?.receipt?.status === "manual_quarantined"
      && manualScope === "global";
    if (remainsHardBlocked) {
      if (
        !postReceipts?.batchIds?.includes(exactBatchId)
        || !postReceipts?.hardBlockedBatchIds?.includes(exactBatchId)
        || postReceipts?.reconciliationEligibleBatchIds?.includes(exactBatchId)
        || postVerification.recoveryAllowed === true
      ) {
        throw new Error(
          "The global quarantine did not become an exact hard-blocked receipt. Stop and inspect it."
        );
      }
    } else if (
      postReceipts?.batchIds?.includes(exactBatchId)
      || postReceipts?.reconciliationEligibleBatchIds?.includes(exactBatchId)
      || postReceipts?.hardBlockedBatchIds?.includes(exactBatchId)
    ) {
      throw new Error(
        "The reconciled batch remains unresolved after recovery. Do not reconcile or retry it again."
      );
    }
    return stripApprovalSecrets(response);
  }

  async function planPdfUpload(input) {
    const generation = invalidateLocalApprovals();
    if (!PDF_UPLOADS_ENABLED) throw new Error("PDF upload is built but not activated. A reviewed coordinated release is required.");
    const payload = await readLocalPdf(input);
    requireCurrentApprovalGeneration(generation);
    // The immutable byte snapshot is retained only in the one-use local
    // approval slot. No base64 or source path is returned to chat or a ledger.
    return planActionBatch([{ type: PDF_UPLOAD_TYPE, payload }], "assigned");
  }

  async function executePdfUpload(approvalDigest) {
    const pending = approvals.get(approvalDigest);
    if (!PDF_UPLOADS_ENABLED || pending?.kind !== "action_batch") throw new Error("No current approved PDF snapshot exists.");
    const operations = JSON.parse(pending.operations);
    if (operations.length !== 1 || operations[0].type !== PDF_UPLOAD_TYPE) throw new Error("This digest is not a sole PDF-upload plan.");
    // Never reopen a potentially changed path, accept replacement bytes, or
    // re-create an expired/lost plan. Execution uses exactly the reviewed bytes.
    return executeActionBatch(approvalDigest, operations, "assigned");
  }

  return Object.freeze({
    verifiedBridgeSession,
    restartVerifiedBridgeSession,
    readClaimFilingConfiguration,
    planClaimFilingCall,
    executeClaimFilingCall,
    reviewClaimFilingCallResult,
    listPendingClaimCallbacks,
    planActionBatch,
    executeActionBatch,
    reconcileActionBatch,
    planPdfUpload,
    executePdfUpload
  });
}
