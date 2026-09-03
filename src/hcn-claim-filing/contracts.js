import { createHash } from "node:crypto";

import {
  analyzeClaimCall,
  CLAIM_BRIDGE_SOURCE,
  digest
} from "../claim-filing-adapter.js";

const GOOGLE_SUBJECT_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
const FILE_REF_PATTERN = /^subject_[a-f0-9]{32}$/;
const CONVERSATION_REF_PATTERN = /^conversation_[a-f0-9]{32}$/;
const CALL_REF_PATTERN = /^claim_call_[a-f0-9]{32}$/;
const PLAN_ID_PATTERN = /^plan_[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const VERIFIED_OUTCOMES = new Set([
  "claim_filed",
  "existing_claim_confirmed"
]);
const CONFIRMATION_KEYS = new Set([
  "damageOpening",
  "damageDetails",
  "injuries",
  "homeLivable",
  "temporaryRepairs",
  "contractorHired",
  "carrierPhone"
]);
const WRITEBACK_MAPPING_VERSION = "hcn.jobnimbus.claim-fields.v1";
const WRITEBACK_MAPPING_KEYS = new Set([
  "version",
  "verified",
  "claimNumber",
  "adjusterName",
  "adjusterPhone",
  "adjusterEmail"
]);
const STATUS_ADVANCEMENT_ALLOWLIST = new Set([
  "photo file / estimate needed",
  "need paperwork/info",
  "ready for pa review",
]);
const ANSWER_ENUMS = Object.freeze({
  injuries: Object.freeze({
    no_injuries_reported: "No injuries reported",
    injuries_reported: "Injuries were reported; stop and escalate to a human"
  }),
  homeLivable: Object.freeze({
    livable: "Yes, the home is livable",
    not_livable: "No, the home is not livable"
  }),
  temporaryRepairs: Object.freeze({
    none_made: "No temporary repairs have been made",
    repairs_made: "Temporary repairs have been made"
  }),
  contractorHired: Object.freeze({
    none_hired: "No contractor has been hired",
    contractor_hired: "A contractor has been hired"
  })
});
const RESULT_FIELDS = [
  ["claimNumber", "claim number"],
  ["adjusterName", "adjuster name"],
  ["adjusterPhone", "adjuster phone"],
  ["adjusterEmail", "adjuster email"],
  ["documentSubmission", "representation destination"]
];
const TRUSTED_CALL_EVIDENCE = new WeakSet();

export class HcnClaimFilingContractError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = "HcnClaimFilingContractError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function parseHcnClaimFilingPilotSubjects(raw) {
  const text = String(raw || "").trim();
  if (!text) return immutablePilotRegistry([]);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "HCN_CLAIM_FILING_PILOT_SUBJECTS_JSON must be a JSON array of Google subjects."
    );
  }
  if (
    !Array.isArray(parsed)
    || (parsed.length !== 0 && parsed.length !== 2)
  ) {
    throw new Error(
      "HCN_CLAIM_FILING_PILOT_SUBJECTS_JSON must contain exactly two Google subjects when the pilot is enabled."
    );
  }
  const subjects = parsed.map((value) => {
    if (typeof value !== "string" || !GOOGLE_SUBJECT_PATTERN.test(value)) {
      throw new Error(
        "HCN_CLAIM_FILING_PILOT_SUBJECTS_JSON contains an invalid Google subject."
      );
    }
    return value;
  });
  if (new Set(subjects).size !== subjects.length) {
    throw new Error(
      "HCN_CLAIM_FILING_PILOT_SUBJECTS_JSON contains a duplicate Google subject."
    );
  }
  return immutablePilotRegistry(subjects);
}

export function hcnClaimFilingPilotEligible(subjects, googleSubject) {
  return Boolean(subjects)
    && typeof subjects.has === "function"
    && GOOGLE_SUBJECT_PATTERN.test(String(googleSubject || ""))
    && subjects.has(String(googleSubject));
}

export function assertHcnClaimFilingPilot(subjects, googleSubject) {
  if (!hcnClaimFilingPilotEligible(subjects, googleSubject)) {
    throw contractError(
      "claim_filing_pilot_required",
      403,
      "This employee is not enabled for the internal claim-filing pilot."
    );
  }
}

