import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../lib/config.js";
import { readJson, writeJson, writeText, toCsv } from "../lib/io.js";

const CLAIM_PREP_NAMES = [
  "Adelle Rugambamazima",
  "Andrew Adothor",
  "Aureliano Cruz (Rental)",
  "Birtha Jeter",
  "Carson Pham",
  "Chun-Hui Lyon",
  "Francisco Lopez",
  "Hoa Nguyen",
  "Jose Castillo",
  "Marc Maldonado",
  "Margarito Vega",
  "Migel Rodriguez",
  "Mohammed Barbi",
  "Nicolas Huerta",
  "Rodney Heaney",
  "Ronald Lewis",
  "Rosa Sanchez",
  "Scott Butler",
  "Sonia Garcia",
  "Veronica Hernandez"
];

const POLICY_DOC_PATTERN = /(^|[\s_-])(dec|declaration|declarations|policy|renewal|home renewal)([\s_.-]|$)/i;
const DAMAGE_DOC_PATTERN = /(final draft|deprec|estimate|scope|xact|\.esx$)/i;
const PDF_PATTERN = /\.pdf$/i;

export async function runClaimPrep() {
  const config = loadConfig();
  const files = readJson(path.join(config.paths.normalizedDir, "files.json"));
  const rawDocuments = readJson(path.join(config.paths.rawDir, "documents.json"));
  const outDir = path.join(config.projectRoot, "work", "claim-prep");
  fs.mkdirSync(outDir, { recursive: true });

  const rows = [];
  for (const name of CLAIM_PREP_NAMES) {
    const file = findFile(files, name);
    if (!file) {
      rows.push({ searchName: name, found: false });
      continue;
    }

    const documents = rawDocuments
      .filter((document) => relatesTo(document, file.id))
      .map((document) => ({
        id: idOf(document),
        name: document.filename || document.name || document.title || "Document",
        contentType: document.content_type || "",
        type: document.record_type_name || document.type || ""
      }));

    const policyDocs = chooseDocuments(documents, POLICY_DOC_PATTERN);
    const damageDocs = chooseDocuments(documents, DAMAGE_DOC_PATTERN);
    const downloaded = [];

    for (const document of [...policyDocs.slice(0, 4), ...damageDocs.slice(0, 4)]) {
      if (!PDF_PATTERN.test(document.name) && !document.contentType.includes("pdf")) continue;
      const downloadedFile = await downloadDocument({ config, document, file, outDir });
      if (downloadedFile) downloaded.push(downloadedFile);
    }

    const extracted = downloaded.map((download) => ({
      ...download,
      text: extractPdfText(download.path)
    }));

    const noteText = (file.notes || []).map((note) => note.body || "").join("\n");
    const policyDocText = extracted
      .filter((item) => POLICY_DOC_PATTERN.test(item.name))
      .map((item) => item.text)
      .join("\n\n");
    const policyText = [policyDocText, noteText].join("\n\n");
    const damageText = extracted
      .filter((item) => DAMAGE_DOC_PATTERN.test(item.name))
      .map((item) => item.text)
      .join("\n\n");

    const inferredPolicy = inferPolicyNumber(policyText, file.policyNumber);
    const inferredCarrier = normalizeCarrier(file.carrier || inferCarrier(policyText));
    const inferredDeductible = inferDeductible(policyDocText, file.deductibleAmount);
    const damageRecap = summarizeDamage(damageText, file.notes);
    const needs = [];
    if (!inferredCarrier) needs.push("carrier");
    if (!inferredPolicy) needs.push("policy/dec page");
    if (!file.dateOfLoss) needs.push("date of loss");
    if (!damageRecap) needs.push("estimate/scope damage recap");

    rows.push({
      searchName: name,
      found: true,
      customer: file.customer,
      status: file.status,
      carrier: inferredCarrier,
      policyNumberJobNimbus: file.policyNumber,
      policyNumberFromDocs: inferredPolicy,
      claimNumber: cleanMultiline(file.claimNumber),
      dateOfLoss: file.dateOfLoss,
      typeOfLoss: file.typeOfLoss,
      deductibleJobNimbus: file.deductibleAmount,
      deductibleFromDocs: inferredDeductible,
      address: file.address,
      homeownerEmail: contactEmail(file),
      homeownerPhone: contactPhone(file),
      adjuster: [file.adjuster?.name, file.adjuster?.phone, file.adjuster?.email].filter(Boolean).join(" | "),
      policyDocs: policyDocs.map((document) => document.name),
      damageDocs: damageDocs.map((document) => document.name),
      downloadedDocs: downloaded.map((document) => document.name),
      damageRecap,
      needs: needs.join(", "),
      readyToFile: isReadyToFile(file, inferredCarrier, inferredPolicy, damageRecap),
      notes: summarizeNotes(file.notes)
    });
  }

  rows.sort((a, b) => String(a.carrier || "ZZZ").localeCompare(String(b.carrier || "ZZZ")) ||
    String(a.customer || a.searchName).localeCompare(String(b.customer || b.searchName)));

  const jsonPath = path.join(config.paths.reportsDir, "claim-filing-prep.json");
  const csvPath = path.join(config.paths.reportsDir, "claim-filing-prep.csv");
  const mdPath = path.join(config.paths.reportsDir, "claim-filing-prep.md");

  writeJson(jsonPath, rows);
  writeText(csvPath, toCsv(rows, [
    { header: "Carrier", key: "carrier" },
    { header: "Client", key: "customer" },
    { header: "Status", key: "status" },
    { header: "Ready to file", key: "readyToFile" },
    { header: "Policy from docs", key: "policyNumberFromDocs" },
    { header: "Policy in JobNimbus", key: "policyNumberJobNimbus" },
    { header: "Claim #", key: "claimNumber" },
    { header: "DOL", key: "dateOfLoss" },
    { header: "Loss", key: "typeOfLoss" },
    { header: "Deductible from docs", key: "deductibleFromDocs" },
    { header: "Deductible in JobNimbus", key: "deductibleJobNimbus" },
    { header: "Address", key: "address" },
    { header: "Homeowner email", key: "homeownerEmail" },
    { header: "Homeowner phone", key: "homeownerPhone" },
    { header: "Needs", key: "needs" },
    { header: "Damage recap", key: "damageRecap" }
  ]));
  writeText(mdPath, buildMarkdown(rows));

  console.log(`Claim prep complete:`);
  console.log(`- ${mdPath}`);
  console.log(`- ${csvPath}`);
  console.log(`- ${jsonPath}`);
}

