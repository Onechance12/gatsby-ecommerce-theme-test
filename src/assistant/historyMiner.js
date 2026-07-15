// History miner — deterministic, READ-ONLY archaeology over the whole company
// book. Pulls contacts (+ status-change activities + payments), computes the
// numbers a VP asks for, and writes reports/history-digest.md. It makes NO
// writes and stores NO conclusions: the digest is raw material that Chance and
// the assistant distill into verified brain memories afterwards.
//
// Company-wide on purpose (stats need the whole book, not just Chance's lane);
// per-rep numbers are workload/aging facts, not judgments. The digest lands in
// gitignored reports/ — client names may appear there, never in git or chat.
import fs from "node:fs";
import path from "node:path";
import { ReadOnlyJobNimbusClient } from "../jobnimbus/client.js";

const DAY = 86400;

export async function runHistoryMiner(config, args) {
  const input = parseInput(args);
  const client = new ReadOnlyJobNimbusClient(config);
  const now = Math.floor(Date.now() / 1000);

  console.log("- pulling contacts (whole book, read-only)...");
  const contacts = (await client.listResourceWithMeta("contacts", config.endpoints.contacts)).rows
    .filter((c) => c.record_type_name === "Insurance");
  console.log(`  ${contacts.length} contacts`);

  console.log("- pulling activities (newest-first window)...");
  const actsMeta = await client.listResourceWithMeta("activities", config.endpoints.activities);
  const statusChanges = actsMeta.rows.filter((a) => a.is_status_change && a.primary?.id);
  const actDates = actsMeta.rows.map((a) => a.date_created || 0).filter((t) => t > 0 && t <= now + 7 * DAY);
  const coverage = actDates.length
    ? { from: new Date(Math.min(...actDates) * 1000).toISOString().slice(0, 10), to: new Date(Math.max(...actDates) * 1000).toISOString().slice(0, 10), rows: actsMeta.rows.length, complete: actsMeta.meta.complete }
    : { from: "-", to: "-", rows: 0, complete: false };
  console.log(`  ${actsMeta.rows.length} activities (${statusChanges.length} status changes), window ${coverage.from} → ${coverage.to}`);

  console.log("- pulling document metadata (newest-first window, photos excluded)...");
  const docsMeta = await client.listResourceWithMeta("files", "/files");
  const { PHOTO_CONTENT_TYPES } = await import("../jobnimbus/documentFilters.js");
  const docs = docsMeta.rows
    .filter((f) => !PHOTO_CONTENT_TYPES.includes(String(f.content_type || "").toLowerCase()))
    .map((f) => ({
      filename: String(f.filename || ""),
      kind: classifyDocument(f.filename),
      contactIds: [...new Set([f.primary?.id, ...(f.related || []).map((r) => r.id)].filter(Boolean))],
      date: f.date_created || 0,
      size: f.size || 0
    }))
    .filter((d) => d.kind !== "other");
  const docDates = docsMeta.rows.map((f) => f.date_created || 0).filter((t) => t > 0 && t <= now + 7 * DAY);
  const docCoverage = docDates.length ? new Date(Math.min(...docDates) * 1000).toISOString().slice(0, 10) : "-";
  console.log(`  ${docsMeta.rows.length} of ${docsMeta.meta?.pages?.[0]?.total ?? "?"} docs pulled (window back to ${docCoverage}); ${docs.length} classified operational docs`);

  console.log("- pulling payments...");
  let payments = [];
  try { payments = (await client.listResourceWithMeta("payments", config.endpoints.payments || "/payments")).rows; }
  catch { console.log("  payments endpoint unavailable — skipping"); }

  // ---- classify every file ----
  const files = contacts.map((c) => {
    const status = String(c.status_name || "");
    return {
      id: c.jnid,
      name: c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim(),
      status,
      bucket: bucketStatus(status),
      carrier: normalizeCarrier(pickField(c, ["Insurance Company", "Insurance Carrier", "Carrier", "cf_string_1"])),
      claimNumber: pickField(c, ["Claim #", "Claim Number", "cf_string_2"]),
      adjuster: pickField(c, ["Carrier DA", "Adjuster", "Adjuster Name", "cf_string_7"]),
      dateOfLoss: pickField(c, ["Date of Loss", "cf_date_1"]),
      rep: c.sales_rep_name || "(unassigned)",
      created: c.date_created || 0,
      updated: c.date_updated || 0,
      statusChanged: c.date_status_change || 0
    };
  });

  const leads = files.filter((f) => f.bucket === "lead");
  const working = files.filter((f) => f.bucket === "working");
  const settlement = files.filter((f) => f.bucket === "settlement");
  const closed = files.filter((f) => f.bucket === "closed");
  const dead = files.filter((f) => f.bucket === "dead");
  const active = [...working, ...settlement];

  // ---- per-carrier league table ----
  const carriers = groupBy(files.filter((f) => f.carrier), (f) => f.carrier);
  const league = Object.entries(carriers).map(([carrier, rows]) => {
    const a = rows.filter((f) => f.bucket === "working" || f.bucket === "settlement");
    const p = rows.filter((f) => f.bucket === "closed");
    const d = rows.filter((f) => f.bucket === "dead");
    const resolved = p.length + d.length;
    return {
      carrier,
      total: rows.length,
      active: a.length,
      paid: p.length,
      dead: d.length,
      paidRate: resolved >= 5 ? Math.round((p.length / resolved) * 100) : null,
      medianDaysInStatus: median(a.map((f) => f.statusChanged ? Math.floor((now - f.statusChanged) / DAY) : null).filter((v) => v !== null)),
      claimPct: pct(rows, (f) => f.claimNumber),
      adjusterPct: pct(rows, (f) => f.adjuster)
    };
  }).sort((x, y) => y.total - x.total);

  // Status ids -> names (activities carry ids in old_status/new_status).
  const statusNames = {};
  for (const c of contacts) if (c.status !== undefined && c.status_name) statusNames[String(c.status)] = c.status_name;
  const statusLabel = (v) => statusNames[String(v).trim()] || String(v).trim();

  // ---- status dwell times from status-change activities ----
  // Group transitions per contact, sort by time; dwell in status S = gap
  // between entering S and the next transition. Median per status.
  const byContact = groupBy(statusChanges, (a) => a.primary.id);
  const dwellByStatus = {};
  const transitionCounts = {};
  for (const changes of Object.values(byContact)) {
    const sorted = [...changes].sort((a, b) => (a.date_created || 0) - (b.date_created || 0));
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i];
      const entered = statusLabel(cur.primary?.new_status || "");
      const left = statusLabel(cur.primary?.old_status || "");
      if (left && entered) {
        const key = `${left} → ${entered}`;
        transitionCounts[key] = (transitionCounts[key] || 0) + 1;
      }
      if (entered && sorted[i + 1]) {
        const days = ((sorted[i + 1].date_created || 0) - (cur.date_created || 0)) / DAY;
        if (days >= 0 && days < 400) (dwellByStatus[entered] = dwellByStatus[entered] || []).push(days);
      }
    }
  }
  const dwell = Object.entries(dwellByStatus)
    .map(([status, arr]) => ({ status, n: arr.length, medianDays: median(arr) }))
    .filter((d) => d.n >= 3)
    .sort((x, y) => y.n - x.n);

  // ---- Richard's 14-day standard, company-wide ----
  const staleLimit = Number(input.staleDays || 14);
  const staleActive = active.filter((f) => f.updated && (now - f.updated) / DAY >= staleLimit);
  const repBoard = Object.entries(groupBy(active, (f) => f.rep)).map(([rep, rows]) => ({
    rep,
    active: rows.length,
    stale: rows.filter((f) => f.updated && (now - f.updated) / DAY >= staleLimit).length,
    oldestDays: Math.max(0, ...rows.map((f) => f.updated ? Math.floor((now - f.updated) / DAY) : 0))
  })).sort((x, y) => y.active - x.active);

  // ---- scope-document inventory: who has our estimate vs the carrier's ----
  const docsByContact = {};
  for (const d of docs) for (const id of d.contactIds) (docsByContact[id] = docsByContact[id] || new Set()).add(d.kind);
  const scopeRows = [...working, ...settlement, ...closed].map((f) => {
    const kinds = docsByContact[f.id] || new Set();
    return { ...f, hasOurEstimate: kinds.has("our-estimate"), hasCarrierScope: kinds.has("carrier-scope"), hasDecPage: kinds.has("policy-doc"), hasDenial: kinds.has("denial") };
  });
  const scopeStats = {
    considered: scopeRows.length,
    ourEstimate: scopeRows.filter((r) => r.hasOurEstimate).length,
    carrierScope: scopeRows.filter((r) => r.hasCarrierScope).length,
    both: scopeRows.filter((r) => r.hasOurEstimate && r.hasCarrierScope).length,
    neither: scopeRows.filter((r) => !r.hasOurEstimate && !r.hasCarrierScope).length,
    workingMissingOurs: scopeRows.filter((r) => r.bucket === "working" && !r.hasOurEstimate).length
  };
  // comparison-ready pairs = the training set for the carrier-scope build
  const scopePairs = scopeRows.filter((r) => r.hasOurEstimate && r.hasCarrierScope).map((r) => ({ id: r.id, name: r.name, carrier: r.carrier, bucket: r.bucket }));
  fs.mkdirSync(config.paths.reportsDir, { recursive: true });
  fs.writeFileSync(path.join(config.paths.reportsDir, "scope-pairs.json"), JSON.stringify(scopePairs, null, 2));

  // ---- payments ----
  const paySum = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // ---- years ----
  const byYear = groupBy(files.filter((f) => f.created), (f) => new Date(f.created * 1000).getFullYear());

  const digest = renderDigest({
    now, files, leads, working, settlement, closed, dead, active, league, dwell, transitionCounts,
    staleLimit, staleActive, repBoard, payments, paySum, byYear, coverage,
    scopeStats, scopePairs, docCoverage,
    statuses: countBy(files, (f) => f.status)
  });

  fs.mkdirSync(config.paths.reportsDir, { recursive: true });
  const outPath = path.join(config.paths.reportsDir, "history-digest.md");
  fs.writeFileSync(outPath, digest);

  // ---- brain training: deterministic candidate-lesson drafts ----
  // Thresholded, PII-free, evidence = this mining run. These are DRAFTS: the
  // assistant reviews them, saves survivors as candidate memories, and Chance's
  // verify pass turns them into law. Re-runnable — dedupKeys keep it idempotent.
  const runTag = `history:mine ${new Date(now * 1000).toISOString().slice(0, 10)}`;
  const lessons = buildCandidateLessons({ league, dwell, closed, dead, staleLimit, staleActive, active, runTag });
  const lessonsPath = path.join(config.paths.reportsDir, "history-candidate-memories.json");
  fs.writeFileSync(lessonsPath, JSON.stringify(lessons, null, 2));

  console.log("");
  console.log(`HISTORY MINED — ${files.length} files | leads ${leads.length} | working ${working.length} | settlement ${settlement.length} | closed ${closed.length} | lost ${dead.length}`);
  console.log(`carriers: ${league.length} | status-change events: ${statusChanges.length} (window ${coverage.from} → ${coverage.to})`);
  console.log(`Richard standard (${staleLimit}d): ${staleActive.length} of ${active.length} active files stale`);
  console.log(`digest: ${outPath}`);
  console.log(`candidate memories: ${lessons.length} drafts -> reports/history-candidate-memories.json`);
}

