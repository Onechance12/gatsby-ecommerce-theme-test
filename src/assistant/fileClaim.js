import { loadReviews, findMatches } from "./fileReview.js";
import { buildClaimCallPacket } from "./claimCallPrompt.js";
import { flattenFactsForDynamicVariables } from "../voice/retellCli.js";
import { triggerRetellCall, fetchRetellCallResult } from "../voice/retell.js";
import { runPostCallWriteback } from "./postCallWriteback.js";
import { lookupCarrier, knownCarriers } from "../voice/carrierDirectory.js";
import { ReadOnlyJobNimbusClient } from "../jobnimbus/client.js";
import { dateOnly } from "../lib/dates.js";

// ---------------------------------------------------------------------------
// file:claim — one deterministic command that gathers every fact a filing call
// needs and hands it to the Retell agent. Built to burn ZERO Claude tokens on
// the gathering/orchestration: Claude only kicks it off and reads the final
// result. Everything in between (JobNimbus reads, storm time, carrier lookup,
// dynamic-variable assembly, placing the call, polling the result) is code.
//
//   npm run file:claim -- '{"query":"Robert Frazier"}'                 (dry run)
//   npm run file:claim -- '{"query":"Robert Frazier","execute":true}'  (places call)
//   npm run file:claim -- '{"callId":"call_xxx"}'                      (fetch result)
// ---------------------------------------------------------------------------
export async function runFileClaim(config, args) {
  const input = parseInput(args.join(" "));

  // Mode 3: fetch a completed call AND propose the JobNimbus writeback bundle
  // (extracted claim #, adjuster, status, note) for approval.
  if (input.callId) {
    const result = await runPostCallWriteback(config, String(input.callId), input);
    printJson(result);
    return;
  }

  const query = required(input.query || input._, "query");
  const reviews = loadReviews(config);
  const matches = findMatches(reviews, query);
  if (!matches.length) throw new Error(`No matching files found for: ${query}`);
  const review = matches[0];

  // Read the live contact ONCE: refresh the key filing fields (sweep data can be
  // stale) and parse the inspection-captured description lines. One API call,
  // zero Claude tokens, fully fresh facts.
  const { captured, contact, liveError } = await gatherLiveContext(config, review);
  if (contact) applyLiveOverrides(review.file, contact);

  const goal = input.goal || "file_new_claim";
  const packet = buildClaimCallPacket(review, {
    goal,
    carrierPhone: input.carrierPhone || "",
    stormTime: input.stormTime || captured.stormTime || "",
    occupancy: input.occupancy || captured.occupancy || "",
    damageDiscovered: input.damageDiscovered || captured.damageDiscovered || "",
    injuries: input.injuries || "",
    homeLivable: input.homeLivable || "",
    temporaryRepairs: input.temporaryRepairs || "",
    contractorHired: input.contractorHired || ""
  });

  // Resolve the carrier filing number deterministically from the directory.
  const carrier = lookupCarrier(packet.verifiedFileFacts.carrier);
  const to = input.carrierPhone || carrier?.filingPhone || "";
  const dynamicVariables = flattenFactsForDynamicVariables(packet);

  const readiness = assessReadiness(packet, to, carrier);

  // Duplicate-filing guard: never open a NEW claim on a file that already has a
  // claim number (that's a follow-up, not a filing).
  const existingClaim = String(review.file.claimNumber || "").replace(/^missing.*/i, "").trim();
  if (goal === "file_new_claim" && existingClaim) {
    readiness.blockers.push(`file already has claim # ${existingClaim} — use goal:"status_follow_up", not a new filing`);
    readiness.ready = false;
  }
  // Surface a silent live-refresh failure so a call never quietly runs on stale data.
  if (liveError) {
    readiness.warnings.push(`LIVE JOBNIMBUS REFRESH FAILED (${liveError}) — facts below are from the last sweep and may be stale`);
  }

  const execute = input.execute === true;

  const plan = {
    tool: "file_claim",
    file: {
      id: review.file.id,
      customer: review.file.customer,
      status: review.file.status,
      address: review.file.address || ""
    },
    goal,
    objective: packet.objective,
    carrier: {
      name: packet.verifiedFileFacts.carrier,
      filingPhone: to || "(unknown — pass carrierPhone, no dossier for this carrier)",
      dossier: carrier?.dossier || null,
      known: Boolean(carrier),
      allKnownCarriers: knownCarriers()
    },
    capturedFromJobNimbus: captured,
    dynamicVariables,
    readiness,
    mode: execute && config.retell.allowRetellCalls ? "EXECUTE" : "DRY RUN"
  };

  if (!execute) {
    printJson({
      ...plan,
      note: "Dry run. Review the facts and readiness above. To place the call, set ALLOW_RETELL_CALLS=true and pass execute:true."
    });
    return;
  }

  if (!to) {
    printJson({ ...plan, blocked: "No filing phone. Pass carrierPhone or add this carrier to carrierDirectory.js." });
    process.exitCode = 1;
    return;
  }
  if (readiness.blockers.length) {
    printJson({ ...plan, blocked: `Not ready to file: ${readiness.blockers.join("; ")}. Override by fixing the file or passing the values explicitly.` });
    process.exitCode = 1;
    return;
  }

  const call = await triggerRetellCall(config, {
    to,
    agentId: input.agentId,
    dynamicVariables,
    metadata: { purpose: "file_claim", goal, file: `${review.file.customer} (${review.file.id})`, carrier: packet.verifiedFileFacts.carrier },
    execute: true
  });

  printJson({ ...plan, call, next: "Poll the result with: npm run file:claim -- '{\"callId\":\"<call_id>\"}'" });
}

