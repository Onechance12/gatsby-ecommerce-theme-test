// Scope miner — deep-dive ONE file's estimate pair: OUR estimate (Xactimate
// ESX or Final Draft PDF) vs the CARRIER's scope PDF. Deterministic, read-only
// (downloads to work/scope/, writes reports/) — extracts line items + money
// totals and computes what the carrier's scope leaves out. This is the data
// layer for the carrier-scope-build system: enough pair reports, distilled,
// become per-carrier "what they always omit" brain lessons.
//
// Parsing is best-effort by design: Xactimate PDFs vary. Every report states
// how many lines parsed vs skipped — never presents partial parses as complete.
// Uses python3 (pypdf + zipfile) for PDF text and ESX XML; both are present in
// this environment.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadReviews, findMatches } from "./fileReview.js";
import { listContactFiles, downloadFile } from "../jobnimbus/files.js";
import { classifyDocument } from "./historyMiner.js";

export async function runScopeMiner(config, args) {
  const query = (args || []).join(" ").replace(/^["']|["']$/g, "").trim();
  if (!query) {
    console.log('Usage: npm run scope:mine -- "<customer name>"  (see reports/scope-pairs.json for comparison-ready files)');
    return;
  }
  const file = resolveFile(config, query);
  console.log(`- file: ${file.customer} | ${file.carrier || "?"} | ${file.claimNumber || "no claim #"}`);

  const docs = await listContactFiles(config, file.id);
  const classified = docs.map((d) => ({ ...d, kind: classifyDocument(d.filename) }));
  const ours = classified.filter((d) => d.kind === "our-estimate");
  const theirs = classified.filter((d) => d.kind === "carrier-scope");
  console.log(`- docs: ${docs.length} total | ours: ${ours.map((d) => d.filename).join(", ") || "none"} | carrier: ${theirs.map((d) => d.filename).join(", ") || "none"}`);
  if (!ours.length && !theirs.length) {
    console.log("No estimate documents recognized on this file. Nothing to mine.");
    return;
  }

  const workDir = path.join(config.paths.workDir, "scope");
  fs.mkdirSync(workDir, { recursive: true });

  // Prefer the PDF render of our estimate (same parser both sides = comparable
  // line items); ESX kept as fallback/extra totals.
  const ourDoc = pickBest(ours, [/final draft/i, /\.pdf$/i, /\.esx$/i]);
  const theirDoc = pickBest(theirs, [/\.pdf$/i]);

  const sides = {};
  for (const [side, doc] of [["ours", ourDoc], ["carrier", theirDoc]]) {
    if (!doc) { sides[side] = null; continue; }
    // Cache key includes the contact id — carrier docs share generic filenames
    // ("Carrier Estimate 1.pdf") across clients and must never collide.
    const dest = path.join(workDir, `${file.id.slice(0, 8)}-${side}-${safeName(doc.filename)}`);
    if (!fs.existsSync(dest)) await downloadFile(config, doc.jnid, dest);
    sides[side] = /\.esx$/i.test(doc.filename)
      ? { doc: doc.filename, ...parseEsx(dest) }
      : { doc: doc.filename, ...parsePdfEstimate(dest) };
    console.log(`- ${side}: ${doc.filename} -> ${sides[side].items.length} line items parsed (${sides[side].skipped} lines skipped), RCV ${sides[side].totals.rcv ?? "?"}`);
  }

  const comparison = compareScopes(sides.ours, sides.carrier);
  const report = renderReport(file, sides, comparison);
  const outPath = path.join(config.paths.reportsDir, `scope-compare-${safeName(file.customer)}.md`);
  fs.mkdirSync(config.paths.reportsDir, { recursive: true });
  fs.writeFileSync(outPath, report);
  fs.writeFileSync(outPath.replace(/\.md$/, ".json"), JSON.stringify({ file: { id: file.id, customer: file.customer, carrier: file.carrier }, sides, comparison }, null, 2));
  console.log(`- report: ${outPath}`);
  if (comparison) {
    console.log(`\nSCOPE GAP — ours RCV ${fmtMoney(sides.ours?.totals.rcv)} vs carrier ${fmtMoney(sides.carrier?.totals.rcv)} | carrier missing ${comparison.missingFromCarrier.length} of our ${sides.ours?.items.length} items`);
  }
}

// ---- parsing ----

// Xactimate-style PDF line items: "<n>. <description> <qty> <UNIT> <unit$> ... <total$>"
// Also captures the money summary block (RCV/ACV/depreciation/deductible).
export function parseEstimateText(text) {
  const items = [];
  let skipped = 0;
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const UNIT = "(?:SQ|SF|LF|EA|HR|CF|SY|DA|WK|MO|RM|TON|BX|RL|PR|GL)";
  // Style A (Allstate): "<n>. <description> <qty> <UNIT> <money...>"
  const inlineRe = new RegExp(`^(\\d{1,3})[.)]\\s+(.{6,120}?)\\s+([\\d,]+(?:\\.\\d+)?)\\s*${UNIT}\\b(.*)$`, "i");
  // Style B (State Farm): description on the previous line, numbers-only line:
  // "<qty> <UNIT> <unit$> ... <total$>"
  const splitRe = new RegExp(`^([\\d,]+(?:\\.\\d+)?)\\s+${UNIT}\\s+[\\d,]+\\.\\d{2}\\b(.*)$`, "i");
  const descLike = (l) => /[A-Za-z]{4}/.test(l) && !/^Totals?:|^Total:|^(?:SF|LF|SY)\b/i.test(l) && (l.match(/\d/g) || []).length < l.length / 3;
  let lastDesc = "";
  for (const line of lines) {
    const a = line.match(inlineRe);
    if (a) {
      const money = (a[4].match(/[\d,]+\.\d{2}/g) || []).map((v) => Number(v.replace(/,/g, "")));
      items.push({ n: Number(a[1]), description: a[2].replace(/\s+/g, " ").trim(), qty: Number(a[3].replace(/,/g, "")), total: money.length ? money[money.length - 1] : null });
      lastDesc = "";
      continue;
    }
    const b = line.match(splitRe);
    if (b && lastDesc) {
      const money = (b[2].match(/[\d,]+\.\d{2}/g) || []).map((v) => Number(v.replace(/,/g, "").replace(/[<>]/g, "")));
      items.push({ n: items.length + 1, description: lastDesc.replace(/^\d{1,3}[.)]\s*/, ""), qty: Number(b[1].replace(/,/g, "")), total: money.length ? money[money.length - 1] : null });
      lastDesc = "";
      continue;
    }
    if (b && !lastDesc) { skipped++; continue; }
    if (descLike(line)) lastDesc = line;
    else if (/\d[.)]\s/.test(line) && /\d\.\d\d\b/.test(line)) skipped++;
  }
  const totals = {};
  const grab = (label, re) => { const m = String(text).match(re); if (m) totals[label] = Number(m[1].replace(/,/g, "")); };
  grab("rcv", /(?:Replacement Cost Value|Total RCV|RCV)[:\s$]*\$?\s*([\d,]+\.\d{2})/i);
  grab("acv", /(?:Actual Cash Value|Total ACV|ACV)[:\s$]*\$?\s*([\d,]+\.\d{2})/i);
  grab("depreciation", /(?:Less )?Depreciation[^$\n]*\$?\s*\(?([\d,]+\.\d{2})\)?/i);
  grab("deductible", /(?:Less )?Deductible[^$\n]*\$?\s*\(?([\d,]+\.\d{2})\)?/i);
  grab("netClaim", /Net Claim(?: if Depreciation is Recovered)?[^$\n]*\$?\s*([\d,]+\.\d{2})/i);
  return { items, skipped, totals };
}

