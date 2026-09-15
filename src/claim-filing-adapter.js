import { createHash } from "node:crypto";

import {
  assessReadiness,
  buildClaimCallPacket,
  buildWritebackProposal,
  existingClaimBlock,
  extractCallResults,
  flattenFactsForDynamicVariables,
  isConfirmedCarrierCallback,
  lookupCarrier,
  PROMPT_PLACEHOLDERS
} from "./claim-filing-core/index.js";

export const CLAIM_PLAN_VERSION = "2026-09-15.1";
export const CLAIM_BRIDGE_SOURCE = "hcn-wave-jobnimbus-bridge";

export const CLAIM_FILING_COVERAGE_TERM_STATUSES = Object.freeze([
  "verified_in_force",
  "carrier_lookup_required",
  "blocked_conflict"
]);

export const CLAIM_FILING_OVERRIDE_STRING_KEYS = Object.freeze([
  "goal",
  "carrierPhone",
  "insuredName",
  "customer",
  "propertyAddress",
  "address",
  "carrier",
  "policyNumber",
  "claimNumber",
  "dateOfLoss",
  "causeOfLoss",
  "typeOfLoss",
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

export function normalizeClaimFilingOverrides(value = {}) {
  if (value === undefined || value === null) return {};
  if (
    typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw validationError("overrides must be an exact object when supplied.");
  }
  const unknown = Object.keys(value).filter((key) => !CLAIM_FILING_OVERRIDE_KEYS.has(key));
  if (unknown.length) {
    throw validationError(`Unsupported claim-filing override keys: ${unknown.sort().join(", ")}.`);
  }
  const normalized = {};
  for (const key of CLAIM_FILING_OVERRIDE_STRING_KEYS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") {
      throw validationError(`${key} must be a string when supplied.`);
    }
    normalized[key] = value[key];
  }
  if (value.coverageTermStatus !== undefined) {
    if (!CLAIM_FILING_COVERAGE_TERM_STATUSES.includes(value.coverageTermStatus)) {
      throw validationError(
        `coverageTermStatus must be one of: ${CLAIM_FILING_COVERAGE_TERM_STATUSES.join(", ")}.`
      );
    }
    normalized.coverageTermStatus = value.coverageTermStatus;
  }
  if (value.damageDetails !== undefined) {
    if (typeof value.damageDetails === "string") {
      if (!value.damageDetails.trim()) throw validationError("damageDetails cannot be empty when supplied.");
      normalized.damageDetails = value.damageDetails;
    } else if (
      Array.isArray(value.damageDetails)
      && value.damageDetails.length > 0
      && value.damageDetails.every((item) => typeof item === "string" && item.trim())
    ) {
      normalized.damageDetails = [...value.damageDetails];
    } else {
      throw validationError("damageDetails must be a non-empty string or array of non-empty strings.");
    }
  }
  return normalized;
}

export function buildClaimFilingPlan(input, options = {}) {
  const approvedOverrides = {
    ...normalizeClaimFilingOverrides(input.overrides),
    ...normalizeClaimFilingOverrides(options.overrides)
  };
  const verifiedInput = applyVerifiedFileOverrides(input, approvedOverrides);
  const explicitOptions = cleanObject({
    goal: options.goal,
    carrierPhone: options.carrierPhone,
    stormTime: options.stormTime,
    occupancy: options.occupancy,
    damageDiscovered: options.damageDiscovered,
    propertyStories: options.propertyStories,
    roofAccessibility: options.roofAccessibility,
    damagedRooms: options.damagedRooms,
    damagedRoomCount: options.damagedRoomCount,
    contractorPhone: options.contractorPhone,
    injuries: options.injuries,
    homeLivable: options.homeLivable,
    temporaryRepairs: options.temporaryRepairs,
    contractorHired: options.contractorHired
  });
  const packetOptions = {
    ...approvedOverrides,
    ...explicitOptions
  };
  const packet = buildClaimCallPacket(verifiedInput, packetOptions);
  const carrier = lookupCarrier(packet.verifiedFileFacts.carrier, packet.verifiedFileFacts.policyNumber);
  const to = normalizePhone(options.to || packetOptions.carrierPhone || carrier?.filingPhone || "");
  const from = normalizePhone(options.from || "");
  const readiness = assessReadiness(packet, to, carrier);
  const duplicateBlock = existingClaimBlock(verifiedInput.file?.claimNumber, packet.goal);
  const blockers = [...readiness.blockers, ...(duplicateBlock ? [duplicateBlock] : [])];
  const dynamicVariables = flattenFactsForDynamicVariables(packet);
  const ownerId = String(options.ownerId || "").trim();
  const contactId = String(input.file?.id || "").trim();
  const agentId = String(options.agentId || "").trim();

  const digestMaterial = {
    version: CLAIM_PLAN_VERSION,
    ownerId,
    contactId,
    goal: packet.goal,
    to,
    from,
    agentId,
    verifiedFileFacts: packet.verifiedFileFacts,
    damageSummary: packet.damageSummary,
    dynamicVariables
  };
  const planDigest = digest(digestMaterial);

  return {
    version: CLAIM_PLAN_VERSION,
    planDigest,
    file: {
      id: contactId,
      number: String(options.fileNumber || ""),
      customer: input.file?.customer || "",
      currentStatus: input.file?.status || ""
    },
    packet,
    carrier: carrier ? {
      display: carrier.display,
      filingPhone: carrier.filingPhone,
      requiresPolicyNumber: Boolean(carrier.requiresPolicyNumber),
      ivrType: carrier.ivrType || ""
    } : null,
    readiness: {
      ready: blockers.length === 0,
      blockers,
      warnings: readiness.warnings
    },
    callPlan: {
      to,
      from,
      agentId,
      dynamicVariables,
      metadata: {
        source: CLAIM_BRIDGE_SOURCE,
        version: CLAIM_PLAN_VERSION,
        ownerId,
        contactId,
        fileNumber: String(options.fileNumber || ""),
        goal: packet.goal,
        planDigest
      }
    }
  };
}

function applyVerifiedFileOverrides(input, overrides) {
  const file = { ...(input.file || {}) };
  const mappings = {
    insuredName: "customer",
    customer: "customer",
    propertyAddress: "address",
    address: "address",
    carrier: "carrier",
    policyNumber: "policyNumber",
    claimNumber: "claimNumber",
    dateOfLoss: "dateOfLoss",
    causeOfLoss: "typeOfLoss",
    typeOfLoss: "typeOfLoss",
    mortgageCompany: "mortgageCompany"
  };

  for (const [overrideKey, fileKey] of Object.entries(mappings)) {
    const value = overrides?.[overrideKey];
    if (value !== undefined && value !== null && String(value).trim()) file[fileKey] = value;
  }

  return { ...input, file };
}

export function assertApprovalDigest(expected, actual, label = "planDigest") {
  const supplied = String(expected || "").trim();
  if (!supplied) throw validationError(`${label} is required. Prepare the action first, review it, then approve that exact digest.`);
  if (supplied !== actual) {
    throw conflictError(`${label} no longer matches the fresh file state. Prepare and review the action again before executing.`);
  }
}

export function retellCallBody(plan) {
  return cleanObject({
    from_number: plan.callPlan.from,
    to_number: plan.callPlan.to,
    override_agent_id: plan.callPlan.agentId,
    override_agent_version: plan.callPlan.agentVersion,
    metadata: plan.callPlan.metadata,
    retell_llm_dynamic_variables: plan.callPlan.dynamicVariables
  });
}

export function callbackDynamicVariablesDigest(variables) {
  return digest(stringifyDynamicVariables(variables));
}

export function callbackCandidateFromCall(call) {
  const metadata = call?.metadata || {};
  const variables = call?.retell_llm_dynamic_variables || {};
  if (metadata.source !== CLAIM_BRIDGE_SOURCE || !metadata.contactId) return null;
  const filingOutcome = String(call?.call_analysis?.custom_analysis_data?.filing_outcome || "");
  if (filingOutcome === "claim_filed" || filingOutcome === "existing_claim_confirmed") return null;
  return {
    callId: String(call.call_id || ""),
    callStatus: String(call.call_status || ""),
    agentId: String(call.agent_id || ""),
    reportedAgentVersion: Number.isInteger(Number(call.agent_version))
      ? Number(call.agent_version)
      : null,
    agentVersion: Number.isInteger(Number(metadata.agentVersion))
      ? Number(metadata.agentVersion)
      : null,
    agentConfigDigest: String(metadata.agentConfigDigest || ""),
    callbackPacketDigest: String(metadata.callbackPacketDigest || ""),
    contactId: String(metadata.contactId),
    fileNumber: String(metadata.fileNumber || ""),
    goal: String(metadata.goal || variables.goal || "file_new_claim"),
    carrier: String(variables.carrier || ""),
    insuredName: String(variables.insuredName || ""),
    propertyAddress: String(variables.propertyAddress || ""),
    policyNumber: String(variables.policyNumber || ""),
    policyNumberSpoken: String(variables.policyNumberSpoken || ""),
    claimNumber: String(variables.claimNumber || ""),
    filingOutcome,
    callbackRequested: confirmedCallbackRequest(call),
    carrierPhone: normalizePhoneOrBlank(call.to_number),
    createdAt: callbackWindowStartedAt(call),
    ownerId: String(metadata.ownerId || ""),
    planDigest: String(metadata.planDigest || ""),
    sourcePlanDigest: String(metadata.sourcePlanDigest || ""),
    version: String(metadata.version || ""),
    batchContactIds: String(metadata.batchContactIds || ""),
    retryOfCallId: String(metadata.retryOfCallId || ""),
    operatorLane: String(metadata.operatorLane || ""),
    operatorPrincipalHash: String(metadata.operatorPrincipalHash || ""),
    dynamicVariables: stringifyDynamicVariables(variables)
  };
}

export function callbackCandidateRemainsPending(candidate, cutoffMs) {
  const createdAt = Number(candidate?.createdAt);
  const cutoff = Number(cutoffMs);
  if (!Number.isFinite(cutoff) || cutoff < 0) return true;
  // A confirmed callback with no trustworthy window start is malformed, not
  // expired. Keep it pending until a human reconciles the carrier call.
  if (!Number.isFinite(createdAt) || createdAt <= 0) return true;
  return createdAt >= cutoff;
}

function callbackWindowStartedAt(call) {
  const explicitEnd = Number(call?.end_timestamp || 0);
  if (Number.isFinite(explicitEnd) && explicitEnd > 0) return explicitEnd;
  const start = Number(call?.start_timestamp || 0);
  const duration = Number(call?.duration_ms || 0);
  if (Number.isFinite(start) && start > 0 && Number.isFinite(duration) && duration > 0) {
    return start + duration;
  }
  return start;
}

export function buildCallbackDynamicVariables(candidate, match = "matched") {
  const out = stringifyDynamicVariables(candidate?.dynamicVariables || {});
  out.directionMode = "carrier_callback";
  out.callbackMatch = String(match || "matched");
  out.callbackCarrier = String(candidate?.carrier || out.carrier || "Unknown");
  out.callbackInsuredName = String(candidate?.insuredName || out.insuredName || "Unknown");
  out.callbackPropertyAddress = String(candidate?.propertyAddress || out.propertyAddress || "Unknown");
  out.callbackPolicyNumber = String(candidate?.policyNumberSpoken || out.policyNumberSpoken || "Unknown");
  out.callbackClaimNumber = String(candidate?.claimNumber || out.claimNumber || "Missing / not filed");
  out.pendingCallbackCases = "";
  out.callbackPacketStatus = callbackPacketStatus(out);

  for (const key of PROMPT_PLACEHOLDERS) {
    if (!out[key]) out[key] = "Missing";
  }
  return out;
}

export function buildCallbackMetadata(candidate, match = "matched") {
  return {
    source: candidate ? CLAIM_BRIDGE_SOURCE : "hcn-wave-retell-callback-unmatched",
    version: String(candidate?.version || ""),
    ownerId: String(candidate?.ownerId || ""),
    contactId: String(candidate?.contactId || ""),
    fileNumber: String(candidate?.fileNumber || ""),
    goal: String(candidate?.goal || "file_new_claim"),
    planDigest: String(candidate?.planDigest || ""),
    sourcePlanDigest: String(candidate?.sourcePlanDigest || ""),
    agentVersion: Number.isInteger(Number(candidate?.agentVersion))
      ? Number(candidate.agentVersion)
      : undefined,
    agentConfigDigest: String(candidate?.agentConfigDigest || ""),
    callbackPacketDigest: String(candidate?.callbackPacketDigest || ""),
    batchContactIds: String(candidate?.batchContactIds || ""),
    retryOfCallId: String(candidate?.retryOfCallId || ""),
    operatorLane: String(candidate?.operatorLane || ""),
    operatorPrincipalHash: String(candidate?.operatorPrincipalHash || ""),
    callLeg: "carrier_callback",
    originalCallId: String(candidate?.callId || ""),
    callbackMatch: String(match || "matched")
  };
}

export function selectCallbackCandidate(candidates, fromNumber) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const exact = rows.filter((candidate) => samePhone(candidate.carrierPhone, fromNumber));
  if (exact.length === 1) return { selected: exact[0], match: "matched" };
  return {
    selected: null,
    match: rows.length
      ? "different_number_requires_manual_recovery"
      : "no_pending_case"
  };
}