// One live read of the contact: returns the inspection-captured description
// lines plus the raw contact record (for refreshing stale filing fields).
// liveError is set (not thrown) when the refresh fails, so callers can WARN
// rather than silently proceed on stale sweep data.
export async function gatherLiveContext(config, review) {
  const captured = { stormTime: "", occupancy: "", damageDiscovered: "" };
  if (config.useFixtures) return { captured, contact: null, liveError: null };
  try {
    const client = new ReadOnlyJobNimbusClient(config);
    const contact = await client.getJson(`${config.endpoints.contacts}/${encodeURIComponent(review.file.id)}`);
    const description = String(contact?.description || "");
    captured.stormTime = matchLine(description, "Time of Loss");
    captured.occupancy = matchLine(description, "Occupancy");
    captured.damageDiscovered = matchLine(description, "Damage Discovered");
    return { captured, contact, liveError: null };
  } catch (error) {
    return { captured, contact: null, liveError: config.redact ? config.redact(error.message) : error.message };
  }
}

// Overwrite the (possibly stale) sweep fields with the live contact's custom
// fields, using the same cf_* mapping the normalizer uses. Only overrides when
// the live value is present, so we never blank out good sweep data.
export function applyLiveOverrides(file, contact) {
  const set = (key, value) => { if (value) file[key] = value; };
  set("carrier", contact.cf_string_1 || contact["Insurance Company"]);
  set("claimNumber", contact.cf_string_2 || contact["Claim #"]);
  set("policyNumber", contact.cf_string_4 || contact["Policy #"]);
  set("typeOfLoss", contact.cf_string_5 || contact["Type Of Loss"]);
  const dol = dateOnly(contact.cf_date_1 || contact["Date of Loss"]);
  if (dol) file.dateOfLoss = dol;
  const adjName = contact.cf_string_7 || contact["Carrier DA"];
  if (adjName) {
    file.adjuster = {
      name: adjName,
      phone: contact.cf_string_8 || contact["Carrier DA Contact #"] || "",
      email: contact.cf_string_9 || contact["Carrier DA Email"] || ""
    };
  }
}

function matchLine(text, label) {
  const re = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)$`, "im");
  const m = re.exec(text || "");
  return m ? m[1].trim() : "";
}

// A file is "ready to file" when the carrier can actually find and open the
// claim: insured name, property address, carrier, policy number, date of loss.
function assessReadiness(packet, to, carrier) {
  const f = packet.verifiedFileFacts;
  const blockers = [];
  const isMissing = (v) => !v || /^missing/i.test(String(v));
  const warnings = [];
  if (isMissing(f.insuredName)) blockers.push("no insured name");
  if (isMissing(f.propertyAddress)) blockers.push("no property address");
  if (isMissing(f.carrier)) blockers.push("no carrier");
  if (isMissing(f.dateOfLoss)) blockers.push("no date of loss");
  if (!to && !carrier) blockers.push("no filing phone for this carrier");

  // Policy number is NOT a universal blocker: the Wave playbook has the agent let
  // the carrier locate coverage by insured name + property address + phone. Only
  // carriers explicitly flagged requiresPolicyNumber in the directory hard-block.
  if (isMissing(f.policyNumber)) {
    if (carrier?.requiresPolicyNumber) blockers.push(`no policy number (${carrier.display} requires it to locate the policy)`);
    else warnings.push("no policy number — carrier will be asked to locate coverage by insured name/address/phone");
  }

  if (isMissing(f.stormTime)) warnings.push("no storm time (run DOL report / inspection capture)");
  if (!packet.damageSummary?.length || /^No specific/i.test(packet.damageSummary[0])) {
    warnings.push("no damage scope captured");
  }
  return { ready: blockers.length === 0, blockers, warnings };
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