function findFile(files, name) {
  const needle = normalize(name);
  return files
    .filter((file) => normalize(file.customer).includes(needle) || needle.includes(normalize(file.customer)))
    .sort((a, b) => String(b.lastActivityDate || "").localeCompare(String(a.lastActivityDate || "")))[0];
}

function chooseDocuments(documents, pattern) {
  return documents
    .filter((document) => pattern.test(document.name) || pattern.test(document.type))
    .sort((a, b) => scoreDocument(b, pattern) - scoreDocument(a, pattern));
}

function scoreDocument(document, pattern) {
  let score = pattern.test(document.name) ? 10 : 0;
  if (PDF_PATTERN.test(document.name)) score += 5;
  if (/final draft|deprec/i.test(document.name)) score += 4;
  if (/dec|declaration|policy/i.test(document.name)) score += 4;
  if (/rev|updated/i.test(document.name)) score += 2;
  return score;
}

async function downloadDocument({ config, document, file, outDir }) {
  if (!config.apiKey || !document.id) return null;

  const safeDir = path.join(outDir, slug(file.customer));
  fs.mkdirSync(safeDir, { recursive: true });
  const filePath = path.join(safeDir, `${slug(document.name)}${PDF_PATTERN.test(document.name) ? "" : ".pdf"}`);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return { ...document, path: filePath };
  }

  const response = await fetch(`https://app.jobnimbus.com/files/${document.id}`, {
    headers: {
      authorization: `${config.authScheme} ${config.apiKey}`
    }
  });
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return { ...document, path: filePath };
}