export function normalizeHcnClaimConfirmations(value = {}) {
  assertPlainObject(value, "confirmations");
  assertExactKeys(value, CONFIRMATION_KEYS, "confirmations");
  const damageDetails = normalizeDamageDetails(value.damageDetails);
  return Object.freeze({
    damageOpening: boundedLine(value.damageOpening, 600),
    damageDetails,
    injuries: enumValue(value.injuries, ANSWER_ENUMS.injuries),
    homeLivable: enumValue(value.homeLivable, ANSWER_ENUMS.homeLivable),
    temporaryRepairs: enumValue(
      value.temporaryRepairs,
      ANSWER_ENUMS.temporaryRepairs
    ),
    contractorHired: enumValue(
      value.contractorHired,
      ANSWER_ENUMS.contractorHired
    ),
    carrierPhone: boundedPhone(value.carrierPhone)
  });
}

export function hcnClaimSpokenAnswers(confirmations) {
  return Object.freeze({
    injuries: ANSWER_ENUMS.injuries[confirmations.injuries] || "",
    homeLivable: ANSWER_ENUMS.homeLivable[confirmations.homeLivable] || "",
    temporaryRepairs:
      ANSWER_ENUMS.temporaryRepairs[confirmations.temporaryRepairs] || "",
    contractorHired:
      ANSWER_ENUMS.contractorHired[confirmations.contractorHired] || ""
  });
}

export function parseHcnClaimWritebackMapping(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return Object.freeze({
      configured: false,
      version: WRITEBACK_MAPPING_VERSION,
      fields: Object.freeze({})
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      "HCN_JOBNIMBUS_CLAIM_FIELD_MAPPING_JSON must be valid JSON."
    );
  }
  assertPlainObject(value, "HCN JobNimbus claim field mapping");
  assertExactKeys(
    value,
    WRITEBACK_MAPPING_KEYS,
    "HCN JobNimbus claim field mapping"
  );
  if (
    value.version !== WRITEBACK_MAPPING_VERSION
    || value.verified !== true
  ) {
    throw new Error(
      "HCN JobNimbus claim field mapping must be explicitly verified at the supported version."
    );
  }
  const fields = {};
  for (const key of [
    "claimNumber",
    "adjusterName",
    "adjusterPhone",
    "adjusterEmail"
  ]) {
    const field = String(value[key] || "");
    if (!/^cf_string_\d{1,3}$/.test(field)) {
      throw new Error(`HCN JobNimbus ${key} mapping is invalid.`);
    }
    fields[key] = field;
  }
  if (new Set(Object.values(fields)).size !== 4) {
    throw new Error("HCN JobNimbus claim field mappings must be unique.");
  }
  return Object.freeze({
    configured: true,
    version: WRITEBACK_MAPPING_VERSION,
    fields: Object.freeze(fields)
  });
}

