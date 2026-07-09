import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, writeText } from "../lib/io.js";
import { loadReviews } from "./fileReview.js";
import { findChanceUserIds, isChanceContact } from "../lib/chanceScope.js";

const LEDGER_VERSION = 1;

export function runFileLedger(config, args = []) {
  const input = parseArgs(args);
  const scope = input.scope || "chance";
  const reviews = loadLedgerReviews(config, scope);
  const scopedRawDir = path.join(config.paths.rawDir, "chance");
  const rawContacts = readOptionalJson(path.join(scopedRawDir, "contacts.json"), readOptionalJson(path.join(config.paths.rawDir, "contacts.json"), []));
  const rawUsersPayload = readOptionalJson(path.join(scopedRawDir, "accountUsers.json"), readOptionalJson(path.join(config.paths.rawDir, "accountUsers.json"), []));
  const chanceUserIds = findChanceUserIds(rawUsersPayload);
  const rawById = new Map(rawContacts.map((contact) => [contact.jnid, contact]));

  const previousPath = path.join(config.projectRoot, "work", "claim-brain", "claim-ledger.json");
  const previous = readOptionalJson(previousPath, { version: LEDGER_VERSION, files: {} });
  const next = {
    version: LEDGER_VERSION,
    scope,
    generatedAt: new Date().toISOString(),
    source: "fresh/local JobNimbus normalized reviews + preserved local ledger notes",
    files: {}
  };

  const scopedReviews = reviews
    .filter((review) => scope !== "chance" || isChanceFile(review, rawById.get(review.file.id), chanceUserIds))
    .sort((a, b) => String(a.file.number || "").localeCompare(String(b.file.number || ""), undefined, { numeric: true }));

  for (const review of scopedReviews) {
    const raw = rawById.get(review.file.id) || {};
    const old = previous.files?.[review.file.id] || {};
    next.files[review.file.id] = mergeLedgerEntry(old, review, raw);
  }

  fs.mkdirSync(path.dirname(previousPath), { recursive: true });
  writeJson(previousPath, next);
  writeText(path.join(config.paths.reportsDir, "claim-brain-ledger.md"), buildLedgerMarkdown(next));
  writeJson(path.join(config.paths.reportsDir, "claim-brain-ledger.json"), next);

  console.log(`Claim brain ledger built:`);
  console.log(`- ${previousPath}`);
  console.log(`- ${path.join(config.paths.reportsDir, "claim-brain-ledger.md")}`);
  console.log("");
  console.log(summary(next));
}

function mergeLedgerEntry(old, review, raw) {
  const file = review.file;
  const blockers = blockersFor(review);
  const phase = operationalPhase(review);
  const checklist = checklistFor(review, phase, blockers);
  const preserved = {
    humanNotes: old.humanNotes || "",
    userInstructions: old.userInstructions || [],
    verifiedOverrides: old.verifiedOverrides || {},
    completedChecks: old.completedChecks || {},
    doNotDo: old.doNotDo || []
  };

  return {
    id: file.id,
    number: file.number,
    customer: file.customer,
    ownerScope: "Chance Pearson",
    refreshedAt: new Date().toISOString(),
    observed: {
      status: file.status,
      thresherPhase: review.thresherPhase,
      workflowLane: review.workflowLane,
      ownerLane: review.ownerLane,
      priority: review.priority,
      lastActivityDate: file.lastActivityDate || "",
      address: file.address || "",
      phone: contactPhone(raw),
      email: raw.email || "",
      carrier: file.carrier || "",
      policyNumber: file.policyNumber || "",
      claimNumber: cleanClaim(file.claimNumber),
      dateOfLoss: file.dateOfLoss || "",
      typeOfLoss: file.typeOfLoss || "",
      deductibleAmount: file.deductibleAmount || "",
      adjuster: [file.adjuster?.name, file.adjuster?.phone, file.adjuster?.email].filter(Boolean).join(" / "),
      openTasks: file.openTasks || [],
      documentCount: file.documents?.length || 0,
      recentNotes: (file.notes || []).slice(0, 8).map((note) => ({
        createdAt: note.createdAt,
        body: String(note.body || "").replace(/\s+/g, " ").trim().slice(0, 500)
      }))
    },
    brain: {
      operationalPhase: phase,
      blockers,
      nextAction: review.recommendedNextAction,
      suggestedTask: review.suggestedTask,
      categories: review.categories.filter((category) => !category.startsWith("Thresher:")),
      missingInfo: review.missingInfo,
      checklist,
      evidenceSignals: review.signals || [],
      confidence: confidenceFor(review, blockers)
    },
    preserved
  };
}

