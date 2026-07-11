import { createHash } from "node:crypto";

import {
  assessReadiness,
  buildClaimCallPacket,
  buildWritebackProposal,
  existingClaimBlock,
  extractCallResults,
  flattenFactsForDynamicVariables,
  lookupCarrier
} from "./claim-filing-core/index.js";

export const CLAIM_PLAN_VERSION = "2026-07-10.1";
export const CLAIM_BRIDGE_SOURCE = "hcn-wave-jobnimbus-bridge";

export function buildClaimFilingPlan(input, options = {}) {
  const packetOptions = cleanObject({
    ...(input.overrides || {}),
    ...(options.overrides || {}),
    goal: options.goal,
    carrierPhone: options.carrierPhone,
    stormTime: options.stormTime,
    occupancy: options.occupancy,
    damageDiscovered: options.damageDiscovered,
    injuries: options.injuries,
    homeLivable: options.homeLivable,
    temporaryRepairs: options.temporaryRepairs,
    contractorHired: options.contractorHired
  });
  const packet = buildClaimCallPacket(input, packetOptions);
  const carrier = lookupCarrier(packet.verifiedFileFacts.carrier, packet.verifiedFileFacts.policyNumber);
  const to = normalizePhone(options.to || packetOptions.carrierPhone || carrier?.filingPhone || "");
  const from = normalizePhone(options.from || "");
  const readiness = assessReadiness(packet, to, carrier);
  const duplicateBlock = existingClaimBlock(input.file?.claimNumber, packet.goal);
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
    metadata: plan.callPlan.metadata,
    retell_llm_dynamic_variables: plan.callPlan.dynamicVariables
  });
}

export function callbackCandidateFromCall(call) {
  const metadata = call?.metadata || {};
  const variables = call?.retell_llm_dynamic_variables || {};
  if (metadata.source !== CLAIM_BRIDGE_SOURCE || !metadata.contactId) return null;
  const filingOutcome = String(call?.call_analysis?.custom_analysis_data?.filing_outcome || "");
  if (filingOutcome === "claim_filed" || filingOutcome === "existing_claim_confirmed") return null;
  return {
    callId: String(call.call_id || ""),
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
    carrierPhone: normalizePhoneOrBlank(call.to_number),
    createdAt: Number(call.start_timestamp || 0)
  };
}

function normalizePhoneOrBlank(value) {
  try { return normalizePhone(value); } catch { return ""; }
}

export function analyzeClaimCall(call, file) {
  const extracted = extractCallResults(call);
  const proposal = buildWritebackProposal(file, extracted);
  const writeback = proposalToProcessUpdate(proposal);
  const writebackDigest = digest({
    version: CLAIM_PLAN_VERSION,
    contactId: file.id,
    callId: call.callId || call.raw?.call_id || "",
    fields: writeback.fields,
    status: writeback.status,
    note: writeback.note,
    unverified: proposal.unverified
  });
  return { extracted, proposal, writeback, writebackDigest };
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