export function hcnClaimPreparationMissingFacts({
  file = {},
  property = {},
  confirmations = {},
  corePlan = null
} = {}) {
  const missing = [];
  const add = (code, label, source) => {
    if (!missing.some((item) => item.code === code)) {
      missing.push({ code, label, source });
    }
  };
  if (!presentText(file.name)) add("homeowner", "homeowner/insured name", "jobnimbus");
  if (!presentText(property.addressLine1)) add("property_address", "property street address", "jobnimbus");
  if (!presentText(property.city)) add("property_city", "property city", "jobnimbus");
  if (!presentText(property.state) || !/^[A-Za-z]{2}$/.test(String(property.state))) {
    add("property_state", "two-letter property state", "jobnimbus");
  }
  if (!validZip(property.zip)) add("property_zip", "valid property ZIP code", "jobnimbus");
  if (!validPhone(file.phone)) add("homeowner_phone", "valid homeowner phone", "jobnimbus");
  if (!presentText(file.carrier)) add("carrier", "insurance carrier", "jobnimbus");
  if (!presentScalar(file.policyNumber)) add("policy_number", "policy number", "jobnimbus");
  if (!validDate(file.dateOfLoss)) add("date_of_loss", "valid date of loss", "jobnimbus");
  if (!presentText(file.typeOfLoss)) add("cause_of_loss", "cause/type of loss", "jobnimbus");
  if (presentScalar(file.claimNumber)) {
    add("existing_claim", "file already has a claim number", "jobnimbus");
  }
  if (!presentText(confirmations.damageOpening)) {
    add("damage_opening", "file-specific damage opening", "employee_confirmation");
  }
  if (!Array.isArray(confirmations.damageDetails) || confirmations.damageDetails.length === 0) {
    add("damage_details", "file-specific damage details", "employee_confirmation");
  }
  for (const [key, label] of [
    ["injuries", "injury answer"],
    ["homeLivable", "habitability answer"],
    ["temporaryRepairs", "temporary-repairs answer"],
    ["contractorHired", "contractor answer"]
  ]) {
    if (!Object.hasOwn(ANSWER_ENUMS[key], confirmations[key])) {
      add(key, label, "employee_confirmation");
    }
  }
  if (confirmations.injuries === "injuries_reported") {
    add(
      "injuries_human_escalation",
      "reported injuries require human review before any carrier call",
      "employee_confirmation"
    );
  }
  if (corePlan) {
    for (const blocker of corePlan.readiness?.blockers || []) {
      add(
        `core_${createHash("sha256").update(String(blocker)).digest("hex").slice(0, 12)}`,
        String(blocker),
        "claim_core"
      );
    }
    if (!validPhone(corePlan.callPlan?.to)) {
      add("carrier_destination", "carrier claim-filing phone", "verified_carrier_directory");
    }
    const directoryPhone = String(corePlan.carrier?.filingPhone || "");
    if (
      !validPhone(directoryPhone)
      || phoneDigits(corePlan.callPlan?.to) !== phoneDigits(directoryPhone)
    ) {
      add(
        "untrusted_carrier_destination",
        "carrier destination must match the verified carrier directory",
        "verified_carrier_directory"
      );
    }
    if (
      phoneDigits(corePlan.callPlan?.to)
      && phoneDigits(corePlan.callPlan?.to) === phoneDigits(file.phone)
    ) {
      add(
        "unsafe_carrier_destination",
        "carrier destination cannot be the homeowner phone",
        "verified_carrier_directory"
      );
    }
    if (!validPhone(corePlan.callPlan?.from)) {
      add("outbound_number", "approved outbound calling number", "server_configuration");
    }
    if (!presentText(corePlan.callPlan?.agentId)) {
      add("retell_agent", "approved Retell claim agent", "server_configuration");
    }
  }
  return Object.freeze(missing.map(Object.freeze));
}

export function buildHcnClaimReviewPresentation({
  fileRef,
  file,
  plan,
  confirmations,
  missingFacts = []
}) {
  assertFileRef(fileRef);
  if (!plan || typeof plan !== "object") {
    return Object.freeze({
      schema: "hcn.claim-filing.review.v1",
      ready: false,
      fileRef,
      file: publicFile(file),
      objective: "File one new property insurance claim for this exact assigned file.",
      carrierDestination: null,
      callerIdentity: null,
      verifiedFacts: verifiedFacts(file),
      employeeConfirmedFacts: confirmedFacts(confirmations),
      missingFacts: [...missingFacts],
      stopRules: [],
      planDigest: ""
    });
  }
  return Object.freeze({
    schema: "hcn.claim-filing.review.v1",
    ready: missingFacts.length === 0 && plan.readiness?.ready === true,
    fileRef,
    file: publicFile(file),
    objective: String(plan.packet?.objective || ""),
    carrierDestination: Object.freeze({
      carrier: String(plan.carrier?.display || file.carrier || ""),
      phone: String(plan.callPlan?.to || "")
    }),
    callerIdentity: approvedCallerIdentity(plan),
    verifiedFacts: verifiedFacts(file),
    employeeConfirmedFacts: confirmedFacts(confirmations),
    missingFacts: [...missingFacts],
    warnings: [...(plan.readiness?.warnings || [])],
    stopRules: [...(plan.packet?.stopRules || [])],
    planDigest: String(plan.planDigest || "")
  });
}

