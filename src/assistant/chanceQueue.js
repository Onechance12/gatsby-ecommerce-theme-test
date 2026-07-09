import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../lib/io.js";
import { ReadOnlyJobNimbusClient } from "../jobnimbus/client.js";
import { runChanceSweep } from "../sweep/runChanceSweep.js";
import { loadReviews } from "./fileReview.js";
import { notePolicyViolations } from "./actionTools.js";
import { agentById, listChanceAgents } from "./chanceAgents.js";
import { calendarEventActionFromReview } from "./calendarEvents.js";
import { carrierDocsSubmissionAction, evaluateWorkflowGates, lorDestinationAction, lorEmailAction, shouldFindLorDestination, shouldSendLorToAdjuster, shouldSubmitCarrierDocs } from "./workflowGates.js";
import { CHANCE_NAME, findChanceUserIds, isChanceContact } from "../lib/chanceScope.js";

export async function runChanceQueue(config, args) {
  const input = parseInput(args.join(" "));
  const displayLimit = Number(input.displayLimit ?? input.limit ?? 20);
  const refresh = input.refresh === undefined ? true : truthy(input.refresh);

  if (refresh) {
    await runChanceSweep(config);
  }

  const reviews = loadChanceReviews(config);
  const overlay = loadCommunicationOverlay(config);
  const approvals = buildApprovalItems(reviews, overlay);
  const queue = {
    owner: CHANCE_NAME,
    generatedAt: new Date().toISOString(),
    source: refresh ? "fresh Chance-only JobNimbus sweep" : "existing local synced Chance/JobNimbus data",
    refreshedBeforeAnalysis: refresh,
    communicationOverlay: {
      loaded: overlay.entries.length > 0,
      source: overlay.source,
      reviewedAt: overlay.reviewedAt || "",
      entryCount: overlay.entries.length,
      stale: overlay.stale === true,
      staleReason: overlay.staleReason || ""
    },
    fileCount: reviews.length,
    approvalCount: approvals.length,
    approvalModel: {
      default: "show first, execute only after approval",
      jobNimbus: "can be executed by chat:action after explicit approval",
      quoAndGmail: "drafted here; sending must happen through connected chat connectors with approval"
    },
    agents: listChanceAgents(),
    approvals
  };

  if (truthy(input.writeReport ?? true)) {
    writeJson(path.join(config.paths.reportsDir, "chance-approval-queue.json"), queue);
  }

  const printable = {
    ...queue,
    displayedApprovalCount: Math.min(approvals.length, Number.isFinite(displayLimit) ? displayLimit : approvals.length),
    approvals: approvals.slice(0, Number.isFinite(displayLimit) ? displayLimit : approvals.length)
  };

  printJson(printable);
}

