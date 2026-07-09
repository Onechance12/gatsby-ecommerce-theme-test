import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config.js";
import { readJson, writeJson, writeText } from "../lib/io.js";

const CURRENT_YEAR = 2026;
const DEFAULT_START_YEAR = 2025;
const REPORT_TYPES = ["hail", "wind"];
const MAX_RADIUS_MILES = 35;
const STRONG_RADIUS_MILES = 15;
const MIN_MEANINGFUL_HAIL = 1.0;
const TARGET_HAIL = 1.5;

export async function runStormResearch(config = loadConfig(), args = []) {
  const options = parseArgs(args);
  const files = readJson(path.join(config.paths.normalizedDir, "files.json"));
  const targets = findTargets(files, options.queries);
  const cacheDir = path.join(config.projectRoot, "work", "storm-research", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const reports = await loadSpcReports({
    cacheDir,
    startYear: options.startYear,
    endYear: options.endYear,
    startDate: options.startDate,
    endDate: options.endDate
  });

  const results = [];
  for (const file of targets) {
    const geocode = await geocodeAddress(file.address, cacheDir);
    const candidates = geocode
      ? rankCandidates({ file, geocode, reports, maxRadiusMiles: options.radiusMiles })
      : [];

    results.push({
      file: {
        number: file.number,
        customer: file.customer,
        status: file.status,
        address: file.address,
        carrier: file.carrier || "",
        policyNumber: file.policyNumber || "",
        existingDateOfLoss: file.dateOfLoss || ""
      },
      geocode,
      recommendedDateOfLoss: candidates[0]?.date || "",
      confidence: candidates[0]?.confidence || "none",
      reason: candidates[0]?.reason || "No nearby SPC hail/wind reports found in selected years.",
      candidates: candidates.slice(0, options.limit)
    });
  }

  const outJson = path.join(config.paths.reportsDir, "storm-dol-research.json");
  const outMd = path.join(config.paths.reportsDir, "storm-dol-research.md");
  writeJson(outJson, results);
  writeText(outMd, buildMarkdown(results));

  console.log(`Storm DOL research complete:`);
  console.log(`- ${outMd}`);
  console.log(`- ${outJson}`);
  console.log("");
  console.log(buildConsoleSummary(results));
}

function parseArgs(args) {
  const options = {
    queries: [],
    startYear: DEFAULT_START_YEAR,
    endYear: CURRENT_YEAR,
    startDate: null,
    endDate: null,
    radiusMiles: MAX_RADIUS_MILES,
    limit: 5
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--start-year") options.startYear = Number(args[++i]);
    else if (arg === "--end-year") options.endYear = Number(args[++i]);
    else if (arg === "--start-date") options.startDate = args[++i];
    else if (arg === "--end-date") options.endDate = args[++i];
    else if (arg === "--radius") options.radiusMiles = Number(args[++i]);
    else if (arg === "--limit") options.limit = Number(args[++i]);
    else options.queries.push(arg);
  }

  if (!options.queries.length) {
    options.queries = ["Alice Gonzales", "Geidy Perez", "Maribel Munoz", "Alejandro Alarcon"];
  }
  return options;
}

function findTargets(files, queries) {
  return queries
    .map((query) => {
      const needle = normalize(query);
      return files
        .filter((file) =>
          normalize(file.customer).includes(needle) ||
          normalize(file.number) === needle ||
          normalize(file.address).includes(needle)
        )
        .sort((a, b) => String(b.lastActivityDate || "").localeCompare(String(a.lastActivityDate || "")))[0];
    })
    .filter(Boolean);
}

async function loadSpcReports({ cacheDir, startYear, endYear, startDate, endDate }) {
  const start = startDate ? new Date(`${startDate}T00:00:00Z`) : new Date(Date.UTC(startYear, 0, 1));
  const end = endDate ? new Date(`${endDate}T00:00:00Z`) : new Date(Date.UTC(endYear, 11, 31));
  const today = new Date();
  const tasks = [];
  for (let cursor = start; cursor <= end && cursor <= today; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const yymmdd = formatSpcDate(cursor);
    const date = isoDate(cursor);
    for (const type of REPORT_TYPES) {
      tasks.push(async () => {
        const rows = await fetchSpcCsv({ cacheDir, yymmdd, type });
        return rows.map((row) => ({ ...row, date, type }));
      });
    }
  }
  return (await runLimited(tasks, 12)).flat();
}

async function runLimited(tasks, limit) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (index < tasks.length) {
      const taskIndex = index;
      index += 1;
      results[taskIndex] = await tasks[taskIndex]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchSpcCsv({ cacheDir, yymmdd, type }) {
  const filePath = path.join(cacheDir, `spc-${yymmdd}-${type}.csv`);
  if (!fs.existsSync(filePath)) {
    const url = `https://www.spc.noaa.gov/climo/reports/${yymmdd}_rpts_${type}.csv`;
    let text = "";
    try {
      const response = await fetch(url);
      if (response.ok) text = await response.text();
    } catch {
      text = "";
    }
    fs.writeFileSync(filePath, text);
  }

  const text = fs.readFileSync(filePath, "utf8");
  if (!text.trim() || /404|Not Found/i.test(text.slice(0, 200))) return [];
  return parseCsv(text)
    .map((row) => normalizeSpcRow(row, type))
    .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon));
}

