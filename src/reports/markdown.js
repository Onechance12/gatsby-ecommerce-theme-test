import path from "node:path";
import { writeText } from "../lib/io.js";

const REPORT_SECTIONS = [
  "Do today",
  "Check redirection risk",
  "Two key confirmations needed",
  "Client update due",
  "Phase aging risk",
  "High-priority files",
  "Claims needing filed",
  "Missing claim numbers",
  "Missing carrier information",
  "Missing adjuster info",
  "Waiting on payments",
  "Waiting on homeowner",
  "Waiting on carrier",
  "Photo file / estimate needed",
  "Denied or underpaid claims",
  "Ready for appraisal",
  "Submitted for appraisal",
  "Carrier appraiser assigned",
  "Appraisal inspection scheduled",
  "Appraisal approval awaiting estimate",
  "Appraisal finalized awaiting ACV",
  "Appraisal candidates",
  "Appraisal in progress",
  "Overdue tasks",
  "Stale files",
  "Files with unclear status",
  "Ready to move forward"
];

export function writeMarkdownReport(config, reviews, options = {}) {
  const basename = options.basename || "jobnimbus-sweep";
  const title = options.title || "JobNimbus Operations Sweep";
  const filePath = path.join(config.paths.reportsDir, `${basename}.md`);
  writeText(filePath, buildMarkdown(config, reviews, title));
  return filePath;
}

function buildMarkdown(config, reviews, title) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Mode: ${config.useFixtures ? "Fixture/sample data" : "Live read-only API"}`);
  lines.push("");
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(`- Files reviewed: ${reviews.length}`);
  lines.push(`- High priority: ${countWhere(reviews, (review) => review.priority === "High")}`);
  lines.push(`- Medium priority: ${countWhere(reviews, (review) => review.priority === "Medium")}`);
  lines.push(`- Low priority: ${countWhere(reviews, (review) => review.priority === "Low")}`);
  lines.push(`- Files with overdue tasks: ${countWhere(reviews, (review) => review.overdueTasks.length > 0)}`);
  lines.push(`- Stale files: ${countCategory(reviews, "Stale files")}`);
  lines.push(`- Check redirection risk: ${countCategory(reviews, "Check redirection risk")}`);
  lines.push(`- Two key confirmations needed: ${countCategory(reviews, "Two key confirmations needed")}`);
  lines.push(`- Client update due: ${countCategory(reviews, "Client update due")}`);
  lines.push("");
  lines.push("## Thresher Phase Summary");
  lines.push("");
  for (const [phase, count] of countBy(reviews, (review) => review.thresherPhase)) {
    lines.push(`- ${phase}: ${count}`);
  }
  lines.push("");
  lines.push("## Owner Lane Summary");
  lines.push("");
  for (const [lane, count] of countBy(reviews, (review) => review.ownerLane)) {
    lines.push(`- ${lane}: ${count}`);
  }
  lines.push("");

  for (const section of REPORT_SECTIONS) {
    const items = itemsForSection(reviews, section);

    lines.push(`## ${section}`);
    lines.push("");
    if (!items.length) {
      lines.push("_None found._");
      lines.push("");
      continue;
    }

    for (const review of items) {
      lines.push(summaryBullet(review));
    }
    lines.push("");
  }

  lines.push("## Full File-by-File Breakdown");
  lines.push("");

  for (const review of reviews) {
    lines.push(`### ${review.file.customer}`);
    lines.push("");
    lines.push(`- Address: ${review.file.address || "Unknown"}`);
    lines.push(`- Current JobNimbus status: ${review.file.status}`);
    lines.push(`- Thresher phase: ${review.thresherPhase}`);
    lines.push(`- Workflow lane: ${review.workflowLane}`);
    lines.push(`- Owner lane: ${review.ownerLane}`);
    lines.push(`- Days in phase/status: ${review.daysInPhase ?? "Unknown"}${review.phaseExpectedDays ? ` (target ${review.phaseExpectedDays})` : ""}`);
    lines.push(`- Carrier: ${review.file.carrier || "Missing"}`);
    lines.push(`- Claim number: ${review.file.claimNumber || "Missing"}`);
    lines.push(`- Policy number: ${review.file.policyNumber || "Missing"}`);
    lines.push(`- Deductible: ${review.file.deductibleAmount || "Unknown"}`);
    lines.push(`- Date of loss: ${review.file.dateOfLoss || "Missing"}`);
    lines.push(`- Type of loss: ${review.file.typeOfLoss || "Unknown"}`);
    lines.push(`- Adjuster: ${formatAdjuster(review.file)}`);
    lines.push(`- Days in status: ${review.file.daysInStatus || "Unknown"}`);
    lines.push(`- Last activity date: ${review.file.lastActivityDate || "Unknown"}`);
    lines.push(`- Open tasks: ${formatTasks(review.file.openTasks)}`);
    lines.push(`- Missing information: ${review.missingInfo.join(", ") || "None obvious"}`);
    lines.push(`- Current bottleneck: ${review.bottleneck}`);
    lines.push(`- Priority: ${review.priority}`);
    lines.push(`- Recommended next step: ${review.recommendedNextAction}`);
    lines.push(`- Suggested internal note: ${review.suggestedInternalNote}`);
    lines.push(`- Suggested follow-up task: ${review.suggestedTask}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function summaryBullet(review) {
  return `- **${review.priority}** - ${review.file.customer} - ${review.thresherPhase} / ${review.ownerLane} - ${review.bottleneck}. Next: ${review.recommendedNextAction}`;
}

function formatAdjuster(file) {
  const parts = [file.adjuster.name, file.adjuster.phone, file.adjuster.email].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Missing";
}

function formatTasks(tasks) {
  if (!tasks.length) return "None";
  return tasks.map((task) => `${task.title}${task.dueDate ? ` due ${task.dueDate}` : ""}`).join("; ");
}

function countWhere(items, predicate) {
  return items.filter(predicate).length;
}

function countCategory(reviews, category) {
  return reviews.filter((review) => review.categories.includes(category)).length;
}

function itemsForSection(reviews, section) {
  if (section === "Do today") {
    return reviews.filter((review) =>
      review.priority === "High" ||
      review.categories.includes("Check redirection risk") ||
      review.categories.includes("Two key confirmations needed") ||
      review.categories.includes("Phase aging risk") ||
      review.overdueTasks.length > 0
    ).slice(0, 150);
  }
  if (section === "High-priority files") return reviews.filter((review) => review.priority === "High");
  return reviews.filter((review) => review.categories.includes(section));
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item) || "Unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