export async function runChanceApprove(config, args) {
  const input = parseInput(args.join(" "));
  const queuePath = path.join(config.paths.reportsDir, "chance-approval-queue.json");
  if (!fs.existsSync(queuePath)) {
    throw new Error("No Chance approval queue found. Run `npm run chance:queue` first.");
  }

  const queue = readJson(queuePath);
  const queueAgeMinutes = minutesSince(queue.generatedAt);
  const ids = normalizeIds(input.ids || input.id || input._);
  const approvals = ids.length
    ? queue.approvals.filter((item) => ids.includes(item.approvalId))
    : queue.approvals;

  if (!approvals.length) {
    throw new Error(`No matching approval items found for: ${ids.join(", ") || "all"}`);
  }

  const executableActions = [];
  const externalActions = [];

  for (const approval of approvals) {
    for (const action of approval.proposedActions || []) {
      const item = {
        approvalId: approval.approvalId,
        actionType: "primary",
        file: approval.file,
        action
      };
      if (action.channel === "jobnimbus" && ["create_task", "create_note"].includes(action.action)) {
        executableActions.push(item);
      } else {
        externalActions.push(item);
      }
    }
    for (const action of approval.supportingActions || []) {
      const item = {
        approvalId: approval.approvalId,
        actionType: "supporting",
        file: approval.file,
        action
      };
      if (action.channel === "jobnimbus" && ["create_task", "create_note"].includes(action.action)) {
        executableActions.push(item);
      } else {
        externalActions.push(item);
      }
    }
  }

  if (!truthy(input.execute)) {
    printJson({
      mode: "dry_run",
      queueGeneratedAt: queue.generatedAt,
      queueAgeMinutes,
      staleWarning: queueAgeMinutes > 30 ? "Queue is over 30 minutes old. Run `npm run chance:queue` again before approving live actions." : "",
      selectedApprovalCount: approvals.length,
      jobNimbusActionsReady: executableActions.map((item) => planJobNimbusAction(config, item)),
      externalActionsNeedingConnectorApproval: externalActions,
      execute: {
        allowed: false,
        reason: "Pass execute:true and run with ALLOW_JOBNIMBUS_WRITES=true to execute the approved JobNimbus writes. Quo/Gmail still require their own connector send step."
      }
    });
    return;
  }

  ensureCanExecute(config);
  const client = new ReadOnlyJobNimbusClient(config);
  const results = [];
  for (const item of executableActions) {
    const plan = planJobNimbusAction(config, item);
    if (plan.policyViolations?.length) {
      results.push({
        approvalId: item.approvalId,
        file: item.file,
        blocked: true,
        policyViolations: plan.policyViolations,
        request: plan
      });
      continue;
    }
    const result = await client.postJson(plan.endpoint, plan.body);
    results.push({
      approvalId: item.approvalId,
      file: item.file,
      blocked: false,
      request: plan,
      result
    });
  }

  printJson({
    mode: "executed",
    queueGeneratedAt: queue.generatedAt,
    queueAgeMinutes,
    selectedApprovalCount: approvals.length,
    jobNimbusWritesExecuted: results.filter((result) => !result.blocked).length,
    jobNimbusWritesBlocked: results.filter((result) => result.blocked).length,
    results,
    externalActionsNeedingConnectorApproval: externalActions
  });
}

export function runChanceAgents() {
  printJson({
    scope: "Chance Pearson files for now, using company-wide HCN/Wave guardrails.",
    agents: listChanceAgents()
  });
}

export function loadChanceReviews(config) {
  const chanceReviewsPath = path.join(config.paths.normalizedDir, "chance-reviews.json");
  const reviews = fs.existsSync(chanceReviewsPath) ? readJson(chanceReviewsPath) : loadReviews(config);
  const scopedRawDir = path.join(config.paths.rawDir, "chance");
  const rawContacts = readOptionalJson(path.join(scopedRawDir, "contacts.json"), readOptionalJson(path.join(config.paths.rawDir, "contacts.json"), []));
  const rawUsersPayload = readOptionalJson(path.join(scopedRawDir, "accountUsers.json"), readOptionalJson(path.join(config.paths.rawDir, "accountUsers.json"), []));
  const chanceUserIds = findChanceUserIds(rawUsersPayload);
  const contactsById = new Map(rawContacts.map((contact) => [recordId(contact), contact]));

  return reviews
    .filter((review) => isChanceFile(review, contactsById.get(review.file.id), chanceUserIds))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.file.customer.localeCompare(b.file.customer));
}

function buildApprovalItems(reviews, overlay = emptyOverlay()) {
  const items = [];

  for (const review of reviews) {
    const overlayEntry = findOverlayEntry(overlay, review);
    const item = buildFileApproval(review, overlayEntry);
    const overlaid = applyCommunicationOverlay(item, review, overlay, overlayEntry);
    if (overlaid) items.push(overlaid);
  }

  return items.map((item, index) => ({
    approvalId: `chance-${String(index + 1).padStart(3, "0")}`,
    ...item
  }));
}

