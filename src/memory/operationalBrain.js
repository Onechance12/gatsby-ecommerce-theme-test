// Evidence-backed operational open loops for exact JobNimbus files.
//
// Deterministic rules detect repeatable Thresher conditions from a refreshed
// private client snapshot. The ledger preserves unresolved work between chats,
// but never authorizes or executes an action. An optional model pass may rank
// and explain detected loops; it receives no tools and returns strict advisory
// JSON that is still subject to Chance's separate action approval.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { memoryPaths } from "./store.js";
import { providerDescriptor } from "./operationalAdvisoryProvider.js";

const LEDGER_VERSION = 1;
const ACTIVE_STATUSES = new Set(["open", "waiting"]);
const MAX_LEDGER_ROWS = 3000;
const APPOINTMENT_LOOKBACK_HOURS = 18;
const APPOINTMENT_HORIZON_DAYS = 30;

export function operationalBrainPaths(config) {
  const privateRoot = path.dirname(memoryPaths(config).client);
  return {
    loops: path.join(privateRoot, "operational-loops.jsonl"),
    advisories: path.join(privateRoot, "operational-advisories.jsonl")
  };
}

export function reconcileOperationalState(config, snapshot, options = {}) {
  if (!snapshot?.subjectKey) throw new Error("operational review requires an exact-file snapshot");
  const now = validDate(options.now) || new Date();
  const evaluations = evaluateOperationalRules(snapshot, { now });
  const file = operationalBrainPaths(config).loops;
  const rows = readJsonl(file);
  const nowIso = now.toISOString();
  const activeForSubject = rows.filter((row) =>
    row.subjectKey === snapshot.subjectKey && ACTIVE_STATUSES.has(row.status)
  );

  for (const evaluation of evaluations) {
    const existing = activeForSubject.find((row) => row.ruleId === evaluation.ruleId);
    if (evaluation.matches === true) {
      const draft = loopFromEvaluation(snapshot, evaluation, nowIso);
      if (existing) {
        Object.assign(existing, draft, {
          id: existing.id,
          firstDetectedAt: existing.firstDetectedAt,
          status: evaluation.waiting ? "waiting" : "open",
          lastDetectedAt: nowIso,
          updatedAt: nowIso
        });
      } else {
        rows.push({
          id: operationalId("loop"),
          ...draft,
          status: evaluation.waiting ? "waiting" : "open",
          firstDetectedAt: nowIso,
          lastDetectedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso
        });
      }
      continue;
    }

    if (evaluation.matches === false && existing) {
      existing.status = "resolved";
      existing.resolvedAt = nowIso;
      existing.updatedAt = nowIso;
      existing.resolutionReason = evaluation.resolutionReason || "Fresh evidence no longer supports this open condition.";
    }
    // matches=null means required evidence was unavailable. Preserve the prior
    // state rather than falsely resolving an operational loop during an outage.
  }

  writeJsonl(file, rows.slice(-MAX_LEDGER_ROWS));
  return operationalState(config, snapshot.subjectKey, { evaluations });
}

export function operationalState(
  config,
  subjectKey,
  { evaluations = [], quarantineCorrupt = true } = {}
) {
  const rows = readJsonl(operationalBrainPaths(config).loops, { quarantineCorrupt })
    .filter((row) => row.subjectKey === String(subjectKey || ""))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return {
    subjectKey: String(subjectKey || ""),
    openLoops: rows.filter((row) => ACTIVE_STATUSES.has(row.status)),
    recentResolvedLoops: rows.filter((row) => row.status === "resolved").slice(0, 8),
    indeterminateRules: evaluations
      .filter((evaluation) => evaluation.matches === null)
      .map((evaluation) => ({
        ruleId: evaluation.ruleId,
        reason: evaluation.indeterminateReason || "Required evidence was unavailable."
      })),
    authority: operationalAuthority()
  };
}

export function evaluateOperationalRules(snapshot, { now = new Date() } = {}) {
  return [
    evaluateAppointmentConfirmation(snapshot, now),
    evaluateReadyForPaReview(snapshot),
    evaluateSubmittedAdjusterConfirmation(snapshot),
    evaluateReadyForAppraisal(snapshot),
    evaluateUnauthorizedAppointmentStage(snapshot)
  ];
}

