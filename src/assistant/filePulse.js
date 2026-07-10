// file:pulse — the reconciliation layer. For one file, pull its recent Gmail
// threads (matched by claim#, insured email, insured name) and Quo texts/calls
// (matched by homeowner phone), then flag anything that suggests the file has
// MOVED in the real world but not in JobNimbus: adjuster assigned, inspection
// scheduled, payment/check issued, a missing document, an approval/denial.
//
// This is what stops files from silently sitting in the wrong status — the
// biggest hole the audit found. Read-only; it never writes.
//
//   npm run file:pulse -- '{"query":"Robert Frazier"}'
import { loadReviews, findMatches } from "./fileReview.js";
import { gatherLiveContext, applyLiveOverrides } from "./fileClaim.js";
import { googleConfigured, googleApi } from "../google/googleAuth.js";

const GMAIL = "https://gmail.googleapis.com";

// Signals that a file's real status differs from JobNimbus. Ordered by urgency.
const SIGNALS = [
  { key: "payment", re: /payment (?:has been )?(?:issued|sent|released|processed)|check (?:has been )?(?:issued|mailed|sent|cut)|has been paid/i, suggests: "Payment/check issued — confirm check redirection (Wave as payee) NOW" },
  { key: "missing-doc", re: /never (?:got|received)|did not receive|have ?n'?t received|still (?:missing|need)|resend|didn'?t get/i, suggests: "Carrier/adjuster is missing a document — likely LOR/TDI/direct-to-pay" },
  { key: "denial", re: /\b(denied|denial|not covered|coverage is denied)\b/i, suggests: "Possible denial — needs PA attention" },
  { key: "approved", re: /\b(approved|approval|estimate is approved|claim is approved)\b/i, suggests: "Claim/estimate approved — advance status" },
  { key: "adjuster", re: /adjuster (?:is |has been |will be )?(?:assigned|named|handling)|assigned adjuster|your adjuster is/i, suggests: "Adjuster assigned — capture name/contact + advance status" },
  { key: "inspection", re: /inspection (?:is )?(?:scheduled|set|confirmed|booked)|scheduled (?:the |your )?inspection|inspection (?:on|for) \w+day|reinspection/i, suggests: "Inspection scheduled — move to Appointment Set / calendar it" },
  { key: "supplement", re: /supplement/i, suggests: "Supplement activity" },
  { key: "appraisal", re: /appraisal|appraiser|umpire/i, suggests: "Appraisal activity" },
];

export async function runFilePulse(config, args) {
  const input = parseInput(args);
  const query = required(input.query || input._, "query");
  const reviews = loadReviews(config);
  const match = findMatches(reviews, query)[0];
  if (!match) { printJson({ error: `No file found for: ${query}` }); process.exitCode = 1; return; }
  const file = match.file;

  // Freshest join keys from live JobNimbus.
  const { contact, liveError } = await gatherLiveContext(config, match);
  if (contact) applyLiveOverrides(file, contact);

  const keys = {
    insuredName: file.customer || "",
    homeownerPhone: pickPhone(file),
    homeownerEmail: (file.email || file.source?.contact?.email || "").trim(),
    claimNumber: cleanClaim(file.claimNumber),
  };

  const [gmail, quo] = await Promise.all([
    pullGmail(config, keys).catch((e) => ({ error: redact(config, e.message), threads: [] })),
    pullQuo(config, keys).catch((e) => ({ error: redact(config, e.message), messages: [], calls: [] })),
  ]);

  // Merge every text blob and scan for signals.
  const haystack = [
    ...gmail.threads.map((t) => `${t.subject} ${t.snippet}`),
    ...quo.messages.map((m) => m.text || ""),
  ];
  const signals = [];
  for (const s of SIGNALS) {
    const hit = haystack.find((h) => s.re.test(h));
    if (hit) signals.push({ signal: s.key, suggests: s.suggests, evidence: hit.slice(0, 160).trim() });
  }

  const result = {
    tool: "file_pulse",
    file: { id: file.id, customer: file.customer, status: file.status, carrier: file.carrier, claim: keys.claimNumber || "(none)" },
    matchedOn: keys,
    liveRefresh: liveError ? `FAILED (${liveError}) — keys from last sweep` : "ok",
    gmail: gmail.error ? { error: gmail.error } : { count: gmail.threads.length, threads: gmail.threads },
    quo: quo.error ? { error: quo.error } : { messageCount: quo.messages.length, callCount: quo.calls.length, messages: quo.messages.slice(0, 8), calls: quo.calls.slice(0, 6) },
    signals,
    summary: signals.length
      ? `${signals.length} signal(s) suggest this file may have moved. Top: ${signals[0].suggests}`
      : "No status-change signals found in recent Gmail/Quo activity.",
  };
  printJson(result);
}

