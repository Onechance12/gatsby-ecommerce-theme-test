// CLI for the memory system. Usage: npm run memory -- <tool> '<json>'
// Tools: brain | remember | list | verify | dispute | handoff | propose |
//        proposals | review
// All writes are LOCAL files (no JobNimbus/Gmail/network) so no execute gate,
// with one exception baked into contracts: company-lane saves are PII-guarded.
import { renderBrain } from "./brain.js";
import {
  saveMemory, listMemory, setMemoryStatus,
  recordEpisode, latestEpisodes,
  saveProposal, listProposals, reviewProposal
} from "./store.js";
import { loadReviews } from "../assistant/fileReview.js";

export async function runMemoryTool(config, args) {
  const [tool, ...rest] = args;
  const input = parseInput(rest.join(" "));

  if (!tool || tool === "help") {
    printJson({
      tools: {
        brain: "render session-start orientation (run FIRST every session)",
        remember: '{"lane":"company|client","kind":"lesson|correction|fact|decision|preference|commitment|outcome","content":"...","evidence":[{"type":"chance|gmail|jobnimbus|quo|git|note","id":"...","note":"..."}],"importance":1-10,"subjectKey":"optional"}',
        list: '{"lane":"","kind":"","status":"","subjectKey":""}',
        verify: '{"id":"mem_...","approved":true,"by":"Chance Pearson"} — mark verified after explicit approval',
        dispute: '{"id":"mem_...","approved":true,"by":"Chance Pearson"} — mark disputed after explicit approval',
        handoff: '{"summary":"...","decisions":[],"commitments":[],"openQuestions":[],"corrections":[]} — run LAST every session',
        propose: '{"type":"recommendation|risk|opportunity|process_change","title":"","detail":"","memoryIds":["mem_..."]}',
        proposals: '{"status":"candidate"}',
        review: '{"id":"prop_...","status":"approved|rejected|executed|obsolete","reason":"","approved":true,"by":"Chance Pearson"}'
      },
      lanes: { company: "memory/company.jsonl — COMMITTED to the PUBLIC repo. No client names/numbers (enforced).", client: "data/memory/ — gitignored, local only. PII allowed." },
      authority: "remember creates candidates only; verify/dispute/review require explicit Chance approval; memory and proposals never execute external actions"
    });
    return;
  }

  if (tool === "brain") {
    // Local ops sessions default to the full client lane (single operator, one
    // machine). Pass {"clientLane":"subject","subjectKey":"<jnid>"} to isolate.
    console.log(renderBrain(config, { clientLane: input.clientLane || "full", subjectKey: input.subjectKey || "", includeEpisodes: input.includeEpisodes === true }));
    return;
  }

  if (tool === "remember") {
    const customerNames = input.lane === "company" ? safeCustomerNames(config) : [];
    const result = saveMemory(config, input, { customerNames });
    printJson(result.deduped
      ? { mode: "deduped", note: "existing memory strengthened (evidence merged, confidence raised)", record: compact(result.record) }
      : { mode: "saved", record: compact(result.record) });
    return;
  }

  if (tool === "list") {
    const rows = listMemory(config, input);
    printJson({ count: rows.length, records: rows.map(compact) });
    return;
  }

  if (tool === "verify" || tool === "dispute") {
    requireApproval(input);
    const record = setMemoryStatus(config, required(input.id, "id"), tool === "verify" ? "verified" : "disputed", { by: input.by, reason: input.reason || "" });
    printJson({ mode: tool, record: compact(record) });
    return;
  }

  if (tool === "handoff") {
    const episode = recordEpisode(config, input);
    printJson({ mode: "recorded", episode });
    return;
  }

  if (tool === "episodes") {
    printJson({ episodes: latestEpisodes(config, input.count || 3) });
    return;
  }

  if (tool === "propose") {
    printJson(saveProposal(config, input));
    return;
  }

  if (tool === "proposals") {
    printJson({ proposals: listProposals(config, input) });
    return;
  }

  if (tool === "review") {
    requireApproval(input);
    printJson({ proposal: reviewProposal(config, required(input.id, "id"), required(input.status, "status"), input.reason || "", { by: input.by }) });
    return;
  }

  throw new Error(`Unknown memory tool: ${tool}. Run 'npm run memory -- help'.`);
}

// Names from the synced book power the company-lane PII guard. Missing sweep
// data (fresh clone, fixtures mode) degrades to number-guard only.
function safeCustomerNames(config) {
  try { return loadReviews(config).map((r) => r?.file?.customer).filter(Boolean); }
  catch { return []; }
}

function compact(r) {
  return {
    id: r.id, lane: r.lane, kind: r.kind, status: r.status,
    confidence: r.confidence, importance: r.importance,
    content: r.content, subjectKey: r.subjectKey || undefined,
    evidence: (r.evidence || []).map((e) => `${e.type}:${e.id || e.note}`.slice(0, 80))
  };
}

function parseInput(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch { return { _: trimmed }; }
}

function required(value, name) {
  if (!value) throw new Error(`Missing required input: ${name}`);
  return value;
}

function requireApproval(input) {
  if (input.approved !== true || String(input.by || "").trim().toLowerCase() !== "chance pearson") {
    throw new Error('authoritative memory changes require approved:true and by:"Chance Pearson"');
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
