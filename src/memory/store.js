// JSONL memory store. Two physical roots, one logical brain — hardened per
// Codex's PR #4 review:
//
//   REPO ROOT   (config.projectRoot) → memory/company.jsonl
//     Tracked in git, PII-guarded, survives every deploy because it ships with
//     the repo. ALWAYS anchored to the repo — a MEMORY_ROOT override must never
//     make the seeded company rules vanish (Codex reproduced exactly that).
//   DATA ROOT   (MEMORY_ROOT env || config.memoryRoot || repo root)
//     → data/memory/{records,episodes,proposals}.jsonl
//     Client lane. Gitignored; on Render point MEMORY_ROOT at a persistent disk.
//
// Durability: all writes are atomic (temp file + rename). Corrupt JSONL lines
// are never silently discarded — reads warn, and MUTATING operations refuse to
// rewrite a corrupt file (a rewrite would destroy the malformed lines forever).
// Single-writer design: the CLI/bridge runs one operation at a time; atomic
// rename keeps concurrent readers safe from torn files.
import fs from "node:fs";
import path from "node:path";
import {
  normalizeMemoryDraft,
  normalizeProposalDraft,
  assertCompanyLaneSafe,
  memoryId,
  EVIDENCE_RANK,
  MEMORY_STATUSES,
  PROPOSAL_STATUSES
} from "./contracts.js";

export function memoryPaths(config) {
  const repoRoot = config?.projectRoot || process.cwd();
  const dataRoot = process.env.MEMORY_ROOT || config?.memoryRoot || repoRoot;
  return {
    company: path.join(repoRoot, "memory", "company.jsonl"),
    client: path.join(dataRoot, "data", "memory", "records.jsonl"),
    episodes: path.join(dataRoot, "data", "memory", "episodes.jsonl"),
    proposals: path.join(dataRoot, "data", "memory", "proposals.jsonl"),
    actions: path.join(dataRoot, "data", "memory", "actions.jsonl")
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return { rows: [], corrupt: 0 };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const rows = [];
  let corrupt = 0;
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { corrupt++; }
  }
  if (corrupt) console.error(`WARN: ${file} has ${corrupt} corrupt JSONL line(s) — reads continue, mutations are blocked until repaired.`);
  return { rows, corrupt };
}

// Atomic replace: write a temp file in the same directory, then rename over the
// target. Readers never observe a torn file.
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  fs.renameSync(tmp, file);
}

function readForMutation(file) {
  const { rows, corrupt } = readJsonl(file);
  if (corrupt) throw new Error(`${file} contains ${corrupt} corrupt line(s). Repair the file before writing — rewriting now would silently destroy those lines.`);
  return rows;
}

function laneFile(paths, lane) {
  return lane === "company" ? paths.company : paths.client;
}

// Save with dedup + supersession. Same-dedupKey live record → merge evidence
// (strongest verification wins), raise confidence/importance, no duplicate.
// Every new record is a candidate. Evidence supplied by a caller can support a
// later review, but cannot promote itself to verified authority.
export function saveMemory(config, draft, { customerNames = [] } = {}) {
  const normalized = normalizeMemoryDraft(draft);
  if (normalized.lane === "company") {
    // Guard EVERYTHING that lands in the tracked file — content, subject, and
    // evidence notes alike (a client name in an evidence note leaks just the same).
    const guarded = [normalized.content, normalized.subjectKey, ...normalized.evidence.map((e) => `${e.id} ${e.note}`)].join(" \n ");
    assertCompanyLaneSafe(guarded, customerNames);
  }

  const paths = memoryPaths(config);
  const file = laneFile(paths, normalized.lane);
  const rows = readForMutation(file);
  const now = new Date().toISOString();

  const existing = rows.find((r) => r.dedupKey === normalized.dedupKey && !["superseded", "expired"].includes(r.status));
  if (existing) {
    existing.evidence = mergeEvidence(existing.evidence || [], normalized.evidence);
    existing.confidence = Math.max(existing.confidence || 0, normalized.confidence);
    existing.importance = Math.max(existing.importance || 0, normalized.importance);
    existing.updatedAt = now;
    writeJsonl(file, rows);
    return { record: existing, deduped: true };
  }

  const record = { id: memoryId(), ...normalized, createdAt: now, updatedAt: now };
  if (record.supersedesId) {
    const old = rows.find((r) => r.id === record.supersedesId);
    if (!old) throw new Error(`superseded memory ${record.supersedesId} not found in ${record.lane} lane`);
    if (["superseded", "expired"].includes(old.status)) throw new Error("cannot replace a retired memory");
  }
  rows.push(record);
  writeJsonl(file, rows);
  return { record, deduped: false };
}