export async function createOperationalAdvisory(config, snapshot, operational, options = {}) {
  const openLoops = Array.isArray(operational?.openLoops) ? operational.openLoops : [];
  if (!openLoops.length) {
    return {
      status: "not_needed",
      reason: "No evidence-backed operational loops are currently open.",
      authority: operationalAuthority()
    };
  }

  const providers = (Array.isArray(options.providers) ? options.providers : [])
    .filter((provider) => providerDescriptor(provider));
  if (!providers.length) {
    return {
      status: "unavailable",
      reason: "No operational advisory provider is configured.",
      authority: operationalAuthority()
    };
  }
  const sourceManifest = buildSourceManifest(snapshot, openLoops);
  const evidenceFingerprint = hashJson({
    subjectKey: snapshot.subjectKey,
    refreshedAt: snapshot.refreshedAt,
    loops: openLoops.map((loop) => ({ id: loop.id, fingerprint: loop.fingerprint })),
    sourceManifest
  });
  const rows = readJsonl(operationalBrainPaths(config).advisories);
  const reusable = rows.find((row) =>
    row.evidenceFingerprint === evidenceFingerprint
    && row.status === "candidate"
    && row.advisory
  );
  if (reusable) return { status: "cached", advisory: reusable, authority: operationalAuthority() };

  const providerPacket = buildProviderPacket(snapshot, openLoops, sourceManifest);
  const failures = [];
  for (const provider of providers) {
    const descriptor = providerDescriptor(provider);
    const requestFingerprint = hashJson({ evidenceFingerprint, ...descriptor });
    try {
      const result = await provider.generate({
        systemPrompt: operationalAdvisorSystemPrompt(),
        userPayload: {
          dataPolicy: "private_exact_client_operational_evidence",
          file: compactAdvisoryFile(snapshot.file),
          sourceStatus: snapshot.sourceStatus || {},
          openLoops: providerPacket.openLoops,
          sources: providerPacket.sources
        },
        outputSchema: advisorySchema(),
        maxOutputTokens: 900,
        signal: options.signal
      });
      validateProviderResult(result, descriptor);
      const providerAdvisory = validateAdvisory(result.output, {
        allowedLoopIds: new Set(providerPacket.openLoops.map((loop) => loop.id)),
        allowedSourceIds: new Set(providerPacket.sources.map((source) => source.id))
      });
      const advisory = restoreProviderCitations(providerAdvisory, providerPacket);
      const record = {
        id: operationalId("adv"),
        version: LEDGER_VERSION,
        subjectKey: snapshot.subjectKey,
        status: "candidate",
        provider: descriptor.provider,
        model: descriptor.model,
        evidenceFingerprint,
        requestFingerprint,
        createdAt: new Date().toISOString(),
        snapshotRefreshedAt: snapshot.refreshedAt || "",
        advisory,
        provenance: result.provenance,
        authority: operationalAuthority()
      };
      rows.push(record);
      writeJsonl(operationalBrainPaths(config).advisories, rows.slice(-1000));
      return {
        status: "created",
        advisory: record,
        fallbackUsed: failures.length > 0,
        failedProviders: failures,
        authority: operationalAuthority()
      };
    } catch (error) {
      failures.push({
        provider: descriptor.provider,
        model: descriptor.model,
        code: String(error?.code || "provider_failed").slice(0, 80)
      });
    }
  }
  const error = new Error(`Operational advisory providers failed: ${failures.map((item) => `${item.provider}:${item.code}`).join(", ")}.`);
  error.providerFailures = failures;
  throw error;
}

