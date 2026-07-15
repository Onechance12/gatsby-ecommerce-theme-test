// Scope profile generator — aggregate every scope-compare-*.json the scope
// miner produced into PER-CARRIER omission profiles: which trade categories a
// carrier systematically leaves out of its initial scope vs our estimate, and
// how far under our RCV they open. Deterministic, read-only. This is Claude's
// half of the Scope Intelligence collaboration; Codex consumes the emitted
// profile at runtime to flag gaps on incoming carrier scopes.
//
// Output:
//   reports/carrier-omission-profiles.json  (per-carrier, with sample sizes)
//   reports/carrier-omission-profiles.md    (human-readable)
// Profiles carry NO client PII — carrier + category counts + RCV ratios only,
// so they are safe to distill into tracked company-lane brain lessons.
import fs from "node:fs";
import path from "node:path";

// The trade categories we score. Order = review priority on a new scope.
export const SCOPE_CATEGORIES = [
  ["detach-reset", /detach|reset|r&r|remove.{0,12}(replace|reset)/],
  ["paint-seal", /paint|stain|seal|prime|primer/],
  ["interior-water", /interior|water stain|ceiling|drywall|insulation|texture|sheetrock/],
  ["fascia-soffit", /fascia|soffit/],
  ["gutters-downspouts", /gutter|downspout/],
  ["vents-caps", /\bvent\b|ridge vent|turbine|turtle|cap\b/],
  ["flashing", /flashing|step flash|counterflash/],
  ["drip-edge", /drip edge/],
  ["starter", /starter/],
  ["ice-water-barrier", /ice ?& ?water|ice and water|ice barrier|i&w/],
  ["ridge-cap", /ridge cap|hip.{0,6}ridge/],
  ["underlayment", /felt|underlayment|synthetic/],
  ["windows-screens", /window|screen|glazing/],
  ["siding-wrap", /siding|housewrap|house wrap/],
  ["steep-access", /steep|high roof|two story|2 story|additional layer|access/],
  ["debris-haul", /haul|debris|dumpster|disposal/],
  ["detach-gutters-solar", /solar|satellite|antenna|detach.{0,10}(gutter|guard)/]
];

function categorize(desc) {
  const d = String(desc || "").toLowerCase();
  for (const [name, re] of SCOPE_CATEGORIES) if (re.test(d)) return name;
  return "other";
}

export function buildProfiles(reports) {
  const carriers = {};
  for (const r of reports) {
    if (!r.comparison || !r.sides?.ours?.items?.length) continue;
    const carrier = normalizeCarrierName(r.file?.carrier);
    if (!carrier) continue;
    const c = carriers[carrier] || (carriers[carrier] = {
      carrier, pairs: 0, rcvRatios: [],
      categoryOmitted: {}, categoryPresent: {}
    });
    c.pairs++;
    // RCV ratio: carrier opening / ours (lower = more aggressive lowball)
    const ourRcv = r.sides.ours.totals?.rcv, theirRcv = r.sides.carrier?.totals?.rcv;
    if (ourRcv && theirRcv !== undefined && theirRcv !== null && ourRcv > 0) c.rcvRatios.push(theirRcv / ourRcv);

    // Which categories WE scoped, and which of those the carrier omitted.
    const ourCats = new Set(r.sides.ours.items.map((i) => categorize(i.description)));
    const missingCats = new Set((r.comparison.missingFromCarrier || []).map((i) => categorize(i.description)));
    for (const cat of ourCats) {
      if (cat === "other") continue;
      c.categoryPresent[cat] = (c.categoryPresent[cat] || 0) + 1;
      if (missingCats.has(cat)) c.categoryOmitted[cat] = (c.categoryOmitted[cat] || 0) + 1;
    }
  }

  // finalize: omission rate per category, sorted; median RCV ratio
  const profiles = Object.values(carriers).map((c) => {
    const cats = Object.keys(c.categoryPresent).map((cat) => ({
      category: cat,
      scopedIn: c.categoryPresent[cat],
      omittedIn: c.categoryOmitted[cat] || 0,
      omissionRate: Math.round(((c.categoryOmitted[cat] || 0) / c.categoryPresent[cat]) * 100)
    })).sort((a, b) => b.omissionRate - a.omissionRate || b.scopedIn - a.scopedIn);
    return {
      carrier: c.carrier,
      pairs: c.pairs,
      medianRcvRatio: median(c.rcvRatios),
      topOmissions: cats.filter((x) => x.omissionRate >= 50).map((x) => x.category),
      categories: cats
    };
  }).sort((a, b) => b.pairs - a.pairs);

  // cross-carrier omission frequency (the general checklist)
  const overall = {};
  for (const p of profiles) for (const c of p.categories) {
    const o = overall[c.category] || (overall[c.category] = { scopedIn: 0, omittedIn: 0 });
    o.scopedIn += c.scopedIn; o.omittedIn += c.omittedIn;
  }
  const checklist = Object.entries(overall)
    .map(([category, o]) => ({ category, omissionRate: Math.round((o.omittedIn / o.scopedIn) * 100), scopedIn: o.scopedIn }))
    .filter((x) => x.scopedIn >= 3)
    .sort((a, b) => b.omissionRate - a.omissionRate);

  return { profiles, checklist, totalPairs: profiles.reduce((s, p) => s + p.pairs, 0) };
}