function mergeEvidence(previous, next) {
  const byKey = new Map();
  for (const item of [...previous, ...next]) {
    const key = `${item.type}:${item.id || item.note}`;
    const existing = byKey.get(key);
    if (!existing || (EVIDENCE_RANK[item.verification] || 0) > (EVIDENCE_RANK[existing.verification] || 0)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()].slice(0, 12);
}

export function listMemory(config, { lane = "", kind = "", status = "", subjectKey = "", includeRetired = false } = {}) {
  const paths = memoryPaths(config);
  const rows = [
    ...readJsonl(paths.company).rows.map((r) => ({ ...r, lane: r.lane || "company" })),
    ...readJsonl(paths.client).rows.map((r) => ({ ...r, lane: r.lane || "client" }))
  ];
  return rows.filter((r) =>
    (includeRetired || !["superseded", "expired"].includes(r.status)) &&
    (!lane || r.lane === lane) &&
    (!kind || r.kind === kind) &&
    (!status || r.status === status) &&
    (!subjectKey || r.subjectKey === subjectKey) &&
    (!r.expiresAt || r.expiresAt > new Date().toISOString())
  ).sort((a, b) => (b.importance - a.importance) || (b.updatedAt < a.updatedAt ? -1 : 1));
}

// Status transitions carry provenance: who moved it and why.
export function setMemoryStatus(config, id, status, { by = "", reason = "" } = {}) {
  if (!MEMORY_STATUSES.includes(status)) throw new Error(`status must be one of ${MEMORY_STATUSES.join("/")}`);
  if (!by) throw new Error("status change requires provenance: pass by (who authorized this)");
  const paths = memoryPaths(config);
  for (const file of [paths.company, paths.client]) {
    const rows = readForMutation(file);
    const hit = rows.find((r) => r.id === id);
    if (hit) {
      if (hit.status === status) return hit;
      assertStatusTransition(hit.status, status);
      if (status === "verified") activateVerifiedReplacement(rows, hit);
      const previousStatus = hit.status;
      hit.status = status;
      hit.updatedAt = new Date().toISOString();
      hit.statusChangedBy = by;
      if (reason) hit.statusReason = reason;
      if (status === "verified") hit.lastVerifiedAt = hit.updatedAt;
      if (previousStatus === "verified" && ["disputed", "expired"].includes(status)) {
        reconcilePredecessor(rows, hit);
      }
      writeJsonl(file, rows);
      return hit;
    }
  }
  throw new Error(`memory ${id} not found`);
}

// ---- Episodes: end-of-session handoff (client lane file — may contain names)
export function recordEpisode(config, draft = {}) {
  const summary = String(draft.summary || "").trim();
  if (summary.length < 12) throw new Error("episode needs a real summary");
  const episode = {
    id: memoryId().replace("mem_", "ep_"),
    at: new Date().toISOString(),
    summary: summary.slice(0, 2000),
    decisions: strList(draft.decisions, 12),
    commitments: strList(draft.commitments, 12),   // still-open promises
    openQuestions: strList(draft.openQuestions, 12),
    corrections: strList(draft.corrections, 8)     // "was X -> Chance said Y"
  };
  const paths = memoryPaths(config);
  const rows = readForMutation(paths.episodes);
  rows.push(episode);
  writeJsonl(paths.episodes, rows.slice(-40)); // keep last 40 sessions
  return episode;
}

export function latestEpisodes(config, count = 2) {
  return readJsonl(memoryPaths(config).episodes).rows.slice(-count).reverse();
}

// Immutable proof that an approved external action ran. Receipts live in the
// private client lane and store summaries, not raw message bodies or secrets.
export function recordActionReceipt(config, draft = {}) {
  const channel = String(draft.channel || "").trim().toLowerCase();
  const action = String(draft.action || "").trim().toLowerCase();
  const summary = String(draft.summary || "").trim();
  if (!channel) throw new Error("action receipt requires channel");
  if (!action) throw new Error("action receipt requires action");
  if (summary.length < 8) throw new Error("action receipt needs a real summary");

  const externalId = String(draft.externalId || "").trim();
  const subjectKey = String(draft.subjectKey || "").trim();
  const dedupKey = String(draft.dedupKey || (externalId ? `${channel}:${action}:${externalId}` : "")).trim();
  const paths = memoryPaths(config);
  const rows = readForMutation(paths.actions);
  if (dedupKey) {
    const existing = rows.find((row) => row.dedupKey === dedupKey);
    if (existing) return { receipt: existing, deduped: true };
  }

  const receipt = {
    id: memoryId().replace("mem_", "act_"),
    at: new Date().toISOString(),
    channel,
    action,
    status: String(draft.status || "executed").trim().toLowerCase(),
    subjectKey,
    fileLabel: String(draft.fileLabel || "").trim().slice(0, 240),
    summary: summary.slice(0, 1600),
    externalId: externalId.slice(0, 300),
    dedupKey,
    followUps: strList(draft.followUps, 12),
    evidence: strList(draft.evidence, 12)
  };
  rows.push(receipt);
  writeJsonl(paths.actions, rows.slice(-1000));
  return { receipt, deduped: false };
}

export function latestActionReceipts(config, count = 10, { subjectKey = "" } = {}) {
  const rows = readJsonl(memoryPaths(config).actions).rows;
  return rows
    .filter((row) => !subjectKey || row.subjectKey === subjectKey)
    .slice(-Math.max(1, Number(count) || 10))
    .reverse();
}

// ---- Proposals: candidate plans awaiting Chance (never self-executing)
export function saveProposal(config, draft) {
  const normalized = normalizeProposalDraft(draft);
  // Every cited memory must actually exist and be live — a proposal built on
  // phantom or retired memories is unreviewable.
  const live = new Set(listMemory(config, { includeRetired: false, status: "verified" }).map((r) => r.id));
  const missing = normalized.memoryIds.filter((id) => !live.has(id));
  if (missing.length) throw new Error(`proposal cites unknown, retired, or unverified memory id(s): ${missing.join(", ")}`);
  const paths = memoryPaths(config);
  const rows = readForMutation(paths.proposals);
  if (rows.some((r) => r.dedupKey === normalized.dedupKey && ["candidate", "approved"].includes(r.status))) {
    return { deduped: true };
  }
  const proposal = { id: memoryId().replace("mem_", "prop_"), ...normalized, createdAt: new Date().toISOString() };
  rows.push(proposal);
  writeJsonl(paths.proposals, rows);
  return { proposal, deduped: false };
}

export function listProposals(config, { status = "candidate" } = {}) {
  return readJsonl(memoryPaths(config).proposals).rows.filter((r) => !status || r.status === status);
}

export function reviewProposal(config, id, status, reason = "", { by = "" } = {}) {
  if (!PROPOSAL_STATUSES.includes(status)) throw new Error(`status must be one of ${PROPOSAL_STATUSES.join("/")}`);
  if (!by) throw new Error("proposal review requires provenance: pass by (who decided)");
  const paths = memoryPaths(config);
  const rows = readForMutation(paths.proposals);
  const hit = rows.find((r) => r.id === id);
  if (!hit) throw new Error(`proposal ${id} not found`);
  hit.status = status;
  hit.reviewReason = reason;
  hit.reviewedBy = by;
  hit.reviewedAt = new Date().toISOString();
  writeJsonl(paths.proposals, rows);
  return hit;
}

function strList(value, max) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => String(v).trim()).filter(Boolean).slice(0, max);
}

