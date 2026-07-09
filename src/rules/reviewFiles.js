import { daysBetween, parseDate, todayDate } from "../lib/dates.js";

export function reviewFiles(files, config) {
  const today = todayDate();

  return files
    .map((file) => reviewFile(file, config, today))
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
}

function reviewFile(file, config, today) {
  const missingInfo = [];
  const categories = new Set();
  const signals = [];
  const status = lower(file.status);
  const notesText = lower(file.notes.map((note) => note.body).join(" "));
  const custom = file.customFields || {};
  const lastActivity = parseDate(file.lastActivityDate);
  const daysStale = daysBetween(today, lastActivity);
  const thresherPhase = classifyThresherPhase(file, status, notesText, custom);
  const policyLookupIssue = analyzePolicyLookupIssue(notesText);
  const daysInPhase = numericDays(file.daysInStatus) ?? daysStale;
  const overdueTasks = file.openTasks.filter((task) => {
    const due = parseDate(task.dueDate);
    return due && due < today;
  });
  const appointmentAccess = analyzeAppointmentAccess(file);

  if (!file.carrier) missingInfo.push("Carrier");
  if (!file.claimNumber && claimLikelyFiled(file, notesText, status)) missingInfo.push("Claim number");
  if (!file.dateOfLoss) missingInfo.push("Date of loss");
  if (!file.policyNumber) missingInfo.push("Policy number/declaration page");
  if (policyLookupIssue.blocked) missingInfo.push("Current active policy/declaration page");
  if (hasCarrierOrClaim(file) && !file.adjuster.name && !file.adjuster.phone && !file.adjuster.email) {
    missingInfo.push("Adjuster contact info");
  }
  if (paymentReceived(file) && !file.mortgageCompany && mentionsMortgage(notesText, custom)) {
    missingInfo.push("Mortgage company info");
  }

  if (needsClaimFiled(file, status, notesText)) {
    categories.add("Claims needing filed");
  }
  if (policyLookupIssue.blocked) {
    categories.add("Policy/coverage lookup failed");
    signals.push(policyLookupIssue.signal);
  }
  if (!file.claimNumber && claimLikelyFiled(file, notesText, status)) {
    categories.add("Missing claim numbers");
  }
  if (!file.carrier) {
    categories.add("Missing carrier information");
  }
  if (hasCarrierOrClaim(file) && !hasAdjuster(file)) {
    categories.add("Missing adjuster info");
  }
  if (waitingOnPayment(file, status, custom, notesText)) {
    categories.add("Waiting on payments");
  }
  if (waitingOnHomeowner(file, status, notesText, custom)) {
    categories.add("Waiting on homeowner");
  }
  if (waitingOnCarrier(file, status, notesText, custom)) {
    categories.add("Waiting on carrier");
  }
  addThresherCategories(thresherPhase, daysInPhase, categories, signals);
  if (photoFileEstimateNeeded(file, status, notesText, custom)) {
    categories.add("Photo file / estimate needed");
  }
  if (deniedOrUnderpaid(file, status, notesText, custom)) {
    categories.add("Denied or underpaid claims");
  }
  addAppraisalStageCategories(file, status, notesText, categories);
  if (appraisalCandidate(file, status, notesText, custom)) {
    categories.add("Appraisal candidates");
  }
  if (!hasAppraisalStage(categories) && appraisalInProgress(file, status, notesText, custom)) {
    categories.add("Appraisal in progress");
  }
  if (overdueTasks.length) {
    categories.add("Overdue tasks");
  }
  if (appointmentAccess.risk && appointmentAccessAppliesToCurrentPhase(file, status)) {
    categories.add("Appointment access risk");
    for (const signal of appointmentAccess.signals) signals.push(signal);
  }
  if (daysStale !== undefined && daysStale >= config.staleDays) {
    categories.add("Stale files");
    signals.push(`No activity for ${daysStale} days`);
  }
  if (unclear(file, missingInfo, categories)) {
    categories.add("Files with unclear status");
  }
  if (!categories.size) {
    categories.add("Ready to move forward");
  }

  for (const task of overdueTasks) {
    signals.push(`Overdue task: ${task.title}${task.dueDate ? ` (${task.dueDate})` : ""}`);
  }

  const bottleneck = chooseBottleneck(file, categories, missingInfo, status, notesText, custom);
  const priority = choosePriority({
    categories,
    missingInfo,
    overdueTasks,
    daysStale,
    thresherPhase,
    daysInPhase,
    highPriorityStaleDays: config.highPriorityStaleDays,
    status
  });
  const nextAction = chooseNextAction(file, categories, missingInfo, bottleneck, thresherPhase);
  const suggestedTask = chooseSuggestedTask(file, categories, nextAction, thresherPhase);
  const suggestedInternalNote = buildSuggestedNote(file, bottleneck, nextAction);

  return {
    file,
    priority,
    thresherPhase: thresherPhase.name,
    workflowLane: thresherPhase.lane,
    ownerLane: thresherPhase.ownerLane,
    phaseExpectedDays: thresherPhase.expectedDays,
    daysInPhase,
    categories: [...categories],
    missingInfo,
    bottleneck,
    recommendedNextAction: nextAction,
    suggestedTask,
    suggestedInternalNote,
    overdueTasks,
    appointmentAccess,
    signals,
    assignedTo: firstAssignedTo(file.openTasks)
  };
}