function blockersFor(review) {
  const blockers = [];
  if (review.categories.includes("Policy/coverage lookup failed")) blockers.push("carrier_could_not_locate_policy_or_active_coverage");
  if (review.missingInfo.includes("Carrier")) blockers.push("missing_carrier");
  if (review.missingInfo.includes("Policy number/declaration page")) blockers.push("missing_policy_or_dec_page");
  if (review.missingInfo.includes("Current active policy/declaration page")) blockers.push("needs_current_active_policy_or_dec_page");
  if (review.missingInfo.includes("Date of loss")) blockers.push("missing_date_of_loss");
  if (review.categories.includes("Appointment access risk")) blockers.push("appointment_access_risk");
  if (review.file.claimNumber && !review.file.adjuster?.name && !review.file.adjuster?.phone && !review.file.adjuster?.email) blockers.push("missing_adjuster_after_claim");
  return [...new Set(blockers)];
}

function operationalPhase(review) {
  const file = review.file;
  if (review.categories.includes("Policy/coverage lookup failed")) return "policy_lookup_failed";
  if (review.thresherPhase === "Appraisal Submitted") return "submitted_for_appraisal";
  if (review.categories.includes("Submitted for appraisal")) return "submitted_for_appraisal";
  if (review.categories.includes("Ready for appraisal")) return "ready_for_appraisal";
  if (file.claimNumber) return "claim_filed_follow_up";
  if (!file.carrier || !file.policyNumber) return "missing_policy_or_carrier";
  if (!file.dateOfLoss) return "needs_dol_before_claim";
  if (file.status === "Ready for PA Review") return "claim_filing_candidate";
  return review.thresherPhase || "manual_review";
}

function checklistFor(review, phase, blockers) {
  const file = review.file;
  return {
    contactInfo: Boolean(contactPhone(file.source?.contact || {}) || file.address),
    carrierKnown: Boolean(file.carrier),
    policyKnown: Boolean(file.policyNumber),
    activePolicyVerified: !blockers.includes("carrier_could_not_locate_policy_or_active_coverage") && !blockers.includes("needs_current_active_policy_or_dec_page"),
    dateOfLossKnown: Boolean(file.dateOfLoss),
    estimateUploaded: (file.documents || []).some((doc) => /estimate|final draft|deprec|\.esx/i.test(doc.name || "")),
    claimFiled: Boolean(file.claimNumber),
    adjusterKnown: Boolean(file.adjuster?.name || file.adjuster?.phone || file.adjuster?.email),
    appraisalDemandSent: phase === "submitted_for_appraisal" || (file.notes || []).some((note) => /appraisal demand sent|appraisal letter submitted|appraisal letter sent/i.test(note.body || "")),
    nextTaskExists: Boolean(file.openTasks?.length)
  };
}

function confidenceFor(review, blockers) {
  if (blockers.includes("carrier_could_not_locate_policy_or_active_coverage")) return "high_blocker";
  if (review.signals?.length || review.file.notes?.length) return "medium_from_file_activity";
  return "field_only_low";
}

function buildLedgerMarkdown(ledger) {
  const rows = Object.values(ledger.files);
  const lines = ["# Claim Brain Ledger", "", `Generated: ${ledger.generatedAt}`, ""];
  lines.push("| # | Client | Phase | Status | Carrier | Policy | Claim | DOL | Blockers | Next action |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(`| ${row.number || ""} | ${row.customer} | ${row.brain.operationalPhase} | ${row.observed.status} | ${row.observed.carrier || ""} | ${row.observed.policyNumber || ""} | ${row.observed.claimNumber || ""} | ${row.observed.dateOfLoss || ""} | ${row.brain.blockers.join(", ")} | ${row.brain.nextAction} |`);
  }
  return `${lines.join("\n")}\n`;
}

function summary(ledger) {
  const rows = Object.values(ledger.files);
  const counts = rows.reduce((acc, row) => {
    acc[row.brain.operationalPhase] = (acc[row.brain.operationalPhase] || 0) + 1;
    return acc;
  }, {});
  return JSON.stringify({ fileCount: rows.length, phases: counts }, null, 2);
}

function isChanceFile(review, rawContact, chanceUserIds) {
  return isChanceContact(rawContact, chanceUserIds);
}

function contactPhone(raw) {
  return [raw.mobile_phone, raw.home_phone, raw.work_phone].filter(Boolean).join(" / ");
}

function cleanClaim(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(args) {
  const input = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--scope") input.scope = args[++i];
  }
  return input;
}

function readOptionalJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return readJson(filePath);
}

function loadLedgerReviews(config, scope) {
  if (scope === "chance") {
    const chanceReviewsPath = path.join(config.paths.normalizedDir, "chance-reviews.json");
    if (fs.existsSync(chanceReviewsPath)) return readJson(chanceReviewsPath);
  }
  return loadReviews(config);
}