function parsePdfEstimate(pdfPath) {
  const text = pdfText(pdfPath);
  return parseEstimateText(text);
}

// ESX = ZIP containing XML. Line items live in <XactimateDoc>… ITEM elements
// with DESC/QTY/ITEM_TOTAL-ish attributes; schemas vary so match generously.
function parseEsx(esxPath) {
  const script = `
import zipfile, re, sys
z = zipfile.ZipFile(sys.argv[1])
xml = ""
for n in z.namelist():
    if n.lower().endswith((".xml", ".xactdoc")):
        xml += z.read(n).decode("utf-8", "ignore")
print(xml[:2000000])
`;
  try {
    const xml = execFileSync("python3", ["-c", script, esxPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const items = [];
    const itemRe = /<ITEM\b[^>]*?(?:DESC|Desc|description)="([^"]{4,140})"[^>]*?(?:QTY|Qty|quantity)="([\d.]+)"[^>]*?>/g;
    let m;
    while ((m = itemRe.exec(xml))) items.push({ n: items.length + 1, description: m[1], qty: Number(m[2]), total: null });
    const totals = {};
    const rcv = xml.match(/(?:RCV|ReplCostVal|replacementCost)="([\d.]+)"/i);
    if (rcv) totals.rcv = Number(rcv[1]);
    return { items, skipped: 0, totals };
  } catch (error) {
    return { items: [], skipped: 0, totals: {}, parseError: `ESX parse failed: ${error.message.split("\n")[0]}` };
  }
}