function approvedCallerIdentity(plan) {
  const variables = plan?.callPlan?.dynamicVariables || {};
  return Object.freeze({
    authority: "server_bound_approved_call_plan",
    publicAdjusterName: String(variables.publicAdjusterName || ""),
    licenseJurisdiction: String(variables.licenseJurisdiction || ""),
    licenseNumber: String(variables.licenseNumber || ""),
    firmName: String(variables.firmName || ""),
    officeAddress: String(variables.officeAddress || ""),
    officePhone: String(variables.officePhone || ""),
    email: String(variables.publicAdjusterEmail || ""),
    queueCallbackPhone: String(variables.queueCallbackPhone || "")
  });
}

export function hcnClaimApprovalDigest({
  principalRef,
  conversationRef,
  fileRef,
  corePlanDigest
}) {
  assertPrincipalRef(principalRef);
  assertConversationRef(conversationRef);
  assertFileRef(fileRef);
  assertDigest(corePlanDigest, "corePlanDigest");
  return digest({
    schema: "hcn.claim-filing.approval.v1",
    principalRef,
    conversationRef,
    fileRef,
    corePlanDigest
  });
}

export function hcnClaimScopeBinding({
  principalRef,
  conversationRef,
  fileRef,
  providerFileId,
  ownerId,
  relevantFileState,
  approvalDigest
}) {
  assertPrincipalRef(principalRef);
  assertConversationRef(conversationRef);
  assertFileRef(fileRef);
  assertDigest(approvalDigest, "approvalDigest");
  if (!presentText(providerFileId) || !presentText(ownerId)) {
    throw contractError(
      "invalid_scope",
      400,
      "The exact provider file and assignment owner are required."
    );
  }
  return digest({
    schema: "hcn.claim-filing.scope.v1",
    principalRef,
    conversationRef,
    fileRef,
    providerFileId: String(providerFileId),
    ownerId: String(ownerId),
    relevantFileState,
    approvalDigest
  });
}

export function hcnClaimCallRef({ principalRef, fileRef, approvalDigest }) {
  assertPrincipalRef(principalRef);
  assertFileRef(fileRef);
  assertDigest(approvalDigest, "approvalDigest");
  return `claim_call_${digest({
    schema: "hcn.claim-filing.call-ref.v1",
    principalRef,
    fileRef,
    approvalDigest
  }).slice(0, 32)}`;
}

export function assertHcnClaimCallRef(value) {
  if (typeof value !== "string" || !CALL_REF_PATTERN.test(value)) {
    throw contractError(
      "claim_call_not_found",
      404,
      "The claim call reference was not found."
    );
  }
  return value;
}

