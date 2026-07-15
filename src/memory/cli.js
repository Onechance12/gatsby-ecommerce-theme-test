#!/usr/bin/env node
// Standalone memory CLI for the bridge runtime (no ops-branch dependencies).
// Usage: npm run memory -- <tool> '<json>'
// Tools: brain | remember | list | verify | dispute | handoff | episodes |
//        propose | proposals | review
//
// Same contracts as the ops branch (see AGENT_HANDOFF core-sync rule — this
// module family stays in sync across branches). Storage root resolves to
// MEMORY_ROOT (set it to the Render persistent-disk mount, e.g. /var/data)
// else the working directory. Company lane (memory/company.jsonl) is tracked
// in git and PII-guarded; client lane (data/memory/) must NEVER be committed.
//
// PII guard note: the ops branch feeds the guard live customer names from its
// sweep. The bridge has no sweep, so pass names explicitly when available:
//   remember '{"lane":"company",...,"customerNames":["Full Name",...]}'
// The long-number guard always applies regardless.
import { renderBrain } from "./brain.js";
import {
  saveMemory, listMemory, setMemoryStatus,
  recordEpisode, latestEpisodes,
  saveProposal, listProposals, reviewProposal
} from "./store.js";

const [tool, ...rest] = process.argv.slice(2);
const config = { projectRoot: process.cwd() };  // company seed lives in the repo; MEMORY_ROOT (persistent disk) is honored inside the store for client data

function parseInput(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch { return { _: trimmed }; }
}
const input = parseInput(rest.join(" "));
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

try {
  if (!tool || tool === "help") {
    out({
      tools: ["brain", "remember", "list", "verify", "dispute", "handoff", "episodes", "propose", "proposals", "review"],
      lanes: {
        company: "memory/company.jsonl — tracked in git; PII-free (guarded).",
        client: "data/memory/ — NEVER commit; on Render set MEMORY_ROOT to a persistent disk or client memory is lost on deploy."
      },
      authority: "remember creates candidates only; verify/dispute/review require approved:true and by:\"Chance Pearson\"; no memory command executes external actions"
    });
  } else if (tool === "brain") {
    // Bridge default is ISOLATED: company rules only. Pass subjectKey for one
    // file's client records; clientLane:"full" is reserved for local operator use.
    const clientLane = input.clientLane || (input.subjectKey ? "subject" : "none");
    out(renderBrain(config, { clientLane, subjectKey: input.subjectKey || "", includeEpisodes: input.includeEpisodes === true }));
  } else if (tool === "remember") {
    const customerNames = Array.isArray(input.customerNames) ? input.customerNames : [];
    delete input.customerNames;
    const result = saveMemory(config, input, { customerNames });
    out(result.deduped ? { mode: "deduped", record: result.record } : { mode: "saved", record: result.record });
  } else if (tool === "list") {
    const rows = listMemory(config, input);
    out({ count: rows.length, records: rows });
  } else if (tool === "verify" || tool === "dispute") {
    requireApproval(input);
    out({ mode: tool, record: setMemoryStatus(config, input.id, tool === "verify" ? "verified" : "disputed", { by: input.by, reason: input.reason || "" }) });
  } else if (tool === "handoff") {
    out({ mode: "recorded", episode: recordEpisode(config, input) });
  } else if (tool === "episodes") {
    out({ episodes: latestEpisodes(config, input.count || 3) });
  } else if (tool === "propose") {
    out(saveProposal(config, input));
  } else if (tool === "proposals") {
    out({ proposals: listProposals(config, input) });
  } else if (tool === "review") {
    requireApproval(input);
    out({ proposal: reviewProposal(config, input.id, input.status, input.reason || "", { by: input.by }) });
  } else {
    throw new Error(`Unknown memory tool: ${tool}. Run with no args for help.`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function requireApproval(input) {
  if (input.approved !== true || String(input.by || "").trim().toLowerCase() !== "chance pearson") {
    throw new Error('authoritative memory changes require approved:true and by:"Chance Pearson"');
  }
}