function chooseBottleneck(file, categories, missingInfo, status, notesText, custom) {
  if (categories.has("Check redirection risk")) return "Check redirection/ACV control needs confirmation";
  if (categories.has("Two key confirmations needed")) return "Claim filed but receipt/desk adjuster or check redirection confirmation is missing";
  if (categories.has("Policy/coverage lookup failed")) return "Carrier could not locate active coverage/policy; current dec page or corrected insured/policy information is needed";
  if (categories.has("Appointment access risk")) return "Inspection has prior access/availability issues and needs confirmed homeowner access before another field appointment";
  if (categories.has("Client update due")) return "Homeowner communication should be reviewed before deciding whether an update is actually needed";
  if (categories.has("Phase aging risk")) return "File has aged beyond the expected Thresher timing for its current phase";
  if (categories.has("Claims needing filed")) return "Claim has not been filed or filing status is unclear";
  if (categories.has("Denied or underpaid claims")) return "Claim appears denied or underpaid";
  if (categories.has("Ready for appraisal")) return "Initial ACV/estimate received and file is ready to invoke appraisal";
  if (categories.has("Submitted for appraisal")) return "Appraisal letter submitted; waiting on carrier response or next appraisal step";
  if (categories.has("Carrier appraiser assigned")) return "Carrier appraiser assigned; coordinate appraisal path";
  if (categories.has("Appraisal inspection scheduled")) return "Appraisal inspection is scheduled and needs attendance/document readiness";
  if (categories.has("Appraisal approval awaiting estimate")) return "Appraisal approval received; awaiting revised estimate/scope";
  if (categories.has("Appraisal finalized awaiting ACV")) return "Appraisal finalized; awaiting ACV/payment release";
  if (categories.has("Appraisal in progress")) return "Appraisal is active and needs tracking";
  if (categories.has("Appraisal candidates")) return "Likely appraisal candidate";
  if (categories.has("Photo file / estimate needed")) return "Photo file needs estimate/scope review";
  if (categories.has("Missing claim numbers")) return "Claim appears filed but claim number is missing";
  if (categories.has("Missing carrier information")) return "Carrier information missing";
  if (categories.has("Missing adjuster info")) return "Adjuster contact information missing";
  if (waitingOnCarrier(file, status, notesText, custom)) return "Waiting on carrier/adjuster response";
  if (categories.has("Waiting on payments")) return "Waiting on insurance payment";
  if (categories.has("Waiting on homeowner")) return "Waiting on homeowner decision or confirmation";
  if (paymentReceived(file) && custom.deductibleConfirmed === false) return "Deductible not confirmed";
  if (paymentReceived(file) && custom.mortgagePacketSent === false) return "Mortgage processing not started";
  if (missingInfo.length) return `Missing ${missingInfo[0]}`;
  if (categories.has("Stale files")) return "File needs touch/follow-up";
  return "No obvious bottleneck found";
}