export function createHcnServerClaimEvidence({
  callRef,
  fileRef,
  callPlanId,
  planDigest,
  terminalReceipt,
  rawCall,
  file,
  ownerId
}) {
  assertHcnClaimCallRef(callRef);
  assertFileRef(fileRef);
  assertDigest(planDigest, "planDigest");
  assertTerminalCallReceipt(terminalReceipt, planDigest, fileRef, callPlanId);
  assertPlainObject(rawCall, "rawCall");
  const metadata = rawCall.metadata;
  if (
    !metadata
    || metadata.source !== CLAIM_BRIDGE_SOURCE
    || metadata.hcnCallRef !== callRef
    || metadata.hcnFileRef !== fileRef
    || metadata.hcnApprovalDigest !== planDigest
    || String(metadata.contactId || "") !== String(file?.id || "")
    || String(metadata.ownerId || "") !== String(ownerId || "")
  ) {
    throw contractError(
      "call_evidence_mismatch",
      409,
      "The provider call is not bound to this exact approved HCN plan."
    );
  }
  const callStatus = String(rawCall.call_status || "").trim().toLowerCase();
  if (!new Set(["ended", "completed"]).has(callStatus)) {
    throw contractError(
      "call_not_terminal",
      409,
      "The provider call is not terminal and cannot be reviewed for writeback."
    );
  }
  if (!presentText(rawCall.call_id)) {
    throw contractError(
      "call_evidence_mismatch",
      409,
      "The provider call is missing its exact provider identifier."
    );
  }
  const call = {
    callId: String(rawCall.call_id || ""),
    callStatus,
    disconnectionReason: String(rawCall.disconnection_reason || ""),
    transcript: String(rawCall.transcript || ""),
    callAnalysis: rawCall.call_analysis || {},
    raw: rawCall
  };
  const analysis = analyzeClaimCall(call, {
    id: String(file?.id || ""),
    customer: String(file?.name || file?.customer || ""),
    status: String(file?.status || ""),
    carrier: String(file?.carrier || "")
  });
  const structuredOutcome = String(
    rawCall.call_analysis?.custom_analysis_data?.filing_outcome || ""
  ).trim();
  const extracted = analysis.extracted || {};
  const sources = extracted.source || {};
  const modelAnalyzedSuggestions = {};
  const transcriptGuesses = [];
  for (const [key, label] of RESULT_FIELDS) {
    const value = String(extracted[key] || "").trim();
    if (!value) continue;
    if (sources[key] === "retell-analysis") {
      modelAnalyzedSuggestions[key] = Object.freeze({
        value,
        provenance: "retell_post_call_model",
        humanConfirmed: false
      });
    } else {
      transcriptGuesses.push(Object.freeze({
        field: key,
        label,
        value,
        provenance: "transcript_parser",
        humanConfirmed: false
      }));
    }
  }
  const outcomeSuggestion = VERIFIED_OUTCOMES.has(structuredOutcome)
    ? Object.freeze({
        value: structuredOutcome,
        provenance: "retell_post_call_model",
        humanConfirmed: false
      })
    : null;
  const reviewTranscript = boundedEvidenceText(call.transcript, 12_000);
  const disconnectionReason = boundedEvidenceText(call.disconnectionReason, 240);
  const evidenceDigest = digest({
    schema: "hcn.claim-filing.evidence.v1",
    callRef,
    fileRef,
    planId: callPlanId,
    planDigest,
    receiptBatchRef: terminalReceipt.batchRef,
    receiptStatus: terminalReceipt.status,
    callStatus,
    disconnectionReason,
    transcriptDigest: digest(reviewTranscript),
    outcomeSuggestion,
    modelAnalyzedSuggestions,
    transcriptGuesses
  });
  const evidence = Object.freeze({
    schema: "hcn.claim-filing.server-evidence.v1",
    callRef,
    fileRef,
    planId: callPlanId,
    planDigest,
    evidenceDigest,
    terminalReceipt: Object.freeze({
      batchRef: String(terminalReceipt.batchRef),
      status: String(terminalReceipt.status),
      terminalAt: String(terminalReceipt.terminalAt || "")
    }),
    callStatus,
    disconnectionReason,
    reviewTranscript,
    outcomeSuggestion,
    modelAnalyzedSuggestions: Object.freeze(modelAnalyzedSuggestions),
    transcriptGuesses: Object.freeze(transcriptGuesses),
    blocker: String(extracted.blockingReason || ""),
    callbackRequested: extracted.callbackRequested === true
  });
  TRUSTED_CALL_EVIDENCE.add(evidence);
  return evidence;
}

export function projectHcnClaimResult(evidence) {
  assertTrustedCallEvidence(evidence);
  return Object.freeze({
    schema: "hcn.claim-filing.result-review.v2",
    callRef: evidence.callRef,
    fileRef: evidence.fileRef,
    planId: evidence.planId,
    planDigest: evidence.planDigest,
    evidenceDigest: evidence.evidenceDigest,
    callStatus: evidence.callStatus,
    disconnectionReason: evidence.disconnectionReason,
    reviewTranscript: evidence.reviewTranscript,
    outcomeSuggestion: evidence.outcomeSuggestion,
    modelAnalyzedSuggestions: evidence.modelAnalyzedSuggestions,
    transcriptGuesses: evidence.transcriptGuesses,
    blocker: evidence.blocker,
    callbackRequested: evidence.callbackRequested,
    humanConfirmationRequired: true,
    automaticRetry: false,
    writebackEligible: false
  });
}