async function geocodeAddress(address, cacheDir) {
  if (!address) return null;
  const cachePath = path.join(cacheDir, `geocode-${slug(address)}.json`);
  if (!fs.existsSync(cachePath)) {
    const url = new URL("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates");
    url.searchParams.set("SingleLine", address);
    url.searchParams.set("f", "json");
    url.searchParams.set("maxLocations", "1");
    url.searchParams.set("outFields", "Match_addr,Addr_type,Score");

    let payload = {};
    try {
      const response = await fetch(url);
      if (response.ok) payload = await response.json();
    } catch {
      payload = {};
    }
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2));
  }

  const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const candidate = payload.candidates?.[0];
  if (!candidate?.location) return null;
  return {
    address: candidate.address,
    score: candidate.score,
    lat: candidate.location.y,
    lon: candidate.location.x
  };
}

function rankCandidates({ file, geocode, reports, maxRadiusMiles }) {
  const nearby = reports
    .map((report) => ({
      ...report,
      distanceMiles: haversineMiles(geocode.lat, geocode.lon, report.lat, report.lon)
    }))
    .filter((report) => report.distanceMiles <= maxRadiusMiles);

  const byDate = new Map();
  for (const report of nearby) {
    const bucket = byDate.get(report.date) || {
      date: report.date,
      maxHailInches: 0,
      closestHailMiles: null,
      maxWindMph: 0,
      closestWindMiles: null,
      reports: []
    };

    if (report.type === "hail") {
      bucket.maxHailInches = Math.max(bucket.maxHailInches, report.size);
      bucket.closestHailMiles = bucket.closestHailMiles === null
        ? report.distanceMiles
        : Math.min(bucket.closestHailMiles, report.distanceMiles);
    }
    if (report.type === "wind") {
      bucket.maxWindMph = Math.max(bucket.maxWindMph, report.size);
      bucket.closestWindMiles = bucket.closestWindMiles === null
        ? report.distanceMiles
        : Math.min(bucket.closestWindMiles, report.distanceMiles);
    }
    bucket.reports.push(report);
    byDate.set(report.date, bucket);
  }

  return [...byDate.values()]
    .map((candidate) => scoreCandidate(candidate, file))
    .sort((a, b) => b.score - a.score || a.closestDistanceMiles - b.closestDistanceMiles);
}