function choosePriority({ categories, missingInfo, overdueTasks, daysStale, thresherPhase, daysInPhase, highPriorityStaleDays }) {
  if (categories.has("Check redirection risk")) return "High";
  if (categories.has("Two key confirmations needed") && daysInPhase !== undefined && daysInPhase >= 3) return "High";
  if (categories.has("Policy/coverage lookup failed")) return "High";
  if (categories.has("Appointment access risk")) return "High";
  if (categories.has("Phase aging risk") && thresherPhase.risk === "high") return "High";
  if (overdueTasks.length >= 2) return "High";
  if (categories.has("Claims needing filed") && daysStale !== undefined && daysStale >= 7) return "High";
  if (categories.has("Missing claim numbers") && overdueTasks.length) return "High";
  if (daysStale !== undefined && daysStale >= highPriorityStaleDays) return "High";
  if (categories.has("Waiting on payments") && daysStale !== undefined && daysStale >= 14) return "High";
  if (categories.has("Denied or underpaid claims") || categories.has("Appraisal candidates")) return daysStale !== undefined && daysStale >= 7 ? "High" : "Medium";
  if (hasAppraisalStage(categories)) return "High";
  if (categories.has("Appraisal in progress")) return "High";
  if (categories.has("Photo file / estimate needed") && daysStale !== undefined && daysStale >= 7) return "High";
  if (categories.has("Client update due") || categories.has("Phase aging risk") || categories.has("Two key confirmations needed")) return "Medium";
  if (overdueTasks.length || missingInfo.length || categories.has("Stale files")) return "Medium";
  return "Low";
}

function chooseNextAction(file, categories, missingInfo, bottleneck, thresherPhase) {
  if (categories.has("Check redirection risk")) return "Confirm ACV/check redirection with carrier and office admin before any payment is released to the client.";
  if (categories.has("Two key confirmations needed")) return "Get both initial confirmations: carrier receipt/desk adjuster assignment and check redirection acknowledgment.";
  if (categories.has("Policy/coverage lookup failed")) return "Obtain the current declarations page or corrected insured/policy information before another filing attempt; route homeowner contact through Andrea unless directed otherwise.";
  if (categories.has("Appointment access risk")) return "Before rescheduling, confirm homeowner availability and interior access; after scheduling, send a day-before confirmation that requires actual homeowner confirmation.";
  if (categories.has("Phase aging risk")) return thresherPhase.nextAction;
  if (categories.has("Claims needing filed")) return "Confirm intake details and file the claim or verify that it has already been filed.";
  if (categories.has("Denied or underpaid claims")) return "Review denial/underpayment facts, compare scope/payment, and decide whether supplement or appraisal is the next move.";
  if (categories.has("Ready for appraisal")) return "Confirm ACV/carrier estimate, policy/appraisal clause, deductible posture, and send or prepare the appraisal demand.";
  if (categories.has("Submitted for appraisal")) return "Confirm appraisal letter delivery, track carrier response, and push for carrier appraiser assignment.";
  if (categories.has("Carrier appraiser assigned")) return "Capture carrier appraiser contact details and coordinate next appraisal meeting or document exchange.";
  if (categories.has("Appraisal inspection scheduled")) return "Confirm inspection date/time, appraiser attendance, photos, ESX/estimate, and homeowner expectations.";
  if (categories.has("Appraisal approval awaiting estimate")) return "Obtain/review revised appraisal estimate and prepare next payment/ACV follow-up.";
  if (categories.has("Appraisal finalized awaiting ACV")) return "Follow up for ACV/payment release and confirm mortgage/deductible handling.";
  if (categories.has("Appraisal in progress")) return "Check appraisal deadlines, appraiser communication, pending documents, and next required follow-up.";
  if (categories.has("Appraisal candidates")) return "Review estimate/payment gap and prepare the appraisal recommendation package.";
  if (categories.has("Photo file / estimate needed")) return "Review photos/documents and prepare or request the estimate/scope needed to advance the file.";
  if (categories.has("Missing claim numbers")) return "Call carrier or homeowner to obtain the claim number, then update the file after approval.";
  if (categories.has("Missing carrier information")) return "Contact homeowner to collect carrier, policy number, and declaration page.";
  if (categories.has("Missing adjuster info")) return "Call carrier claim line and request assigned adjuster contact details.";
  if (categories.has("Waiting on carrier")) return "Follow up with carrier/adjuster for inspection, scope, estimate, or claim status.";
  if (categories.has("Waiting on payments")) return "Follow up with carrier for payment status and expected release date.";
  if (categories.has("Waiting on homeowner")) return "Call or text homeowner with a clear update request.";
  if (categories.has("Client update due")) return "Review recent communication first; only send a homeowner update for appointment/access coordination, missing homeowner documents, or another clear homeowner-facing need.";
  if (categories.has("Overdue tasks")) return "Work or reassign overdue task and log the outcome.";
  if (categories.has("Stale files")) return "Touch the file today and create a clear next follow-up.";
  if (missingInfo.length) return `Collect missing information: ${missingInfo.join(", ")}.`;
  return thresherPhase.nextAction || `Review file manually; bottleneck currently reads: ${bottleneck}.`;
}

