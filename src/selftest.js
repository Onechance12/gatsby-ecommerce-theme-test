#!/usr/bin/env node

// Fast local self-test: exercises normalize -> rules on the bundled fixture
// without touching the network or writing outside the repo.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./lib/io.js";
import { normalizeFiles } from "./normalize/normalizeFiles.js";
import { reviewFiles } from "./rules/reviewFiles.js";
import { parseDate, daysBetween, dateOnly, todayDate } from "./lib/dates.js";
import { findChanceUserIds, isChanceContact } from "./lib/chanceScope.js";
import { isOperationalDocument } from "./jobnimbus/documentFilters.js";
import { extractCallResults, buildWritebackBundle } from "./assistant/postCallWriteback.js";
import { activityFileIds, noteOwnershipError } from "./assistant/actionTools.js";
import {
  buildClaimCallPacket,
  assessReadiness,
  existingClaimBlock,
  lookupCarrier,
  resolveStandardAnswers,
  buildWritebackProposal,
  STANDARD_FILING_ANSWERS
} from "./claim-filing-core/index.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`- ok   ${label}`);
  } else {
    console.log(`- FAIL ${label}`);
    failures += 1;
  }
}

// dates
check("parseDate handles ISO strings", dateOnly("2026-06-26T09:45:00-05:00") === "2026-06-26");
check("parseDate handles US dates", dateOnly("07/15/2026") === "2026-07-15");
check("parseDate handles unix seconds", parseDate(1782601000)?.getUTCFullYear() >= 2026);
check("daysBetween is signed days", daysBetween("2026-07-10", "2026-07-01") === 9);
check("todayDate returns a date", todayDate() instanceof Date);

// chance scope
const users = [{ jnid: "user-chance", first_name: "Chance", last_name: "Pearson" }];
const chanceIds = findChanceUserIds(users);
check("findChanceUserIds finds Chance", chanceIds.has("user-chance"));
check("isChanceContact matches by owner id", isChanceContact({ owners: [{ id: "user-chance" }] }, chanceIds));
check("isChanceContact matches by sales rep name", isChanceContact({ sales_rep_name: "Chance Pearson" }, chanceIds));
check("isChanceContact rejects others", !isChanceContact({ owners: [{ id: "user-mark", name: "Mark Harrison" }] }, chanceIds));

// document filters
check("pdf is operational", isOperationalDocument({ content_type: "application/pdf", filename: "policy.pdf" }));
check("esx is operational", isOperationalDocument({ content_type: "application/octet-stream", filename: "estimate.esx" }));
check("jpeg is not operational", !isOperationalDocument({ content_type: "image/jpeg", filename: "roof.jpg" }));

// normalize + rules on fixture
const raw = readJson(path.join(projectRoot, "fixtures", "sample-data.json"));
const { files } = normalizeFiles(raw);
check("fixture normalizes to files", files.length >= 6);

const rosa = files.find((file) => file.customer === "Rosa Sanchez");
check("insurance contact treated as file", Boolean(rosa));
check("custom fields map (carrier)", rosa?.carrier === "Farmers");
check("notes attach to files", (rosa?.notes || []).length >= 1);

const pete = files.find((file) => file.customer === "Pete Fowler");
check("payments attach to job files", (pete?.payments || []).length === 1);
check("open tasks attach", (pete?.openTasks || []).length >= 1);

const reviews = reviewFiles(files, { staleDays: 7, highPriorityStaleDays: 14 });
check("reviews produced for every file", reviews.length === files.length);
check("reviews are priority sorted", ["High", "Medium", "Low"].includes(reviews[0].priority));
check("every review has a next action", reviews.every((review) => review.recommendedNextAction));
check("every review has a thresher phase", reviews.every((review) => review.thresherPhase));

const readyForAppraisal = reviews.find((review) => review.file.customer === "Josee Jimenez");
check("ready-for-appraisal detected", readyForAppraisal?.categories.includes("Ready for appraisal"));

// ---- post-call writeback: extraction, outcome distinction, note hygiene ----
const fakeFile = { id: "abc123", customer: "Test Insured", status: "Photo File Received", carrier: "Allstate" };

// A NEW filing that captured a claim number via Retell's structured analysis.
// All values here are synthetic — never a real claim number, name, or phone.
const newFilingCall = {
  transcript: "Rep: your claim number is 1 1 1 2 2 2 3 3 3 4.",
  raw: {
    metadata: { goal: "file_new_claim" },
    call_analysis: { custom_analysis_data: { claim_number: "1112223334", adjuster_name: "Fixture Team", adjuster_phone: "555-000-1111" } }
  }
};
const newEx = extractCallResults(newFilingCall);
check("extract reads claim # from retell analysis", newEx.claimNumber === "1112223334");
check("extract source flags retell-analysis", newEx.source.claimNumber === "retell-analysis");
check("new-filing goal => claim_filed", newEx.outcome === "claim_filed");