function pdfText(pdfPath) {
  const script = `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
print("\\n".join((p.extract_text() or "") for p in r.pages))
`;
  return execFileSync("python3", ["-c", script, pdfPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// ---- comparison ----

// Normalize a line-item description for matching: lowercase, strip counts and
// punctuation, keep the trade words. "R&R Laminated - comp. shingle rfg." and
// "Remove & replace laminated comp shingle roofing" should collide.
export function normalizeItem(desc) {
  return String(desc || "").toLowerCase()
    .replace(/\br&r\b/g, "remove replace")
    .replace(/\brfg\b\.?/g, "roofing").replace(/\bcomp\b\.?/g, "composition")
    .replace(/[^a-z ]/g, " ").replace(/\b(w|per|and|the|of|to|up|for)\b/g, " ")
    .replace(/\s+/g, " ").trim().split(" ").filter((w) => w.length > 2).sort().join(" ");
}

function compareScopes(ours, carrier) {
  if (!ours?.items?.length || !carrier?.items?.length) return null;
  const carrierKeys = carrier.items.map((i) => normalizeItem(i.description));
  const missingFromCarrier = ours.items.filter((item) => {
    const key = normalizeItem(item.description);
    // fuzzy containment: shared-word overlap >= 60% counts as present
    return !carrierKeys.some((ck) => overlap(key, ck) >= 0.6);
  });
  const rcvGap = (ours.totals.rcv && carrier.totals.rcv) ? ours.totals.rcv - carrier.totals.rcv : null;
  return { missingFromCarrier, rcvGap };
}

function overlap(a, b) {
  const wa = new Set(a.split(" ")), wb = new Set(b.split(" "));
  if (!wa.size || !wb.size) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size);
}

// ---- report ----

function renderReport(file, sides, comparison) {
  const L = [];
  L.push(`# Scope comparison — ${file.customer} (${file.carrier || "?"} ${file.claimNumber || ""})`);
  L.push("");
  for (const side of ["ours", "carrier"]) {
    const s = sides[side];
    L.push(`## ${side === "ours" ? "Our estimate" : "Carrier scope"}`);
    if (!s) { L.push("", "_No document found/parsed._", ""); continue; }
    L.push("", `Source: ${s.doc}${s.parseError ? ` — ${s.parseError}` : ""}`);
    L.push(`Parsed: ${s.items.length} line items (${s.skipped} candidate lines skipped — parse is best-effort, not exhaustive)`);
    L.push(`Totals: RCV ${fmtMoney(s.totals.rcv)} | ACV ${fmtMoney(s.totals.acv)} | depreciation ${fmtMoney(s.totals.depreciation)} | deductible ${fmtMoney(s.totals.deductible)} | net claim ${fmtMoney(s.totals.netClaim)}`);
    L.push("");
  }
  if (comparison) {
    L.push(`## Gap analysis`);
    L.push("");
    if (comparison.rcvGap !== null) L.push(`RCV gap (ours − carrier): **${fmtMoney(comparison.rcvGap)}**`, "");
    L.push(`Our line items with NO fuzzy match in the carrier scope: **${comparison.missingFromCarrier.length}**`);
    for (const item of comparison.missingFromCarrier.slice(0, 60)) {
      L.push(`- ${item.description}${item.total ? ` (${fmtMoney(item.total)})` : ""}`);
    }
  } else {
    L.push(`## Gap analysis`, "", "_Needs BOTH sides parsed to compare — see above for which side is missing._");
  }
  L.push("", "_Deterministic best-effort parse. Verify against the actual documents before using in negotiation._");
  return L.join("\n");
}

function pickBest(docs, prefs) {
  for (const re of prefs) { const hit = docs.find((d) => re.test(d.filename)); if (hit) return hit; }
  return docs[0] || null;
}

// Resolve from Chance's sweep first; fall back to the company-wide
// comparison pairs the history miner discovered (mining is read-only, so the
// wider scope is safe — writes elsewhere stay Chance-files-only).
function resolveFile(config, query) {
  try {
    const matches = findMatches(loadReviews(config), query);
    if (matches.length) return matches[0].file;
  } catch { /* sweep data may be absent */ }
  const pairsPath = path.join(config.paths.reportsDir, "scope-pairs.json");
  if (fs.existsSync(pairsPath)) {
    const pairs = JSON.parse(fs.readFileSync(pairsPath, "utf8"));
    const q = query.toLowerCase();
    const hit = pairs.find((p) => p.name.toLowerCase().includes(q));
    if (hit) return { id: hit.id, customer: hit.name, carrier: hit.carrier || "", claimNumber: "" };
  }
  throw new Error(`No file matches "${query}" in the sweep or reports/scope-pairs.json (run history:mine first).`);
}

function safeName(v) { return String(v || "").replace(/[^\w.-]+/g, "_").slice(0, 60); }
function fmtMoney(v) { return v === null || v === undefined ? "?" : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
