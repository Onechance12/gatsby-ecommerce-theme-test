// JSONL memory store. Two physical files, one logical brain:
//   memory/company.jsonl      — TRACKED (public repo): PII-free operating knowledge
//   data/memory/records.jsonl — GITIGNORED: client-lane memories
// Same record shape in both; lane decides the file. Append-mostly: status
// changes rewrite the file (small data, simplicity beats cleverness).
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
  const root = process.env.MEMORY_ROOT || config?.projectRoot || process.cwd();
  return {
    company: path.join(root, "memory", "company.jsonl"),
    client: path.join(root, "data", "memory", "records.jsonl"),
    episodes: path.join(root, "data", "memory", "episodes.jsonl"),
    proposals: path.join(root, "data", "memory", "proposals.jsonl")
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

function laneFile(paths, lane) {
  return lane === "company" ? paths.company : paths.client;
}

// Save with dedup + supersession. If a record with the same dedupKey exists and
// is not superseded/expired: merge evidence (keep strongest verification),
// raise confidence to the max of the two, and DON'T create a duplicate. If the
// draft names supersedesId, the old record is marked superseded.
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
  const rows = readJsonl(file);
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
    if (old) { old.status = "superseded"; old.supersededById = record.id; old.updatedAt = now; }
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
    ...readJsonl(paths.company).map((r) => ({ ...r, lane: r.lane || "company" })),
    ...readJsonl(paths.client).map((r) => ({ ...r, lane: r.lane || "client" }))
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

export function setMemoryStatus(config, id, status) {
  if (!MEMORY_STATUSES.includes(status)) throw new Error(`status must be one of ${MEMORY_STATUSES.join("/")}`);
  const paths = memoryPaths(config);
  for (const file of [paths.company, paths.client]) {
    const rows = readJsonl(file);
    const hit = rows.find((r) => r.id === id);
    if (hit) {
      hit.status = status;
      hit.updatedAt = new Date().toISOString();
      if (status === "verified") hit.lastVerifiedAt = hit.updatedAt;
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
  const rows = readJsonl(paths.episodes);
  rows.push(episode);
  writeJsonl(paths.episodes, rows.slice(-40)); // keep last 40 sessions
  return episode;
}

export function latestEpisodes(config, count = 2) {
  return readJsonl(memoryPaths(config).episodes).slice(-count).reverse();
}

// ---- Proposals: candidate plans awaiting Chance (never self-executing)
export function saveProposal(config, draft) {
  const normalized = normalizeProposalDraft(draft);
  const paths = memoryPaths(config);
  const rows = readJsonl(paths.proposals);
  if (rows.some((r) => r.dedupKey === normalized.dedupKey && ["candidate", "approved"].includes(r.status))) {
    return { deduped: true };
  }
  const proposal = { id: memoryId().replace("mem_", "prop_"), ...normalized, createdAt: new Date().toISOString() };
  rows.push(proposal);
  writeJsonl(paths.proposals, rows);
  return { proposal, deduped: false };
}

export function listProposals(config, { status = "candidate" } = {}) {
  return readJsonl(memoryPaths(config).proposals).filter((r) => !status || r.status === status);
}

export function reviewProposal(config, id, status, reason = "") {
  if (!PROPOSAL_STATUSES.includes(status)) throw new Error(`status must be one of ${PROPOSAL_STATUSES.join("/")}`);
  const paths = memoryPaths(config);
  const rows = readJsonl(paths.proposals);
  const hit = rows.find((r) => r.id === id);
  if (!hit) throw new Error(`proposal ${id} not found`);
  hit.status = status;
  hit.reviewReason = reason;
  hit.reviewedAt = new Date().toISOString();
  writeJsonl(paths.proposals, rows);
  return hit;
}

function strList(value, max) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => String(v).trim()).filter(Boolean).slice(0, max);
}