// Draft company-lane lessons from mined stats. Every draft cites the mining run
// and embeds its numbers, so a verify pass can judge it on evidence. Thresholds
// are deliberately conservative — better five solid lessons than twenty weak ones.
export function buildCandidateLessons({ league, dwell, closed, dead, staleLimit, staleActive, active, runTag }) {
  const drafts = [];
  const add = (kind, content, importance, key) => drafts.push({
    lane: "company", kind, content, importance,
    subjectKey: "history-mining",
    dedupKey: `company:${kind}:history-${key}`,
    evidence: [{ type: "miner", id: runTag, note: "deterministic whole-book mining run", verification: "observed" }]
  });

  // resolution baseline
  const resolved = closed.length + dead.length;
  if (resolved >= 100) {
    add("fact", `Historical baseline: of ${resolved} resolved files in the book, ${Math.round((closed.length / resolved) * 100)}% closed and ${Math.round((dead.length / resolved) * 100)}% were lost. Every recovered point of the lost rate is the value target.`, 8, "resolution-baseline");
  }

  // carrier speed outliers vs book median
  const withSpeed = league.filter((c) => c.total >= 10 && c.medianDaysInStatus !== null);
  const bookMedian = medianOf(withSpeed.map((c) => c.medianDaysInStatus));
  if (bookMedian !== null) {
    for (const c of withSpeed) {
      if (c.medianDaysInStatus >= bookMedian * 2) {
        add("lesson", `${c.carrier} is a slow-mover: active files sit a median ${c.medianDaysInStatus} days in status vs ${bookMedian} book-wide (n=${c.total} files). Build extra follow-up cadence into every ${c.carrier} file.`, 7, `slow-${c.carrier.toLowerCase().replace(/\s+/g, "-")}`);
      }
    }
  }

  // big-carrier close rates
  for (const c of league.filter((x) => x.paidRate !== null && x.paid + x.dead >= 20)) {
    add("fact", `${c.carrier} historical close rate: ${c.paidRate}% of ${c.paid + c.dead} resolved files closed (n=${c.total} total). Use as the baseline when judging whether a ${c.carrier} file is on track.`, 6, `closerate-${c.carrier.toLowerCase().replace(/\s+/g, "-")}`);
  }

  // pipeline bottleneck: worst dwell among high-volume working stages
  const busy = dwell.filter((x) => x.n >= 30);
  if (busy.length) {
    const worst = [...busy].sort((a, b) => b.medianDays - a.medianDays)[0];
    add("lesson", `Pipeline bottleneck: "${worst.status}" holds files a median ${worst.medianDays.toFixed(1)} days (${worst.n} transitions observed) — the slowest high-volume stage. Files entering it deserve proactive scheduling/estimate pushes, not passive waiting.`, 7, "bottleneck-stage");
  }

  // adjuster data gap
  const bigCarriers = league.filter((c) => c.total >= 15);
  if (bigCarriers.length) {
    const avgAdj = Math.round(bigCarriers.reduce((s, c) => s + c.adjusterPct, 0) / bigCarriers.length);
    if (avgAdj < 50) {
      add("lesson", `Adjuster fields are chronically empty (~${avgAdj}% filled across major carriers). Capturing the adjuster at first contact is a standing gap — every carrier email/call that names one should be written to the file immediately.`, 7, "adjuster-gap");
    }
  }

  // staleness reality vs Richard's standard
  if (active.length >= 50) {
    const stalePct = Math.round((staleActive.length / active.length) * 100);
    if (stalePct >= 25) {
      add("fact", `Aging reality: ${stalePct}% of active files (${staleActive.length}/${active.length}) sit untouched >= ${staleLimit} days against the 2-week audit standard. Staleness is systemic, not an exception — triage should assume it.`, 6, "staleness-baseline");
    }
  }

  return drafts;
}