async function pullGmail(config, keys) {
  if (!googleConfigured(config)) return { error: "Google not configured", threads: [] };
  const queries = [];
  if (keys.claimNumber) queries.push(keys.claimNumber);
  if (keys.homeownerEmail) queries.push(`(from:${keys.homeownerEmail} OR to:${keys.homeownerEmail})`);
  if (keys.insuredName) queries.push(`"${lastName(keys.insuredName)}"`);
  const seen = new Map();
  for (const q of queries) {
    const list = await googleApi(config, GMAIL, `/gmail/v1/users/me/messages?maxResults=6&q=${encodeURIComponent(q)}`);
    for (const m of list.messages || []) {
      if (seen.has(m.threadId)) continue;
      const full = await googleApi(config, GMAIL, `/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name, x.value]));
      seen.set(m.threadId, { date: (h.Date || "").slice(0, 16), from: (h.From || "").slice(0, 40), subject: (h.Subject || "").slice(0, 60), snippet: (full.snippet || "").slice(0, 200) });
    }
  }
  return { threads: [...seen.values()] };
}

async function pullQuo(config, keys) {
  if (!config.quo.apiKey) return { error: "Quo not configured", messages: [], calls: [] };
  if (!keys.homeownerPhone) return { error: "no homeowner phone on file", messages: [], calls: [] };
  const phone = toE164(keys.homeownerPhone);
  const lines = await quoGet(config, "/phone-numbers");
  const lineIds = (lines.data || []).map((n) => n.id);
  const messages = [];
  const calls = [];
  for (const lineId of lineIds) {
    for (const kind of ["messages", "calls"]) {
      let payload;
      try {
        payload = await quoGet(config, `/${kind}?phoneNumberId=${encodeURIComponent(lineId)}&participants[]=${encodeURIComponent(phone)}&maxResults=20`);
      } catch { continue; }
      for (const row of payload.data || []) {
        if (kind === "messages") messages.push({ at: row.createdAt, direction: row.direction, text: (row.text || "").replace(/\s+/g, " ").trim() });
        else calls.push({ at: row.createdAt, direction: row.direction, durationSec: row.duration, status: row.status });
      }
    }
  }
  messages.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  calls.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { messages, calls };
}

async function quoGet(config, endpoint) {
  const response = await fetch(`${config.quo.baseUrl}${endpoint}`, {
    headers: { authorization: config.quo.apiKey, "content-type": "application/json" },
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!response.ok) throw new Error(`Quo ${response.status}`);
  return json;
}

// ---------- helpers ----------
function pickPhone(file) {
  const c = file.source?.contact || {};
  return String(file.mobilePhone || file.phone || c.mobile_phone || c.home_phone || c.phone || "").trim();
}
function toE164(v) {
  const d = String(v || "").replace(/[^0-9+]/g, "");
  if (!d) return "";
  if (d.startsWith("+")) return d;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.startsWith("+") ? d : `+${d}`;
}
function lastName(name) { const p = String(name || "").trim().split(/\s+/); return p[p.length - 1] || name; }
function cleanClaim(v) { return String(v || "").replace(/claim\s*#?:?/ig, "").replace(/^missing.*/i, "").trim(); }
function redact(config, msg) { return config.redact ? config.redact(msg) : msg; }
function parseInput(args) { const t = (args || []).join(" ").trim(); if (!t) return {}; try { return JSON.parse(t); } catch { return { _: t }; } }
function required(v, n) { const t = String(v || "").trim(); if (!t) throw new Error(`Missing required input: ${n}`); return t; }
function printJson(v) { console.log(JSON.stringify(v, null, 2)); }
