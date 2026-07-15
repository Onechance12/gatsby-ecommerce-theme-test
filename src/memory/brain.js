// Session-start brain: render everything a fresh session must know, compactly.
// This is the answer to "a scheduled session wakes up knowing nothing" — it
// reads the durable memory lanes + the last episodes and prints an orientation
// block. Modeled on Jobrolo's buildTurnMemoryContext/renderEpisode (read-only
// reference), rebuilt file-based.
import { listMemory, latestEpisodes, listProposals } from "./store.js";

export function renderBrain(config, { maxPerSection = 10 } = {}) {
  const lines = [];
  const company = listMemory(config, { lane: "company" });
  const client = listMemory(config, { lane: "client" });
  const episodes = latestEpisodes(config, 2);
  const proposals = listProposals(config, { status: "candidate" });

  lines.push("BRAIN — durable memory for this session");
  lines.push(`records: company=${company.length} client=${client.length} | open proposals: ${proposals.length}`);

  const corrections = [...company, ...client].filter((r) => r.kind === "correction").slice(0, maxPerSection);
  if (corrections.length) {
    lines.push("", "CORRECTIONS FROM CHANCE (highest authority — never repeat these mistakes):");
    for (const r of corrections) lines.push(`- ${flag(r)} ${r.content}`);
  }

  const rules = company.filter((r) => ["preference", "decision", "lesson"].includes(r.kind)).slice(0, maxPerSection + 5);
  if (rules.length) {
    lines.push("", "OPERATING RULES & LESSONS (company lane):");
    for (const r of rules) lines.push(`- ${flag(r)} [${r.kind}] ${r.content}`);
  }

  const commitments = [...company, ...client].filter((r) => r.kind === "commitment").slice(0, maxPerSection);
  if (commitments.length) {
    lines.push("", "OPEN COMMITMENTS:");
    for (const r of commitments) lines.push(`- ${flag(r)} ${r.content}${r.subjectKey ? ` (subject: ${r.subjectKey})` : ""}`);
  }

  const clientFacts = client.filter((r) => ["fact", "outcome", "decision"].includes(r.kind)).slice(0, maxPerSection + 5);
  if (clientFacts.length) {
    lines.push("", "CLIENT-FILE FACTS (local lane, PII-allowed, verify against JobNimbus before acting):");
    for (const r of clientFacts) lines.push(`- ${flag(r)} [${r.kind}] ${r.content}`);
  }

  if (episodes.length) {
    lines.push("", "LAST SESSIONS (episodes, newest first):");
    for (const ep of episodes) {
      lines.push(`- ${ep.at.slice(0, 16)} — ${ep.summary}`);
      for (const d of ep.decisions.slice(0, 4)) lines.push(`    decision: ${d}`);
      for (const c of ep.commitments.slice(0, 4)) lines.push(`    open: ${c}`);
      for (const q of ep.openQuestions.slice(0, 3)) lines.push(`    question: ${q}`);
      for (const c of ep.corrections.slice(0, 3)) lines.push(`    correction: ${c}`);
    }
  }

  if (proposals.length) {
    lines.push("", "CANDIDATE PROPOSALS (suggestions only — need Chance's approval, never self-execute):");
    for (const p of proposals.slice(0, 6)) lines.push(`- ${p.id} [${p.type}/${p.priority}] ${p.title}: ${p.detail.slice(0, 160)}`);
  }

  lines.push("", "Truth-precedence: JobNimbus/Gmail/Quo records outrank every memory above. Verify before acting.");
  return lines.join("\n");
}

function flag(r) {
  const conf = r.confidence >= 0.85 ? "" : r.confidence >= 0.6 ? "~" : "?";
  return `${r.status === "verified" ? "✓" : "•"}${conf}`;
}