const newBundle = buildWritebackBundle(fakeFile, newEx);
check("claim # goes to fields not just note", newBundle.proposedFields.cf_string_2 === "1112223334");
check("adjuster name goes to fields", newBundle.proposedFields.cf_string_7 === "Fixture Team");
check("writeback note is short (single line, no field dump)", newBundle.proposedNote.split("\n").length === 1 && !newBundle.proposedNote.includes("1112223334"));

// A STATUS follow-up that surfaced an existing claim number must NOT read as filed.
const followUpCall = {
  transcript: "Rep: yes that claim is on file, number 1 2 3 4 5 6 7.",
  raw: { metadata: { goal: "status_follow_up" }, call_analysis: { custom_analysis_data: { claim_number: "1234567" } } }
};
const followEx = extractCallResults(followUpCall);
check("follow-up goal => existing_claim_confirmed", followEx.outcome === "existing_claim_confirmed");
check("existing-claim note says confirmed, not filed", /confirmed/i.test(buildWritebackBundle(fakeFile, followEx).proposedNote));

// No claim number captured => no_result, and no field writes proposed.
const deadCall = { transcript: "no answer", raw: { metadata: { goal: "file_new_claim" }, call_analysis: { custom_analysis_data: {} } }, disconnectionReason: "dial_no_answer" };
const deadEx = extractCallResults(deadCall);
check("no claim # => no_result outcome", deadEx.outcome === "no_result");
check("no extraction => no field updates", Object.keys(buildWritebackBundle(fakeFile, deadEx).proposedFields).length === 0);

// Spelled-out claim number ("zero eight three...") parsed from transcript fallback.
const spelledCall = { transcript: "Rep: the claim number is zero eight three two seven, thanks.", raw: { metadata: {}, call_analysis: { custom_analysis_data: {} } } };
check("spelled-out claim # parsed from transcript", extractCallResults(spelledCall).claimNumber === "08327");

// ---- note-ownership guard (scope-note-update hardening) ----
const primaryOwned = { primary: { id: "abc123" }, related: [] };
const relatedOwned = { primary: { id: "zzz999" }, related: [{ id: "abc123" }] };
const foreign = { primary: { id: "other1" }, related: [{ id: "other2" }] };
check("activityFileIds collects primary + related", activityFileIds(relatedOwned).join(",") === "zzz999,abc123");
check("note owned via primary => allowed", noteOwnershipError(primaryOwned, "abc123", "Test") === "");
check("note owned via related => allowed", noteOwnershipError(relatedOwned, "abc123", "Test") === "");
check("note on foreign file => rejected", noteOwnershipError(foreign, "abc123", "Test").length > 0);
check("missing activity => rejected", noteOwnershipError(null, "abc123", "Test").length > 0);

// ---- portable claim core: packet, standard answers, readiness, duplicate guard ----
const coreInput = {
  file: {
    id: "file1", customer: "Synthetic Insured", address: "1 Test St, Dallas TX",
    carrier: "Allstate", policyNumber: "", claimNumber: "", dateOfLoss: "2026-05-01",
    typeOfLoss: "Hail", status: "Photo File Received",
    contact: { mobile_phone: "555-000-2222", email: "insured@example.test" }
  },
  evidence: { categories: ["roof hail damage"], documents: [], notes: [] }
};
const corePacket = buildClaimCallPacket(coreInput, { goal: "file_new_claim" });
check("core packet resolves insured", corePacket.verifiedFileFacts.insuredName === "Synthetic Insured");
check("core packet keeps the four standard defaults", corePacket.verifiedFileFacts.contractorHired === STANDARD_FILING_ANSWERS.contractorHired && corePacket.verifiedFileFacts.injuries === STANDARD_FILING_ANSWERS.injuries);

// Standard-answer override wins over the default when a file differs.
const overridden = buildClaimCallPacket(coreInput, { goal: "file_new_claim", injuries: "Yes, one minor injury reported" });
check("standard answer is overrideable", overridden.verifiedFileFacts.injuries === "Yes, one minor injury reported");
check("resolveStandardAnswers falls back to defaults", resolveStandardAnswers({}).temporaryRepairs === STANDARD_FILING_ANSWERS.temporaryRepairs);

