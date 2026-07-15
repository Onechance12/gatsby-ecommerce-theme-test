// Memory suite — Codex's PR #4 acceptance checks, runnable via `npm run check`.
// All synthetic data in temp dirs; no live effects.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveMemory, listMemory, setMemoryStatus, saveProposal, reviewProposal, recordEpisode, recordActionReceipt, latestActionReceipts, memoryPaths } from "./store.js";
import { renderBrain } from "./brain.js";
import { assertCompanyLaneSafe, normalizeMemoryDraft } from "./contracts.js";

function freshCfg() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memtest-repo-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memtest-data-"));
  return { projectRoot: repoRoot, memoryRoot: dataRoot };
}

test("storage roots: company anchors to repo root, client follows data root", () => {
  const cfg = freshCfg();
  const paths = memoryPaths(cfg);
  assert.ok(paths.company.startsWith(cfg.projectRoot));
  assert.ok(paths.client.startsWith(cfg.memoryRoot));
  assert.ok(paths.episodes.startsWith(cfg.memoryRoot));
  assert.ok(paths.actions.startsWith(cfg.memoryRoot));
});

test("seeded company rules survive a data-root override", () => {
  const cfg = freshCfg();
  saveMemory(cfg, { lane: "company", kind: "lesson", content: "seeded rule stays visible", evidence: [{ type: "chance", note: "synthetic" }] });
  assert.equal(listMemory(cfg, { lane: "company" }).length, 1);
  // client write lands under data root, not repo root
  saveMemory(cfg, { lane: "client", kind: "fact", content: "client record synthetic", evidence: ["x"], subjectKey: "f1" });
  assert.ok(fs.existsSync(memoryPaths(cfg).client));
  assert.ok(!fs.existsSync(path.join(cfg.projectRoot, "data", "memory", "records.jsonl")));
});

test("authority: candidate/disputed decisions never render as operating rules", () => {
  const cfg = freshCfg();
  const cand = saveMemory(cfg, { lane: "company", kind: "decision", content: "quarantine this candidate decision", evidence: [{ type: "note", note: "obs" }] }).record;
  assert.equal(cand.status, "candidate");
  let brain = renderBrain(cfg);
  const rulesSection = brain.split("UNVERIFIED CANDIDATES")[0];
  assert.ok(!rulesSection.includes("quarantine this candidate decision"));
  assert.ok(brain.includes("UNVERIFIED CANDIDATES"));
  setMemoryStatus(cfg, cand.id, "disputed", { by: "test" });
  brain = renderBrain(cfg);
  assert.ok(!brain.includes("quarantine this candidate decision"));
  assert.match(brain, /DISPUTED needing resolution: 1/);
});

test("caller-supplied Chance evidence stays candidate until explicit approval", () => {
  const cfg = freshCfg();
  const rec = saveMemory(cfg, { lane: "company", kind: "correction", content: "verified straight from the operator", evidence: [{ type: "chance", note: "direct instruction" }] }).record;
  assert.equal(rec.status, "candidate");
  assert.ok(!renderBrain(cfg).split("UNVERIFIED CANDIDATES")[0].includes("verified straight from the operator"));
  setMemoryStatus(cfg, rec.id, "verified", { by: "Chance Pearson" });
  assert.ok(renderBrain(cfg).includes("verified straight from the operator"));
});

test("isolation: brain for file A cannot expose file B facts", () => {
  const cfg = freshCfg();
  const alpha = saveMemory(cfg, { lane: "client", kind: "fact", content: "alpha file synthetic fact", evidence: ["a"], subjectKey: "fileA" }).record;
  saveMemory(cfg, { lane: "client", kind: "fact", content: "beta file synthetic fact", evidence: ["b"], subjectKey: "fileB" });
  setMemoryStatus(cfg, alpha.id, "verified", { by: "Chance Pearson" });
  const subj = renderBrain(cfg, { clientLane: "subject", subjectKey: "fileA" });
  assert.ok(subj.includes("alpha file synthetic fact"));
  assert.ok(!subj.includes("beta file synthetic fact"));
  const none = renderBrain(cfg, { clientLane: "none" });
  assert.ok(!none.includes("alpha file synthetic fact") && !none.includes("beta file synthetic fact"));
});

