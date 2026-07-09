import { loadReviews, findMatches } from "../assistant/fileReview.js";
import { buildClaimCallPacket } from "../assistant/claimCallPrompt.js";
import { normalizeE164, parseJsonArg } from "./twilioHelpers.js";
import {
  configureRetellAgentFromPacket,
  triggerRetellCall,
  fetchRetellCallResult
} from "./retell.js";

const FREE_TRIAL_NOTICE =
  "Chance's Retell account is on the FREE TRIAL. Test with a controlled call (e.g. Chance's own cell number) " +
  "before ever pointing this at a real carrier line. Do not run bulk/looped test calls.";

// npm run retell:configure -- '{"query":"Raj Thamizhan","goal":"file_new_claim","execute":false}'
export async function runRetellConfigure(config, args) {
  const input = parseJsonArg(args);
  const query = requireQuery(input);
  const { review } = requireFileMatch(config, query);
  const packet = buildClaimCallPacket(review, { goal: input.goal, carrierPhone: input.carrierPhone || "" });

  const result = await configureRetellAgentFromPacket(config, packet, {
    execute: input.execute === true,
    agentName: input.agentName,
    beginMessage: input.beginMessage
  });

  printJson({ tool: "retell_configure", freeTrialNotice: FREE_TRIAL_NOTICE, query, goal: packet.goal, result });
}

// npm run retell:call -- '{"query":"Raj Thamizhan","to":"+18065551212","execute":false}'
export async function runRetellCall(config, args) {
  const input = parseJsonArg(args);

  let packetInfo = {};
  let dynamicVariables;
  if (input.query) {
    const { review } = requireFileMatch(config, input.query);
    const packet = buildClaimCallPacket(review, { goal: input.goal, carrierPhone: input.carrierPhone || "" });
    packetInfo = { query: input.query, goal: packet.goal, objective: packet.objective };
    dynamicVariables = flattenFactsForDynamicVariables(packet);
  }

  const to = normalizeE164(input.to || config.twilio.verifiedTestNumber);
  const from = input.from ? normalizeE164(input.from) : undefined;

  const result = await triggerRetellCall(config, {
    to,
    from,
    agentId: input.agentId,
    metadata: input.metadata,
    dynamicVariables: input.dynamicVariables || dynamicVariables,
    execute: input.execute === true
  });

  printJson({ tool: "retell_call", freeTrialNotice: FREE_TRIAL_NOTICE, ...packetInfo, result });
}

// npm run retell:result -- '{"callId":"call_xyz"}'
export async function runRetellResult(config, args) {
  const input = parseJsonArg(args);
  const callId = String(input.callId || input._ || "").trim();
  if (!callId) {
    console.log('Usage: npm run retell:result -- \'{"callId":"call_xyz"}\'');
    process.exitCode = 1;
    return;
  }
  const result = await fetchRetellCallResult(config, callId);
  printJson({
    tool: "retell_result",
    result,
    postCallJobNimbusReminder: [
      "Do not update JobNimbus from this call result until Chance approves.",
      "After approval, update claim number/status/adjuster fields and leave one short file-specific note."
    ]
  });
}

// Every {{placeholder}} referenced in the Retell prompt. Kept in sync with
// renderRetellPrompt — any placeholder missing a value at call time would be
// spoken literally as "curly brace insured name", so we default them all.
const PROMPT_PLACEHOLDERS = [
  "objective",
  "insuredName",
  "propertyAddress",
  "homeownerPhone",
  "homeownerEmail",
  "carrier",
  "policyNumber",
  "claimNumber",
  "dateOfLoss",
  "stormTime",
  "causeOfLoss",
  "adjuster",
  "mortgageCompany",
  "damageSummary",
  "injuries",
  "homeLivable",
  "temporaryRepairs",
  "contractorHired",
  "occupancy",
  "damageDiscovered"
];

export function flattenFactsForDynamicVariables(packet) {
  const out = {};
  for (const [key, value] of Object.entries(packet.verifiedFileFacts || {})) {
    out[key] = String(value ?? "");
  }
  out.objective = String(packet.objective ?? "");
  // damageSummary is a separate packet field (array) — the generic prompt
  // references {{damageSummary}}, so pass it as a joined string per call.
  out.damageSummary = (packet.damageSummary || []).join(", ");
  for (const key of PROMPT_PLACEHOLDERS) {
    if (!out[key]) out[key] = "Missing";
  }
  return out;
}

function requireQuery(input) {
  const query = String(input.query || input._ || "").trim();
  if (!query) throw new Error("Missing required input: query");
  return query;
}

function requireFileMatch(config, query) {
  const reviews = loadReviews(config);
  const matches = findMatches(reviews, query);
  if (!matches.length) throw new Error(`No matching files found for: ${query}`);
  return { review: matches[0] };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