export function buildHcnVerifiedClaimWriteback({
  evidence,
  humanConfirmation,
  currentStatus,
  fieldMapping
}) {
  assertTrustedCallEvidence(evidence);
  const confirmation = normalizeWritebackConfirmation(humanConfirmation);
  if (confirmation.evidenceDigest !== evidence.evidenceDigest) {
    throw contractError(
      "evidence_digest_mismatch",
      409,
      "The human confirmation does not match this exact call evidence."
    );
  }
  if (
    confirmation.reviewBasis !== "reviewed_call_transcript"
    || !presentText(evidence.reviewTranscript)
    || !VERIFIED_OUTCOMES.has(confirmation.outcome)
  ) {
    return Object.freeze({
      ready: false,
      blockers: Object.freeze([
        "The actual call transcript and exact outcome must be independently reviewed and human-confirmed."
      ]),
      fields: Object.freeze({}),
      status: "",
      note: "",
      fieldSources: Object.freeze({})
    });
  }
  if (!fieldMapping?.configured) {
    return Object.freeze({
      ready: false,
      blockers: Object.freeze([
        "The exact JobNimbus claim custom-field mapping has not been verified and configured."
      ]),
      fields: Object.freeze({}),
      status: "",
      note: "",
      fieldSources: Object.freeze({})
    });
  }
  if (evidence.callbackRequested) {
    return Object.freeze({
      ready: false,
      blockers: Object.freeze([
        "The carrier requested a callback; reconcile the completed carrier interaction before writeback."
      ]),
      fields: Object.freeze({}),
      status: "",
      note: "",
      fieldSources: Object.freeze({})
    });
  }
  const fields = {};
  const fieldSources = {};
  for (const extractedKey of [
    "claimNumber",
    "adjusterName",
    "adjusterPhone",
    "adjusterEmail"
  ]) {
    const field = fieldMapping.fields[extractedKey];
    const value = String(confirmation[extractedKey] || "").trim();
    const suggestion = evidence.modelAnalyzedSuggestions[extractedKey];
    if (value) {
      const normalized = normalizeWritebackValue(extractedKey, value);
      if (!normalized) {
        throw contractError(
          "invalid_confirmed_value",
          400,
          `The confirmed ${extractedKey} is invalid after normalization.`
        );
      }
      fields[field] = normalized;
      fieldSources[field] = suggestion && value === suggestion.value
        ? "human_accepted_retell_model_suggestion"
        : "human_entered_after_call_review";
    }
  }
  if (!fields[fieldMapping.fields.claimNumber]) {
    return Object.freeze({
      ready: false,
      blockers: Object.freeze([
        "The claim number must be reviewed and human-confirmed."
      ]),
      fields: Object.freeze({}),
      status: "",
      note: "",
      fieldSources: Object.freeze({})
    });
  }
  assertHcnClaimWritebackFields(fields, fieldMapping);
  const status = STATUS_ADVANCEMENT_ALLOWLIST.has(
    normalizeStatus(currentStatus)
  )
    ? "Submitted Awaiting Confirmation"
    : "";
  const adjusterCaptured = Boolean(
    fields[fieldMapping.fields.adjusterName]
    || fields[fieldMapping.fields.adjusterPhone]
    || fields[fieldMapping.fields.adjusterEmail]
  );
  const lead = confirmation.outcome === "existing_claim_confirmed"
    ? "Existing claim confirmed by phone."
    : "Claim filed by phone.";
  const tail = adjusterCaptured
    ? "Claim number and carrier adjuster details verified for JobNimbus writeback."
    : "Claim number verified for JobNimbus writeback; awaiting carrier adjuster assignment."
  return Object.freeze({
    ready: true,
    blockers: Object.freeze([]),
    fields: Object.freeze(fields),
    status,
    note: `${lead} ${tail}`,
    fieldSources: Object.freeze(fieldSources)
  });
}

export function assertHcnClaimWritebackFields(fields, fieldMapping) {
  assertPlainObject(fields, "writeback fields");
  if (!fieldMapping?.configured) {
    throw contractError(
      "writeback_mapping_unavailable",
      503,
      "The verified JobNimbus claim field mapping is unavailable."
    );
  }
  const allowed = new Set(Object.values(fieldMapping.fields));
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      throw contractError(
        "writeback_field_denied",
        400,
        `Claim filing cannot write JobNimbus field ${key}.`
      );
    }
  }
  return fields;
}