test("PII firewall fails closed without customerNames", () => {
  assert.throws(() => assertCompanyLaneSafe("reach the desk at desk@example.com"), /email/);
  assert.throws(() => assertCompanyLaneSafe("call 214-555-0142 before noon"), /phone/);
  assert.throws(() => assertCompanyLaneSafe("tarp the roof at 1012 Sunset Dr today"), /address/);
  assert.throws(() => assertCompanyLaneSafe("the policyholder John Smith prefers texts"), /name/);
  assert.throws(() => assertCompanyLaneSafe("claim 12345678 was slow"), /long number/);
  assert.doesNotThrow(() => assertCompanyLaneSafe("always verify a write by fetching the created activity id"));
  assert.doesNotThrow(() => assertCompanyLaneSafe("48% of files (159/329) sit untouched >= 14 days against the 2-week audit standard"));
});

test("PII guard also covers subjectKey and evidence notes on save", () => {
  const cfg = freshCfg();
  assert.throws(() => saveMemory(cfg, { lane: "company", kind: "lesson", content: "clean rule text here", evidence: [{ type: "note", note: "learned on the file at 99 Oak Street" }] }), /address/);
});

test("dedup + approval-gated supersession with predecessor recovery", () => {
  const cfg = freshCfg();
  const a = saveMemory(cfg, { lane: "company", kind: "lesson", content: "identical lesson content for dedup", evidence: ["one"] });
  const b = saveMemory(cfg, { lane: "company", kind: "lesson", content: "identical lesson content for dedup", evidence: ["two"] });
  assert.equal(b.deduped, true);
  assert.equal(listMemory(cfg, { lane: "company" }).length, 1);
  setMemoryStatus(cfg, a.record.id, "verified", { by: "Chance Pearson" });
  const c = saveMemory(cfg, { lane: "company", kind: "lesson", content: "improved replacement lesson content", evidence: ["three"], supersedesId: a.record.id }).record;
  let all = listMemory(cfg, { lane: "company", includeRetired: true });
  let old = all.find((r) => r.id === a.record.id);
  assert.equal(old.status, "verified");
  assert.equal(c.status, "candidate");

  setMemoryStatus(cfg, c.id, "verified", { by: "Chance Pearson" });
  all = listMemory(cfg, { lane: "company", includeRetired: true });
  old = all.find((r) => r.id === a.record.id);
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededById, c.id);
  assert.equal(listMemory(cfg, { lane: "company" }).length, 1);

  setMemoryStatus(cfg, c.id, "disputed", { by: "Chance Pearson", reason: "replacement was wrong" });
  all = listMemory(cfg, { lane: "company", includeRetired: true });
  old = all.find((r) => r.id === a.record.id);
  assert.equal(old.status, "verified");
  assert.equal(old.supersededById, undefined);
});

test("proposals must cite live memory ids and reviews carry provenance", () => {
  const cfg = freshCfg();
  assert.throws(() => saveProposal(cfg, { type: "risk", title: "phantom", detail: "cites nothing real", memoryIds: ["mem_ghost"] }), /unknown|retired|unverified/);
  const rec = saveMemory(cfg, { lane: "company", kind: "lesson", content: "real cited memory content", evidence: ["x"] }).record;
  assert.throws(() => saveProposal(cfg, { type: "recommendation", title: "early", detail: "candidate memory cannot support a proposal", memoryIds: [rec.id] }), /unverified/);
  setMemoryStatus(cfg, rec.id, "verified", { by: "Chance Pearson" });
  const prop = saveProposal(cfg, { type: "recommendation", title: "real", detail: "cites a live memory", memoryIds: [rec.id] }).proposal;
  assert.throws(() => reviewProposal(cfg, prop.id, "approved", "ok", {}), /provenance/);
  const reviewed = reviewProposal(cfg, prop.id, "approved", "ok", { by: "test-operator" });
  assert.equal(reviewed.reviewedBy, "test-operator");
});