function evaluateAppointmentConfirmation(snapshot, now) {
  const ruleId = "appointment.homeowner_confirmation";
  if (!sourceFresh(snapshot, "jobNimbus")) {
    return indeterminate(ruleId, "Fresh JobNimbus tasks are required.");
  }
  const appointment = currentAppointment(snapshot.jobNimbus?.openTasks || [], now);
  if (!appointment) {
    return {
      ruleId,
      matches: false,
      resolutionReason: "No current open inspection or adjuster appointment task remains."
    };
  }
  if (!sourceFresh(snapshot, "quo")) {
    return indeterminate(ruleId, "Fresh homeowner Quo history is required to verify notification and confirmation.");
  }

  const activities = snapshot.jobNimbus?.recentActivities || [];
  const timeline = snapshot.communications?.quo?.evidence?.timeline || [];
  const noteConfirmation = findNoteConfirmation(activities, appointment);
  const quoEvidence = findQuoAppointmentEvidence(timeline, appointment);
  if (noteConfirmation || quoEvidence.confirmed) {
    return {
      ruleId,
      matches: false,
      resolutionReason: "Fresh evidence shows the homeowner or occupant confirmed the appointment."
    };
  }

  const hoursUntil = (appointment.at.getTime() - now.getTime()) / 3_600_000;
  const priority = hoursUntil <= 24 ? "urgent" : hoursUntil <= 72 ? "high" : "normal";
  const notified = Boolean(quoEvidence.notified);
  const notifiedAt = validDate(quoEvidence.notified?.at);
  const hoursSinceNotice = notifiedAt ? (now.getTime() - notifiedAt.getTime()) / 3_600_000 : Number.POSITIVE_INFINITY;
  const waitingForReply = notified && hoursSinceNotice < 24 && hoursUntil > 24;
  const action = notified
    ? {
      type: "quo.send_text",
      channel: "quo",
      goal: "Follow up for an explicit homeowner or occupant confirmation of the scheduled appointment.",
      targetRole: "homeowner_or_occupant",
      draftGuidance: "Reference the verified appointment date and arrival window, ask whether access will be available, and wait for a direct answer."
    }
    : {
      type: "quo.send_text",
      channel: "quo",
      goal: "Notify the homeowner or occupant and request confirmation of the scheduled appointment.",
      targetRole: "homeowner_or_occupant",
      draftGuidance: "Use a conversational greeting, provide the verified appointment date and arrival window, ask whether access will be available, and do not claim they already confirmed."
    };

  return {
    ruleId,
    matches: true,
    waiting: waitingForReply,
    title: notified ? "Homeowner appointment confirmation is still pending" : "Homeowner has not been notified of the appointment",
    summary: `An open ${appointment.title || "inspection"} task is scheduled for ${appointment.at.toISOString()}, but fresh evidence does not show an explicit homeowner or occupant confirmation.`,
    priority,
    action,
    evidence: [
      taskEvidence(appointment.task),
      ...(quoEvidence.notified ? [quoEvidence.notified] : [])
    ],
    missingEvidence: ["Explicit homeowner or occupant confirmation and access availability."],
    confidence: 0.93
  };
}

function evaluateReadyForPaReview(snapshot) {
  const ruleId = "thresher.ready_for_pa_review";
  if (!sourceFresh(snapshot, "jobNimbus")) return indeterminate(ruleId, "Fresh JobNimbus evidence is required.");
  if (!statusIncludes(snapshot, "ready for pa review")) {
    return { ruleId, matches: false, resolutionReason: "The file is no longer in Ready for PA Review." };
  }
  return {
    ruleId,
    matches: true,
    title: "Ready for PA Review requires claim-path determination",
    summary: "The file is in Ready for PA Review. The next decision must distinguish a new claim from a prior denied or underpaid claim before filing or reopening.",
    priority: "high",
    action: {
      type: "review",
      channel: "jobnimbus_gmail_quo_documents",
      goal: "Determine whether to file a new claim, reopen/reactivate an existing claim, or obtain missing policy evidence.",
      targetRole: "public_adjuster",
      draftGuidance: "Review the complete file and prior claim history; do not assume every Ready for PA Review file needs a new claim."
    },
    evidence: [fileStatusEvidence(snapshot)],
    missingEvidence: missingCoreClaimFacts(snapshot),
    confidence: 0.98
  };
}