function chooseSuggestedTask(file, categories, nextAction, thresherPhase) {
  if (categories.has("Check redirection risk")) return "Confirm check redirection";
  if (categories.has("Two key confirmations needed")) return "Get two key confirmations";
  if (categories.has("Policy/coverage lookup failed")) return "Get current active policy/dec page";
  if (categories.has("Appointment access risk")) return "Confirm homeowner access before inspection";
  if (categories.has("Ready for appraisal")) return "Prepare/send appraisal demand";
  if (categories.has("Submitted for appraisal")) return "Track carrier response to appraisal demand";
  if (categories.has("Carrier appraiser assigned")) return "Coordinate with carrier appraiser";
  if (categories.has("Appraisal inspection scheduled")) return "Prepare appraisal inspection";
  if (categories.has("Appraisal approval awaiting estimate")) return "Get revised appraisal estimate";
  if (categories.has("Appraisal finalized awaiting ACV")) return "Follow up for ACV/payment release";
  if (categories.has("Appraisal in progress")) return "Track appraisal follow-up";
  if (categories.has("Denied or underpaid claims")) return "Review denied/underpaid claim for next move";
  if (categories.has("Photo file / estimate needed")) return "Prepare estimate/scope from photo file";
  if (categories.has("Missing claim numbers")) return "Get claim number from carrier/homeowner";
  if (categories.has("Missing adjuster info")) return "Get adjuster contact info";
  if (categories.has("Claims needing filed")) return "Confirm claim filing status";
  if (categories.has("Waiting on payments")) return "Follow up on payment status";
  if (categories.has("Waiting on homeowner")) return "Follow up with homeowner";
  if (categories.has("Waiting on carrier")) return "Follow up with carrier/adjuster";
  if (categories.has("Appraisal candidates")) return "Review for appraisal";
  if (categories.has("Client update due")) return "Review homeowner communication need";
  if (categories.has("Phase aging risk")) return thresherPhase.task;
  if (categories.has("Stale files")) return "Touch stale file";
  return nextAction.slice(0, 80);
}

function buildSuggestedNote(file, bottleneck, nextAction) {
  return `${bottleneck}. Recommended next step: ${nextAction}`;
}