function verifiedFacts(file = {}) {
  return Object.freeze({
    homeowner: String(file.name || ""),
    property: String(file.address || ""),
    homeownerPhone: String(file.phone || ""),
    homeownerEmail: String(file.email || ""),
    carrier: String(file.carrier || ""),
    policyNumber: String(file.policyNumber || ""),
    dateOfLoss: String(file.dateOfLoss || ""),
    causeOfLoss: String(file.typeOfLoss || "")
  });
}

function confirmedFacts(confirmations = {}) {
  return Object.freeze({
    damageOpening: String(confirmations.damageOpening || ""),
    damageDetails: [...(confirmations.damageDetails || [])],
    injuries: String(confirmations.injuries || ""),
    homeLivable: String(confirmations.homeLivable || ""),
    temporaryRepairs: String(confirmations.temporaryRepairs || ""),
    contractorHired: String(confirmations.contractorHired || "")
  });
}

function publicFile(file = {}) {
  return Object.freeze({
    jobNumber: String(file.number || ""),
    displayName: String(file.name || ""),
    status: String(file.status || "")
  });
}

function normalizeDamageDetails(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[;\n]+/)
      : [];
  if (source.length > 12) {
    throw contractError(
      "invalid_confirmation",
      400,
      "damageDetails may contain at most 12 exact items."
    );
  }
  return Object.freeze(source
    .map((item) => boundedLine(item, 240))
    .filter((item) => presentText(item)));
}

function immutablePilotRegistry(subjects) {
  const values = Object.freeze([...subjects]);
  const lookup = new Set(values);
  return Object.freeze({
    size: values.length,
    values,
    has(subject) {
      return lookup.has(subject);
    }
  });
}

function assertTerminalCallReceipt(receipt, planDigest, fileRef, callPlanId) {
  assertPlainObject(receipt, "terminalReceipt");
  if (
    !PLAN_ID_PATTERN.test(String(callPlanId || ""))
    || receipt.planId !== callPlanId
    || receipt.fileRef !== fileRef
    || receipt.digest !== planDigest
    || receipt.operationCount !== 1
    || receipt.status !== "completed_pending_verification"
    || receipt.succeededCount !== 1
    || receipt.failedCount !== 0
    || receipt.blockedCount !== 0
    || receipt.unknownCount !== 0
    || typeof receipt.batchRef !== "string"
    || !/^batch_[a-f0-9]{32}$/.test(receipt.batchRef)
    || typeof receipt.terminalAt !== "string"
  ) {
    throw contractError(
      "terminal_receipt_mismatch",
      409,
      "A terminal receipt for this exact approved claim call is required."
    );
  }
}

function assertTrustedCallEvidence(evidence) {
  if (!evidence || !TRUSTED_CALL_EVIDENCE.has(evidence)) {
    throw contractError(
      "untrusted_call_evidence",
      400,
      "Claim result provenance must be built by the server from the exact provider call and terminal receipt."
    );
  }
}

function normalizeWritebackConfirmation(value = {}) {
  assertPlainObject(value, "humanConfirmation");
  const allowed = new Set([
    "evidenceDigest",
    "reviewBasis",
    "outcome",
    "claimNumber",
    "adjusterName",
    "adjusterPhone",
    "adjusterEmail"
  ]);
  assertExactKeys(value, allowed, "humanConfirmation");
  const evidenceDigest = String(value.evidenceDigest || "");
  assertDigest(evidenceDigest, "evidenceDigest");
  return Object.freeze({
    evidenceDigest,
    reviewBasis: boundedLine(value.reviewBasis, 80),
    outcome: boundedLine(value.outcome, 80),
    claimNumber: boundedLine(value.claimNumber, 120),
    adjusterName: boundedLine(value.adjusterName, 160),
    adjusterPhone: boundedLine(value.adjusterPhone, 40),
    adjusterEmail: boundedLine(value.adjusterEmail, 254)
  });
}

