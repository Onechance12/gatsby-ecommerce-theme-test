import { createHash } from "node:crypto";

import {
  assessReadiness,
  buildClaimCallPacket,
  buildWritebackProposal,
  existingClaimBlock,
  extractCallResults,
  flattenFactsForDynamicVariables,
  lookupCarrier,
  PROMPT_PLACEHOLDERS
} from "./claim-filing-core/index.js";

export const CLAIM_PLAN_VERSION = "2026-08-24.1";
export const CLAIM_BRIDGE_SOURCE = "hcn-wave-jobnimbus-bridge";

export function buildClaimFilingPlan(input, options = {}) {
  const verifiedInput = applyVerifiedFileOverrides(input, {
    ...(input.overrides || {}),
    ...(options.overrides || {})
  });
  const packetOptions = cleanObject({
    ...(input.overrides || {}),
    ...(options.overrides || {}),
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
    createdAt: Number(call.start_timestamp || 0),
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
  if (rows.length === 1) return { selected: rows[0], match: "single_pending_case_requires_carrier_confirmation" };
  return { selected: null, match: rows.length ? "needs_identity_confirmation" : "no_pending_case" };
}

export function confirmedCallbackRequest(call) {
  const transcript = String(call?.transcript || "");
  return /(?:(?:request for (?:a )?callback|callback request) (?:has been|is|was) (?:confirmed|accepted|scheduled|received)|callback (?:is|was|has been) (?:confirmed|accepted|scheduled)|you(?:'ll| will) receive (?:a|the) callback|we(?:'ll| will) call you back|(?:your|the) (?:place|position) in (?:the )?line (?:has been|is) (?:saved|reserved))/i.test(transcript);
}

export function callbackPacketStatus(variables) {
  const goal = String(variables.goal || "file_new_claim");
  const goalRequired = goal === "file_new_claim"
    ? ["insuredName", "propertyAddress", "carrier", "policyNumberSpoken", "dateOfLoss", "causeOfLoss", "damageOpening", "damageDetails"]
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

export function analyzeClaimCall(call, file) {
  const extracted = extractCallResults(call);
  const proposal = buildWritebackProposal(file, extracted);
  const writeback = proposalToProcessUpdate(proposal);
  const completedClaim = ["claim_filed", "existing_claim_confirmed"].includes(extracted.outcome);
  const completionGaps = [];
  if (completedClaim && !extracted.documentSubmissionRequested) {
    completionGaps.push("The agent did not ask where to send the Letter of Representation and supporting documents.");
  } else if (completedClaim && !extracted.documentSubmission) {
    completionGaps.push("The agent asked about document submission, but no destination or carrier instruction was captured.");
  }
  const completionReview = {
    claimNumberCaptured: Boolean(extracted.claimNumber),
    adjusterContactCaptured: Boolean(extracted.adjusterName || extracted.adjusterPhone || extracted.adjusterEmail),
    documentSubmissionRequested: extracted.documentSubmissionRequested,
    documentSubmissionCaptured: Boolean(extracted.documentSubmission),
    nextStepCaptured: Boolean(extracted.nextStep),
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
    unverified: proposal.unverified
  });
  return { extracted, completionReview, proposal, writeback, writebackDigest };
}

export function buildPostClaimWorkflow(analysis = {}) {
  const extracted = analysis.extracted || {};
  const completedClaim = ["claim_filed", "existing_claim_confirmed"].includes(extracted.outcome);
  if (!completedClaim || !extracted.claimNumber) {
    return {
      applicable: false,
      primaryAction: "Resolve the incomplete carrier-call outcome before starting representation delivery.",
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