function loadCommunicationOverlay(config) {
  const overlayPath = path.join(config.paths.reportsDir, "chance-communication-overlay.json");
  if (!fs.existsSync(overlayPath)) return emptyOverlay();
  const overlay = readJson(overlayPath);
  const reviewedAt = overlay.reviewedAt || "";
  const entries = Array.isArray(overlay.entries) ? overlay.entries : [];
  const ageMinutes = minutesSince(reviewedAt);
  const maxAgeMinutes = Number(process.env.CHANCE_COMM_OVERLAY_MAX_MINUTES || 720);
  if (ageMinutes !== null && ageMinutes > maxAgeMinutes) {
    return {
      source: overlayPath,
      reviewedAt,
      entries: [],
      stale: true,
      staleReason: `Communication overlay is ${ageMinutes} minutes old; ignored because it exceeds ${maxAgeMinutes} minutes. Rebuild from Gmail/Quo before relying on those facts.`,
      originalEntryCount: entries.length
    };
  }
  return {
    source: overlayPath,
    reviewedAt,
    entries,
    stale: false,
    staleReason: "",
    originalEntryCount: entries.length
  };
}

function emptyOverlay() {
  return { source: "", reviewedAt: "", entries: [], stale: false, staleReason: "", originalEntryCount: 0 };
}

function findOverlayEntry(overlay, review) {
  return overlay.entries.find((candidate) => overlayMatches(candidate, review));
}

function applyCommunicationOverlay(item, review, overlay, knownEntry = null) {
  if (!item) return null;
  const entry = knownEntry || overlay.entries.find((candidate) => overlayMatches(candidate, review));
  if (!entry) return item;

  const suppressed = new Set(entry.suppressApprovalTitles || []);
  if (suppressed.has(item.needsApprovalFor)) {
    if (entry.replacementApproval) {
      return buildOverlayReplacement(item, entry);
    }
    return null;
  }

  const suppressedActionTitles = new Set(entry.suppressActionTitles || []);
  const proposedActions = (item.proposedActions || []).filter((action) => !suppressedActionTitles.has(action.title));
  const supportingActions = (item.supportingActions || []).filter((action) => !suppressedActionTitles.has(action.title));
  const overlayActions = (entry.addSupportingActions || []).map((action) => normalizeOverlayAction(review, action));

  return {
    ...item,
    communicationOverlayApplied: overlaySummary(entry),
    proposedActions: proposedActions.length ? proposedActions : item.proposedActions,
    supportingActions: [...supportingActions, ...overlayActions]
  };
}

function buildOverlayReplacement(item, entry) {
  const replacement = entry.replacementApproval;
  const primaryAgent = replacement.primaryAgentId ? agentById(replacement.primaryAgentId) : item.primaryAgent;
  return {
    ...item,
    executable: (replacement.proposedActions || []).some((action) => action.executable !== false),
    primaryAgent: {
      id: primaryAgent.id,
      name: primaryAgent.name,
      purpose: primaryAgent.purpose
    },
    needsApprovalFor: replacement.needsApprovalFor,
    reason: replacement.reason || item.reason,
    communicationOverlayApplied: overlaySummary(entry),
    proposedActions: (replacement.proposedActions || []).map((action) => normalizeOverlayAction({ file: item.file }, action)),
    supportingActions: (replacement.supportingActions || []).map((action) => normalizeOverlayAction({ file: item.file }, action))
  };
}

function normalizeOverlayAction(reviewLike, action) {
  if (action.channel === "jobnimbus" && action.action === "create_task") {
    return {
      channel: "jobnimbus",
      action: "create_task",
      executable: true,
      title: action.title,
      description: action.description,
      dryRunCommand: `npm run chat:action -- create_jobnimbus_task '${JSON.stringify({
        query: reviewLike.file.id,
        title: action.title,
        description: action.description
      })}'`
    };
  }

  if (action.channel === "jobnimbus" && action.action === "create_note") {
    return {
      channel: "jobnimbus",
      action: "create_note",
      executable: true,
      title: action.title || "Create JobNimbus note",
      note: action.note,
      dryRunCommand: `npm run chat:action -- create_jobnimbus_note '${JSON.stringify({
        query: reviewLike.file.id,
        note: action.note
      })}'`
    };
  }

  return action;
}