function extractPdfText(filePath) {
  const python = process.env.CLAIM_PREP_PYTHON ||
    "/Users/chancepearson/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
  const code = [
    "import sys, pdfplumber",
    "path=sys.argv[1]",
    "with pdfplumber.open(path) as pdf:",
    "    print('\\n'.join([(p.extract_text(x_tolerance=1,y_tolerance=3) or '') for p in pdf.pages]))"
  ].join("\n");
  const result = spawnSync(python, ["-c", code, filePath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : "";
}

function inferPolicyNumber(text, fallback) {
  const fallbackPolicy = cleanMultiline(fallback);
  if (fallbackPolicy) return fallbackPolicy;

  const clean = String(text || "");
  const patterns = [
    /policy\s*(?:number|no\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9 -]{4,32})/i
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match && validPolicyCandidate(match[1])) return normalizePolicy(match[1]);
  }
  return "";
}

function inferDeductible(text, fallback) {
  const fallbackDeductible = cleanMultiline(fallback);
  if (fallbackDeductible) return dollarish(fallbackDeductible);

  const clean = String(text || "");
  const hail = clean.match(/(?:windstorm|hurricane|hail)[\s\S]{0,140}?\$?([0-9][0-9,]{2,})/i);
  if (hail) return dollarish(hail[1]);
  const deductible = clean.match(/deductible[\s\S]{0,80}?\$?([0-9][0-9,]{2,})/i);
  if (deductible) return dollarish(deductible[1]);
  return cleanMultiline(fallback);
}

function validPolicyCandidate(value) {
  const clean = normalizePolicy(value);
  if (clean.length < 5 || clean.length > 28) return false;
  if (!/\d/.test(clean)) return false;
  if (/\b(to|from|with|before|after|insured|verify|proceed|paperwork|documentations|continuation|claim)\b/i.test(clean)) return false;
  return /^[A-Z0-9][A-Z0-9 -]+$/i.test(clean);
}

function summarizeDamage(text, notes) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const hits = [];
  const patterns = [
    /roof[^.]{0,160}/ig,
    /gutter[^.]{0,120}/ig,
    /downspout[^.]{0,120}/ig,
    /window screen[^.]{0,120}/ig,
    /fence[^.]{0,120}/ig,
    /interior[^.]{0,140}/ig,
    /water stain[^.]{0,140}/ig,
    /ceiling[^.]{0,140}/ig,
    /siding[^.]{0,120}/ig,
    /garage door[^.]{0,120}/ig,
    /personal property[^.]{0,120}/ig
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const value = match[0].trim();
      if (value.length > 8 && !hits.some((hit) => hit.toLowerCase() === value.toLowerCase())) {
        hits.push(value);
      }
      if (hits.length >= 6) break;
    }
    if (hits.length >= 6) break;
  }

  if (hits.length) return hits.map(trimSentence).join("; ");
  return summarizeNotes(notes);
}

function summarizeNotes(notes = []) {
  return notes
    .map((note) => String(note.body || "").replace(/\s+/g, " ").trim())
    .filter((body) => /damage|roof|interior|water|hail|estimate|scope|file claim|ready/i.test(body))
    .slice(0, 3)
    .map((body) => trimSentence(body))
    .join("; ");
}