function evaluateSubmittedAdjusterConfirmation(snapshot) {
  const ruleId = "thresher.submitted_missing_adjuster";
  if (!sourceFresh(snapshot, "jobNimbus")) return indeterminate(ruleId, "Fresh JobNimbus evidence is required.");
  if (!statusIncludes(snapshot, "submitted", "confirmation")) {
    return { ruleId, matches: false, resolutionReason: "The file is no longer awaiting submitted-claim confirmations." };
  }
  const file = snapshot.file || {};
  if (file.adjusterName || file.adjusterPhone || file.adjusterEmail) {
    return { ruleId, matches: false, resolutionReason: "JobNimbus now contains carrier adjuster contact information." };
  }
  return {
    ruleId,
    matches: true,
    title: "Carrier adjuster assignment is still unconfirmed",
    summary: "The claim is in Submitted Awaiting Confirmation, but JobNimbus does not contain a desk adjuster name, phone number, or email.",
    priority: "high",
    action: {
      type: "carrier_follow_up",
      channel: "gmail_or_phone",
      goal: "Confirm the assigned desk adjuster and save the verified contact details.",
      targetRole: "carrier",
      draftGuidance: "Prefer verified carrier email when available; otherwise call. Do not text a desk adjuster unless prior evidence shows that person uses text."
    },
    evidence: [fileStatusEvidence(snapshot)],
    missingEvidence: ["Assigned desk adjuster name and at least one verified contact method."],
    confidence: 0.96
  };
}

function evaluateReadyForAppraisal(snapshot) {
  const ruleId = "thresher.ready_for_appraisal";
  if (!sourceFresh(snapshot, "jobNimbus")) return indeterminate(ruleId, "Fresh JobNimbus evidence is required.");
  if (!statusIncludes(snapshot, "ready for appraisal")) {
    return { ruleId, matches: false, resolutionReason: "The file is no longer in Ready for Appraisal." };
  }
  return {
    ruleId,
    matches: true,
    title: "Appraisal submission is ready and should not sit",
    summary: "The file is in Ready for Appraisal and needs an evidence-verified appraisal package, submission date, and appraiser assignment.",
    priority: "urgent",
    action: {
      type: "appraisal_prepare",
      channel: "gmail_and_jobnimbus",
      goal: "Prepare the appraisal package for approval, then document submission and assign the approved appraiser after execution.",
      targetRole: "public_adjuster",
      draftGuidance: "Verify the current scope, appraisal basis, recipient, and documents before requesting approval."
    },
    evidence: [fileStatusEvidence(snapshot)],
    missingEvidence: [],
    confidence: 0.98
  };
}

function evaluateUnauthorizedAppointmentStage(snapshot) {
  const ruleId = "thresher.unauthorized_appointment_stage";
  if (!sourceFresh(snapshot, "jobNimbus")) return indeterminate(ruleId, "Fresh JobNimbus evidence is required.");
  const status = String(snapshot.file?.status || "").trim().toLowerCase();
  if (!status.includes("appointment")) {
    return { ruleId, matches: false, resolutionReason: "The file is not in an appointment workflow stage." };
  }
  return {
    ruleId,
    matches: true,
    title: "File is parked in the retired appointment stage",
    summary: "The current workflow status includes Appointment, which is not part of the approved Thresher stages and should be reviewed for Negotiating or Hot Final Negotiation.",
    priority: "high",
    action: {
      type: "jobnimbus.update_status",
      channel: "jobnimbus",
      goal: "Move the file to the correct approved Thresher stage after reviewing current settlement posture.",
      targetRole: "public_adjuster",
      draftGuidance: "Do not change the status automatically; verify whether Negotiating or Hot Final Negotiation is correct."
    },
    evidence: [fileStatusEvidence(snapshot)],
    missingEvidence: ["The correct replacement Thresher stage."],
    confidence: 0.99
  };
}

function currentAppointment(tasks, now) {
  const lower = now.getTime() - APPOINTMENT_LOOKBACK_HOURS * 3_600_000;
  const upper = now.getTime() + APPOINTMENT_HORIZON_DAYS * 86_400_000;
  return tasks
    .filter((task) => !task.completed && appointmentText(task))
    .map((task) => ({ task, title: task.title || "", at: taskDate(task) }))
    .filter((item) => item.at && item.at.getTime() >= lower && item.at.getTime() <= upper)
    .sort((a, b) => a.at - b.at)[0] || null;
}

function appointmentText(task) {
  return /\b(inspection|reinspection|adjuster meeting|adjuster appointment|property appointment)\b/i
    .test(`${task?.title || ""} ${task?.description || ""}`);
}

function taskDate(task) {
  return validDate(task?.dateStart || task?.dueDate || task?.dateEnd);
}

