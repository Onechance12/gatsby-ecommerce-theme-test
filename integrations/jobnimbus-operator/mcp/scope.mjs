import { createHash } from "node:crypto";
import {
  APPROVED_NOTE_RELEASE,
  APPROVED_NOTES_ENABLED as LEGACY_NOTES_ENABLED,
  approvedNoteMentionIntent,
  matchesApprovedNoteMentionIntent,
  validateApprovedNoteOperation
} from "./approved-note-release.mjs";
import { PDF_UPLOAD_RELEASE, PDF_UPLOADS_ENABLED } from "./pdf-upload-release.mjs";
import { PDF_UPLOAD_TYPE, validatePdfPayload, validatePdfMetadata, assertPdfReceipt } from "./pdf-upload-contract.mjs";
const APPROVED_NOTES_ENABLED = LEGACY_NOTES_ENABLED || PDF_UPLOADS_ENABLED;
const ACTIVE_RELEASE = PDF_UPLOADS_ENABLED ? PDF_UPLOAD_RELEASE : APPROVED_NOTE_RELEASE;

export const CHANCE_RUN_POLICY = Object.freeze({
  id: APPROVED_NOTES_ENABLED ? ACTIVE_RELEASE.policyId : "chance-58-files-v1",
  sha256: APPROVED_NOTES_ENABLED ? ACTIVE_RELEASE.policySha256 : "40c8a7d418d9349b0b3315b693ce70486040092dcef250043f3397dc10a1c458"
});

export const EXPECTED_BRIDGE_BUILD = Object.freeze({
  service: "jobnimbus-chatgpt-bridge",
  apiVersion: "v1",
  schemaVersion: "0.1.0",
  sourceCommit: APPROVED_NOTES_ENABLED ? ACTIVE_RELEASE.bridgeCommit : "49465dded1707d5be6c019fd99de0baa90393c10",
  sourceCommitTrust: "provider_attested",
  attested: true
});

export const CHANCE_LEGACY_ISOLATION_ENTRIES = Object.freeze([
  Object.freeze({
    batchId: "bfd19ab5-0ec1-44fd-9c4c-e004870b26b2",
    rawRowSha256: "3589bf8066d9d1a734df1379a2cd8fec57bc6200e6758c19fd9a5d54e8f7b1ad"
  }),
  Object.freeze({
    batchId: "7bbecc58-74ff-43be-ab60-462588c0f1b3",
    rawRowSha256: "dd99036b5dfd5d027bdcb4daf105989554d89db8c2872e3c203b27848befec79"
  }),
  Object.freeze({
    batchId: "88993b24-dec4-4b95-b207-84ed282edc63",
    rawRowSha256: "6b15e43c7318bdb301ab2141e5d4911edc2b61c71bc6daf6d0e8604432401493"
  }),
  Object.freeze({
    batchId: "62290621-12d8-4778-9c02-c3e18f7c583c",
    rawRowSha256: "4fada12c7f13ec6be04fb816042b7bb2d1e7d8e54417a77afc251380c8b45c8a"
  }),
  Object.freeze({
    batchId: "08fb7310-5c11-4030-9ed2-b80733197c0a",
    rawRowSha256: "72f8d9461e16e9209e3fd09d3c530361dc447b1587888a65d2d40f84ef9a6ea7"
  }),
  Object.freeze({
    batchId: "6ea93648-23bf-47b9-97a9-6106a092b335",
    rawRowSha256: "1b05c555209e0a44b26284a63699337299e0d5bcea63bd6be56a685d0b06a013"
  })
]);

export const EXPECTED_OPERATOR_CAPABILITIES = Object.freeze([
  "claims.filing.call.place",
  "claims.filing.callbacks.read",
  "claims.filing.configuration.review",
  "claims.filing.prepare",
  "claims.filing.result.review",
  "gmail.attachments.review",
  "gmail.messages.search",
  "gmail.threads.read",
  "identity.read",
  "jobnimbus.contacts.search",
  "jobnimbus.documents.attach_to_chat",
  "jobnimbus.documents.review",
  "jobnimbus.documents.text.read",
  "jobnimbus.files.review",
  "operations.action_batch.process",
  "operations.action_batch_receipts.read",
  "operations.action_batch_receipts.reconcile",
  "operations.files.review",
  "operations.run_policy.read",
  "operations.session.start",
  "platform.session.read",
  "quo.history.read",
  "quo.lines.read",
  "quo.transcripts.read",
  "scheduling.availability.review",
  "weather.date_of_loss.research"
]);

export const CHANCE_LEGACY_ISOLATION = Object.freeze({
  id: "chance-58-prelock-receipts-v1",
  entryCount: 6,
  classification: "legacy_historical_attention_nonblocking",
  reasonCode: "pre_scope_receipt_unrecoverable_manual_risk_acceptance",
  entries: CHANCE_LEGACY_ISOLATION_ENTRIES
});

const EXPECTED_MAC_OPERATOR_SCOPES = Object.freeze([
  "approval_batches:prepare_execute",
  "client_evidence:read",
  "company_exact_file:read",
  "retell_claim_filing:prepare_execute_review"
]);

const DISABLED_EFFECT_GATES = Object.freeze([
  "carrierFollowUpCalls",
  "clientCoordinatorAppointmentCalls",
  "clientCoordinatorExpandedCalls",
  "gmailSend",
  "hcnActionExecution",
  "quoSend",
  "realtimeVoiceCalls"
]);

const EXPECTED_CONTROL_KEYS = Object.freeze([
  "actionBatchOnly",
  "automaticEmailOrTextSending",
  "changedPayloadInvalidatesApproval",
  "claimFilingApprovalLane",
  "directEffectRoutes",
  "exactDryRunDigestRequired",
  "explicitChanceApprovalRequired",
  "jobNimbusWritesActionBatchOnly",
  "modelCanExecute",
  "roleEnforcement",
  "schedulingFailClosed",
  "shortLivedSingleUseChallengeRequired"
]);

const EXPECTED_GATE_KEYS = Object.freeze([
  ...DISABLED_EFFECT_GATES,
  "claimFilingCalls",
  "externalWrites"
]);

const EXPECTED_RELEASE_GATE_KEYS = Object.freeze([
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
]);

export const CHANCE_RUN_FILE_COUNT = 58;

export const CHANCE_RUN_EXCLUDED_FILE_NUMBERS = Object.freeze(["2628"]);

export const CHANCE_RUN_ACTION_TYPES = Object.freeze([
  "jobnimbus.update_contact",
  "jobnimbus.update_status",
  "jobnimbus.ensure_current_task",
  "gmail.create_draft",
  "gmail.send_existing_draft",
  ...(APPROVED_NOTES_ENABLED ? ["jobnimbus.create_note"] : []),
  ...(PDF_UPLOADS_ENABLED ? [PDF_UPLOAD_TYPE] : [])
]);

export const CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES = Object.freeze([
  "jobnimbus_activity",
  "gmail_message",
  "quo_message"
]);

export const CHANCE_RUN_ALLOWED_CONTACT_FIELDS = Object.freeze([
  "display_name",
  "email",
  "mobile_phone",
  "home_phone",
  "work_phone",
  "address_line1",
  "address_line2",
  "city",
  "state_text",
  "zip",
  "cf_date_1",
  "cf_string_1",
  "cf_string_2",
  "cf_string_4",
  "cf_string_5",
  "cf_string_7",
  "cf_string_8",
  "cf_string_9"
]);

