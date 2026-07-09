import path from "node:path";
import { syncChanceRawData } from "./syncChanceRawData.js";
import { normalizeFiles } from "../normalize/normalizeFiles.js";
import { reviewFiles } from "../rules/reviewFiles.js";
import { writeJson } from "../lib/io.js";
import { writeMarkdownReport } from "../reports/markdown.js";
import { writeCsvReport } from "../reports/csv.js";

export async function runChanceSweep(config) {
  const { raw, syncMeta, scopeRawDir } = await syncChanceRawData(config);
  const normalized = normalizeFiles(raw);
  const reviews = reviewFiles(normalized.files, config);

  writeJson(path.join(config.paths.normalizedDir, "chance-files.json"), normalized.files);
  writeJson(path.join(config.paths.normalizedDir, "chance-reviews.json"), reviews);
  writeJson(path.join(config.paths.reportsDir, "chance-sweep.json"), {
    generatedAt: new Date().toISOString(),
    scope: "Chance Pearson",
    fileCount: reviews.length,
    syncMeta,
    reviews
  });

  const mdPath = writeMarkdownReport(config, reviews, {
    basename: "chance-sweep",
    title: "Chance Pearson JobNimbus Operations Sweep"
  });
  const csvPath = writeCsvReport(config, reviews, { basename: "chance-sweep" });

  console.log("Chance Pearson JobNimbus sweep complete");
  console.log("- mode: live API");
  console.log("- scope: Chance Pearson files only");
  console.log(`- raw data: ${scopeRawDir}`);
  console.log(`- files reviewed: ${reviews.length}`);
  console.log(`- markdown: ${mdPath}`);
  console.log(`- csv: ${csvPath}`);
}