// Missing policy number: allowed for a carrier that does not require it (warning, not blocker).
const allstate = lookupCarrier("Allstate");
const readyAllowed = assessReadiness(corePacket, allstate.filingPhone, allstate);
check("missing policy allowed when carrier does not require it", readyAllowed.ready === true && readyAllowed.warnings.some((w) => /no policy number/i.test(w)));

// Missing policy number: hard-blocks a carrier flagged requiresPolicyNumber.
const strictCarrier = { display: "Strict Mutual", filingPhone: "+18005550000", requiresPolicyNumber: true };
const readyBlocked = assessReadiness(corePacket, strictCarrier.filingPhone, strictCarrier);
check("missing policy blocks a requiresPolicyNumber carrier", readyBlocked.ready === false && readyBlocked.blockers.some((b) => /policy number/i.test(b)));

// Duplicate-new-claim guard.
check("existing claim blocks a new filing", existingClaimBlock("CLM-123456", "file_new_claim").length > 0);
check("existing claim does not block a status follow-up", existingClaimBlock("CLM-123456", "status_follow_up") === "");
check("no claim number => no duplicate block", existingClaimBlock("", "file_new_claim") === "");

// ---- writeback confidence: transcript-guessed adjuster fields are NOT silently written ----
const guessCall = {
  transcript: "Rep: the claim number is 9 9 8 8 7 7 6 6. You can reach the adjuster team at 800-555-1212, email adjuster@example.test.",
  raw: { metadata: { goal: "file_new_claim" }, call_analysis: { custom_analysis_data: { claim_number: "99887766" } } }
};
const guessEx = extractCallResults(guessCall);
const guessProposal = buildWritebackProposal({ id: "file1", customer: "Synthetic Insured", status: "Photo File Received" }, guessEx);
check("claim # (structured) written to fields", guessProposal.proposedFields.cf_string_2 === "99887766");
check("transcript-guessed adjuster phone NOT written as verified field", !("cf_string_8" in guessProposal.proposedFields));
check("transcript-guessed adjuster surfaced as unverified", guessProposal.unverified.some((u) => u.source === "transcript-guess"));
check("note does not claim adjuster saved when none verified", /awaiting adjuster/i.test(guessProposal.proposedNote));

// Accurate note when an adjuster WAS captured (structured): no "awaiting adjuster".
const withAdjuster = extractCallResults({ raw: { metadata: { goal: "file_new_claim" }, call_analysis: { custom_analysis_data: { claim_number: "55554444", adjuster_name: "Desk Team" } } } });
const adjProposal = buildWritebackProposal({ id: "file1", customer: "Synthetic Insured", status: "Photo File Received" }, withAdjuster);
check("adjuster captured => field written + note reflects it", adjProposal.proposedFields.cf_string_7 === "Desk Team" && /adjuster saved/i.test(adjProposal.proposedNote) && !/awaiting adjuster/i.test(adjProposal.proposedNote));

// ---- Codex edge-case follow-ups ----
// (1) All four defaults apply to NON-storm losses too (habitability not dropped).
const nonStormInput = { file: { customer: "Non Storm", address: "2 Test St", carrier: "Allstate", dateOfLoss: "2026-05-02", typeOfLoss: "Theft" }, evidence: {} };
const nonStormPacket = buildClaimCallPacket(nonStormInput, { goal: "file_new_claim" });
check("non-storm loss still gets habitable default", nonStormPacket.verifiedFileFacts.homeLivable === STANDARD_FILING_ANSWERS.homeLivable);
check("resolveStandardAnswers gives all four defaults with no overrides", resolveStandardAnswers({}).homeLivable === STANDARD_FILING_ANSWERS.homeLivable);

// (2) Evidence-only documents/notes are honored (bridge supplies them under evidence).
// typeOfLoss is left empty so cause is INFERRED from the evidence note (a present
// typeOfLoss would short-circuit inference).
const evidenceOnly = { file: { customer: "Evidence Only", address: "3 Test St", carrier: "Allstate", dateOfLoss: "2026-05-03", typeOfLoss: "", documents: [], notes: [] }, evidence: { documents: [{ name: "roof inspection report" }], notes: [{ body: "hail impact bruising on shingles; gutter and downspout damage noted" }] } };
const evidencePacket = buildClaimCallPacket(evidenceOnly, { goal: "file_new_claim" });
check("evidence-only documents drive damage categories", evidencePacket.damageSummary.some((c) => /roof/i.test(c)) && !/^No specific/i.test(evidencePacket.damageSummary[0]));
check("evidence-only notes drive cause inference", evidencePacket.verifiedFileFacts.causeOfLoss === "Hail");