function needsClaimFiled(file, status, notesText) {
  if (analyzePolicyLookupIssue(notesText).blocked) return false;
  if (photoFileEstimateNeeded(file, status, notesText, file.customFields || {})) return false;
  if (status.includes("appraisal")) return false;
  if (file.claimNumber || status.includes("submitted awaiting confirmation") || status === "submitted") {
    return false;
  }
  if (status.includes("ready for pa review") && !file.claimNumber) return true;
  if (status.includes("new") || status.includes("lead") || status.includes("intake")) return true;
  if (notesText.includes("need to file") || notesText.includes("claim not filed")) return true;
  return !file.claimNumber && !file.carrier && !status.includes("closed");
}

function claimLikelyFiled(file, notesText, status) {
  return status.includes("claim filed") ||
    status.includes("submitted awaiting confirmation") ||
    status === "submitted" ||
    notesText.includes("claim was filed") ||
    notesText.includes("claim filed") ||
    notesText.includes("filed online");
}

function analyzePolicyLookupIssue(notesText) {
  const blocked = POLICY_LOOKUP_FAILURE_PATTERN.test(notesText);
  return {
    blocked,
    signal: blocked ? "Carrier/policy lookup issue found in notes: carrier could not locate policy or active coverage; current dec page/correct insured info needed." : ""
  };
}

function hasCarrierOrClaim(file) {
  return Boolean(file.carrier || file.claimNumber);
}

function hasAdjuster(file) {
  return Boolean(file.adjuster.name || file.adjuster.phone || file.adjuster.email);
}

function waitingOnPayment(file, status, custom, notesText) {
  if (paymentReceived(file)) return false;
  return status.includes("payment") ||
    status.includes("invoice") ||
    status.includes("acv") ||
    status.includes("rcv") ||
    notesText.includes("waiting on payment") ||
    notesText.includes("payment status") ||
    custom.waitingOnPayment === true;
}

function paymentReceived(file) {
  return lower(file.status).includes("payment received") ||
    file.customFields?.paymentReceived === true ||
    (Array.isArray(file.payments) && file.payments.length > 0);
}

function waitingOnHomeowner(file, status, notesText, custom) {
  return status.includes("homeowner") ||
    notesText.includes("homeowner") && (
      notesText.includes("waiting") ||
      notesText.includes("confirm") ||
      notesText.includes("need")
    ) ||
    custom.deductibleConfirmed === false;
}

function waitingOnCarrier(file, status, notesText, custom) {
  if (photoFileEstimateNeeded(file, status, notesText, custom)) return false;
  return status.includes("carrier") ||
    status.includes("inspection") ||
    status.includes("estimate") ||
    notesText.includes("waiting on adjuster") ||
    notesText.includes("waiting on carrier") ||
    custom.estimateReceived === false;
}

function appraisalCandidate(file, status, notesText, custom) {
  if (appraisalInProgress(file, status, notesText, custom)) return false;
  return status.includes("appraisal") ||
    deniedOrUnderpaid(file, status, notesText, custom) ||
    /\b(?:ready|proceed|push|submit|submitted|sent|invoke|invoked)\s+(?:to\s+)?appraisal\b/i.test(notesText) ||
    /\bappraisal\s+(?:demand|letter|package|request|submitted|sent|invoked)\b/i.test(notesText) ||
    notesText.includes("supplement denied") ||
    notesText.includes("low offer") ||
    notesText.includes("lowball") ||
    custom.appraisalCandidate === true;
}

function photoFileEstimateNeeded(file, status, notesText, custom) {
  return status.includes("photo file") ||
    status.includes("estimate needed") ||
    lower(file.estimateStatus).includes("needed") ||
    custom.estimateNeeded === true;
}

function appointmentAccessAppliesToCurrentPhase(file, status) {
  if (status.includes("photo file") || status.includes("estimate needed")) return true;
  if (status.includes("appointment") || status.includes("meeting") || status.includes("inspection")) return true;
  return (file.openTasks || []).some((task) => {
    const due = parseDate(task.dueDate);
    return due && due >= todayDate() && /inspection|appointment|meeting|reinspection/i.test(`${task.title || ""} ${task.description || ""}`);
  });
}

