#!/usr/bin/env node

// Fast local self-test: exercises normalize -> rules on the bundled fixture
// without touching the network or writing outside the repo.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./lib/io.js";
import { normalizeFiles } from "./normalize/normalizeFiles.js";
import { reviewFiles } from "./rules/reviewFiles.js";
import { parseDate, daysBetween, dateOnly, todayDate } from "./lib/dates.js";
import { findChanceUserIds, isChanceContact } from "./lib/chanceScope.js";
import { isOperationalDocument } from "./jobnimbus/documentFilters.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`- ok   ${label}`);
  } else {
    console.log(`- FAIL ${label}`);
    failures += 1;
  }
}

// dates
check("parseDate handles ISO strings", dateOnly("2026-06-26T09:45:00-05:00") === "2026-06-26");
check("parseDate handles US dates", dateOnly("07/15/2026") === "2026-07-15");
check("parseDate handles unix seconds", parseDate(1782601000)?.getUTCFullYear() >= 2026);
check("daysBetween is signed days", daysBetween("2026-07-10", "2026-07-01") === 9);
check("todayDate returns a date", todayDate() instanceof Date);

// chance scope
const users = [{ jnid: "user-chance", first_name: "Chance", last_name: "Pearson" }];
const chanceIds = findChanceUserIds(users);
check("findChanceUserIds finds Chance", chanceIds.has("user-chance"));
check("isChanceContact matches by owner id", isChanceContact({ owners: [{ id: "user-chance" }] }, chanceIds));
check("isChanceContact matches by sales rep name", isChanceContact({ sales_rep_name: "Chance Pearson" }, chanceIds));
check("isChanceContact rejects others", !isChanceContact({ owners: [{ id: "user-mark", name: "Mark Harrison" }] }, chanceIds));

// document filters
check("pdf is operational", isOperationalDocument({ content_type: "application/pdf", filename: "policy.pdf" }));
check("esx is operational", isOperationalDocument({ content_type: "application/octet-stream", filename: "estimate.esx" }));
check("jpeg is not operational", !isOperationalDocument({ content_type: "image/jpeg", filename: "roof.jpg" }));

// normalize + rules on fixture
const raw = readJson(path.join(projectRoot, "fixtures", "sample-data.json"));
const { files } = normalizeFiles(raw);
check("fixture normalizes to files", files.length >= 6);

const rosa = files.find((file) => file.customer === "Rosa Sanchez");
check("insurance contact treated as file", Boolean(rosa));
check("custom fields map (carrier)", rosa?.carrier === "Farmers");
check("notes attach to files", (rosa?.notes || []).length >= 1);

const pete = files.find((file) => file.customer === "Pete Fowler");
check("payments attach to job files", (pete?.payments || []).length === 1);
check("open tasks attach", (pete?.openTasks || []).length >= 1);

const reviews = reviewFiles(files, { staleDays: 7, highPriorityStaleDays: 14 });
check("reviews produced for every file", reviews.length === files.length);
check("reviews are priority sorted", ["High", "Medium", "Low"].includes(reviews[0].priority));
check("every review has a next action", reviews.every((review) => review.recommendedNextAction));
check("every review has a thresher phase", reviews.every((review) => review.thresherPhase));

const readyForAppraisal = reviews.find((review) => review.file.customer === "Josee Jimenez");
check("ready-for-appraisal detected", readyForAppraisal?.categories.includes("Ready for appraisal"));

console.log("");
if (failures) {
  console.error(`Self-test failed: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`Self-test passed (${reviews.length} fixture files reviewed).`);