function overlayMatches(entry, review) {
  const match = entry.match || {};
  const file = review.file;
  if (match.id && match.id === file.id) return true;
  if (match.name && normalizeMatch(match.name) === normalizeMatch(file.customer)) return true;
  if (match.nameContains && normalizeMatch(file.customer).includes(normalizeMatch(match.nameContains))) return true;
  if (match.claimNumber && cleanClaimNumber(match.claimNumber) && cleanClaimNumber(match.claimNumber) === cleanClaimNumber(file.claimNumber)) return true;
  if (match.policyNumber && normalizeMatch(match.policyNumber) === normalizeMatch(file.policyNumber)) return true;
  return false;
}

function overlaySummary(entry) {
  return {
    reviewedAt: entry.reviewedAt || "",
    sources: entry.sources || [],
    facts: entry.facts || []
  };
}

function buildFileApproval(review, overlayEntry = null) {
  const file = review.file;
  const needs = new Set(review.categories || []);
  const actions = [];
  const supportActions = [];
  const workflowGate = evaluateWorkflowGates(review, overlayEntry);
  const agentId = chooseAgentId(review, needs, workflowGate);
  const agent = agentById(agentId);
  let approvalTitle = review.recommendedNextAction || "Move file forward";

  if (needs.has("Claims needing filed")) {
    approvalTitle = "Prepare claim filing packet";
    actions.push(claimPacketAction(review));
  } else if (shouldSendLorToAdjuster(review, workflowGate)) {
    approvalTitle = "Send LOR to adjuster";
    actions.push(lorEmailAction(review));
  } else if (shouldSubmitCarrierDocs(review, workflowGate)) {
    approvalTitle = "Submit/upload LOR and claim docs";
    actions.push(carrierDocsSubmissionAction(review));
  } else if (shouldFindLorDestination(review, workflowGate)) {
    approvalTitle = "Find LOR/document destination";
    actions.push(lorDestinationAction(review));
  } else if (needs.has("Policy/coverage lookup failed")) {
    approvalTitle = "Resolve policy/coverage lookup failure";
    actions.push(policyCoverageResearchAction(review));
  } else if (file.status === "Submitted Awaiting Confirmation") {
    approvalTitle = "Confirm carrier receipt / adjuster assignment";
    actions.push(carrierFollowupAction(review));
  } else if (!file.policyNumber && stageCanRequestPolicy(file.status)) {
    approvalTitle = "Request policy/declarations page";
    actions.push(quoDraftAction(review, "homeowner", "Request policy/declarations page", draftPolicyRequest(file)));
  } else if (needs.has("Submitted for appraisal")) {
    approvalTitle = "Follow up on appraisal demand";
    actions.push(gmailDraftAction(review, "carrier/adjuster", "Follow up on appraisal demand", draftAppraisalFollowUp(file)));
  } else if (needs.has("Ready for appraisal") || needs.has("Appraisal candidates")) {
    approvalTitle = "Review for appraisal next step";
    actions.push(appraisalReviewAction(review));
  } else if (needs.has("Photo file / estimate needed")) {
    approvalTitle = "Push estimate/photo file forward";
    actions.push(estimateReviewAction(review));
  } else if (needs.has("Client update due")) {
    approvalTitle = "Review homeowner communication need";
    actions.push(reviewOnlyAction(
      review,
      "Review homeowner communication need",
      "Review recent JobNimbus/Quo context first. Only draft a homeowner update for appointment/access coordination, missing homeowner documents, or another clear homeowner-facing need."
    ));
  } else if (review.overdueTasks?.length) {
    approvalTitle = "Clear overdue task";
    actions.push(reviewOnlyAction(review, "Clear overdue task", `Review and work/close/reassign overdue task: ${review.overdueTasks[0].title}. Do not create another task just to clear a task.`));
  } else if (review.priority !== "Low") {
    approvalTitle = "Review manually";
    actions.push(reviewOnlyAction(review, "Manual file review", review.recommendedNextAction || "Review file and choose next step."));
  }

  if (!actions.length) return null;

  if (needs.has("Missing adjuster info") && file.claimNumber && !actions.some((action) => action.title === "Get adjuster contact info")) {
    supportActions.push(reviewOnlyAction(review, "Get adjuster contact info", "Check carrier messages/portal or call carrier for assigned adjuster name, phone, and email before adding JobNimbus fields."));
  }

  const calendarAction = calendarEventActionFromReview(review);
  if (calendarAction) {
    supportActions.unshift(calendarAction);
  }

  return {
    channel: "bundle",
    action: "approve_file_next_move",
    executable: actions.some((action) => action.executable),
    primaryAgent: {
      id: agent.id,
      name: agent.name,
      purpose: agent.purpose
    },
    workflowGates: [workflowGate],
    file: fileSummary(review),
    needsApprovalFor: approvalTitle,
    reason: review.bottleneck,
    proposedActions: actions,
    supportingActions: supportActions
  };
}