function deniedOrUnderpaid(file, status, notesText, custom) {
  const denialText = lower(file.denialStatus);
  return status.includes("denied") ||
    status.includes("underpaid") ||
    notesText.includes("denied") ||
    notesText.includes("underpaid") ||
    notesText.includes("partial denial") ||
    notesText.includes("coverage denial") ||
    notesText.includes("low offer") ||
    notesText.includes("lowball") ||
    denialText.includes("denied") ||
    denialText.includes("underpaid") ||
    custom.denied === true ||
    custom.underpaid === true;
}

function appraisalInProgress(file, status, notesText, custom) {
  const appraisalStatus = lower(file.appraisalStatus);
  return status.includes("appraisal") && !status.includes("candidate") ||
    appraisalStatus.includes("filed") ||
    appraisalStatus.includes("demand") ||
    appraisalStatus.includes("pending") ||
    notesText.includes("appraisal invoked") ||
    notesText.includes("appraisal filed") ||
    notesText.includes("appraisal letter sent") ||
    custom.appraisalInProgress === true;
}

function addAppraisalStageCategories(file, status, notesText, categories) {
  if (status.includes("ready for appraisal") || notesText.includes("ready for appraisal")) {
    categories.add("Ready for appraisal");
    return;
  }
  if (status.includes("submitted for appraisal") || notesText.includes("appraisal letter sent")) {
    categories.add("Submitted for appraisal");
    return;
  }
  if (status.includes("carrier appraiser assigned")) {
    categories.add("Carrier appraiser assigned");
    return;
  }
  if (status.includes("meeting scheduled") || status.includes("inspection scheduled") || notesText.includes("reinspection")) {
    categories.add("Appraisal inspection scheduled");
    return;
  }
  if (status.includes("initial approval") || status.includes("awaiting estimate")) {
    categories.add("Appraisal approval awaiting estimate");
    return;
  }
  if (status.includes("finalized") || status.includes("awaiting acv")) {
    categories.add("Appraisal finalized awaiting ACV");
  }
}

function addThresherCategories(phase, daysInPhase, categories, signals) {
  categories.add(`Thresher: ${phase.name}`);

  if (phase.needsTwoConfirmations) {
    categories.add("Two key confirmations needed");
  }
  if (phase.checkRisk) {
    categories.add("Check redirection risk");
  }
  if (phase.clientUpdateDue) {
    categories.add("Client update due");
  }
  if (daysInPhase !== undefined && phase.expectedDays && daysInPhase > phase.expectedDays) {
    categories.add("Phase aging risk");
    signals.push(`${phase.name} phase has aged ${daysInPhase} days; expected ${phase.expectedDays} or fewer`);
  }
}