export function runScopeProfiles(config) {
  const dir = config.paths.reportsDir;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^scope-compare-.*\.json$/.test(f)) : [];
  const reports = files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } }).filter(Boolean);
  if (!reports.length) {
    console.log("No scope-compare reports found. Run `npm run scope:mine -- \"<name>\"` on comparison pairs first (see reports/scope-pairs.json).");
    return;
  }
  const result = buildProfiles(reports);
  fs.writeFileSync(path.join(dir, "carrier-omission-profiles.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(dir, "carrier-omission-profiles.md"), renderProfiles(result));

  console.log(`SCOPE PROFILES — ${result.totalPairs} comparison pairs across ${result.profiles.length} carriers`);
  console.log(`\nGeneral omission checklist (cross-carrier, most-omitted first):`);
  for (const c of result.checklist.slice(0, 10)) console.log(`  ${String(c.omissionRate).padStart(3)}%  ${c.category} (n=${c.scopedIn})`);
  console.log(`\nPer-carrier:`);
  for (const p of result.profiles) {
    console.log(`  ${p.carrier} (${p.pairs} pair${p.pairs > 1 ? "s" : ""}): opens at ${p.medianRcvRatio === null ? "?" : Math.round(p.medianRcvRatio * 100) + "% of our RCV"}${p.topOmissions.length ? ` | omits: ${p.topOmissions.join(", ")}` : ""}`);
  }
  console.log(`\nprofiles: ${path.join(dir, "carrier-omission-profiles.md")}`);
}

function renderProfiles(r) {
  const L = [`# Carrier omission profiles`, "", `${r.totalPairs} comparison pairs, ${r.profiles.length} carriers. Small samples — directional, not statistical. Regenerate as more pairs are mined.`, ""];
  L.push(`## General omission checklist (check these on ANY carrier scope)`, "", `| Category | Omission rate | Times we scoped it |`, `|---|---|---|`);
  for (const c of r.checklist) L.push(`| ${c.category} | ${c.omissionRate}% | ${c.scopedIn} |`);
  L.push("", `## Per-carrier profiles`, "");
  for (const p of r.profiles) {
    L.push(`### ${p.carrier} — ${p.pairs} pair(s)`);
    L.push(`- Opens at median **${p.medianRcvRatio === null ? "?" : Math.round(p.medianRcvRatio * 100) + "%"}** of our RCV`);
    if (p.topOmissions.length) L.push(`- Systematically omits: **${p.topOmissions.join(", ")}**`);
    L.push(`- Detail: ${p.categories.filter((c) => c.omittedIn > 0).map((c) => `${c.category} ${c.omittedIn}/${c.scopedIn}`).join(", ") || "no omissions detected in sample"}`);
    L.push("");
  }
  return L.join("\n");
}

export function normalizeCarrierName(name) {
  const s = String(name || "").trim().toLowerCase();
  if (!s) return "";
  if (/all ?state/.test(s)) return "Allstate";
  if (/s?tate ?farm/.test(s)) return "State Farm";
  if (/foremost/.test(s)) return "Foremost";
  if (/farmers/.test(s)) return "Farmers";
  if (/usaa/.test(s)) return "USAA";
  if (/liberty/.test(s)) return "Liberty Mutual";
  if (/travelers/.test(s)) return "Travelers";
  if (/nationwide/.test(s)) return "Nationwide";
  if (/american modern/.test(s)) return "American Modern";
  if (/national general/.test(s)) return "National General";
  return name.trim();
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