const STATUS_TRANSITIONS = {
  candidate: new Set(["verified", "disputed", "expired"]),
  verified: new Set(["disputed", "expired"]),
  disputed: new Set(["verified", "expired"]),
  superseded: new Set([]),
  expired: new Set([])
};

function assertStatusTransition(from, to) {
  if (!STATUS_TRANSITIONS[from]?.has(to)) throw new Error(`memory cannot transition from ${from} to ${to}`);
}

function activateVerifiedReplacement(rows, record) {
  if (!record.supersedesId) return;
  const predecessor = rows.find((row) => row.id === record.supersedesId);
  if (!predecessor) throw new Error(`superseded memory ${record.supersedesId} not found`);
  if (["superseded", "expired"].includes(predecessor.status)) throw new Error("replacement predecessor is not active");
  const lineage = lineageIds(rows, record.id, predecessor.id);
  const otherVerified = rows.find((row) => lineage.has(row.id) && row.id !== predecessor.id && row.id !== record.id && row.status === "verified");
  if (otherVerified) throw new Error("another verified memory already exists in this replacement lineage");
  record.predecessorStatus = predecessor.status;
  predecessor.status = "superseded";
  predecessor.supersededById = record.id;
  predecessor.updatedAt = new Date().toISOString();
}

function reconcilePredecessor(rows, record) {
  if (!record.supersedesId) return;
  const predecessor = rows.find((row) => row.id === record.supersedesId);
  if (!predecessor || predecessor.status !== "superseded") return;
  const lineage = lineageIds(rows, predecessor.id);
  const otherVerified = rows.find((row) => lineage.has(row.id) && row.id !== predecessor.id && row.id !== record.id && row.status === "verified");
  predecessor.status = !otherVerified && record.predecessorStatus === "verified" ? "verified" : "disputed";
  predecessor.updatedAt = new Date().toISOString();
  delete predecessor.supersededById;
}

function lineageIds(rows, ...seeds) {
  const seen = new Set(seeds.filter(Boolean));
  const queue = [...seen];
  while (queue.length) {
    const current = queue.shift();
    const adjacent = rows
      .filter((row) => row.id === current || row.supersedesId === current)
      .flatMap((row) => [row.id, row.supersedesId])
      .filter(Boolean);
    for (const id of adjacent) {
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  return seen;
}