function classifyThresherPhase(file, status, notesText, custom) {
  const lastClientTouch = latestClientTouchDays(file);
  const clientUpdateDue = lastClientTouch === undefined
    ? status !== "lost" && status !== "hold/closed"
    : lastClientTouch >= 14;

  if (status.includes("lost") || status.includes("hold/closed") || status.includes("review for close")) {
    return phase("Closeout / Hold", "Closeout", "IPA / Supervisor", 14, "Review closeout reason, payment status, and final client communication before archiving.", "Close or problem-review file", { clientUpdateDue: false });
  }
  if (status.includes("photo file") || status.includes("estimate needed")) {
    return phase("Photo File / Estimate Build", "Estimating", "Estimator", 5, "Audit photo completeness, request missing photos/measurements, and push estimate preparation.", "Push photo file to estimate", { clientUpdateDue });
  }
  if (status.includes("ready for pa review")) {
    return phase("PA Estimate Review", "Estimating", "IPA", 3, "Review Xactimate/scope for completeness, bid items, and claim filing readiness.", "Review estimate for completeness", { clientUpdateDue });
  }
  if (status.includes("submitted awaiting confirmation") || status === "submitted") {
    return phase("Two Key Confirmations", "Claim Filing", "IPA", 2, "Confirm carrier receipt/desk adjuster assignment and check redirection acknowledgment.", "Get two key confirmations", {
      needsTwoConfirmations: true,
      checkRisk: true,
      clientUpdateDue
    });
  }
  if (status.includes("negotiating") || status.includes("hot/final negotiation")) {
    return phase("Carrier Negotiation", "Negotiation", "IPA", 7, "Call carrier/adjuster, compare scope/payment gap, and decide supplement, second adjustment, or appraisal.", "Push carrier negotiation", { clientUpdateDue });
  }
  if (status.includes("awaiting acv")) {
    return phase("Awaiting ACV / Payment Control", "Payment", "Office Admin / IPA", 5, "Confirm payment status, check redirection, mortgage handling, and expected arrival date.", "Follow up on ACV/payment", {
      checkRisk: true,
      clientUpdateDue
    });
  }
  if (status.includes("ready for appraisal")) {
    return phase("Ready for Appraisal", "Appraisal", "IPA", 3, "Confirm appraisal package, policy clause, estimate/payment gap, and send the demand.", "Prepare/send appraisal demand", { clientUpdateDue });
  }
  if (status.includes("submitted for appraisal")) {
    return phase("Appraisal Submitted", "Appraisal", "IPA", 5, "Confirm carrier acknowledgment and push for carrier appraiser assignment.", "Track carrier appraiser assignment", { clientUpdateDue });
  }
  if (status.includes("carrier appraiser assigned")) {
    return phase("Carrier Appraiser Assigned", "Appraisal", "Appraiser / IPA", 5, "Collect appraiser contact info and coordinate inspection/document exchange.", "Coordinate carrier appraiser", { clientUpdateDue });
  }
  if (status.includes("meeting scheduled") || status.includes("inspection scheduled")) {
    return phase("Appraisal Meeting Scheduled", "Appraisal", "Appraiser / IPA", 4, "Confirm meeting logistics, appraiser attendance, estimate, photos, and client expectations.", "Prepare appraisal meeting", { clientUpdateDue });
  }
  if (status.includes("initial approval") || status.includes("awaiting estimate")) {
    return phase("Appraisal Approval / Scope Pending", "Appraisal", "Appraiser / Estimator", 5, "Obtain revised appraisal scope/award draft and prepare payment follow-up.", "Get revised appraisal scope", { clientUpdateDue });
  }
  if (status.includes("umpire")) {
    return phase("Umpire", "Appraisal", "Appraiser / Supervisor", 7, "Track umpire appointment, submissions, deadlines, and escalation needs.", "Track umpire status", { clientUpdateDue });
  }
  if (status.includes("finalized")) {
    return phase("Finalized / Awaiting Appraisal ACV", "Payment", "Office Admin / IPA", 5, "Confirm signed award, ACV release, redirection, mortgage handling, and final payment path.", "Collect appraisal ACV", {
      checkRisk: true,
      clientUpdateDue
    });
  }
  if (status.includes("lead") || status.includes("appointment") || status.includes("need paperwork") || status.includes("contracted")) {
    return phase("Intake / Paperwork", "Intake", "Sales / Client Coordinator", 5, "Confirm paperwork, client fit, damage type, carrier/policy details, and appointment path.", "Complete intake/paperwork", { clientUpdateDue });
  }
  if (notesText.includes("appraisal")) {
    return phase("Appraisal Tracking", "Appraisal", "IPA", 7, "Review appraisal notes and identify the next blocked party or deadline.", "Review appraisal tracking", { clientUpdateDue });
  }
  if (custom.paymentReceived === true || file.payments.length) {
    return phase("Payment / Closeout", "Payment", "Office Admin / IPA", 7, "Verify payment, deductible/mortgage handling, production or closeout path, and client update.", "Verify payment/closeout", { clientUpdateDue });
  }
  return phase("Manual Review", "Problem File", "IPA / Supervisor", 7, "Review the file manually and set a concrete next task, owner, and follow-up date.", "Manual file review", { clientUpdateDue });
}