function chooseAgentId(review, needs, workflowGate = null) {
  const status = String(review.file.status || "").toLowerCase();
  if (needs.has("Claims needing filed")) return "claim-filing-reviewer";
  if (workflowGate?.nextRequiredAction?.toLowerCase().includes("lor")) return "carrier-followup";
  if (review.file.status === "Submitted Awaiting Confirmation" || needs.has("Missing adjuster info") || needs.has("Waiting on carrier")) return "carrier-followup";
  if (needs.has("Submitted for appraisal") || needs.has("Ready for appraisal") || needs.has("Appraisal candidates") || status.includes("appraisal")) return "appraisal-pusher";
  if (!review.file.policyNumber || needs.has("Client update due") || needs.has("Waiting on homeowner")) return "client-comms";
  if (needs.has("Photo file / estimate needed")) return "estimate-scope-reviewer";
  return "jobnimbus-hygiene";
}

function carrierFollowupAction(review) {
  return reviewOnlyAction(
    review,
    "Confirm carrier receipt / adjuster assignment",
    "Confirm carrier received the claim, capture adjuster/contact info if assigned, and verify the next inspection/status step."
  );
}

function appraisalReviewAction(review) {
  return reviewOnlyAction(
    review,
    "Review appraisal next step",
    "Confirm estimate/payment gap, policy appraisal clause, documents, and whether appraisal demand or appraisal follow-up is the correct next move."
  );
}

function estimateReviewAction(review) {
  return reviewOnlyAction(
    review,
    "Push estimate/photo file forward",
    "Confirm whether estimate/scope is complete, identify what is missing, and push the file to PA review or claim/appraisal next step."
  );
}

function policyCoverageResearchAction(review) {
  return reviewOnlyAction(
    review,
    "Resolve policy/coverage lookup failure",
    "Review the newest policy/dec/TDI documents and prior claim filing attempts; determine whether Andrea needs to get the current active declarations page or whether the claim can be filed with corrected info."
  );
}

function reviewOnlyAction(review, title, description) {
  return {
    channel: "assistant_review",
    action: "review_file",
    executable: false,
    title,
    description,
    reviewCommand: `npm run review:file -- "${review.file.id}"`
  };
}

function jobNimbusTaskAction(review, title, description) {
  return {
    channel: "jobnimbus",
    action: "create_task",
    executable: true,
    title,
    description,
    dryRunCommand: `npm run chat:action -- create_jobnimbus_task '${JSON.stringify({
        query: review.file.id,
        title,
        description
    })}'`
  };
}

function planJobNimbusAction(config, item) {
  if (item.action.action === "create_note") return planJobNimbusNote(config, item);
  return planJobNimbusTask(config, item);
}

function planJobNimbusTask(config, item) {
  return {
    approvalId: item.approvalId,
    actionType: item.actionType,
    file: item.file,
    method: "POST",
    endpoint: config.endpoints.tasks,
    body: {
      title: item.action.title,
      description: item.action.description,
      related: [{ id: item.file.id }],
      record_type_name: "Task"
    }
  };
}