function normalizedFileNumbers(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value || "").trim().replace(/^#/, ""))
    .sort();
}

function normalizedStrings(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value || "").trim()).sort();
}

function sameStrings(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function plainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

export function assertDedicatedMacOperatorIdentity(whoami) {
  const identity = whoami?.identity;
  const access = whoami?.operatorAccess;
  if (
    whoami?.authenticated !== true
    || !plainObject(identity)
    || identity.type !== "codex_operator_token"
    || identity.subject !== "codex-mac-operator"
    || identity.name !== "Codex Mac Operator"
    || identity.role !== "codex_operator"
    || identity.jobNimbusScope !== "assigned"
    || !String(identity.jobNimbusOwnerId || "").trim()
    || identity.quoLineConfigured !== true
    || !sameStrings(
      normalizedStrings(identity.scopes),
      [...EXPECTED_MAC_OPERATOR_SCOPES]
    )
  ) {
    throw new Error("The bridge did not attest the dedicated authenticated Mac operator identity.");
  }
  if (
    !plainObject(access)
    || access.defaultScope !== "chance_assigned"
    || access.companyExactFileScope !== true
    || access.companyWideIndexOrSweep !== false
    || access.assignedBatchMaxFiles !== 5
    || !sameStrings(
      normalizedStrings(access.assignedMultiFileActionTypes),
      [
        "jobnimbus.ensure_current_task",
        "jobnimbus.update_contact",
        "jobnimbus.update_status"
      ]
    )
    || access.assignedMultiFileExecution !== "sequential_fail_stop_no_rollback"
    || access.companyBatchMaxFiles !== 1
    || access.claimFilingSingleFileOnly !== true
    || access.claimFilingWritebackAllowed !== false
    || !sameStrings(
      normalizedStrings(access.claimFilingSupportedGoals),
      ["file_new_claim", "find_existing_claim"]
    )
    || access.callApprovalChallenge !== "short_lived_identity_bound_single_use"
    || access.actionPath !== "approval_batch_plus_retell_claim_filing"
    || !plainObject(access.actionReceiptRecovery)
    || access.actionReceiptRecovery.status !== "ready"
    || String(access.actionReceiptRecovery.error || "").trim()
  ) {
    throw new Error("The dedicated Mac operator access boundary differs from the pinned lane.");
  }
  assertRunPolicyAttestation(
    { runPolicy: access.chanceRunPolicy },
    { requireFullSurface: true }
  );
  return identity;
}

export function assertPlatformSessionAttestation(session) {
  const build = session?.build;
  if (
    session?.schemaVersion !== "hcn.platform.session.v1"
    || session?.authenticated !== true
    || !plainObject(build)
    || build.service !== EXPECTED_BRIDGE_BUILD.service
    || build.apiVersion !== EXPECTED_BRIDGE_BUILD.apiVersion
    || build.schemaVersion !== EXPECTED_BRIDGE_BUILD.schemaVersion
    || build.sourceCommit !== EXPECTED_BRIDGE_BUILD.sourceCommit
    || build.sourceCommitTrust !== EXPECTED_BRIDGE_BUILD.sourceCommitTrust
    || build.attested !== EXPECTED_BRIDGE_BUILD.attested
  ) {
    throw new Error("The bridge session is not provider-attested to the exact pinned production build.");
  }

  const identity = session.identity;
  if (
    !plainObject(identity)
    || identity.authentication !== "authenticated"
    || identity.type !== "codex_operator"
    || identity.role !== "codex_operator"
    || identity.jobNimbusScope !== "assigned"
    || identity.gmailMode !== "exact_assigned_file_evidence"
  ) {
    throw new Error("The platform session is not bound to the dedicated assigned-file Codex operator lane.");
  }

  const capabilities = normalizedStrings(session.authorizedCapabilities);
  if (
    capabilities.length !== new Set(capabilities).size
    || !sameStrings(capabilities, [...EXPECTED_OPERATOR_CAPABILITIES])
  ) {
    throw new Error(
      "The platform capability surface differs from the pinned read, action-batch, and single-file Retell claim lane."
    );
  }

  const runtime = session.runtime;
  const brain = runtime?.brain;
  const connectors = runtime?.connectors;
  const controls = runtime?.controls;
  const gates = runtime?.gates;
  const configurationDrift = runtime?.configurationDrift;
  if (
    !plainObject(runtime)
    || !plainObject(brain)
    || brain.execution !== "disabled"
    || brain.legacyClientMemoryWrites !== "disabled"
    || !plainObject(connectors)
    || connectors.jobNimbus !== "configured"
    || connectors.gmail !== "configured"
    || connectors.claimFiling !== "configured"
  ) {
    throw new Error("The required JobNimbus, Gmail, and Retell claim-filing connectors are not all configured.");
  }
  if (
    !plainObject(controls)
    || !sameStrings(normalizedStrings(Object.keys(controls)), [...EXPECTED_CONTROL_KEYS].sort())
    || controls.actionBatchOnly !== "disabled"
    || controls.automaticEmailOrTextSending !== "disabled"
    || controls.changedPayloadInvalidatesApproval !== "enabled"
    || controls.claimFilingApprovalLane !== "enabled"
    || controls.directEffectRoutes !== "disabled"
    || controls.exactDryRunDigestRequired !== "enabled"
    || controls.explicitChanceApprovalRequired !== "enabled"
    || controls.jobNimbusWritesActionBatchOnly !== "enabled"
    || controls.modelCanExecute !== "disabled"
    || controls.roleEnforcement !== "enabled"
    || controls.schedulingFailClosed !== "enabled"
    || controls.shortLivedSingleUseChallengeRequired !== "enabled"
  ) {
    throw new Error(
      "The runtime does not enforce the pinned approval-batch plus single-file Retell claim-filing controls."
    );
  }
  if (
    !plainObject(gates)
    || !sameStrings(normalizedStrings(Object.keys(gates)), [...EXPECTED_GATE_KEYS].sort())
    || gates.externalWrites !== "enabled"
    || gates.claimFilingCalls !== "enabled"
    || DISABLED_EFFECT_GATES.some((key) => gates[key] !== "disabled")
  ) {
    throw new Error("The runtime gates differ from the pinned claim-filing-only effect boundary.");
  }
  const driftDifferences = Array.isArray(configurationDrift?.differences)
    ? configurationDrift.differences
    : [];
  const driftUnknown = Array.isArray(configurationDrift?.unknown)
    ? configurationDrift.unknown
    : [];
  const releaseGateRuntime = {
    ALLOW_CARRIER_FOLLOWUP_CALLS: gates.carrierFollowUpCalls,
    ALLOW_CLIENT_COORDINATOR_CALLS: gates.clientCoordinatorExpandedCalls,
    ALLOW_GMAIL_SEND: gates.gmailSend,
    ALLOW_LEGACY_CLIENT_MEMORY_WRITES: runtime?.brain?.legacyClientMemoryWrites,
    ALLOW_QUO_SEND: gates.quoSend,
    ALLOW_RETELL_CLAIM_CALLS: gates.claimFilingCalls,
    ALLOW_RETELL_CALLS: gates.claimFilingCalls,
    ALLOW_VOICE_CALLS: gates.realtimeVoiceCalls,
    BRIDGE_ALLOW_WRITES: gates.externalWrites,
    HCN_ACTION_EXECUTION_ENABLED: gates.hcnActionExecution
  };
  if (
    !plainObject(configurationDrift)
    || configurationDrift.scope !== "release_critical_effect_gates"
    || !sameStrings(
      normalizedStrings(configurationDrift.monitoredKeys),
      [...EXPECTED_RELEASE_GATE_KEYS].sort()
    )
    || !["aligned", "detected"].includes(configurationDrift.status)
    || driftUnknown.length !== 0
    || (configurationDrift.status === "aligned" && driftDifferences.length !== 0)
    || (configurationDrift.status === "detected" && driftDifferences.length === 0)
    || new Set(driftDifferences.map((difference) => difference?.key)).size
      !== driftDifferences.length
    || driftDifferences.some((difference) => (
      !plainObject(difference)
      || !EXPECTED_RELEASE_GATE_KEYS.includes(difference.key)
      || !["enabled", "disabled", "unknown"].includes(difference.checkedIn)
      || !["enabled", "disabled"].includes(difference.runtime)
      || releaseGateRuntime[difference.key] !== difference.runtime
    ))
  ) {
    throw new Error("The release-critical runtime gate drift attestation is incomplete or unsafe.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(session.descriptorHash || ""))) {
    throw new Error("The platform session omitted its deterministic descriptor hash.");
  }
  return session;
}

export function assertLegacyIsolationAttestation(response) {
  const isolation = response?.legacyIsolation;
  const receipts = response?.receipts;
  const historicalCount = receipts?.historicalAttentionCount;
  const historicalIds = Array.isArray(receipts?.historicalAttentionBatchIds)
    ? receipts.historicalAttentionBatchIds.map((value) => String(value || "").trim())
    : [];
  const unresolvedIds = Array.isArray(receipts?.unresolvedBatchIds)
    ? receipts.unresolvedBatchIds.map((value) => String(value || "").trim())
    : [];
  const summaries = Array.isArray(receipts?.historicalAttentionSummaries)
    ? receipts.historicalAttentionSummaries
    : [];
  const expectedEntries = new Map(
    CHANCE_LEGACY_ISOLATION_ENTRIES.map((entry) => [entry.batchId, entry.rawRowSha256])
  );
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (
    !plainObject(isolation)
    || isolation.configured !== true
    || isolation.valid !== true
    || isolation.id !== CHANCE_LEGACY_ISOLATION.id
    || isolation.runPolicyId !== CHANCE_RUN_POLICY.id
    || isolation.runPolicySha256 !== CHANCE_RUN_POLICY.sha256
    || isolation.entryCount !== CHANCE_LEGACY_ISOLATION.entryCount
    || isolation.errorCode !== ""
    || isolation.error !== ""
    || isolation.classification !== CHANCE_LEGACY_ISOLATION.classification
    || isolation.reasonCode !== CHANCE_LEGACY_ISOLATION.reasonCode
    || isolation.neverReplay !== true
    || isolation.freshReadRequired !== true
  ) {
    throw new Error("The bridge did not attest the exact six-receipt historical isolation boundary.");
  }
  if (
    !plainObject(receipts)
    || historicalCount !== CHANCE_LEGACY_ISOLATION.entryCount
    || historicalIds.length !== historicalCount
    || new Set(historicalIds).size !== historicalIds.length
    || historicalIds.some((id) => !uuid.test(id))
    || !sameStrings([...historicalIds].sort(), [...expectedEntries.keys()].sort())
    || historicalIds.some((id) => unresolvedIds.includes(id))
    || summaries.length !== historicalCount
  ) {
    throw new Error("The historical isolation receipt index is incomplete or ambiguous.");
  }

  const summaryIds = [];
  const summaryRowHashes = [];
  const statuses = [];
  for (const summary of summaries) {
    const batchId = String(summary?.batchId || "").trim();
    const status = String(summary?.status || "").trim();
    const rawRowSha256 = String(summary?.rawRowSha256 || "").trim();
    if (
      !plainObject(summary)
      || !uuid.test(batchId)
      || !historicalIds.includes(batchId)
      || !/^[a-f0-9]{64}$/.test(rawRowSha256)
      || expectedEntries.get(batchId) !== rawRowSha256
      || !["partial_failure", "completed_pending_verification"].includes(status)
      || summary.principalBound !== false
      || summary.principalMatchesCurrent !== false
      || !Number.isInteger(summary.operationCount)
      || summary.operationCount < 1
      || summary.operationCount > 15
      || !Number.isInteger(summary.completedCount)
      || summary.completedCount < 0
      || summary.completedCount > summary.operationCount
      || summary.currentPresent !== false
      || !Array.isArray(summary.completed)
      || !Array.isArray(summary.notAttempted)
      || !Array.isArray(summary.files)
      || !plainObject(summary.runPolicy)
      || summary.runPolicy.present !== false
      || summary.runPolicy.matchesCurrent !== false
      || summary.scope !== "global"
    ) {
      throw new Error("A historical isolation receipt summary is incomplete or unsafe.");
    }
    if (
      status === "partial_failure"
        ? summary.completedCount !== 0 || summary.completed.length !== 0
        : summary.operationCount !== 1
          || summary.completedCount !== 1
          || summary.completed.length !== 1
          || summary.completed[0]?.receipt?.manualVerificationRequired !== true
    ) {
      throw new Error("A historical isolation receipt summary has an unexpected legacy shape.");
    }
    summaryIds.push(batchId);
    summaryRowHashes.push(rawRowSha256);
    statuses.push(status);
  }
  if (
    new Set(summaryIds).size !== summaryIds.length
    || new Set(summaryRowHashes).size !== summaryRowHashes.length
    || !sameStrings([...summaryIds].sort(), [...historicalIds].sort())
    || statuses.filter((status) => status === "partial_failure").length !== 5
    || statuses.filter((status) => status === "completed_pending_verification").length !== 1
  ) {
    throw new Error("The historical isolation summaries do not match the exact six-receipt index.");
  }
  return isolation;
}

export function approvalBoundary({ whoami, session, policy, restartBoundary }) {
  const historicalIds = [...(policy?.receipts?.historicalAttentionBatchIds || [])]
    .map((value) => String(value || ""))
    .sort();
  const historicalSummaries = [...(policy?.receipts?.historicalAttentionSummaries || [])]
    .sort((left, right) => String(left?.batchId || "").localeCompare(String(right?.batchId || "")));
  return {
    bridgeBootId: String(restartBoundary?.bridgeBootId || ""),
    build: session?.build,
    runPolicy: policy?.runPolicy,
    legacyIsolation: policy?.legacyIsolation,
    historicalAttention: {
      count: policy?.receipts?.historicalAttentionCount,
      batchIds: historicalIds,
      summaries: historicalSummaries
    },
    runtime: session?.runtime,
    descriptorHash: String(session?.descriptorHash || ""),
    operatorIdentity: whoami?.identity,
    operatorAccess: whoami?.operatorAccess,
    identity: session?.identity,
    authorizedCapabilities: session?.authorizedCapabilities
  };
}

export function assertRunPolicyAttestation(
  response,
  { requireReady = false, requireFullSurface = false } = {}
) {
  const policy = response?.runPolicy;
  const expiresAt = Date.parse(String(policy?.expiresAt || ""));
  if (!policy || typeof policy !== "object") {
    throw new Error("The bridge omitted its run-policy attestation.");
  }
  if (
    policy.available !== true
    || policy.enforced !== true
    || policy.id !== CHANCE_RUN_POLICY.id
    || policy.sha256 !== CHANCE_RUN_POLICY.sha256
    || policy.fileCount !== CHANCE_RUN_FILE_COUNT
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) {
    throw new Error("The bridge did not attest the exact live 58-file run manifest.");
  }

  const hasFullSurface = Array.isArray(policy.excludedFileNumbers)
    || Array.isArray(policy.allowedActionTypes)
    || Array.isArray(policy.allowedContactFields)
    || Array.isArray(policy.allowedStageEvidenceSources);
  if (requireFullSurface || hasFullSurface) {
    if (!sameStrings(
      normalizedFileNumbers(policy.excludedFileNumbers),
      [...CHANCE_RUN_EXCLUDED_FILE_NUMBERS]
    )) {
      throw new Error("The bridge did not attest #2628 as the sole excluded file.");
    }
    if (!sameStrings(
      normalizedStrings(policy.allowedActionTypes),
      [...CHANCE_RUN_ACTION_TYPES].sort()
    )) {
      throw new Error("The bridge action surface differs from the pinned operator actions.");
    }
    if (!sameStrings(
      normalizedStrings(policy.allowedContactFields),
      [...CHANCE_RUN_ALLOWED_CONTACT_FIELDS].sort()
    )) {
      throw new Error("The bridge contact-field surface differs from the pinned safe fields.");
    }
    if (!sameStrings(
      normalizedStrings(policy.allowedStageEvidenceSources),
      [...CHANCE_RUN_ALLOWED_STAGE_EVIDENCE_SOURCES].sort()
    )) {
      throw new Error("The bridge stage-evidence surface differs from the pinned provider sources.");
    }
    if (
      policy.taskCompletionAllowed !== false
      || policy.outboundSendAllowed !== false
      || policy.existingDraftSendAllowed !== true
      || policy.rawGmailSendAllowed !== false
      || policy.noteCreationAllowed !== APPROVED_NOTES_ENABLED
      || (APPROVED_NOTES_ENABLED && policy.noteMentionsAllowed !== false)
      || (APPROVED_NOTES_ENABLED && policy.noteMentionRequestsAllowed !== true)
      || (APPROVED_NOTES_ENABLED && policy.noteCreationSoleOperation !== true)
      || (PDF_UPLOADS_ENABLED && (policy.pdfUploadAllowed !== true || policy.pdfUploadSoleOperation !== true
        || policy.pdfUploadContentReadbackRequired !== true || policy.pdfUploadMaxBytes !== 8388608))
      || (!PDF_UPLOADS_ENABLED && policy.pdfUploadAllowed === true)
      || policy.backwardStageMovesAllowed !== false
      || policy.stageEvidenceRequired !== true
    ) {
      throw new Error("The bridge safety flags differ from the pinned P0 policy.");
    }
  }
  if (requireReady && response?.ready !== true) {
    throw new Error("The bridge run policy is not ready.");
  }
  return policy;
}

export function assertRestartBoundary(response, { allowHardBlocked = false } = {}) {
  assertRunPolicyAttestation(response, {
    requireFullSurface: true
  });
  const recoveryBoundary = response?.recoveryBoundary;
  const recoveryBoundaryIsPlainObject = Boolean(
    recoveryBoundary
    && typeof recoveryBoundary === "object"
    && !Array.isArray(recoveryBoundary)
    && Object.getPrototypeOf(recoveryBoundary) === Object.prototype
  );
  const recoveryBoundaryError = recoveryBoundaryIsPlainObject
    && Object.hasOwn(recoveryBoundary, "error")
    && recoveryBoundary.error !== null
    && recoveryBoundary.error !== undefined
      ? String(recoveryBoundary.error).trim()
      : "";
  if (!String(response?.bridgeBootId || "").trim()) {
    throw new Error("The bridge omitted its current boot identifier.");
  }
  const receipts = response?.receipts;
  const total = receipts?.total;
  const unresolvedCount = receipts?.unresolvedCount;
  const unresolvedBatchIds = Array.isArray(receipts?.unresolvedBatchIds)
    ? receipts.unresolvedBatchIds.map((value) => String(value || "").trim())
    : [];
  const reconciliationEligibleCount = receipts?.reconciliationEligibleCount;
  const reconciliationEligibleBatchIds = Array.isArray(receipts?.reconciliationEligibleBatchIds)
    ? receipts.reconciliationEligibleBatchIds.map((value) => String(value || "").trim())
    : [];
  const hardBlockedCount = receipts?.hardBlockedCount;
  const hardBlockedBatchIds = Array.isArray(receipts?.hardBlockedBatchIds)
    ? receipts.hardBlockedBatchIds.map((value) => String(value || "").trim())
    : [];
  const hardBlockedSummaries = Array.isArray(receipts?.hardBlockedSummaries)
    ? receipts.hardBlockedSummaries
    : [];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const validIds = (values) => (
    values.every((value) => uuid.test(value))
    && new Set(values).size === values.length
  );
  const classifiedBatchIds = [
    ...reconciliationEligibleBatchIds,
    ...hardBlockedBatchIds
  ].sort();
  if (
    !receipts
    || typeof receipts !== "object"
    || !Number.isInteger(total)
    || total < 0
    || !Number.isInteger(unresolvedCount)
    || unresolvedCount < 0
    || unresolvedCount > total
    || unresolvedBatchIds.length !== unresolvedCount
    || !validIds(unresolvedBatchIds)
    || !Number.isInteger(reconciliationEligibleCount)
    || reconciliationEligibleCount < 0
    || reconciliationEligibleBatchIds.length !== reconciliationEligibleCount
    || !validIds(reconciliationEligibleBatchIds)
    || !Number.isInteger(hardBlockedCount)
    || hardBlockedCount < 0
    || hardBlockedBatchIds.length !== hardBlockedCount
    || !validIds(hardBlockedBatchIds)
    || hardBlockedSummaries.length !== hardBlockedCount
    || new Set(classifiedBatchIds).size !== classifiedBatchIds.length
    || !sameStrings(classifiedBatchIds, [...unresolvedBatchIds].sort())
    || typeof response?.ready !== "boolean"
  ) {
    throw new Error("The bridge omitted a complete unresolved-receipt boundary.");
  }
  const hardBlockedSummaryIds = [];
  for (const summary of hardBlockedSummaries) {
    const summaryId = String(summary?.batchId || "").trim();
    if (
      !plainObject(summary)
      || !uuid.test(summaryId)
      || !hardBlockedBatchIds.includes(summaryId)
      || !/^[a-f0-9]{64}$/.test(String(summary.rawRowSha256 || ""))
      || !String(summary.status || "").trim()
      || typeof summary.principalBound !== "boolean"
      || typeof summary.principalMatchesCurrent !== "boolean"
      || !Number.isInteger(summary.operationCount)
      || summary.operationCount < 1
      || summary.operationCount > 15
      || !Number.isInteger(summary.completedCount)
      || summary.completedCount < 0
      || summary.completedCount > summary.operationCount
      || typeof summary.currentPresent !== "boolean"
      || !Array.isArray(summary.completed)
      || !Array.isArray(summary.notAttempted)
      || !Array.isArray(summary.files)
      || !plainObject(summary.runPolicy)
      || typeof summary.runPolicy.present !== "boolean"
      || typeof summary.runPolicy.matchesCurrent !== "boolean"
      || !plainObject(summary.recovery)
      || typeof summary.recovery.fileScopedQuarantine !== "boolean"
      || !["global", "manifest_files", "outside_manifest_files"].includes(summary.scope)
    ) {
      throw new Error("A hard-blocked receipt summary is incomplete or unsafe.");
    }
    hardBlockedSummaryIds.push(summaryId);
  }
  if (
    new Set(hardBlockedSummaryIds).size !== hardBlockedSummaryIds.length
    || !sameStrings([...hardBlockedSummaryIds].sort(), [...hardBlockedBatchIds].sort())
  ) {
    throw new Error("The hard-blocked receipt summaries do not match their exact batch IDs.");
  }
  if (hardBlockedCount > 0 && !allowHardBlocked) {
    throw new Error("The bridge has hard-blocked receipt batches. Do not reconcile or continue work.");
  }
  if (!allowHardBlocked && !sameStrings(
    [...reconciliationEligibleBatchIds].sort(),
    [...unresolvedBatchIds].sort()
  )) {
    throw new Error("Not every unresolved receipt is eligible for safe reconciliation.");
  }
  if (
    !recoveryBoundaryIsPlainObject
    || recoveryBoundary.status !== "ready"
    || recoveryBoundaryError
  ) {
    throw new Error("The bridge recovery boundary is not ready and error-free.");
  }
  const ready = response?.ready === true;
  if (ready === (unresolvedCount > 0)) {
    throw new Error(
      unresolvedCount > 0
        ? "The bridge reported ready while unresolved receipts remain."
        : "The bridge is not ready for a reason other than unresolved receipts."
    );
  }
  return {
    bridgeBootId: String(response.bridgeBootId),
    ready,
    unresolvedCount,
    unresolvedBatchIds,
    reconciliationEligibleCount,
    reconciliationEligibleBatchIds,
    hardBlockedCount,
    hardBlockedBatchIds
  };
}

export function assertExecutionReceiptAttestation(
  response,
  approvalDigest,
  { operations, bridgeBootId } = {}
) {
  const batch = response?.batch;
  const expiresAt = Date.parse(String(batch?.runPolicyExpiresAt || ""));
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (!plainObject(batch)) {
    throw new Error("The bridge omitted the durable execution batch receipt.");
  }
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 15) {
    throw new Error("Execution receipt attestation requires the exact approved operations.");
  }
  const expectedBootId = String(bridgeBootId || "").trim();
  const expectedTypes = operations.map((operation) => String(operation?.type || ""));
  if (
    !["executed", "partial_failure"].includes(response?.mode)
    || batch.schemaVersion !== 2
    || !uuid.test(String(batch.id || ""))
    || !uuid.test(String(batch.approvalId || ""))
    || !/^[a-f0-9]{64}$/.test(String(batch.principalHash || ""))
    || batch.operatorScope !== "assigned"
    || !expectedBootId
    || String(batch.bootId || "") !== expectedBootId
    || batch.runPolicyId !== CHANCE_RUN_POLICY.id
    || batch.runPolicySha256 !== CHANCE_RUN_POLICY.sha256
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
    || batch.operationCount !== operations.length
    || !["assigned_single_file_v2", "assigned_multi_v1"].includes(batch.batchMode)
    || !Number.isInteger(batch.fileCount)
    || batch.fileCount < 1
    || batch.fileCount > 5
    || (batch.batchMode === "assigned_single_file_v2" && batch.fileCount !== 1)
    || (batch.batchMode === "assigned_multi_v1" && batch.fileCount < 2)
  ) {
    throw new Error("The execution receipt is not bound to the exact live boot, operator, and run policy.");
  }
  if (String(batch.approvalDigest || "") !== String(approvalDigest || "")) {
    throw new Error("The execution receipt is not bound to the approved digest.");
  }

  if (!Array.isArray(batch.files) || batch.files.length !== batch.fileCount) {
    throw new Error("The execution receipt omitted its exact file boundary.");
  }
  const descriptors = new Map();
  const fileIds = new Set();
  const fileNumbers = new Set();
  for (const file of batch.files) {
    const fileId = String(file?.id || "").trim();
    const fileNumber = String(file?.number || "").trim().replace(/^#/, "");
    if (
      !plainObject(file)
      || !/^[a-zA-Z0-9_-]{8,100}$/.test(fileId)
      || !/^\d+$/.test(fileNumber)
      || fileNumber === "2628"
      || fileIds.has(fileId)
      || fileNumbers.has(fileNumber)
      || !Array.isArray(file.operationIndexes)
      || !Array.isArray(file.operationTypes)
      || file.operationIndexes.length !== file.operationTypes.length
      || file.operationIndexes.length < 1
    ) {
      throw new Error("The execution receipt contains an incomplete or unsafe file descriptor.");
    }
    fileIds.add(fileId);
    fileNumbers.add(fileNumber);
    for (let offset = 0; offset < file.operationIndexes.length; offset += 1) {
      const index = file.operationIndexes[offset];
      const type = String(file.operationTypes[offset] || "");
      const requestedFileNumber = String(
        operations[index]?.payload?.query || ""
      ).trim().replace(/^#/, "");
      if (
        !Number.isInteger(index)
        || index < 0
        || index >= operations.length
        || descriptors.has(index)
        || type !== expectedTypes[index]
        || requestedFileNumber !== fileNumber
      ) {
        throw new Error("The execution receipt file operations differ from the approved batch.");
      }
      descriptors.set(index, { index, type, fileId, fileNumber });
    }
  }
  if (descriptors.size !== operations.length) {
    throw new Error("The execution receipt does not cover every approved operation exactly once.");
  }

  if (!Array.isArray(batch.intents) || batch.intents.length !== operations.length) {
    throw new Error("The execution receipt omitted its immutable operation intents.");
  }
  const intentIndexes = new Set();
  for (const intent of batch.intents) {
    const index = intent?.index;
    const descriptor = descriptors.get(index);
    if (
      !plainObject(intent)
      || !descriptor
      || intentIndexes.has(index)
      || intent.type !== descriptor.type
      || String(intent.fileId || "") !== descriptor.fileId
      || String(intent.fileNumber || "").replace(/^#/, "") !== descriptor.fileNumber
      || !plainObject(intent.reconciliation)
      || !/^[a-f0-9]{64}$/.test(String(intent.intentDigest || ""))
    ) {
      throw new Error("The execution receipt contains an invalid immutable operation intent.");
    }
    if (descriptor.type === "jobnimbus.create_note") {
      const note = operations[index]?.payload?.note;
      const noteSha256 = typeof note === "string"
        ? createHash("sha256").update(note, "utf8").digest("hex") : "";
      if (!noteSha256 || intent.reconciliation.noteSha256 !== noteSha256
        || !matchesApprovedNoteMentionIntent(intent.reconciliation, approvedNoteMentionIntent(note))) {
        throw new Error("The immutable note intent differs from the approved text or intended mention recipient.");
      }
    }
    if (descriptor.type === PDF_UPLOAD_TYPE) {
      const expected = validatePdfPayload(operations[index]?.payload).metadata;
      if (!PDF_UPLOADS_ENABLED || operations.length !== 1
        || Object.entries(expected).some(([key, value]) => intent.reconciliation[key] !== value)) {
        throw new Error("PDF intent differs from the approved bytes or metadata.");
      }
    }
    intentIndexes.add(index);
  }

  const completed = Array.isArray(batch.completed) ? batch.completed : null;
  const notAttempted = Array.isArray(batch.notAttempted) ? batch.notAttempted : null;
  if (!completed || !notAttempted) {
    throw new Error("The execution receipt omitted completed or not-attempted indexes.");
  }
  const completedIndexes = new Set();
  for (const item of completed) {
    const index = item?.index;
    const descriptor = descriptors.get(index);
    const receipt = item?.receipt;
    if (
      !plainObject(item)
      || !descriptor
      || completedIndexes.has(index)
      || item.type !== descriptor.type
      || item.status !== "executed"
      || !plainObject(receipt)
      || !String(receipt.mode || "").trim()
      || String(receipt.fileId || "") !== descriptor.fileId
      || String(receipt.fileNumber || "").replace(/^#/, "") !== descriptor.fileNumber
      || receipt.verifiedByReadback !== true
      || receipt.manualVerificationRequired === true
    ) {
      throw new Error("A completed execution receipt lacks exact provider readback confirmation.");
    }
    if (descriptor.type === "gmail.send_existing_draft") {
      const approvedDraftId = String(operations[index]?.payload?.draftId || "").trim();
      if (
        !/^[A-Za-z0-9_-]{1,512}$/.test(String(receipt.externalId || ""))
        || !approvedDraftId
        || String(receipt.sourceDraftId || "") !== approvedDraftId
        || receipt.sourceDraftRetention !== "retained_for_separate_cleanup"
      ) {
        throw new Error("The Gmail send receipt does not prove the exact approved source draft, Sent message id, and retained source.");
      }
    }
    if (descriptor.type === "jobnimbus.create_note") {
      const note = operations[index]?.payload?.note;
      const noteSha256 = typeof note === "string"
        ? createHash("sha256").update(note, "utf8").digest("hex") : "";
      if (
        !APPROVED_NOTES_ENABLED
        || operations.length !== 1
        || !/^[A-Za-z0-9_-]{8,100}$/.test(String(receipt.externalId || ""))
        || !noteSha256 || receipt.noteSha256 !== noteSha256
        || !matchesApprovedNoteMentionIntent(receipt, approvedNoteMentionIntent(note))
        || receipt.mentionsVerified !== false || receipt.accountingNotified !== false
      ) {
        throw new Error("The note receipt does not prove the exact approved text and provider note ID, or incorrectly claims an accounting notification.");
      }
    }
    completedIndexes.add(index);
    if (descriptor.type === PDF_UPLOAD_TYPE) assertPdfReceipt(receipt, operations[index]?.payload);
  }

  const notAttemptedIndexes = new Set();
  for (const item of notAttempted) {
    const index = item?.index;
    const descriptor = descriptors.get(index);
    if (
      !plainObject(item)
      || !descriptor
      || completedIndexes.has(index)
      || notAttemptedIndexes.has(index)
      || item.type !== descriptor.type
      || String(item.fileId || "") !== descriptor.fileId
      || String(item.fileNumber || "").replace(/^#/, "") !== descriptor.fileNumber
      || item.status !== "not_attempted"
    ) {
      throw new Error("A not-attempted execution receipt entry is incomplete or ambiguous.");
    }
    notAttemptedIndexes.add(index);
  }

  if (response.mode === "executed") {
    if (
      batch.status !== "completed"
      || batch.current !== undefined
      || batch.failedAt !== undefined
      || completedIndexes.size !== operations.length
      || notAttemptedIndexes.size !== 0
      || !Number.isFinite(Date.parse(String(batch.completedAt || "")))
    ) {
      throw new Error("The bridge did not return one complete terminal execution receipt.");
    }
  } else {
    const current = batch.current;
    const descriptor = descriptors.get(current?.index);
    const partition = new Set([
      ...completedIndexes,
      ...notAttemptedIndexes,
      current?.index
    ]);
    if (
      batch.status !== "partial_failure"
      || !plainObject(current)
      || !descriptor
      || current.status !== "reconciliation_required"
      || current.type !== descriptor.type
      || String(current.fileId || "") !== descriptor.fileId
      || String(current.fileNumber || "").replace(/^#/, "") !== descriptor.fileNumber
      || batch.failedAt !== current.index
      || completedIndexes.has(current.index)
      || notAttemptedIndexes.has(current.index)
      || [...completedIndexes].some((index) => index >= current.index)
      || [...notAttemptedIndexes].some((index) => index <= current.index)
      || [...Array(current.index).keys()].some((index) => !completedIndexes.has(index))
      || [...Array(operations.length - current.index - 1).keys()]
        .map((offset) => current.index + offset + 1)
        .some((index) => !notAttemptedIndexes.has(index))
      || partition.size !== operations.length
      || [...Array(operations.length).keys()].some((index) => !partition.has(index))
    ) {
      throw new Error("The partial-failure receipt lacks one exact reconciliation boundary.");
    }
  }
  return batch;
}

export function assertReconciliationReceiptAttestation(response, batchId) {
  const receipt = response?.receipt;
  if (!plainObject(receipt)) {
    throw new Error("The bridge omitted the durable reconciliation receipt.");
  }
  if (
    receipt.runPolicyId !== CHANCE_RUN_POLICY.id
    || receipt.runPolicySha256 !== CHANCE_RUN_POLICY.sha256
  ) {
    throw new Error("The reconciliation receipt is not bound to the pinned run policy.");
  }
  if (String(receipt.batchId || "") !== String(batchId || "")) {
    throw new Error("The reconciliation receipt belongs to a different batch.");
  }
  if (!String(receipt.approvalDigest || "").trim()) {
    throw new Error("The reconciliation receipt omitted its original approval digest.");
  }
  if (
    receipt.operatorScope !== "assigned"
    || !["assigned_single_file_v2", "assigned_multi_v1"].includes(receipt.batchMode)
    || !Number.isInteger(receipt.operationCount)
    || receipt.operationCount < 1
    || receipt.operationCount > 15
    || !Number.isInteger(receipt.fileCount)
    || receipt.fileCount < 1
    || receipt.fileCount > 5
    || (receipt.batchMode === "assigned_single_file_v2" && receipt.fileCount !== 1)
    || (receipt.batchMode === "assigned_multi_v1" && receipt.fileCount < 2)
    || !Array.isArray(receipt.files)
    || receipt.files.length !== receipt.fileCount
    || !Array.isArray(receipt.intents)
    || receipt.intents.length !== receipt.operationCount
    || !Array.isArray(receipt.completed)
    || !Array.isArray(receipt.notAttempted)
    || receipt.completedCount !== receipt.completed.length
    || receipt.current !== null
    || receipt.automaticRetryAllowed !== false
    || typeof receipt.freshApprovalRequired !== "boolean"
  ) {
    throw new Error("The reconciliation receipt is structurally incomplete or unsafe.");
  }

  const descriptors = new Map();
  const receiptFileNumbers = new Set();
  for (const file of receipt.files) {
    const fileNumber = String(file?.number || "").replace(/^#/, "");
    if (
      !plainObject(file)
      || !/^\d+$/.test(fileNumber)
      || fileNumber === "2628"
      || receiptFileNumbers.has(fileNumber)
      || !Array.isArray(file.operationIndexes)
      || !Array.isArray(file.operationTypes)
      || file.operationIndexes.length !== file.operationTypes.length
      || file.operationIndexes.length < 1
    ) {
      throw new Error("The reconciliation receipt has an invalid file descriptor.");
    }
    receiptFileNumbers.add(fileNumber);
    for (let offset = 0; offset < file.operationIndexes.length; offset += 1) {
      const index = file.operationIndexes[offset];
      const type = String(file.operationTypes[offset] || "");
      if (
        !Number.isInteger(index)
        || index < 0
        || index >= receipt.operationCount
        || descriptors.has(index)
        || !CHANCE_RUN_ACTION_TYPES.includes(type)
      ) {
        throw new Error("The reconciliation receipt has ambiguous operation descriptors.");
      }
      descriptors.set(index, { index, type, fileNumber });
    }
  }
  if (descriptors.size !== receipt.operationCount) {
    throw new Error("The reconciliation receipt does not cover every operation exactly once.");
  }
  const intentIndexes = new Set();
  const noteIntentHashes = new Map();
  const noteMentionIntents = new Map();
  const pdfIntents = new Map();
  for (const intent of receipt.intents) {
    const descriptor = descriptors.get(intent?.index);
    if (
      !plainObject(intent)
      || !descriptor
      || intentIndexes.has(intent.index)
      || intent.type !== descriptor.type
      || String(intent.fileNumber || "").replace(/^#/, "") !== descriptor.fileNumber
      || !/^[a-f0-9]{64}$/.test(String(intent.intentDigest || ""))
    ) {
      throw new Error("The reconciliation receipt has an invalid immutable intent descriptor.");
    }
    if (descriptor.type === "jobnimbus.create_note") {
      if (!/^[a-f0-9]{64}$/.test(String(intent.noteSha256 || ""))
        || typeof intent.mentionRequested !== "boolean"
        || !matchesApprovedNoteMentionIntent(intent, { mentionRequested: intent.mentionRequested })) {
        throw new Error("The reconciled note intent omitted its exact approved-content hash or intended mention recipient.");
      }
      noteIntentHashes.set(intent.index, intent.noteSha256);
      noteMentionIntents.set(intent.index, intent);
    }
    intentIndexes.add(intent.index);
    if (descriptor.type === PDF_UPLOAD_TYPE) pdfIntents.set(intent.index, validatePdfMetadata(intent));
  }

  const completedIndexes = new Set();
  for (const item of receipt.completed) {
    const descriptor = descriptors.get(item?.index);
    if (
      !plainObject(item)
      || !descriptor
      || completedIndexes.has(item.index)
      || item.type !== descriptor.type
      || item.status !== "executed"
      || String(item.receipt?.fileNumber || "").replace(/^#/, "") !== descriptor.fileNumber
      || !String(item.receipt?.mode || "").trim()
      || item.receipt?.verifiedByReadback !== true
      || item.receipt?.manualVerificationRequired === true
    ) {
      throw new Error("A reconciled completion lacks exact provider readback evidence.");
    }
    if (descriptor.type === "jobnimbus.create_note") {
      if (
        !APPROVED_NOTES_ENABLED || receipt.operationCount !== 1
        || !/^[A-Za-z0-9_-]{8,100}$/.test(String(item.receipt?.externalId || ""))
        || !/^[a-f0-9]{64}$/.test(String(item.receipt?.noteSha256 || ""))
        || item.receipt.noteSha256 !== noteIntentHashes.get(item.index)
        || !matchesApprovedNoteMentionIntent(item.receipt, noteMentionIntents.get(item.index))
        || item.receipt?.mentionsVerified !== false
        || item.receipt?.accountingNotified !== false
      ) {
        throw new Error("The reconciled note receipt omitted provider identity/content proof or claimed an unsupported notification.");
      }
    }
    completedIndexes.add(item.index);
    if (descriptor.type === PDF_UPLOAD_TYPE) {
      if (!PDF_UPLOADS_ENABLED || receipt.operationCount !== 1) throw new Error("PDF recovery is not activated or is mixed with other actions.");
      assertPdfReceipt(item.receipt, pdfIntents.get(item.index));
    }
  }
  const notAttemptedIndexes = new Set();
  for (const item of receipt.notAttempted) {
    const descriptor = descriptors.get(item?.index);
    if (
      !plainObject(item)
      || !descriptor
      || completedIndexes.has(item.index)
      || notAttemptedIndexes.has(item.index)
      || item.type !== descriptor.type
      || String(item.fileNumber || "").replace(/^#/, "") !== descriptor.fileNumber
      || item.status !== "not_attempted"
    ) {
      throw new Error("A reconciled not-attempted entry is incomplete or ambiguous.");
    }
    notAttemptedIndexes.add(item.index);
  }
  const exactPartition = (middleIndex = null) => {
    const indexes = new Set([...completedIndexes, ...notAttemptedIndexes]);
    if (middleIndex !== null) indexes.add(middleIndex);
    return indexes.size === receipt.operationCount
      && [...Array(receipt.operationCount).keys()].every((index) => indexes.has(index))
      && (middleIndex === null || (
        !completedIndexes.has(middleIndex)
        && !notAttemptedIndexes.has(middleIndex)
        && [...completedIndexes].every((index) => index < middleIndex)
        && [...notAttemptedIndexes].every((index) => index > middleIndex)
      ));
  };
  const exactSequentialDirectPartition = () => exactPartition()
    && [...Array(completedIndexes.size).keys()].every((index) => completedIndexes.has(index))
    && [...Array(receipt.operationCount - completedIndexes.size).keys()]
      .map((offset) => completedIndexes.size + offset)
      .every((index) => notAttemptedIndexes.has(index));
  const assertManualDescriptorBinding = (manualQuarantine) => {
    const descriptor = descriptors.get(manualQuarantine?.index);
    const allFileNumbers = [...new Set(
      [...descriptors.values()].map((item) => item.fileNumber)
    )].sort();
    if (
      !descriptor
      || (manualQuarantine.scope === "file" && (
        manualQuarantine.type !== descriptor.type
        || manualQuarantine.fileNumber !== descriptor.fileNumber
        || !sameStrings(manualQuarantine.fileNumbers, [descriptor.fileNumber])
      ))
      || (manualQuarantine.scope === "files" && !sameStrings(
        [...manualQuarantine.fileNumbers].sort(),
        allFileNumbers
      ))
    ) {
      throw new Error("The manual quarantine is not bound to its immutable file descriptor.");
    }
  };

  if (response?.mode === "reconciled") {
    if (!["applied_verified", "not_applied_verified"].includes(response?.outcome)) {
      throw new Error("The bridge returned an unsupported reconciliation outcome.");
    }
    if (response.outcome === "applied_verified") {
      if (
        !exactSequentialDirectPartition()
        || (receipt.notAttempted.length === 0
          ? receipt.status !== "completed"
          : receipt.status !== "partial_failure")
        || receipt.freshApprovalRequired !== (receipt.status === "partial_failure")
      ) {
        throw new Error("The applied reconciliation receipt has an invalid terminal partition.");
      }
    } else if (
      receipt.status !== "partial_failure"
      || !Number.isInteger(receipt.failedAt)
      || completedIndexes.has(receipt.failedAt)
      || notAttemptedIndexes.has(receipt.failedAt)
      || !exactPartition(receipt.failedAt)
      || receipt.freshApprovalRequired !== true
    ) {
      throw new Error("The not-applied reconciliation receipt has an invalid terminal partition.");
    }
  } else if (response?.mode === "manual_quarantined") {
    if (
      response?.outcome !== "unknown_file_quarantined"
      || receipt.status !== "manual_quarantined"
      || receipt.freshApprovalRequired !== false
    ) {
      throw new Error("The bridge returned an invalid manual-quarantine outcome.");
    }
    assertManualQuarantine(receipt.manualQuarantine);
    assertManualDescriptorBinding(receipt.manualQuarantine);
    if (!exactPartition(receipt.manualQuarantine.index)) {
      throw new Error("The manual-quarantine receipt has an invalid terminal partition.");
    }
  } else if (response?.mode === "verified_noop") {
    if (receipt.status === "manual_quarantined") {
      assertManualQuarantine(receipt.manualQuarantine);
      assertManualDescriptorBinding(receipt.manualQuarantine);
      if (
        !exactPartition(receipt.manualQuarantine.index)
        || receipt.freshApprovalRequired !== false
      ) {
        throw new Error("The verified-noop quarantine has an invalid terminal partition.");
      }
    } else if (receipt.status === "completed") {
      if (
        !exactSequentialDirectPartition()
        || receipt.notAttempted.length !== 0
        || receipt.freshApprovalRequired !== false
      ) {
        throw new Error("The verified-noop completed receipt is not terminal.");
      }
    } else if (receipt.status === "partial_failure") {
      const directPartition = exactSequentialDirectPartition();
      const failedPartition = Number.isInteger(receipt.failedAt)
        && !completedIndexes.has(receipt.failedAt)
        && !notAttemptedIndexes.has(receipt.failedAt)
        && exactPartition(receipt.failedAt);
      if ((!directPartition && !failedPartition) || receipt.freshApprovalRequired !== true) {
        throw new Error("The verified-noop partial receipt has an invalid terminal partition.");
      }
    } else {
      throw new Error("The verified-noop receipt has a nonterminal status.");
    }
  } else {
    throw new Error("The bridge returned an unsupported reconciliation mode.");
  }
  return receipt;
}

function assertManualQuarantine(value) {
  const isPlainObject = Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
  const quarantinedAt = isPlainObject
    ? String(value.quarantinedAt || "").trim()
    : "";
  const hasFileNumbersArray = isPlainObject && Array.isArray(value.fileNumbers);
  const fileNumbers = hasFileNumbersArray
    ? value.fileNumbers
    : [];
  const fileNumbersAreNumericAndUnique = fileNumbers.every((fileNumber) => (
      typeof fileNumber === "string" && /^\d+$/.test(fileNumber)
    ))
    && new Set(fileNumbers).size === fileNumbers.length;
  const boundDescriptor = isPlainObject
    && value.scope === "file"
    && typeof value.type === "string"
    && Boolean(value.type.trim())
    && value.type !== "unknown"
    && typeof value.fileNumber === "string"
    && /^\d+$/.test(value.fileNumber)
    && fileNumbers.length === 1
    && fileNumbers[0] === value.fileNumber;
  const unboundFilesDescriptor = isPlainObject
    && value.scope === "files"
    && value.reasonCode === "immutable_intent_invalid"
    && value.type === "unknown"
    && value.fileNumber === ""
    && fileNumbers.length > 0
    && fileNumbersAreNumericAndUnique;
  const globalDescriptor = isPlainObject
    && value.scope === "global"
    && value.reasonCode === "immutable_intent_invalid"
    && value.type === "unknown"
    && value.fileNumber === ""
    && fileNumbers.length === 0;
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    !isPlainObject
    || !Number.isInteger(value.index)
    || value.index < 0
    || !hasFileNumbersArray
    || !fileNumbersAreNumericAndUnique
    || (!boundDescriptor && !unboundFilesDescriptor && !globalDescriptor)
    || !["provider_state_unprovable", "immutable_intent_invalid"].includes(value.reasonCode)
    || typeof value.reason !== "string"
    || !value.reason.trim()
    || typeof value.quarantinedAt !== "string"
    || !isoTimestamp.test(quarantinedAt)
    || !Number.isFinite(Date.parse(quarantinedAt))
  ) {
    throw new Error("The bridge returned an incomplete manual-quarantine record.");
  }
  return value;
}

export function scopedOperations(operations, operatorScope) {
  if (!["assigned", "company"].includes(operatorScope)) {
    throw new Error("Operator scope must be assigned or company.");
  }
  validateApprovedNoteOperation(operations, operatorScope, { enabled: APPROVED_NOTES_ENABLED });
  if (operations.some((operation) => operation?.type === PDF_UPLOAD_TYPE)) {
    if (!PDF_UPLOADS_ENABLED || operatorScope !== "assigned" || operations.length !== 1) {
      throw new Error("PDF uploads require the activated release and one sole assigned-file operation.");
    }
    validatePdfPayload(operations[0].payload);
  }
  const existingDraftSends = operations.filter(
    (operation) => operation?.type === "gmail.send_existing_draft"
  );
  if (existingDraftSends.length) {
    if (operatorScope !== "assigned" || operations.length !== 1 || existingDraftSends.length !== 1) {
      throw new Error("An existing-draft Gmail send must be the sole assigned-file operation in its approval batch.");
    }
    const payload = safePayload(existingDraftSends[0].payload);
    const keys = Object.keys(payload).sort();
    if (
      keys.length !== 2
      || keys[0] !== "draftId"
      || keys[1] !== "query"
      || !/^#?\d+$/.test(String(payload.query || ""))
      || !/^[A-Za-z0-9_-]{1,512}$/.test(String(payload.draftId || ""))
    ) {
      throw new Error("Existing-draft Gmail send payload must be exactly {query,draftId} for one numeric manifest file.");
    }
  }
  return operations.map((operation) => ({
    ...operation,
    payload: {
      ...safePayload(operation.payload),
      operatorScope
    }
  }));
}

function safePayload(payload) {
  const value = payload && typeof payload === "object" ? payload : {};
  const reserved = ["runPolicy", "approvalDigest", "approvalChallenge", "execute"];
  const supplied = reserved.filter((key) => Object.hasOwn(value, key));
  if (supplied.length) {
    throw new Error(`Operation payload cannot supply bridge control fields: ${supplied.join(", ")}.`);
  }
  return value;
}