export function confirmedCallbackRequest(call) {
  return isConfirmedCarrierCallback(call);
}

export function callbackPacketStatus(variables) {
  const goal = String(variables.goal || "file_new_claim");
  const goalRequired = goal === "file_new_claim"
    ? [
        "insuredName",
        "propertyAddress",
        "carrier",
        "dateOfLoss",
        "causeOfLoss",
        "damageOpening",
        "damageDetails",
        "coverageTermStatus"
      ]
    : goal === "find_existing_claim"
      ? ["insuredName", "propertyAddress", "carrier", "policyNumberSpoken", "dateOfLoss"]
      : [];
  if (!goalRequired.length) return "INCOMPLETE: unsupported goal";
  const required = goal === "file_new_claim"
    ? [
        ...goalRequired,
        "injuries",
        "homeLivable",
        "temporaryRepairs",
        "contractorHired",
        "batchClaimCount",
        "batchClaims"
      ]
    : goalRequired;
  const missing = required.filter((key) => !variables[key] || /^missing/i.test(String(variables[key])));
  if (missing.length) return `INCOMPLETE: ${missing.join(", ")}`;

  // Existing-claim lookups are exactly hash-bound to the complete approved
  // packet by the server, but do not require new-claim damage/batch answers.
  if (goal === "find_existing_claim") return "READY";

  const coverageTermStatus = String(variables.coverageTermStatus || "");
  if (!CLAIM_FILING_COVERAGE_TERM_STATUSES.includes(coverageTermStatus)) {
    return "INCOMPLETE: invalid coverageTermStatus";
  }
  if (coverageTermStatus === "blocked_conflict") {
    return "INCOMPLETE: blocked coverage-term conflict";
  }
  if (
    coverageTermStatus === "carrier_lookup_required"
    && (!variables.priorPolicyLookupInstruction || /^missing/i.test(String(variables.priorPolicyLookupInstruction)))
  ) {
    return "INCOMPLETE: priorPolicyLookupInstruction";
  }
  if (
    coverageTermStatus !== "carrier_lookup_required"
    && (!variables.policyNumberSpoken || /^missing/i.test(String(variables.policyNumberSpoken)))
  ) {
    return "INCOMPLETE: policyNumberSpoken";
  }
  if (
    coverageTermStatus === "verified_in_force"
    && ["policyCoverageStart", "policyCoverageEnd"].some((key) => (
      !variables[key] || /^missing/i.test(String(variables[key]))
    ))
  ) {
    return "INCOMPLETE: verified coverage dates";
  }
  if (coverageTermStatus === "verified_in_force") {
    const coverageStart = claimDateKey(variables.policyCoverageStart);
    const coverageEnd = claimDateKey(variables.policyCoverageEnd);
    const dateOfLoss = claimDateKey(variables.dateOfLoss);
    if (!coverageStart || !coverageEnd || !dateOfLoss) {
      return "INCOMPLETE: invalid verified coverage dates";
    }
    if (coverageStart > coverageEnd || dateOfLoss < coverageStart || dateOfLoss > coverageEnd) {
      return "INCOMPLETE: date of loss outside verified coverage term";
    }
  }

  const batchCountText = String(variables.batchClaimCount || "").trim();
  if (!/^\d+$/.test(batchCountText)) return "INCOMPLETE: invalid batchClaimCount";
  const batchCount = Number(batchCountText);
  if (!Number.isSafeInteger(batchCount) || batchCount < 0 || batchCount > 6) {
    return "INCOMPLETE: invalid batchClaimCount";
  }
  if (batchCount === 0) {
    return String(variables.batchClaims || "").trim() === "None"
      ? "READY"
      : "INCOMPLETE: batchClaims must be None when batchClaimCount is zero";
  }
  let batchClaims;
  try {
    batchClaims = JSON.parse(String(variables.batchClaims || ""));
  } catch {
    return "INCOMPLETE: invalid batchClaims JSON";
  }
  if (!Array.isArray(batchClaims) || batchClaims.length !== batchCount) {
    return "INCOMPLETE: batchClaims count mismatch";
  }
  const batchRequired = [
    "fileNumber",
    "contactId",
    "insuredName",
    "propertyAddress",
    "policyNumber",
    "dateOfLoss",
    "causeOfLoss",
    "injuries",
    "homeLivable",
    "temporaryRepairs",
    "contractorHired"
  ];
  const incompleteBatch = batchClaims.findIndex((claim) => (
    !claim
    || typeof claim !== "object"
    || batchRequired.some((key) => !claim[key] || /^missing/i.test(String(claim[key])))
  ));
  return incompleteBatch === -1
    ? "READY"
    : `INCOMPLETE: batchClaims[${incompleteBatch}]`;
}

