// Compact sweep digest for low-token chat sessions. Reads the existing
// normalized reviews (run chance:sweep first) and prints a short prioritized
// brief instead of the full 53-file dump. The assistant should read THIS, and
// only pull a full review:file for files it is actively working.

import { loadReviews } from "./fileReview.js";

export function runChanceBrief(config, args = []) {
  const input = parseArgs(args);
  const limit = Number(input.limit || 12);
  const reviews = loadReviews(config);

  const byPhase = {};
  const gaps = { adjuster: 0, dol: 0, decPage: 0, carrier: 0, claimNumber: 0 };
  for (const review of reviews) {
    byPhase[review.thresherPhase] = (byPhase[review.thresherPhase] || 0) + 1;
    const missing = (review.missingInfo || []).join("|").toLowerCase();
    if (missing.includes("adjuster")) gaps.adjuster += 1;
    if (missing.includes("date of loss")) gaps.dol += 1;
    if (missing.includes("declaration")) gaps.decPage += 1;
    if (missing.includes("carrier")) gaps.carrier += 1;
    if (missing.includes("claim number")) gaps.claimNumber += 1;
  }

  // Rank by real urgency: aging in status, overdue tasks, then priority.
  const ranked = [...reviews].sort((a, b) => urgency(b) - urgency(a));

  const lines = [];
  lines.push(`CHANCE BRIEF — ${reviews.length} files`);
  lines.push(`phases: ${Object.entries(byPhase).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  lines.push(`data gaps: adjuster:${gaps.adjuster} DOL:${gaps.dol} decPage:${gaps.decPage} carrier:${gaps.carrier} claim#:${gaps.claimNumber}`);
  lines.push("");
  lines.push(`TOP ${Math.min(limit, ranked.length)} BY URGENCY (days-in-status | overdue tasks):`);
  for (const review of ranked.slice(0, limit)) {
    const file = review.file;
    const days = file.daysInStatus || "?";
    const overdue = (review.overdueTasks || []).length;
    lines.push(`- ${file.customer} | ${file.status} | ${days}d in status${overdue ? ` | ${overdue} overdue` : ""} | ${file.carrier || "no carrier"}${file.claimNumber ? ` #${file.claimNumber}` : ""}`);
    lines.push(`    next: ${(review.recommendedNextAction || "").slice(0, 110)}`);
  }
  lines.push("");
  lines.push(`stale (>= ${config.staleDays}d in status): ${ranked.filter((review) => Number(review.file.daysInStatus || 0) >= config.staleDays).length}`);
  lines.push("full detail: reports/chance-sweep.md | one file: npm run review:file -- \"<name>\"");

  console.log(lines.join("\n"));
}

function urgency(review) {
  const days = Number(review.file.daysInStatus || 0);
  const overdue = (review.overdueTasks || []).length;
  const priority = { High: 2, Medium: 1, Low: 0 }[review.priority] || 0;
  return days * 3 + overdue * 5 + priority;
}

function parseArgs(args) {
  const text = args.join(" ").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
