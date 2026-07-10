// Local CLI wrapper around the portable claim core. This module resolves a
// Chance file from the local sweep (fileReview) and adapts it to the core's
// canonical input contract, then builds the packet with the SAME core the Render
// bridge uses. There is one packet implementation (src/claim-filing-core), not two.
import { findMatches, loadReviews } from "./fileReview.js";
import { runChanceSweep } from "../sweep/runChanceSweep.js";
import { buildClaimCallPacket, cleanClaimNumber } from "../claim-filing-core/index.js";

// Re-export so existing importers (fileClaim.js) keep working against the core.
export { buildClaimCallPacket } from "../claim-filing-core/index.js";

const DEFAULT_GOAL = "file_new_claim";

// Adapt a local sweep `review` object into the core's canonical claim-file input.
// Pure property mapping — no core dependency on the review/sweep shape.
export function reviewToClaimInput(review) {
  const file = review?.file || {};
  return {
    file: { ...file, contact: file.source?.contact || {} },
    evidence: {
      categories: review?.categories || [],
      recommendedNextAction: review?.recommendedNextAction || "",
      bottleneck: review?.bottleneck || "",
      documents: file.documents || [],
      notes: file.notes || []
    }
  };
}

export async function runClaimCallPrompt(config, args) {
  const input = parseInput(args.join(" "));
  if (input.refresh === true) {
    await runChanceSweep(config);
  }
  const query = required(input.query || input._, "query");
  const reviews = loadReviews(config);
  const { review, alternates } = requireFileMatch(reviews, query);
  const packet = buildClaimCallPacket(reviewToClaimInput(review), {
    goal: input.goal || DEFAULT_GOAL,
    carrierPhone: input.carrierPhone || ""
  });

  printJson({
    tool: "claim_call_prompt",
    query,
    file: fileSummary(review),
    alternates: alternates.map((item) => fileSummary(item)),
    packet,
    prompt: renderCallPrompt(packet)
  });
}

function renderCallPrompt(packet) {
  return [
    `Call objective:\n${packet.objective}`,
    `Verified file facts:\n${renderFacts(packet.verifiedFileFacts)}`,
    `Damage summary:\n- ${packet.damageSummary.join("\n- ")}`,
    `Missing / caution fields:\n- ${packet.missingFields.length ? packet.missingFields.join("\n- ") : "None obvious from synced data"}`,
    `Quo-learned call pattern:\n- ${packet.quoLearnedCallPattern.join("\n- ")}`,
    `Call script:\n${packet.callScript}`,
    `Short IVR answers:\n- ${packet.shortIvrAnswers.join("\n- ")}`,
    `Information to capture:\n- ${packet.informationToCapture.join("\n- ")}`,
    `Stop rules:\n- ${packet.stopRules.join("\n- ")}`,
    `Return the result in this JSON shape:\n${JSON.stringify(packet.resultFormat, null, 2)}`
  ].join("\n\n");
}

function renderFacts(facts) {
  return Object.entries(facts)
    .map(([key, value]) => `- ${labelize(key)}: ${value || "Missing"}`)
    .join("\n");
}

function labelize(value) {
  return String(value)
    .replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
    .replace(/^./, (letter) => letter.toUpperCase());
}

function requireFileMatch(reviews, query) {
  const matches = findMatches(reviews, query);
  if (!matches.length) throw new Error(`No matching files found for: ${query}`);
  return { review: matches[0], alternates: matches.slice(1, 6) };
}

function fileSummary(review) {
  const file = review.file;
  return {
    id: file.id,
    customer: file.customer,
    status: file.status,
    carrier: file.carrier || "",
    policyNumber: file.policyNumber || "",
    claimNumber: cleanClaimNumber(file.claimNumber),
    dateOfLoss: file.dateOfLoss || "",
    address: file.address || ""
  };
}

function parseInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return { _: trimmed };
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Missing required input: ${name}`);
  return text;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
