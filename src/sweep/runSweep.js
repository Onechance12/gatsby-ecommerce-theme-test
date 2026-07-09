import path from "node:path";
import { syncRawData } from "./syncRawData.js";
import { normalizeFiles } from "../normalize/normalizeFiles.js";
import { reviewFiles } from "../rules/reviewFiles.js";
import { writeJson } from "../lib/io.js";
import { writeMarkdownReport } from "../reports/markdown.js";
import { writeCsvReport } from "../reports/csv.js";

export async function runSweep(config) {
  const raw = await syncRawData(config);
  const normalized = normalizeFiles(raw);
  const reviews = reviewFiles(normalized.files, config);

  writeJson(path.join(config.paths.normalizedDir, "files.json"), normalized.files);
  writeJson(path.join(config.paths.normalizedDir, "reviews.json"), reviews);

  const mdPath = writeMarkdownReport(config, reviews);
  const csvPath = writeCsvReport(config, reviews);

  console.log("JobNimbus sweep complete");
  console.log(`- mode: ${config.useFixtures ? "fixture" : "live API"}`);
  console.log(`- files reviewed: ${reviews.length}`);
  console.log(`- markdown: ${mdPath}`);
  console.log(`- csv: ${csvPath}`);
}