function phase(name, lane, ownerLane, expectedDays, nextAction, task, flags = {}) {
  return {
    name,
    lane,
    ownerLane,
    expectedDays,
    nextAction,
    task,
    risk: ["Payment", "Appraisal", "Problem File"].includes(lane) ? "high" : "normal",
    ...flags
  };
}

function hasAppraisalStage(categories) {
  return [
    "Ready for appraisal",
    "Submitted for appraisal",
    "Carrier appraiser assigned",
    "Appraisal inspection scheduled",
    "Appraisal approval awaiting estimate",
    "Appraisal finalized awaiting ACV"
  ].some((category) => categories.has(category));
}

function mentionsMortgage(notesText, custom) {
  return notesText.includes("mortgage") ||
    custom.mortgagePacketSent === false ||
    custom.mortgageNeeded === true;
}

function unclear(file, missingInfo, categories) {
  return lower(file.status) === "unknown" ||
    (missingInfo.length >= 3 && categories.size <= 2);
}

function priorityRank(priority) {
  return { High: 0, Medium: 1, Low: 2 }[priority] ?? 3;
}

function firstAssignedTo(tasks) {
  return tasks.find((task) => task.assignedTo)?.assignedTo || "";
}

function latestClientTouchDays(file) {
  const clientNotes = file.notes
    .filter((note) => /client|homeowner|ho\b|called|text|emailed|spoke|updated/i.test(note.body || ""))
    .map((note) => parseDate(note.createdAt))
    .filter(Boolean);
  if (!clientNotes.length) return undefined;
  return daysBetween(todayDate(), new Date(Math.max(...clientNotes.map((date) => date.getTime()))));
}

function analyzeAppointmentAccess(file) {
  const appointmentTasks = (file.openTasks || []).filter((task) => /inspection|appointment|meeting|reinspection/i.test(`${task.title || ""} ${task.description || ""}`));
  const noteMatches = (file.notes || [])
    .map((note) => cleanSignal(note.body))
    .filter((text) => APPOINTMENT_ACCESS_PATTERN.test(text))
    .slice(0, 4);
  const taskSignals = appointmentTasks
    .slice(0, 4)
    .map((task) => `${task.title}${task.dueDate ? ` due ${task.dueDate}` : ""}`);
  const risk = Boolean(noteMatches.length && appointmentTasks.length) || noteMatches.length >= 2 || appointmentTasks.length >= 2;
  const signals = [];
  if (appointmentTasks.length) signals.push(`Appointment/inspection tasks found: ${taskSignals.join("; ")}`);
  for (const match of noteMatches) signals.push(`Access/availability history: ${match}`);
  return {
    risk,
    appointmentTaskCount: appointmentTasks.length,
    accessHistoryCount: noteMatches.length,
    signals
  };
}

const APPOINTMENT_ACCESS_PATTERN = /\b(not available|won'?t be available|no access|no one|nobody|not home|doorbell|reschedul|negative results|attempted to schedule|missed appointment|no[- ]show|could not access|unable to access|access issue|confirm.*access)\b/i;
const POLICY_LOOKUP_FAILURE_PATTERN = /\b(couldn'?t find (?:a )?policy|could not find (?:a )?policy|can'?t find (?:a )?policy|cannot find (?:a )?policy|could not locate active coverage|couldn'?t locate active coverage|could not locate (?:the )?policy|couldn'?t locate (?:the )?policy|different name|different policy number|current active policy|current.*declarations?|deck page|dec page.*current|policy.*does not include.*dol)\b/i;

function cleanSignal(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function numericDays(value) {
  const number = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function lower(value) {
  return String(value || "").toLowerCase();
}