function scoreCandidate(candidate) {
  const hailDistance = candidate.closestHailMiles ?? 999;
  const windDistance = candidate.closestWindMiles ?? 999;
  const closestDistanceMiles = Math.min(hailDistance, windDistance);
  let score = 0;

  if (candidate.maxHailInches >= TARGET_HAIL) score += 60;
  else if (candidate.maxHailInches >= MIN_MEANINGFUL_HAIL) score += 35;
  if (hailDistance <= STRONG_RADIUS_MILES) score += 25;
  else if (hailDistance <= MAX_RADIUS_MILES) score += 10;
  if (candidate.maxWindMph >= 58) score += 12;
  if (/2026-04-(25|26|27|28|29)/.test(candidate.date)) score += 8;

  const confidence = score >= 85 ? "high" : score >= 55 ? "medium" : score >= 30 ? "low" : "weak";
  const reason = [
    candidate.maxHailInches
      ? `${candidate.maxHailInches.toFixed(2)} in hail within ${formatMiles(hailDistance)}`
      : "no hail report nearby",
    candidate.maxWindMph
      ? `${candidate.maxWindMph.toFixed(0)} mph wind within ${formatMiles(windDistance)}`
      : "no wind report nearby"
  ].join("; ");

  return {
    date: candidate.date,
    confidence,
    score,
    maxHailInches: candidate.maxHailInches || "",
    closestHailMiles: candidate.closestHailMiles === null ? "" : Number(candidate.closestHailMiles.toFixed(1)),
    maxWindMph: candidate.maxWindMph || "",
    closestWindMiles: candidate.closestWindMiles === null ? "" : Number(candidate.closestWindMiles.toFixed(1)),
    closestDistanceMiles: Number(closestDistanceMiles.toFixed(1)),
    reason,
    reports: candidate.reports
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .slice(0, 6)
      .map((report) => ({
        type: report.type,
        time: report.time,
        size: report.size,
        unit: report.type === "hail" ? "in" : "mph",
        location: report.location,
        county: report.county,
        distanceMiles: Number(report.distanceMiles.toFixed(1)),
        comments: report.comments
      }))
  };
}

function normalizeSpcRow(row, type) {
  const sizeRaw = Number(row.Size);
  return {
    time: row.Time || "",
    size: type === "hail" ? sizeRaw / 100 : sizeRaw,
    location: row.Location || "",
    county: row.County || "",
    state: row.State || "",
    lat: Number(row.Lat),
    lon: -Math.abs(Number(row.Lon)),
    comments: row.Comments || ""
  };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function buildMarkdown(results) {
  const lines = ["# Storm DOL Research", ""];
  for (const result of results) {
    lines.push(`## ${result.file.customer} #${result.file.number}`);
    lines.push(`- Address: ${result.file.address}`);
    lines.push(`- Existing DOL: ${result.file.existingDateOfLoss || "Missing"}`);
    lines.push(`- Recommended DOL: ${result.recommendedDateOfLoss || "No candidate"} (${result.confidence})`);
    lines.push(`- Reason: ${result.reason}`);
    if (result.candidates.length) {
      lines.push("");
      lines.push("| Date | Confidence | Hail | Hail distance | Wind | Wind distance | Reason |");
      lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- |");
      for (const candidate of result.candidates) {
        lines.push(`| ${candidate.date} | ${candidate.confidence} | ${candidate.maxHailInches || ""} | ${candidate.closestHailMiles || ""} | ${candidate.maxWindMph || ""} | ${candidate.closestWindMiles || ""} | ${candidate.reason} |`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function buildConsoleSummary(results) {
  return results.map((result) => {
    return [
      `${result.file.customer} #${result.file.number}`,
      `  address: ${result.file.address}`,
      `  recommended DOL: ${result.recommendedDateOfLoss || "none"} (${result.confidence})`,
      `  reason: ${result.reason}`
    ].join("\n");
  }).join("\n\n");
}

function formatSpcDate(date) {
  return `${String(date.getUTCFullYear()).slice(2)}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function isoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const earthMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(value) {
  return value * Math.PI / 180;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slug(value) {
  return normalize(value).replace(/\s+/g, "-").slice(0, 120);
}

function formatMiles(value) {
  if (value === null || value === undefined || value === 999) return "n/a";
  return `${value.toFixed(1)} mi`;
}