function planJobNimbusNote(config, item) {
  const note = item.action.note;
  return {
    approvalId: item.approvalId,
    actionType: item.actionType,
    file: item.file,
    method: "POST",
    endpoint: config.endpoints.activities,
    body: {
      note,
      date_created: Math.floor(Date.now() / 1000),
      record_type_name: "Note",
      primary: { id: item.file.id }
    },
    policyViolations: notePolicyViolations(note)
  };
}

function ensureCanExecute(config) {
  if (config.useFixtures) {
    throw new Error("Cannot execute JobNimbus writes in fixture mode. Set JOBNIMBUS_USE_FIXTURES=false.");
  }
  if (!config.allowJobNimbusWrites) {
    throw new Error("JobNimbus writes are blocked. Set ALLOW_JOBNIMBUS_WRITES=true and pass execute:true to run approved actions.");
  }
}

function claimPacketAction(review) {
  return {
    channel: "mitra",
    action: "prepare_claim_call_packet",
    executable: false,
    title: "Prepare/send claim filing packet",
    summary: "Prepare the info Mitra/Replit needs to file the claim. This repo does not call Mitra directly.",
    dryRunCommand: `npm run chat:tool -- claim_packet '${JSON.stringify({ query: review.file.id })}'`
  };
}

function quoDraftAction(review, audience, title, message) {
  return {
    channel: "quo",
    action: "send_text",
    executable: false,
    title,
    audience,
    message,
    note: "Do not log this text content in JobNimbus unless explicitly requested."
  };
}

function gmailDraftAction(review, audience, title, message) {
  return {
    channel: "gmail",
    action: "send_email",
    executable: false,
    title,
    audience,
    subjectRule: "Use claim number only when emailing insurance.",
    message
  };
}

function fileSummary(review) {
  const file = review.file;
  return {
    id: file.id,
    name: file.customer,
    status: file.status,
    address: file.address || "",
    carrier: file.carrier || "",
    claimNumber: cleanClaimNumber(file.claimNumber),
    policyNumber: file.policyNumber || "",
    dateOfLoss: file.dateOfLoss || "",
    phase: review.thresherPhase,
    priority: review.priority
  };
}

function isChanceFile(review, contact, chanceUserIds) {
  return isChanceContact(contact, chanceUserIds) || /chance pearson/i.test(String(review.assignedTo || ""));
}

function draftPolicyRequest(file) {
  return `Hi ${firstName(file.customer)}, this is Chance with Wave Public Adjusting. Could you please send me a copy of your policy or declarations page when you get a chance? We need the current coverage and correct insured information so we can keep the file moving.`;
}

function draftClientUpdate(review) {
  return `Hi ${firstName(review.file.customer)}, this is Chance with Wave Public Adjusting. Quick update: I am reviewing your file and pushing the next step forward. I will update you again once I have the next item confirmed.`;
}

function draftAppraisalFollowUp(file) {
  return `Hello, this is Chance Pearson with Wave Public Adjusting regarding ${file.customer}${cleanClaimNumber(file.claimNumber) ? `, claim ${cleanClaimNumber(file.claimNumber)}` : ""}. Please confirm receipt of our appraisal demand and advise the next appraisal step.`;
}

function stageCanRequestPolicy(status) {
  return !/closed|review for close|final/i.test(status || "");
}

function priorityRank(priority) {
  if (priority === "High") return 0;
  if (priority === "Medium") return 1;
  return 2;
}

function recordId(record) {
  return String(record?.jnid || record?.id || "");
}

function cleanClaimNumber(value) {
  return String(value || "")
    .replace(/\bReference\s*#?\b/gi, "")
    .replace(/\bClaim\s*#?:?\s*/gi, "")
    .replace(/\s+#\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMatch(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function firstName(name) {
  return String(name || "there").trim().split(/\s+/)[0] || "there";
}

function parseInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return { _: trimmed };
}

function normalizeIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function minutesSince(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.round((Date.now() - date.getTime()) / 60000);
}

function truthy(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function readOptionalJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return readJson(filePath);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