function buildMarkdown(rows) {
  const lines = ["# Claim Filing Prep", "", "Generated from synced JobNimbus metadata plus downloaded attachment text.", ""];
  let carrier = "";
  for (const row of rows) {
    const nextCarrier = row.carrier || "Missing carrier";
    if (nextCarrier !== carrier) {
      carrier = nextCarrier;
      lines.push(`## ${carrier}`, "");
    }
    lines.push(`### ${row.customer || row.searchName}`);
    lines.push(`- Status: ${row.status || "Not found"}`);
    lines.push(`- Ready to file: ${row.readyToFile ? "Yes" : "Needs review"}`);
    lines.push(`- Policy number: ${row.policyNumberFromDocs || row.policyNumberJobNimbus || "Missing"}`);
    if (row.policyNumberFromDocs && row.policyNumberJobNimbus && row.policyNumberFromDocs !== row.policyNumberJobNimbus) {
      lines.push(`- JobNimbus policy field differs: ${row.policyNumberJobNimbus}`);
    }
    lines.push(`- Claim number: ${row.claimNumber || "Missing / not filed"}`);
    lines.push(`- Date of loss: ${row.dateOfLoss || "Missing"}`);
    lines.push(`- Type of loss: ${row.typeOfLoss || "Unknown"}`);
    lines.push(`- Deductible: ${row.deductibleFromDocs || row.deductibleJobNimbus || "Unknown"}`);
    lines.push(`- Address: ${row.address || "Missing"}`);
    lines.push(`- Homeowner email: ${row.homeownerEmail || "Missing"}`);
    lines.push(`- Homeowner phone: ${row.homeownerPhone || "Missing"}`);
    if (row.adjuster) lines.push(`- Adjuster: ${row.adjuster}`);
    if (row.needs) lines.push(`- Need before filing: ${row.needs}`);
    lines.push(`- Policy docs checked: ${row.policyDocs?.join("; ") || "None found"}`);
    lines.push(`- Estimate/scope docs checked: ${row.damageDocs?.join("; ") || "None found"}`);
    lines.push(`- Damage recap: ${row.damageRecap || "No clear damage recap extracted"}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function inferCarrier(text) {
  const clean = String(text || "");
  const carriers = [
    "Allstate",
    "State Farm",
    "Foremost",
    "USAA",
    "Travelers",
    "Liberty Mutual",
    "Conifer",
    "National Summit",
    "Wellington",
    "Texas Farm Bureau",
    "Encompass"
  ];
  return carriers.find((carrier) => new RegExp(`\\b${carrier.replace(/\s+/g, "\\s+")}\\b`, "i").test(clean)) || "";
}

function isReadyToFile(file, carrier, policy, damageRecap) {
  if (file.claimNumber) return false;
  return Boolean(carrier && policy && file.dateOfLoss && damageRecap);
}

function relatesTo(record, jobId) {
  if ([record.jobId, record.job_id, record.parentId, record.parent_id, record.relatedId, record.related_id, record.customer, record.primary?.id]
    .filter(Boolean)
    .map(String)
    .includes(String(jobId))) {
    return true;
  }
  return Array.isArray(record.related) && record.related.some((related) => String(related.id) === String(jobId));
}

function idOf(record) {
  return String(record.id || record.jnid || "");
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function slug(value) {
  return String(value || "document").toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function normalizeCarrier(value) {
  return String(value || "").replace(/^sate farm$/i, "State Farm").trim();
}

function normalizePolicy(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/[.:;,]+$/g, "").trim();
}

function cleanMultiline(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function contactEmail(file) {
  const contact = file.source?.contact || file.source?.contact?.contact || {};
  return cleanMultiline(contact.email || contact.email_address || contact.primary_email);
}

function contactPhone(file) {
  const contact = file.source?.contact || {};
  return [
    contact.mobile_phone,
    contact.home_phone,
    contact.work_phone,
    contact.phone,
    contact.phone_number
  ].map(cleanMultiline).filter(Boolean).join(" | ");
}

function dollarish(value) {
  const clean = String(value || "").replace(/[^\d,]/g, "");
  return clean ? `$${clean}` : "";
}

function trimSentence(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length > 220 ? `${clean.slice(0, 217)}...` : clean;
}