function findNoteConfirmation(activities, appointment) {
  const threshold = Math.max(
    appointment.at.getTime() - 30 * 86_400_000,
    validDate(appointment.task.createdAt)?.getTime() || Number.NEGATIVE_INFINITY
  );
  return activities.find((activity) => {
    const at = validDate(activity.dateCreated);
    if (at && Number.isFinite(threshold) && at.getTime() < threshold) return false;
    const text = String(activity.note || "");
    if (/(not|has not|hasn't|unable to|needs?|awaiting|pending).{0,30}confirm|unconfirmed/i.test(text)) return false;
    return /(homeowner|insured|tenant|occupant).{0,100}(confirm|aware|notified|available)|confirm.{0,100}(homeowner|insured|tenant|occupant)/i.test(text);
  }) || null;
}

function findQuoAppointmentEvidence(timeline, appointment) {
  const createdAt = validDate(appointment.task.createdAt);
  const earliest = createdAt
    ? createdAt.getTime() - 3_600_000
    : appointment.at.getTime() - 30 * 86_400_000;
  const ordered = timeline
    .map((item) => ({ item, at: validDate(item.at || item.atUtc || item.createdAt) }))
    .filter((entry) => entry.at && entry.at.getTime() >= earliest)
    .sort((a, b) => a.at - b.at);
  const outgoing = ordered.find((entry) =>
    String(entry.item.direction || "").toLowerCase() === "outgoing"
    && appointmentCommunication(entry.item.text || entry.item.content || "")
    && !/failed|undeliverable/i.test(String(entry.item.status || ""))
  );
  if (!outgoing) return { notified: null, confirmed: null };
  const incoming = ordered.find((entry) =>
    entry.at >= outgoing.at
    && String(entry.item.direction || "").toLowerCase() === "incoming"
    && affirmativeConfirmation(entry.item.text || entry.item.content || "")
  );
  return {
    notified: communicationEvidence(outgoing.item, "Homeowner appointment notice sent."),
    confirmed: incoming ? communicationEvidence(incoming.item, "Homeowner or occupant confirmed availability.") : null
  };
}

function appointmentCommunication(value) {
  const text = String(value || "");
  return /(inspection|adjuster|appointment|reinspection)/i.test(text)
    && /(am|pm|morning|afternoon|between|\d{1,2}:\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|lunes|martes|miércoles|jueves|viernes|sábado)/i.test(text);
}

function affirmativeConfirmation(value) {
  return /(^|\b)(yes|yeah|yep|confirmed|confirm|works|available|okay|ok|sure|sí|si|está bien|esta bien)(\b|$)/i
    .test(String(value || "").trim());
}

function loopFromEvaluation(snapshot, evaluation, nowIso) {
  const evidence = uniqueEvidence(evaluation.evidence || []);
  return {
    version: LEDGER_VERSION,
    subjectKey: snapshot.subjectKey,
    fileNumber: String(snapshot.file?.number || ""),
    fileName: String(snapshot.file?.name || "").slice(0, 240),
    ruleId: evaluation.ruleId,
    title: evaluation.title,
    summary: evaluation.summary,
    priority: evaluation.priority || "normal",
    confidence: clamp(evaluation.confidence, 0, 1, 0.7),
    proposedAction: evaluation.action || {},
    requiresSeparateApproval: true,
    evidence,
    missingEvidence: stringList(evaluation.missingEvidence, 12),
    fingerprint: hashJson({
      ruleId: evaluation.ruleId,
      summary: evaluation.summary,
      proposedAction: evaluation.action,
      evidence
    }),
    lastEvidenceRefreshAt: snapshot.refreshedAt || nowIso,
    authority: operationalAuthority()
  };
}

function buildSourceManifest(snapshot, loops) {
  const byId = new Map();
  for (const loop of loops) {
    for (const evidence of loop.evidence || []) byId.set(evidence.id, evidence);
  }
  for (const [source, value] of Object.entries(snapshot.sourceStatus || {})) {
    const id = `source-status:${source}`;
    byId.set(id, {
      id,
      source: "source_status",
      at: value?.at || "",
      summary: `${source}=${value?.status || "unknown"}`
    });
  }
  return [...byId.values()].slice(0, 30);
}

function compactAdvisoryFile(file = {}) {
  return {
    number: String(file.number || ""),
    status: String(file.status || "").slice(0, 160),
    carrier: String(file.carrier || "").slice(0, 160),
    hasClaimNumber: Boolean(file.claimNumber),
    hasPolicyNumber: Boolean(file.policyNumber),
    dateOfLoss: String(file.dateOfLoss || "").slice(0, 80),
    hasAdjusterContact: Boolean(file.adjusterName || file.adjusterPhone || file.adjusterEmail)
  };
}

function operationalAdvisorSystemPrompt() {
  return [
    "Role: bounded operational advisor for Home Claim Network and Wave Public Adjusting.",
    "Goal: prioritize the supplied evidence-backed JobNimbus open loops and explain the single best next action.",
    "The evidence is private exact-client operational data. Use it only for this response and never reproduce identifiers unnecessarily.",
    "Use only supplied source IDs. Do not invent facts, recipients, dates, claim details, completed actions, or source IDs.",
    "Live JobNimbus, Gmail, and Quo evidence outranks memory. Missing evidence must remain an uncertainty.",
    "You have no tools and no execution authority. Every recommendation requires separate Chance approval.",
    "Return one JSON object matching the requested schema and nothing else."
  ].join("\n");
}

function buildProviderPacket(snapshot, loops, sources) {
  const sourceIdToAlias = new Map();
  const sourceAliasToId = new Map();
  const aliasedSources = sources.map((source, index) => {
    const alias = `source-${index + 1}`;
    sourceIdToAlias.set(source.id, alias);
    sourceAliasToId.set(alias, source.id);
    return {
      id: alias,
      source: String(source.source || "evidence").slice(0, 80),
      at: String(source.at || "").slice(0, 80),
      summary: String(source.summary || "").slice(0, 800)
    };
  });
  const loopAliasToId = new Map();
  const aliasedLoops = loops.map((loop, index) => {
    const alias = `loop-${index + 1}`;
    loopAliasToId.set(alias, loop.id);
    return {
      ...compactAdvisoryLoop(loop),
      id: alias,
      sourceIds: (loop.evidence || [])
        .map((evidence) => sourceIdToAlias.get(evidence.id))
        .filter(Boolean)
    };
  });
  return {
    subjectKey: snapshot.subjectKey,
    openLoops: aliasedLoops,
    sources: aliasedSources,
    loopAliasToId,
    sourceAliasToId
  };
}

function restoreProviderCitations(advisory, providerPacket) {
  const primaryLoopId = providerPacket.loopAliasToId.get(advisory.primaryLoopId);
  const sourceIds = advisory.sourceIds.map((id) => providerPacket.sourceAliasToId.get(id)).filter(Boolean);
  if (!primaryLoopId || sourceIds.length !== advisory.sourceIds.length) {
    throw new Error("Operational provider citation aliases could not be restored.");
  }
  return {
    ...advisory,
    primaryLoopId,
    sourceIds
  };
}

function compactAdvisoryLoop(loop) {
  return {
    id: loop.id,
    ruleId: loop.ruleId,
    title: loop.title,
    summary: loop.summary,
    priority: loop.priority,
    proposedAction: loop.proposedAction,
    missingEvidence: loop.missingEvidence,
    sourceIds: (loop.evidence || []).map((evidence) => evidence.id)
  };
}

function validateProviderResult(result, descriptor) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Operational provider returned an invalid result.");
  }
  if (!result.provenance || typeof result.provenance !== "object" || Array.isArray(result.provenance)) {
    throw new Error("Operational provider omitted provenance.");
  }
  if (result.provenance.provider !== descriptor.provider || result.provenance.requestedModel !== descriptor.model) {
    throw new Error("Operational provider provenance did not match the configured adapter.");
  }
  if (
    result.provenance.toolCallCount !== 0
    || result.provenance.executionAuthority !== false
    || result.provenance.externalActionAuthorized !== false
  ) {
    throw new Error("Operational provider attempted to exceed advisory authority.");
  }
}

function advisorySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "primaryLoopId", "recommendedAction", "rationale", "uncertainties", "sourceIds", "requiresSeparateApproval"],
    properties: {
      summary: { type: "string" },
      primaryLoopId: { type: "string" },
      recommendedAction: { type: "string" },
      rationale: { type: "string" },
      uncertainties: { type: "array", items: { type: "string" }, maxItems: 8 },
      sourceIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
      requiresSeparateApproval: { type: "boolean", const: true }
    }
  };
}

function validateAdvisory(value, { allowedLoopIds, allowedSourceIds }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Operational advisory must be an object.");
  const keys = ["summary", "primaryLoopId", "recommendedAction", "rationale", "uncertainties", "sourceIds", "requiresSeparateApproval"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Operational advisory contains an unsupported field.");
  if (!allowedLoopIds.has(String(value.primaryLoopId || ""))) throw new Error("Operational advisory cited an unknown open loop.");
  const sourceIds = stringList(value.sourceIds, 20);
  if (!sourceIds.length || sourceIds.some((id) => !allowedSourceIds.has(id))) {
    throw new Error("Operational advisory cited an unknown source.");
  }
  if (value.requiresSeparateApproval !== true) throw new Error("Operational advisory attempted to bypass separate approval.");
  return {
    summary: boundedText(value.summary, 1200),
    primaryLoopId: String(value.primaryLoopId),
    recommendedAction: boundedText(value.recommendedAction, 1200),
    rationale: boundedText(value.rationale, 1600),
    uncertainties: stringList(value.uncertainties, 8).map((item) => item.slice(0, 600)),
    sourceIds,
    requiresSeparateApproval: true
  };
}

function missingCoreClaimFacts(snapshot) {
  const file = snapshot.file || {};
  return [
    !file.carrier && "Carrier",
    !file.policyNumber && "Policy number",
    !file.dateOfLoss && "Date of loss",
    !file.claimNumber && "Claim number or verified determination that no claim exists"
  ].filter(Boolean);
}

function sourceFresh(snapshot, source) {
  return snapshot.sourceStatus?.[source]?.status === "fresh";
}

function statusIncludes(snapshot, ...values) {
  const status = String(snapshot.file?.status || "").toLowerCase();
  return values.every((value) => status.includes(String(value).toLowerCase()));
}

function taskEvidence(task) {
  return {
    id: `jobnimbus-task:${task.id || hashJson(task).slice(0, 16)}`,
    source: "jobnimbus",
    at: String(task.createdAt || task.dateStart || task.dueDate || ""),
    summary: `Open task: ${String(task.title || "inspection appointment").slice(0, 300)}`
  };
}

function fileStatusEvidence(snapshot) {
  return {
    id: `jobnimbus-status:${snapshot.subjectKey}:${hashJson(String(snapshot.file?.status || "")).slice(0, 12)}`,
    source: "jobnimbus",
    at: snapshot.sourceStatus?.jobNimbus?.at || snapshot.refreshedAt || "",
    summary: `Current status: ${String(snapshot.file?.status || "missing").slice(0, 240)}`
  };
}

function communicationEvidence(item, summary) {
  return {
    id: `quo:${item.id || hashJson(item).slice(0, 16)}`,
    source: "quo",
    at: String(item.at || item.atUtc || item.createdAt || ""),
    summary
  };
}

function indeterminate(ruleId, reason) {
  return { ruleId, matches: null, indeterminateReason: reason };
}

function operationalAuthority() {
  return {
    kind: "advisory_open_loop",
    liveSourcesWin: true,
    modelOutputIsCandidateOnly: true,
    doesNotAuthorizeActions: true,
    automaticExternalActions: false,
    explicitChanceApprovalStillRequired: true
  };
}

function readJsonl(file, { quarantineCorrupt = true } = {}) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  let corrupt = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try { rows.push(JSON.parse(line)); } catch { corrupt++; }
  }
  if (corrupt) {
    if (quarantineCorrupt) {
      const quarantined = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, quarantined); } catch { /* leave it for inspection if quarantine fails */ }
      console.error(`WARN: quarantined operational ledger ${file} with ${corrupt} corrupt line(s). It will rebuild from fresh exact-file reviews.`);
    } else {
      console.error(`WARN: corrupt operational ledger left unchanged by read-only review ${file} with ${corrupt} corrupt line(s).`);
    }
    return [];
  }
  return rows;
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function validDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function operationalId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueEvidence(value) {
  return [...new Map(value.filter(Boolean).map((item) => [item.id, item])).values()].slice(0, 20);
}

function stringList(value, max) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, max);
}

function boundedText(value, max) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Operational advisory omitted required text.");
  return text.slice(0, max);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
