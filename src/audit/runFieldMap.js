import path from "node:path";
import { readJson, writeJson, writeText } from "../lib/io.js";

const RAW_NAMES = [
  "contacts",
  "jobs",
  "tasks",
  "activities",
  "documents",
  "payments",
  "accountSettings",
  "accountUsers"
];

export async function runFieldMap(config) {
  const raw = {};
  for (const name of RAW_NAMES) {
    try {
      raw[name] = readJson(path.join(config.paths.rawDir, `${name}.json`));
    } catch {
      raw[name] = [];
    }
  }

  const map = buildFieldMap(raw);
  const jsonPath = path.join(config.paths.reportsDir, "field-map.json");
  const mdPath = path.join(config.paths.reportsDir, "field-map.md");

  writeJson(jsonPath, map);
  writeText(mdPath, toMarkdown(config, map));

  console.log("Field map complete");
  console.log(`- markdown: ${mdPath}`);
  console.log(`- json: ${jsonPath}`);
}

export function buildFieldMap(raw) {
  return {
    generatedAt: new Date().toISOString(),
    resources: Object.fromEntries(Object.entries(raw).map(([name, rows]) => [name, summarizeRows(rows)])),
    statusNames: uniqueValues([...(raw.contacts || []), ...(raw.jobs || [])], "status_name"),
    recordTypes: uniqueValues([...(raw.contacts || []), ...(raw.jobs || [])], "record_type_name"),
    customFieldCandidates: collectCustomFieldCandidates([...(raw.contacts || []), ...(raw.jobs || [])]),
    taskTypes: uniqueValues(raw.tasks || [], "record_type_name"),
    activityTypes: uniqueValues(raw.activities || [], "record_type_name"),
    fileTypes: uniqueValues(raw.documents || [], "record_type_name")
  };
}

function summarizeRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = new Map();
  for (const row of list.slice(0, 200)) {
    for (const key of Object.keys(row || {})) {
      keys.set(key, (keys.get(key) || 0) + 1);
    }
  }
  return {
    count: list.length,
    commonKeys: [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)
  };
}

function uniqueValues(rows, key) {
  const values = new Map();
  for (const row of rows || []) {
    const value = row?.[key];
    if (value != null && String(value).trim()) {
      values.set(String(value).trim(), (values.get(String(value).trim()) || 0) + 1);
    }
  }
  return [...values.entries()].sort((a, b) => b[1] - a[1]);
}

function collectCustomFieldCandidates(rows) {
  const candidates = new Map();
  for (const row of rows || []) {
    for (const [key, value] of Object.entries(row || {})) {
      if (/^(cf_|claim|carrier|policy|date of loss|loss|adjuster|mortgage|deductible|appraisal|estimate|scope|supplement|denial|denied|payment)/i.test(key)) {
        const item = candidates.get(key) || { count: 0, samples: [] };
        item.count += 1;
        if (item.samples.length < 5 && value != null && String(value).trim()) {
          item.samples.push(String(value).slice(0, 80));
        }
        candidates.set(key, item);
      }
    }
  }
  return Object.fromEntries([...candidates.entries()].sort((a, b) => b[1].count - a[1].count));
}

function toMarkdown(config, map) {
  const lines = [];
  lines.push("# JobNimbus Field Map");
  lines.push("");
  lines.push(`Generated: ${map.generatedAt}`);
  lines.push(`Mode: ${config.useFixtures ? "Fixture/sample data" : "Live/raw local data"}`);
  lines.push("");
  lines.push("## Resource Counts");
  lines.push("");
  for (const [name, summary] of Object.entries(map.resources)) {
    lines.push(`- ${name}: ${summary.count}`);
  }
  lines.push("");
  lines.push("## Status Names");
  lines.push("");
  appendPairs(lines, map.statusNames);
  lines.push("## Record Types");
  lines.push("");
  appendPairs(lines, map.recordTypes);
  lines.push("## Public Adjusting Field Candidates");
  lines.push("");
  const fields = Object.entries(map.customFieldCandidates);
  if (!fields.length) {
    lines.push("_None detected yet._");
  } else {
    for (const [key, info] of fields) {
      lines.push(`- ${key}: ${info.count}${info.samples.length ? `; samples: ${info.samples.join(" | ")}` : ""}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function appendPairs(lines, pairs) {
  if (!pairs.length) {
    lines.push("_None detected yet._");
    lines.push("");
    return;
  }
  for (const [value, count] of pairs) {
    lines.push(`- ${value}: ${count}`);
  }
  lines.push("");
}
