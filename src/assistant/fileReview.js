import fs from "node:fs";
import path from "node:path";
import { parseDate } from "../lib/dates.js";
import { readJson } from "../lib/io.js";

export function runSearch(config, query) {
  const reviews = loadReviews(config);
  const matches = findMatches(reviews, query).slice(0, 15);

  if (!query) {
    console.log("Usage: npm run search -- \"client name, claim number, address, carrier, or JobNimbus id\"");
    return;
  }

  if (!matches.length) {
    console.log(`No matching files found for: ${query}`);
    return;
  }

  console.log(`Matches for: ${query}`);
  for (const [index, review] of matches.entries()) {
    console.log(`${index + 1}. ${review.file.customer} | ${review.file.status} | ${review.thresherPhase} | ${review.file.claimNumber || "no claim #"} | ${review.file.carrier || "no carrier"} | ${review.file.id}`);
  }
}

export function runFileReview(config, query) {
  if (!query) {
    console.log("Usage: npm run review:file -- \"client name, claim number, address, carrier, or JobNimbus id\"");
    return;
  }

  const reviews = loadReviews(config);
  const matches = findMatches(reviews, query);

  if (!matches.length) {
    console.log(`No matching files found for: ${query}`);
    return;
  }

  const review = matches[0];
  const alternateMatches = matches.slice(1, 6);

  console.log(buildFileReview(review, alternateMatches));
}

export function loadReviews(config) {
  const reviewsPath = selectReviewsPath(config);
  if (!reviewsPath) {
    throw new Error("No normalized reviews found. Run `npm run sweep` or `npm run chance:sweep` first.");
  }
  return readJson(reviewsPath);
}

function selectReviewsPath(config) {
  const companyPath = path.join(config.paths.normalizedDir, "reviews.json");
  const chancePath = path.join(config.paths.normalizedDir, "chance-reviews.json");
  const scope = String(config.reviewScope || "auto").toLowerCase();

  if (scope === "company" || scope === "all") {
    if (!fs.existsSync(companyPath)) throw new Error("No company normalized reviews found. Run `npm run sweep` first.");
    return companyPath;
  }

  if (scope === "chance") {
    if (!fs.existsSync(chancePath)) throw new Error("No Chance normalized reviews found. Run `npm run chance:sweep` first.");
    return chancePath;
  }

  const candidates = [companyPath, chancePath]
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      path: candidate,
      mtimeMs: fs.statSync(candidate).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.path || "";
}

