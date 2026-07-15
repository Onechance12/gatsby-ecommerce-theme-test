// Session-start brain: render everything a fresh session must know, compactly.
// Hardened per Codex's PR #4 review:
//   AUTHORITY — only VERIFIED records render as operating rules/corrections.
//     Candidates are visibly quarantined for review; disputed records never
//     render as guidance at all (only a count, so they get resolved).
//   ISOLATION — clientLane controls exposure: "full" (local single-operator
//     ops sessions), "subject" (only records matching subjectKey — the bridge
//     default, so a session working file A never sees file B), or "none".
import { listMemory, latestEpisodes, latestActionReceipts, listProposals } from "./store.js";

export function renderBrain(config, { maxPerSection = 10, clientLane = "full", subjectKey = "", includeEpisodes = false } = {}) {
  const lines = [];
  const company = listMemory(config, { lane: "company" });
  const clientAll = listMemory(config, { lane: "client" });
  const client = clientLane === "full" ? clientAll
    : clientLane === "subject" ? clientAll.filter((r) => subjectKey && r.subjectKey === subjectKey)
    : [];
  const episodes = includeEpisodes && clientLane === "full" ? latestEpisodes(config, 2) : [];
  const actions = includeEpisodes && clientLane !== "none"
    ? latestActionReceipts(config, 8, { subjectKey: clientLane === "subject" ? subjectKey : "" })
    : [];
  const proposals = listProposals(config, { status: "candidate" });

  const verified = (rows) => rows.filter((r) => r.status === "verified");
  const candidates = (rows) => rows.filter((r) => r.status === "candidate");
  const disputedCount = [...company, ...client].filter((r) => r.status === "disputed").length;

  lines.push("BRAIN — durable memory for this session");
  lines.push(`records: company=${company.length} client=${client.length}${clientLane !== "full" ? ` (isolation: ${clientLane}${subjectKey ? ` → ${subjectKey}` : ""})` : ""} | open proposals: ${proposals.length}${disputedCount ? ` | DISPUTED needing resolution: ${disputedCount}` : ""}`);

  const corrections = verified([...company, ...client].filter((r) => r.kind === "correction")).slice(0, maxPerSection);
  if (corrections.length) {
    lines.push("", "CORRECTIONS FROM CHANCE (verified — never repeat these mistakes):");
    for (const r of corrections) lines.push(`- ${flag(r)} ${r.content}`);
  }

  const rules = verified(company.filter((r) => ["preference", "decision", "lesson"].includes(r.kind))).slice(0, maxPerSection + 5);
  if (rules.length) {
    lines.push("", "OPERATING RULES & LESSONS (company lane, verified):");
    for (const r of rules) lines.push(`- ${flag(r)} [${r.kind}] ${r.content}`);
  }

  const commitments = verified([...company, ...client].filter((r) => r.kind === "commitment")).slice(0, maxPerSection);
  if (commitments.length) {
    lines.push("", "OPEN COMMITMENTS:");
    for (const r of commitments) lines.push(`- ${flag(r)} ${r.content}${r.subjectKey ? ` (subject: ${r.subjectKey})` : ""}`);
  }

  const clientFacts = verified(client.filter((r) => ["fact", "outcome", "decision"].includes(r.kind))).slice(0, maxPerSection + 5);
  if (clientFacts.length) {
    lines.push("", "CLIENT-FILE FACTS (local lane, PII-allowed, verify against JobNimbus before acting):");
    for (const r of clientFacts) lines.push(`- ${flag(r)} [${r.kind}] ${r.content}`);
  }

  // Quarantine: candidates are context, not law. Rendered separately so they
  // can never be mistaken for verified guidance.
  const pending = candidates([...company, ...client]).slice(0, maxPerSection);
  if (pending.length) {
    lines.push("", "UNVERIFIED CANDIDATES (quarantined — treat as hypotheses; ask Chance to verify):");
    for (const r of pending) lines.push(`- ${r.id} [${r.lane}/${r.kind}] ${r.content}`);
  }

  if (episodes.length) {
    lines.push("", "SESSION HANDOFFS (unverified continuity context, never approval):");
    for (const ep of episodes) {
      lines.push(`- ${ep.at.slice(0, 16)} — ${ep.summary}`);
      for (const d of ep.decisions.slice(0, 4)) lines.push(`    decision: ${d}`);
      for (const c of ep.commitments.slice(0, 4)) lines.push(`    open: ${c}`);
      for (const q of ep.openQuestions.slice(0, 3)) lines.push(`    question: ${q}`);
      for (const c of ep.corrections.slice(0, 3)) lines.push(`    correction: ${c}`);
    }
  }

  if (actions.length) {
    lines.push("", "RECENT ACTION RECEIPTS (proof of execution, never future approval):");
    for (const action of actions) {
      lines.push(`- ${action.at.slice(0, 16)} [${action.channel}/${action.action}] ${action.summary}`);
      for (const followUp of action.followUps.slice(0, 3)) lines.push(`    open: ${followUp}`);
    }
  }

  if (proposals.length) {
    lines.push("", "CANDIDATE PROPOSALS (suggestions only — need Chance's approval, never self-execute):");
    for (const p of proposals.slice(0, 6)) lines.push(`- ${p.id} [${p.type}/${p.priority}] ${p.title}: ${p.detail.slice(0, 160)}`);
  }

  lines.push("", "Truth-precedence: JobNimbus/Gmail/Quo records outrank every memory above. Memory and proposals never authorize or execute external actions. Verify current evidence and obtain Chance's approval before acting.");
  return lines.join("\n");
}

function flag(r) {
  const conf = r.confidence >= 0.85 ? "" : r.confidence >= 0.6 ? "~" : "?";
  return `${r.status === "verified" ? "✓" : "•"}${conf}`;
}