function boundedLine(value, maximumCharacters) {
  if (
    value !== undefined
    && value !== null
    && typeof value !== "string"
    && typeof value !== "number"
  ) {
    throw contractError(
      "invalid_confirmation",
      400,
      "Claim confirmations must be text values."
    );
  }
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if ([...text].length > maximumCharacters) {
    throw contractError(
      "invalid_confirmation",
      400,
      `A claim confirmation exceeds ${maximumCharacters} characters.`
    );
  }
  return text;
}

function boundedPhone(value) {
  const text = boundedLine(value, 40);
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    throw contractError(
      "invalid_confirmation",
      400,
      "carrierPhone must be a valid bounded phone number."
    );
  }
  return text;
}

function enumValue(value, allowed) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return Object.hasOwn(allowed, normalized) ? normalized : "";
}

function presentText(value) {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const text = String(value).trim();
  return Boolean(
    text
    && !/^(?:missing|unknown|n\/?a|not\s+(?:known|sure)|tbd|none provided|\?)(?:\b|\s*\/|$)/i.test(text)
    && text !== "[object Object]"
  );
}

function presentScalar(value) {
  return presentText(value) && /^[A-Za-z0-9][A-Za-z0-9 ._\/-]{2,119}$/.test(String(value).trim());
}

function validPhone(value) {
  if (!presentText(value)) return false;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function validZip(value) {
  return typeof value === "string"
    && /^\d{5}(?:-\d{4})?$/.test(value.trim());
}

function validDate(value) {
  if (!presentText(value)) return false;
  const text = String(value).trim();
  if (/^\d{10}$/.test(text)) {
    return validNonFutureDate(new Date(Number(text) * 1000));
  }
  if (/^\d{13}$/.test(text)) {
    return validNonFutureDate(new Date(Number(text)));
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$|^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return false;
  const year = Number(match[1] || match[6]);
  const month = Number(match[2] || match[4]);
  const day = Number(match[3] || match[5]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && validNonFutureDate(date);
}

function validNonFutureDate(date) {
  if (!Number.isFinite(date.getTime())) return false;
  const today = new Date();
  const endOfTodayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
    23,
    59,
    59,
    999
  );
  return date.getTime() <= endOfTodayUtc;
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function boundedEvidenceText(value, maximumCharacters) {
  return [...String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")]
    .slice(0, maximumCharacters)
    .join("")
    .trim();
}

function normalizeWritebackValue(key, value) {
  if (key === "claimNumber") {
    const normalized = value
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 120);
    return /[A-Za-z0-9]/.test(normalized) ? normalized : "";
  }
  if (key === "adjusterName") {
    return presentText(value) ? value.slice(0, 160) : "";
  }
  if (key === "adjusterPhone") {
    return value ? (validPhone(value) ? value : "") : "";
  }
  if (key === "adjusterEmail") {
    return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      ? value.toLowerCase()
      : "";
  }
  return "";
}

function normalizeStatus(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function assertFileRef(value) {
  if (typeof value !== "string" || !FILE_REF_PATTERN.test(value)) {
    throw contractError("invalid_file_ref", 400, "fileRef is invalid.");
  }
}

function assertConversationRef(value) {
  if (
    typeof value !== "string"
    || !CONVERSATION_REF_PATTERN.test(value)
  ) {
    throw contractError(
      "invalid_conversation_ref",
      400,
      "conversationRef is invalid."
    );
  }
}

function assertPrincipalRef(value) {
  if (typeof value !== "string" || !/^principal_[a-f0-9]{64}$/.test(value)) {
    throw contractError(
      "invalid_principal_ref",
      400,
      "The signed-in employee binding is invalid."
    );
  }
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw contractError("invalid_digest", 400, `${label} is invalid.`);
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw contractError(
        "invalid_request",
        400,
        `${label} contains unsupported field ${key}.`
      );
    }
  }
}

function assertPlainObject(value, label) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw contractError(
      "invalid_request",
      400,
      `${label} must be an object.`
    );
  }
}

function contractError(code, statusCode, message) {
  return new HcnClaimFilingContractError(code, statusCode, message);
}