// (3) Structured adjuster PHONE (no name) still counts as captured in the note.
const phoneOnlyAdj = extractCallResults({ raw: { metadata: { goal: "file_new_claim" }, call_analysis: { custom_analysis_data: { claim_number: "66667777", adjuster_phone: "800-555-9000" } } } });
const phoneOnlyProposal = buildWritebackProposal({ id: "file1", customer: "Synthetic Insured", status: "Photo File Received" }, phoneOnlyAdj);
check("adjuster phone-only written to fields", phoneOnlyProposal.proposedFields.cf_string_8 === "800-555-9000");
check("adjuster phone-only note does not say awaiting adjuster", !/awaiting adjuster/i.test(phoneOnlyProposal.proposedNote));

// ---- Memory system (contracts only — no disk writes in selftest) ----
const { normalizeMemoryDraft, assertCompanyLaneSafe, normalizeProposalDraft } = await import("./memory/contracts.js");
const memDraft = normalizeMemoryDraft({ lane: "company", kind: "lesson", content: "synthetic lesson content for selftest", evidence: [{ type: "chance", note: "synthetic" }] });
check("memory draft normalizes with confirmed chance evidence", memDraft.evidence[0].verification === "confirmed" && memDraft.status === "candidate");
check("memory draft builds a dedup key", memDraft.dedupKey.startsWith("company:lesson:"));
let memThrew = "";
try { normalizeMemoryDraft({ lane: "company", kind: "lesson", content: "no evidence here at all" }); } catch (e) { memThrew = e.message; }
check("memory without evidence is rejected", /evidence/.test(memThrew));
let piiThrew = "";
try { assertCompanyLaneSafe("Synthetic Person owes a call", ["Synthetic Person"]); } catch (e) { piiThrew = e.message; }
check("company-lane PII guard blocks client names", /client name/.test(piiThrew));
let numThrew = "";
try { assertCompanyLaneSafe("claim 12345678 update"); } catch (e) { numThrew = e.message; }
check("company-lane PII guard blocks long numbers", /long number/.test(numThrew));
let propThrew = "";
try { normalizeProposalDraft({ type: "recommendation", title: "test", detail: "detail long enough", memoryIds: [] }); } catch (e) { propThrew = e.message; }
check("proposal without cited memories is rejected", /memory id/.test(propThrew));

// ---- History miner classification helpers ----
const { bucketStatus, normalizeCarrier } = await import("./assistant/historyMiner.js");
check("miner buckets Lost as dead", bucketStatus("Lost") === "dead");
check("miner buckets Hold/Closed as closed", bucketStatus("Hold/Closed") === "closed");
check("miner buckets leads separately", bucketStatus("Cold Lead (Recycle)") === "lead" && bucketStatus("Warm Lead (or New)") === "lead");
check("miner buckets billing as settlement", bucketStatus("Ready for Billing") === "settlement");
check("miner normalizes carrier typos", normalizeCarrier("All State") === "Allstate" && normalizeCarrier("Sate Farm") === "State Farm");