function medianOf(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function renderDigest(d) {
  const lines = [];
  const fmt = (n) => n === null || n === undefined ? "–" : typeof n === "number" && !Number.isInteger(n) ? n.toFixed(1) : String(n);
  lines.push(`# History Digest — whole-book mining (read-only)`);
  lines.push(``);
  lines.push(`Generated ${new Date(d.now * 1000).toISOString().slice(0, 16)}Z. Sources: ${d.files.length} contacts, ${d.coverage.rows} most-recent activities (${d.coverage.from} → ${d.coverage.to}${d.coverage.complete ? ", complete" : ", WINDOW-LIMITED — older transitions not covered"}), ${d.payments.length} payment records.`);
  lines.push(``);
  lines.push(`## Book overview`);
  lines.push(``);
  lines.push(`| Bucket | Files |`);
  lines.push(`|---|---|`);
  lines.push(`| Leads (pre-contract) | ${d.leads.length} |`);
  lines.push(`| Working claims | ${d.working.length} |`);
  lines.push(`| Settlement stage (ACV/billing) | ${d.settlement.length} |`);
  lines.push(`| Closed (Hold/Closed) | ${d.closed.length} |`);
  lines.push(`| Lost/denied | ${d.dead.length} |`);
  lines.push(``);
  const resolvedAll = d.closed.length + d.dead.length;
  if (resolvedAll) lines.push(`Historical resolution rate: **${Math.round((d.closed.length / resolvedAll) * 100)}% closed vs ${Math.round((d.dead.length / resolvedAll) * 100)}% lost** across ${resolvedAll} resolved files.`);
  lines.push(``);
  lines.push(`Files created by year: ` + Object.entries(d.byYear).sort().map(([y, rows]) => `${y}: ${rows.length}`).join(" · "));
  lines.push(``);
  lines.push(`## Carrier league table`);
  lines.push(``);
  lines.push(`| Carrier | Files | Active | Paid | Dead | Closed rate (resolved, n>=5) | Median days-in-status (active) | Claim# % | Adjuster % |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const c of d.league.slice(0, 20)) {
    lines.push(`| ${c.carrier} | ${c.total} | ${c.active} | ${c.paid} | ${c.dead} | ${c.paidRate === null ? "–" : c.paidRate + "%"} | ${fmt(c.medianDaysInStatus)} | ${c.claimPct}% | ${c.adjusterPct}% |`);
  }
  lines.push(``);
  lines.push(`## Status dwell times (median days a file sits in each status before moving)`);
  lines.push(``);
  lines.push(`Window-limited to the activity coverage above.`);
  lines.push(``);
  lines.push(`| Status | Transitions observed | Median days |`);
  lines.push(`|---|---|---|`);
  for (const s of d.dwell.slice(0, 20)) lines.push(`| ${s.status} | ${s.n} | ${fmt(s.medianDays)} |`);
  lines.push(``);
  lines.push(`## Most common status transitions`);
  lines.push(``);
  for (const [t, n] of Object.entries(d.transitionCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)) lines.push(`- ${n}× ${t}`);
  lines.push(``);
  lines.push(`## Richard standard — active files untouched ≥ ${d.staleLimit} days: ${d.staleActive.length}`);
  lines.push(``);
  lines.push(`| Rep | Active files | Stale ≥${d.staleLimit}d | Oldest untouched (days) |`);
  lines.push(`|---|---|---|---|`);
  for (const r of d.repBoard) lines.push(`| ${r.rep} | ${r.active} | ${r.stale} | ${r.oldestDays} |`);
  lines.push(``);
  lines.push(`## Scope-of-loss document inventory (photos excluded; doc window back to ${d.docCoverage})`);
  lines.push(``);
  lines.push(`Of ${d.scopeStats.considered} claim files (working + settlement + closed):`);
  lines.push(`- Our estimate on file: **${d.scopeStats.ourEstimate}**`);
  lines.push(`- Carrier scope/estimate on file: **${d.scopeStats.carrierScope}**`);
  lines.push(`- BOTH (comparison-ready pairs for the scope build): **${d.scopeStats.both}** -> reports/scope-pairs.json`);
  lines.push(`- Neither: **${d.scopeStats.neither}**`);
  lines.push(`- Working files missing OUR estimate: **${d.scopeStats.workingMissingOurs}**`);
  lines.push(``);
  if (d.scopePairs.length) {
    lines.push(`Comparison-ready pairs (first 15):`);
    for (const p of d.scopePairs.slice(0, 15)) lines.push(`- ${p.name} | ${p.carrier || "?"} | ${p.bucket}`);
    lines.push(``);
  }
  lines.push(`## Payments (visible to this key)`);
  lines.push(``);
  lines.push(`${d.payments.length} records, total $${d.paySum.toLocaleString()}. (Payment visibility may be scoped — treat as floor, not total.)`);
  lines.push(``);
  lines.push(`## Status vocabulary observed (for bucket-mapping review)`);
  lines.push(``);
  for (const [status, n] of Object.entries(d.statuses).sort((a, b) => b[1] - a[1])) lines.push(`- ${n}× ${status || "(blank)"} → bucketed as ${bucketStatus(status)}`);
  lines.push(``);
  return lines.join("\n");
}

// Status → outcome bucket. Heuristic on names; the digest prints the full
// observed vocabulary so Chance can correct the mapping — corrections then
// become verified memories, not silent code edits.
export function bucketStatus(status) {
  const s = String(status || "").toLowerCase();
  if (/^lost$|dead|denied|withdraw|cancel|no coverage|dnq|do not|unqualified/.test(s)) return "dead";
  if (/hold\/closed|closed|complete$/.test(s)) return "closed";
  if (/lead|appointment set|^new$|^red hot/.test(s)) return "lead";
  if (/billed|billing|awaiting acv|finalized/.test(s)) return "settlement";
  return "working";
}

export function normalizeCarrier(name) {
  const s = String(name || "").trim().toLowerCase()
    .replace(/\b(insurance|ins|company|co|group|corporation|corp|of texas|texas|mutual fire)\b/g, "")
    .replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (/all\s*state/.test(s)) return "Allstate";
  if (/(?:state|sate|stat)\s*farm/.test(s)) return "State Farm";
  if (/foremost/.test(s)) return "Foremost";
  if (/travelers/.test(s)) return "Travelers";
  if (/liberty/.test(s)) return "Liberty Mutual";
  if (/farmers/.test(s)) return "Farmers";
  if (/nationwide/.test(s)) return "Nationwide";
  if (/american modern/.test(s)) return "American Modern";
  if (/national general/.test(s)) return "National General";
  if (/progressive/.test(s)) return "Progressive";
  if (/usaa/.test(s)) return "USAA";
  if (/lemonade/.test(s)) return "Lemonade";
  if (/homeowners of america|hoa/.test(s)) return "Homeowners of America";
  return s.split(" ").map((w) => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}

// Filename-based document classifier. Photos are excluded upstream by content
// type; "other" is dropped. Exported for selftest coverage.
export function classifyDocument(filename) {
  const f = String(filename || "").toLowerCase();
  if (/\.esx$/.test(f) || /final draft|xactimate|wave estimate|our estimate/.test(f)) return "our-estimate";
  if (/scope|carrier est|adjuster (summary|estimate|report)|claim summary|settlement (summary|letter)|acv (letter|breakdown)|loss (summary|statement)|insurance estimate/.test(f)) return "carrier-scope";
  if (/denial|denied|declin/.test(f)) return "denial";
  if (/dec(laration)? ?page|policy|ins\.? policy|coverage/.test(f)) return "policy-doc";
  if (/\blor\b|letter of representation/.test(f)) return "lor";
  if (/\btdi\b|fin ?535/.test(f)) return "tdi";
  if (/w-?9\b/.test(f)) return "w9";
  if (/check|payment|draft ?check|proceeds/.test(f)) return "payment-doc";
  return "other";
}

function pickField(record, names) {
  for (const n of names) {
    const v = record?.[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function groupBy(rows, fn) {
  const out = {};
  for (const r of rows) { const k = fn(r); (out[k] = out[k] || []).push(r); }
  return out;
}

function countBy(rows, fn) {
  const out = {};
  for (const r of rows) { const k = fn(r); out[k] = (out[k] || 0) + 1; }
  return out;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(rows, fn) {
  if (!rows.length) return 0;
  return Math.round((rows.filter(fn).length / rows.length) * 100);
}

function parseInput(args) {
  const text = (args || []).join(" ").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