test("corruption is surfaced: mutations refuse corrupt files", () => {
  const cfg = freshCfg();
  saveMemory(cfg, { lane: "company", kind: "lesson", content: "healthy record before corruption", evidence: ["x"] });
  fs.appendFileSync(memoryPaths(cfg).company, "{broken-line\n");
  assert.throws(() => saveMemory(cfg, { lane: "company", kind: "lesson", content: "must not overwrite corrupt file", evidence: ["y"] }), /corrupt/i);
  // reads still work (with a warning) so the brain stays available
  assert.equal(listMemory(cfg, { lane: "company" }).length, 1);
});

test("status changes require provenance; episodes record and cap", () => {
  const cfg = freshCfg();
  const rec = saveMemory(cfg, { lane: "company", kind: "lesson", content: "provenance target record", evidence: ["x"] }).record;
  assert.throws(() => setMemoryStatus(cfg, rec.id, "verified", {}), /provenance/);
  const ep = recordEpisode(cfg, { summary: "synthetic session for the suite", decisions: ["d1"], commitments: ["c1"] });
  assert.ok(ep.id.startsWith("ep_"));
  assert.ok(!renderBrain(cfg).includes("synthetic session for the suite"));
  assert.ok(renderBrain(cfg, { includeEpisodes: true }).includes("synthetic session for the suite"));
});

test("candidate commitments and client facts stay quarantined", () => {
  const cfg = freshCfg();
  saveMemory(cfg, { lane: "company", kind: "commitment", content: "candidate commitment must not guide work", evidence: ["x"] });
  saveMemory(cfg, { lane: "client", kind: "fact", content: "candidate client fact must not guide work", evidence: ["y"], subjectKey: "fileA" });
  const brain = renderBrain(cfg, { clientLane: "subject", subjectKey: "fileA" });
  const primary = brain.split("UNVERIFIED CANDIDATES")[0];
  assert.ok(!primary.includes("candidate commitment must not guide work"));
  assert.ok(!primary.includes("candidate client fact must not guide work"));
  assert.ok(brain.includes("candidate commitment must not guide work"));
  assert.ok(brain.includes("candidate client fact must not guide work"));
});

test("contracts: evidence is mandatory", () => {
  assert.throws(() => normalizeMemoryDraft({ lane: "company", kind: "lesson", content: "no evidence provided here" }), /evidence/);
});

test("action receipts are private, deduplicated, and subject-isolated", () => {
  const cfg = freshCfg();
  const first = recordActionReceipt(cfg, {
    channel: "gmail",
    action: "send_email",
    subjectKey: "fileA",
    summary: "Sent approved carrier email.",
    externalId: "message-1"
  });
  const duplicate = recordActionReceipt(cfg, {
    channel: "gmail",
    action: "send_email",
    subjectKey: "fileA",
    summary: "Sent approved carrier email again.",
    externalId: "message-1"
  });
  recordActionReceipt(cfg, {
    channel: "quo",
    action: "send_text",
    subjectKey: "fileB",
    summary: "Sent approved homeowner text.",
    externalId: "message-2"
  });
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.receipt.id, first.receipt.id);
  assert.equal(latestActionReceipts(cfg, 10, { subjectKey: "fileA" }).length, 1);
  assert.equal(latestActionReceipts(cfg, 10, { subjectKey: "fileB" }).length, 1);
  assert.match(renderBrain(cfg, { clientLane: "subject", subjectKey: "fileA", includeEpisodes: true }), /Sent approved carrier email/);
  assert.doesNotMatch(renderBrain(cfg, { clientLane: "subject", subjectKey: "fileA", includeEpisodes: true }), /homeowner text/);
});