// ---- Memory hardening (Codex PR #4 acceptance checks) — temp-dir isolated ----
{
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const { saveMemory, listMemory, setMemoryStatus, saveProposal, memoryPaths } = await import("./memory/store.js");
  const { renderBrain } = await import("./memory/brain.js");
  const { assertCompanyLaneSafe } = await import("./memory/contracts.js");

  const repoRoot = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "mem-repo-"));
  const dataRoot = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "mem-data-"));
  const cfg = { projectRoot: repoRoot, memoryRoot: dataRoot };

  // split roots: company anchors to repo root even when memoryRoot differs
  const paths = memoryPaths(cfg);
  check("memory: company lane anchored to repo root", paths.company.startsWith(repoRoot));
  check("memory: client lane follows data root", paths.client.startsWith(dataRoot));

  // seed survives a data-root override
  fsm.mkdirSync(pathm.join(repoRoot, "memory"), { recursive: true });
  const seeded = saveMemory(cfg, { lane: "company", kind: "lesson", content: "seeded rule for selftest coverage", evidence: [{ type: "chance", note: "synthetic" }] }).record;
  check("memory: chance-confirmed evidence births a verified record", seeded.status === "verified");
  check("memory: seeded company rule visible with data-root override", listMemory(cfg, { lane: "company" }).length === 1);

  // authority: candidate quarantined, disputed never guidance
  const cand = saveMemory(cfg, { lane: "company", kind: "decision", content: "candidate decision must be quarantined", evidence: [{ type: "note", note: "synthetic observation" }] }).record;
  let brain = renderBrain(cfg);
  check("memory: candidate decision NOT under operating rules", !brain.split("UNVERIFIED CANDIDATES")[0].includes("candidate decision must be quarantined"));
  check("memory: candidate decision IS quarantined", brain.includes("UNVERIFIED CANDIDATES") && brain.includes("candidate decision must be quarantined"));
  setMemoryStatus(cfg, cand.id, "disputed", { by: "selftest" });
  brain = renderBrain(cfg);
  check("memory: disputed record renders nowhere as guidance", !brain.includes("candidate decision must be quarantined"));

  // isolation: subject mode hides other files
  saveMemory(cfg, { lane: "client", kind: "fact", content: "file A synthetic fact", evidence: ["a"], subjectKey: "fileA" });
  saveMemory(cfg, { lane: "client", kind: "fact", content: "file B synthetic fact", evidence: ["b"], subjectKey: "fileB" });
  const isolated = renderBrain(cfg, { clientLane: "subject", subjectKey: "fileA" });
  check("memory: subject isolation shows file A", isolated.includes("file A synthetic fact"));
  check("memory: subject isolation hides file B", !isolated.includes("file B synthetic fact"));

  // PII patterns fail closed (no customerNames list needed)
  const rejects = (txt) => { try { assertCompanyLaneSafe(txt); return false; } catch { return true; } };
  check("memory PII: email rejected", rejects("carrier desk is reachable at desk@example.com for scheduling"));
  check("memory PII: phone rejected", rejects("call the adjuster line 214-555-0142 before noon"));
  check("memory PII: street address rejected", rejects("the property at 1012 Sunset Dr needs a tarp"));
  check("memory PII: named insured rejected", rejects("the policyholder John Smith prefers texts"));
  check("memory PII: clean operating rule accepted", !rejects("always verify the claim number by fetching the created activity"));
  check("memory PII: stats text not mistaken for an address", !rejects("48% of files (159/329) sit untouched >= 14 days against the 2-week audit standard"));

  // proposals must cite live memory ids
  let propThrew2 = "";
  try { saveProposal(cfg, { type: "risk", title: "phantom", detail: "cites a memory that does not exist", memoryIds: ["mem_nope"] }); } catch (e) { propThrew2 = e.message; }
  check("memory: proposal citing unknown memory id rejected", /unknown|retired/.test(propThrew2));

  // corruption surfacing: mutations blocked on corrupt files
  fsm.appendFileSync(paths.company, "{not-json\n");
  let corrThrew = "";
  try { saveMemory(cfg, { lane: "company", kind: "lesson", content: "should not write over corruption", evidence: ["x"] }); } catch (e) { corrThrew = e.message; }
  check("memory: mutation refuses corrupt file", /corrupt/i.test(corrThrew));

  // provenance required on status changes
  let provThrew = "";
  try { setMemoryStatus(cfg, seeded.id, "disputed", {}); } catch (e) { provThrew = e.message; }
  check("memory: status change without provenance rejected", /provenance/.test(provThrew));

  fsm.rmSync(repoRoot, { recursive: true, force: true });
  fsm.rmSync(dataRoot, { recursive: true, force: true });
}

// ---- Scope miner parsers (synthetic snippets, both carrier styles) ----
const { parseEstimateText, normalizeItem } = await import("./assistant/scopeMiner.js");
const { classifyDocument } = await import("./assistant/historyMiner.js");
const styleA = parseEstimateText("1.  3 tab - 25 yr. - composition shingle roofing 3.00 EA 19.69 59.07 7/25 yrs Avg. 28% (16.54) 42.53\nReplacement Cost Value $244.39");
check("scope: inline (Allstate) style parses", styleA.items.length === 1 && styleA.items[0].qty === 3 && styleA.totals.rcv === 244.39);
const styleB = parseEstimateText("R&R Drip edge\n74.00 LF 9.04 24.66 693.62 693.62\nReplacement Cost Value 3,145.82");
check("scope: split (State Farm) style parses", styleB.items.length === 1 && /drip edge/i.test(styleB.items[0].description) && styleB.totals.rcv === 3145.82);
check("scope: item normalization collides abbreviations", normalizeItem("R&R Laminated - comp. shingle rfg.") === normalizeItem("remove replace laminated composition shingle roofing"));
check("scope: document classifier", classifyDocument("_Final Draft with_without Removal Depreciation.pdf") === "our-estimate" && classifyDocument("Carrier Estimate 1.pdf") === "carrier-scope" && classifyDocument("JAIRO.ESX") === "our-estimate");

console.log("");
if (failures) {
  console.error(`Self-test failed: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`Self-test passed (${reviews.length} fixture files reviewed).`);