export function findMatches(reviews, query) {
  const term = normalize(query);
  if (!term) return [];

  return reviews
    .map((review) => ({ review, score: scoreReview(review, term) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.review.file.customer.localeCompare(b.review.file.customer))
    .map((item) => item.review);
}

function scoreReview(review, term) {
  const file = review.file;
  let score = 0;
  score += scoreField(file.id, term, 120);
  score += scoreField(file.number, term, 120);
  score += scoreField(file.claimNumber, term, 110);
  score += scoreField(file.customer, term, 100);
  score += scoreField(file.address, term, 80);
  score += scoreField(file.carrier, term, 60);
  score += scoreField(file.policyNumber, term, 40);
  score += scoreField(file.status, term, 20);
  score += scoreField(review.thresherPhase, term, 20);
  return score;
}

function scoreField(value, term, weight) {
  const text = normalize(value);
  if (!text) return 0;
  if (text === term) return weight * 2;
  if (text.startsWith(term)) return weight;
  if (text.includes(term)) return Math.round(weight * 0.7);
  return 0;
}

export function buildFileReview(review, alternateMatches = []) {
  const file = review.file;
  const timeline = buildTimeline(file);
  const recentNotes = timeline.filter((item) => item.kind === "note").slice(0, 8);
  const nextActions = buildNextActions(review);
  const lines = [];

  lines.push(`# File Review: ${file.customer}`);
  lines.push("");
  lines.push(`JobNimbus id: ${file.id}`);
  lines.push(`Status: ${file.status}`);
  lines.push(`Thresher phase: ${review.thresherPhase}`);
  lines.push(`Workflow lane: ${review.workflowLane}`);
  lines.push(`Owner lane: ${review.ownerLane}`);
  lines.push(`Priority: ${review.priority}`);
  lines.push(`Last activity: ${file.lastActivityDate || "Unknown"}`);
  lines.push("");

  lines.push("## Claim Snapshot");
  lines.push(`- Address: ${file.address || "Unknown"}`);
  lines.push(`- Carrier: ${file.carrier || "Missing"}`);
  lines.push(`- Claim number: ${file.claimNumber || "Missing"}`);
  lines.push(`- Policy number: ${file.policyNumber || "Missing"}`);
  lines.push(`- Date of loss: ${file.dateOfLoss || "Missing"}`);
  lines.push(`- Type of loss: ${file.typeOfLoss || "Unknown"}`);
  lines.push(`- Deductible: ${file.deductibleAmount || "Unknown"}`);
  lines.push(`- Adjuster: ${formatAdjuster(file)}`);
  lines.push("");

  lines.push("## Assistant Read");
  lines.push(`Main issue: ${review.bottleneck}.`);
  lines.push(`Risk flags: ${review.categories.filter(isRiskCategory).join(", ") || "None obvious from synced data"}.`);
  lines.push(`Missing info: ${review.missingInfo.join(", ") || "None obvious"}.`);
  if (review.signals?.length) {
    lines.push(`Signals: ${review.signals.join("; ")}.`);
  }
  lines.push("");

  if (review.appointmentAccess?.risk || review.appointmentAccess?.signals?.length) {
    lines.push("## Appointment / Access Review");
    lines.push(`- Risk: ${review.appointmentAccess.risk ? "Yes" : "No obvious repeat access pattern"}`);
    lines.push(`- Appointment task count: ${review.appointmentAccess.appointmentTaskCount || 0}`);
    lines.push(`- Access/history signal count: ${review.appointmentAccess.accessHistoryCount || 0}`);
    for (const signal of review.appointmentAccess.signals || []) {
      lines.push(`- ${signal}`);
    }
    if (review.appointmentAccess.risk) {
      lines.push("- Required control: confirm homeowner availability and interior access before rescheduling; send a day-before confirmation that requires an actual response.");
    }
    lines.push("");
  }

  lines.push("## Next 3 Actions");
  for (const [index, action] of nextActions.entries()) {
    lines.push(`${index + 1}. ${action}`);
  }
  lines.push("");

  lines.push("## Suggested JobNimbus Note");
  lines.push(review.suggestedInternalNote);
  lines.push("");

  lines.push("## Open Tasks");
  if (!file.openTasks.length) {
    lines.push("- None found.");
  } else {
    for (const task of file.openTasks.slice(0, 12)) {
      lines.push(`- ${task.title}${task.dueDate ? ` | due ${task.dueDate}` : ""}${task.assignedTo ? ` | ${task.assignedTo}` : ""}`);
    }
  }
  lines.push("");

  lines.push("## Payments");
  if (!file.payments.length) {
    lines.push("- None found in synced payment data.");
  } else {
    for (const payment of file.payments) {
      lines.push(`- ${payment.amount || "Unknown amount"}${payment.date ? ` | ${payment.date}` : ""}`);
    }
  }
  lines.push("");

  lines.push("## Documents");
  if (!file.documents.length) {
    lines.push("- None found in synced document metadata.");
  } else {
    lines.push(`- ${file.documents.length} synced document/file records.`);
    for (const document of file.documents.slice(0, 10)) {
      lines.push(`- ${document.name}${document.type ? ` | ${document.type}` : ""}`);
    }
  }
  lines.push("");

  lines.push("## Recent Timeline");
  if (!timeline.length) {
    lines.push("- No related notes/tasks/documents/payments found in synced data.");
  } else {
    for (const item of timeline.slice(0, 18)) {
      lines.push(`- ${item.date || "Unknown date"} | ${item.label}: ${item.text}`);
    }
  }
  lines.push("");

  lines.push("## Recent Notes");
  if (!recentNotes.length) {
    lines.push("- No notes found in synced activity data.");
  } else {
    for (const note of recentNotes) {
      lines.push(`- ${note.date || "Unknown date"}: ${note.text}`);
    }
  }

  if (alternateMatches.length) {
    lines.push("");
    lines.push("## Other Possible Matches");
    for (const match of alternateMatches) {
      lines.push(`- ${match.file.customer} | ${match.file.status} | ${match.file.claimNumber || "no claim #"} | ${match.file.id}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function buildNextActions(review) {
  const actions = [];
  addUnique(actions, review.recommendedNextAction);

  if (review.categories.includes("Check redirection risk")) {
    addUnique(actions, "Verify check redirection/ACV handling with the carrier and office admin before money leaves the carrier.");
  }
  if (review.categories.includes("Two key confirmations needed")) {
    addUnique(actions, "Confirm carrier receipt/desk adjuster assignment and check redirection acknowledgment.");
  }
  if (review.categories.includes("Appointment access risk") && !/homeowner availability|interior access|day-before confirmation/i.test(review.recommendedNextAction || "")) {
    addUnique(actions, "Confirm homeowner availability/interior access before rescheduling, then send a day-before confirmation requiring an actual response.");
  }
  if (review.overdueTasks.length) {
    addUnique(actions, `Clear or reassign overdue task: ${review.overdueTasks[0].title}.`);
  }
  if (review.categories.includes("Client update due")) {
    addUnique(actions, "Update the client and log the communication in JobNimbus.");
  }
  if (review.missingInfo.length) {
    addUnique(actions, `Collect missing info: ${review.missingInfo.join(", ")}.`);
  }
  addUnique(actions, `Create/update task: ${review.suggestedTask}.`);

  return actions.slice(0, 3);
}

function buildTimeline(file) {
  const items = [];

  for (const note of file.notes || []) {
    if (!note.body) continue;
    items.push({
      kind: "note",
      label: "Note/activity",
      date: dateOnly(note.createdAt),
      sortDate: parseDate(note.createdAt),
      text: truncate(cleanText(note.body), 220)
    });
  }

  for (const task of file.openTasks || []) {
    items.push({
      kind: "task",
      label: "Open task",
      date: task.dueDate || "",
      sortDate: parseDate(task.dueDate),
      text: truncate(`${task.title}${task.assignedTo ? ` (${task.assignedTo})` : ""}`, 180)
    });
  }

  for (const payment of file.payments || []) {
    items.push({
      kind: "payment",
      label: "Payment",
      date: payment.date || "",
      sortDate: parseDate(payment.date),
      text: `${payment.amount || "Unknown amount"}`
    });
  }

  for (const document of file.documents || []) {
    items.push({
      kind: "document",
      label: "Document",
      date: "",
      sortDate: undefined,
      text: truncate(document.name || "Document", 180)
    });
  }

  return items.sort((a, b) => {
    const aTime = a.sortDate?.getTime() || 0;
    const bTime = b.sortDate?.getTime() || 0;
    return bTime - aTime;
  });
}

function isRiskCategory(category) {
  return [
    "Check redirection risk",
    "Two key confirmations needed",
    "Appointment access risk",
    "Client update due",
    "Phase aging risk",
    "Overdue tasks",
    "Stale files",
    "Missing claim numbers",
    "Missing carrier information",
    "Missing adjuster info",
    "Waiting on payments",
    "Waiting on carrier",
    "Waiting on homeowner",
    "Denied or underpaid claims",
    "Appraisal candidates"
  ].includes(category);
}

function addUnique(items, value) {
  if (value && !items.includes(value)) items.push(value);
}

function formatAdjuster(file) {
  const parts = [file.adjuster?.name, file.adjuster?.phone, file.adjuster?.email].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Missing";
}

function dateOnly(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : "";
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