function stringifyDynamicVariables(variables) {
  return Object.fromEntries(Object.entries(variables || {}).map(([key, value]) => [key, String(value ?? "")]));
}

function normalizePhoneOrBlank(value) {
  try { return normalizePhone(value); } catch { return ""; }
}

function samePhone(a, b) {
  const left = String(a || "").replace(/\D/g, "").slice(-10);
  const right = String(b || "").replace(/\D/g, "").slice(-10);
  return Boolean(left && right && left === right);
}

function claimDateKey(value) {
  const match = String(value || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";
  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return "";
  return `${year}-${month}-${day}`;
}

export function analyzeClaimCall(call, file, options = {}) {
  const extracted = extractCallResults(call);
  const proposal = buildWritebackProposal(file, extracted);
  const writeback = proposalToProcessUpdate(proposal);
  const completedClaim = ["claim_filed", "existing_claim_confirmed"].includes(extracted.outcome);
  const completionGaps = [];
  const guardedCompletionVerified = options.requireGuardedCompletion === true
    ? validGuardedCompletionReceipt(call, extracted, options.guardedCompletion)
    : null;
  if (!completedClaim) {
    completionGaps.push("The call did not produce a verified completed claim outcome.");
  }
  if (completedClaim && !extracted.claimNumber) {
    completionGaps.push("The call outcome says the claim was completed, but no claim or reference number was captured.");
  }
  if (completedClaim && extracted.coverageTermStatus === "carrier_lookup_required") {
    if (extracted.activeCoverageConfirmed !== true) {
      completionGaps.push("The call did not verify that an active policy term covered the date of loss before filing.");
    }
    if (!extracted.activePolicyNumber) {
      completionGaps.push("The call did not capture the active policy number used for the date of loss.");
    }
  }
  if (completedClaim && !extracted.documentSubmissionRequested) {
    completionGaps.push("The agent did not ask where to send the Letter of Representation and supporting documents.");
  } else if (completedClaim && !extracted.documentSubmission) {
    completionGaps.push("The agent asked about document submission, but no destination or carrier instruction was captured.");
  }
  if (options.requireGuardedCompletion === true && guardedCompletionVerified !== true) {
    completionGaps.push("No matching guarded-completion receipt proves this call was safe to close.");
  }
  const completionReview = {
    claimNumberCaptured: Boolean(extracted.claimNumber),
    adjusterContactCaptured: Boolean(extracted.adjusterName || extracted.adjusterPhone || extracted.adjusterEmail),
    documentSubmissionRequested: extracted.documentSubmissionRequested,
    documentSubmissionCaptured: Boolean(extracted.documentSubmission),
    nextStepCaptured: Boolean(extracted.nextStep),
    guardedCompletionVerified,
    complete: completionGaps.length === 0,
    gaps: completionGaps
  };
  const writebackDigest = digest({
    version: CLAIM_PLAN_VERSION,
    contactId: file.id,
    callId: call.callId || call.raw?.call_id || "",
    fields: writeback.fields,
    status: writeback.status,
    note: writeback.note,
    unverified: proposal.unverified,
    completionReview,
    guardedCompletionDigest: options.guardedCompletion ? digest(options.guardedCompletion) : ""
  });
  return { extracted, completionReview, proposal, writeback, writebackDigest };
}

export function buildPostClaimWorkflow(analysis = {}) {
  const extracted = analysis.extracted || {};
  const completedClaim = ["claim_filed", "existing_claim_confirmed"].includes(extracted.outcome);
  if (analysis.completionReview && analysis.completionReview.complete !== true) {
    return {
      applicable: false,
      primaryAction: "Resolve the guarded call-completion gaps before starting representation delivery.",
      steps: []
    };
  }
  const lookupCoverageComplete = extracted.coverageTermStatus !== "carrier_lookup_required"
    || (extracted.activeCoverageConfirmed === true && Boolean(extracted.activePolicyNumber));
  if (!completedClaim || !extracted.claimNumber || !lookupCoverageComplete) {
    return {
      applicable: false,
      primaryAction: lookupCoverageComplete
        ? "Resolve the incomplete carrier-call outcome before starting representation delivery."
        : "Confirm and capture the active policy covering the date of loss before starting representation delivery.",
      steps: []
    };
  }

  const destinationCaptured = Boolean(extracted.documentSubmission);
  const steps = [
    {
      id: "jobnimbus_claim_writeback",
      status: "approval_required",
      action: "Update the claim number, adjuster details, carrier result, and correct workflow status in JobNimbus using the reviewed call writeback."
    },
    {
      id: "representation_destination",
      status: destinationCaptured ? "complete" : "blocked",
      action: destinationCaptured
        ? `Use the verified carrier instruction: ${extracted.documentSubmission}`
        : "Obtain the carrier or adjuster's verified email, portal, fax, or explicit instruction for sending representation documents."
    },
    {
      id: "lor_package",
      status: destinationCaptured ? "approval_required" : "blocked",
      action: "Prepare the file-specific LOR package and carrier email for approval.",
      requiredDocuments: ["Letter of Representation", "TDI/FIN535", "W-9"],
      emailSubjectRule: "Claim number only",
      emailTemplate: "payment_redirection",
      emailBodyRule: "Use Richard's standard payment-redirection wording: request payment to the office with Wave Public Adjusting LLC included as a payee. Do not substitute generic correspondence-only language."
    },
    {
      id: "representation_send",
      status: "blocked",
      action: "After approval, send the exact LOR package and record the Gmail message/thread ID."
    },
    {
      id: "two_key_confirmations",
      status: "blocked",
      action: "Confirm carrier claim/desk-adjuster handling and confirm representation/payment-direction processing before treating the filing phase as complete."
    },
    {
      id: "jobnimbus_lor_closeout",
      status: "blocked",
      action: "After verified delivery, update JobNimbus with the concise LOR-package send result and next carrier follow-up."
    }
  ];

  return {
    applicable: true,
    phase: "post_claim_filing_representation",
    claimNumber: extracted.claimNumber,
    documentSubmission: extracted.documentSubmission || "",
    primaryAction: destinationCaptured
      ? "Prepare the verified LOR, TDI/FIN535, and W-9 carrier package for Chance's approval, then send it using the claim number as the subject."
      : "Obtain a verified representation-document destination, then prepare the LOR package for approval.",
    steps
  };
}

function validGuardedCompletionReceipt(call, extracted, receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  if (
    receipt.writebackEligible !== true
    || String(receipt.decisionCode || "") !== "objective_complete"
    || !["claim_filed", "existing_claim_confirmed"].includes(String(receipt.outcome || ""))
  ) return false;
  const raw = call?.raw && typeof call.raw === "object" ? call.raw : call;
  const callId = String(call?.callId || raw?.call_id || "");
  const transcriptDigest = digest({
    transcript: String(raw?.transcript || call?.transcript || ""),
    transcriptObject: Array.isArray(raw?.transcript_object) ? raw.transcript_object : []
  });
  const same = (left, right) => normalizeReceiptIdentifier(left) === normalizeReceiptIdentifier(right);
  if (
    String(receipt.callId || "") !== callId
    || String(receipt.goal || "") !== String(extracted.goal || "")
    || String(receipt.outcome || "") !== String(extracted.outcome || "")
    || !same(receipt.claimNumber, extracted.claimNumber)
    || String(receipt.transcriptDigest || "") !== transcriptDigest
  ) return false;
  if (extracted.coverageTermStatus === "carrier_lookup_required") {
    return receipt.activeCoverageConfirmed === true
      && extracted.activeCoverageConfirmed === true
      && same(receipt.activePolicyNumber, extracted.activePolicyNumber);
  }
  return true;
}

function normalizeReceiptIdentifier(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function proposalToProcessUpdate(proposal) {
  const fields = { ...(proposal.proposedFields || {}) };
  const status = String(fields.status_name || "").trim();
  delete fields.status_name;
  return {
    fields,
    status,
    note: String(proposal.proposedNote || "").trim()
  };
}

export function validateRetellCallOwnership(call, ownerId) {
  const metadata = call?.raw?.metadata || call?.metadata || {};
  if (metadata.source !== CLAIM_BRIDGE_SOURCE) throw validationError("This Retell call was not created by the JobNimbus claim-filing bridge.");
  if (String(metadata.ownerId || "") !== String(ownerId || "")) throw validationError("This Retell call is not scoped to Chance Pearson.");
  if (!metadata.contactId || !metadata.planDigest) throw validationError("This Retell call is missing its JobNimbus approval metadata.");
  return metadata;
}

export function validateRetellCallChainOwnership(requestedCall, continuationCall, ownerId) {
  const requestedMetadata = validateRetellCallOwnership(requestedCall, ownerId);
  if (!continuationCall) return requestedMetadata;

  const requestedRaw = requestedCall?.raw || requestedCall || {};
  const continuationRaw = continuationCall?.raw || continuationCall || {};
  const continuationMetadata = continuationRaw.metadata || {};
  const linked = String(continuationMetadata.originalCallId || "") === String(requestedRaw.call_id || requestedCall?.callId || "");
  const sameContact = String(continuationMetadata.contactId || "") === String(requestedMetadata.contactId || "");
  const sameOwner = String(continuationMetadata.ownerId || "") === String(ownerId || "");

  if (continuationMetadata.source === CLAIM_BRIDGE_SOURCE) {
    const verified = validateRetellCallOwnership({ raw: continuationRaw }, ownerId);
    if (!linked || !sameContact || String(verified.planDigest || "") !== String(requestedMetadata.planDigest || "")) {
      throw validationError("The carrier callback is not linked to the approved outbound claim call.");
    }
    return verified;
  }

  if (continuationMetadata.source === "hcn-wave-retell-callback" && linked && sameContact && sameOwner) {
    return requestedMetadata;
  }
  throw validationError("The carrier callback is not linked to the approved outbound claim call.");
}

export function digest(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  throw validationError(`Invalid phone number: ${raw}`);
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}
