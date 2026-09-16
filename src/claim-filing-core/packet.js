// Portable claim-call packet builder. Pure + dependency-free (only sibling core
// modules). Takes the canonical claim-file input (see inputContract.js) and
// produces the goal-specific call packet: objective, verified facts (including
// the four resolved standard answers), damage summary, IVR/human scripts,
// capture list, stop rules, and result format. No JobNimbus, no CLI, no env.
import {
  normalizeClaimFileInput,
  normalizeCoverageTermStatus
} from "./inputContract.js";
import { resolveStandardAnswers, inferCause, inferDamageCategories } from "./standardAnswers.js";

export const DEFAULT_GOAL = "file_new_claim";
const ALLOWED_GOALS = new Set([
  "file_new_claim",
  "find_existing_claim",
  "status_follow_up",
  "lor_destination",
  "inspection_scheduling",
  "adjuster_assignment"
]);

// buildClaimCallPacket(input, options)
//   input   — canonical claim-file input (inputContract.js) OR a raw shape that
//             normalizeClaimFileInput can coerce.
//   options — per-call knobs: goal, carrierPhone, stormTime, occupancy,
//             damageDiscovered, propertyStories, roofAccessibility,
//             damagedRooms, damagedRoomCount, contractorPhone, injuries,
//             homeLivable, temporaryRepairs, contractorHired. Options override
//             the input.overrides/captured.
export function buildClaimCallPacket(input, options = {}) {
  const normalized = normalizeClaimFileInput(input);
  const file = normalized.file;
  const overrides = { ...normalized.overrides, ...options };
  const captured = normalized.captured;

  const goal = normalizeGoal(options.goal || overrides.goal || DEFAULT_GOAL, file);
  const causeOfLoss = file.typeOfLoss || inferCause(file, normalized.evidence);
  const standard = resolveStandardAnswers(overrides);
  const coverageTermStatus = normalizeCoverageTermStatus(overrides.coverageTermStatus, {
    defaultStatus: goal === "file_new_claim" ? "carrier_lookup_required" : ""
  });
  const policyCoverageStart = normalizePolicyCoverageDate(overrides.policyCoverageStart);
  const policyCoverageEnd = normalizePolicyCoverageDate(overrides.policyCoverageEnd);
  const dateOfLoss = normalizeDateOfLoss(file.dateOfLoss);
  const priorPolicyLookupInstruction = buildPriorPolicyLookupInstruction({
    goal,
    coverageTermStatus,
    policyCoverageStart,
    policyCoverageEnd,
    dateOfLoss
  });

  const facts = {
    insuredName: file.customer || "Missing",
    propertyAddress: file.address || "Missing",
    homeownerPhone: contactPhone(file) || "Missing",
    homeownerEmail: contactEmail(file) || "Missing",
    carrier: file.carrier || "Missing",
    policyNumber: file.policyNumber || "Missing",
    claimNumber: cleanClaimNumber(file.claimNumber) || "Missing / not filed",
    dateOfLoss,
    coverageTermStatus: coverageTermStatus || "not_applicable",
    policyCoverageStart,
    policyCoverageEnd,
    priorPolicyLookupInstruction,
    stormTime: overrides.stormTime || captured.stormTime || "Missing",
    causeOfLoss,
    currentStatus: file.status || "Missing",
    adjuster: formatAdjuster(file),
    mortgageCompany: file.mortgageCompany || "Missing",
    // The four Chance-approved standard answers (overrideable per call).
    injuries: standard.injuries,
    homeLivable: standard.homeLivable,
    temporaryRepairs: standard.temporaryRepairs,
    contractorHired: standard.contractorHired,
    occupancy: overrides.occupancy || captured.occupancy || "Missing",
    damageDiscovered: overrides.damageDiscovered || captured.damageDiscovered || "Missing",
    propertyStories: overrides.propertyStories || captured.propertyStories || "Missing",
    roofAccessibility: overrides.roofAccessibility || captured.roofAccessibility || "Missing",
    damagedRooms: overrides.damagedRooms || captured.damagedRooms || "Missing",
    damagedRoomCount: overrides.damagedRoomCount || captured.damagedRoomCount || "Missing",
    contractorPhone: overrides.contractorPhone || captured.contractorPhone || "Missing",
    carrierPhone: overrides.carrierPhone || "User will provide / caller should find claims phone if needed"
  };

  // Filename/note keyword matches are useful review hints, but they are not
  // approved claim facts. A new filing may speak and pass readiness only from
  // damage details/opening explicitly supplied in the approved call input.
  const inferredDamageCategories = inferDamageCategories(file, normalized.evidence);
  const approvedDamageDetails = normalizeApprovedDamageDetails(overrides.damageDetails);
  const approvedDamageOpening = normalizeApprovedDamageOpening(overrides.damageOpening);
  const newClaimDamageDetails = approvedDamageDetails.length
    ? approvedDamageDetails
    : approvedDamageOpening
      ? [approvedDamageOpening]
      : [];
  const damageDetails = goal === "file_new_claim"
    ? newClaimDamageDetails
    : normalizeDamageDetails(overrides.damageDetails, inferredDamageCategories);
  const damageCategories = goal === "file_new_claim"
    ? [...newClaimDamageDetails]
    : overrides.damageDetails
      ? [...damageDetails]
      : inferredDamageCategories;
  const damageOpening = goal === "file_new_claim"
    ? approvedDamageOpening || safeApprovedDamageOpening(approvedDamageDetails)
    : String(overrides.damageOpening || "Not applicable for an existing-claim lookup.").trim();
  const missingFields = missingCallFields(facts, goal, damageCategories);

  return {
    objective: objectiveFor(goal, facts),
    goal,
    verifiedFileFacts: facts,
    damageSummary: damageCategories,
    inferredDamageSummary: inferredDamageCategories,
    damageEvidenceSource: goal === "file_new_claim"
      ? (approvedDamageOpening || approvedDamageDetails.length ? "approved_override" : "missing_approved_damage")
      : (approvedDamageDetails.length ? "approved_override" : "synced_evidence_review"),
    damageOpening,
    damageDetails,
    missingFields,
    scriptAuthority: "retell_fixed_carrier_workflow",
    scriptInstruction: "Do not invent damage. Retell handles the IVR with short answers, gives one direct answer per question, and uses only the evidence-backed damage opening after a live person asks what was damaged.",
    quoLearnedCallPattern: buildQuoLearnedPattern(goal),
    callScript: buildCallScript(goal, facts, damageCategories, damageOpening, damageDetails),
    shortIvrAnswers: buildIvrAnswers(goal, facts),
    humanRepresentativeScript: buildHumanScript(goal, facts, damageCategories, damageOpening, damageDetails),
    informationToCapture: captureFieldsFor(goal),
    stopRules: buildStopRules(goal),
    resultFormat: buildResultFormat(goal),
    postCallJobNimbusReminder: [
      "Do not update JobNimbus from the call result until Chance approves.",
      "After approval, update claim number/status/adjuster fields and leave one short file-specific note."
    ]
  };
}

function normalizeDamageDetails(value, fallback) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value && String(value).trim()) return String(value).split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
  return [...fallback];
}

function normalizeApprovedDamageDetails(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(isUsableApprovedDamage);
  }
  const detail = String(value || "").trim();
  // Preserve an approved sentence intact. Splitting on commas or semicolons can
  // detach a limiting clause such as "storm causation not established."
  return isUsableApprovedDamage(detail) ? [detail] : [];
}

function normalizeApprovedDamageOpening(value) {
  const opening = String(value || "").trim();
  return isUsableApprovedDamage(opening) ? opening : "";
}

function isUsableApprovedDamage(value) {
  const detail = String(value || "").trim();
  const concreteComponent = /\b(?:roof|shingle|tile|metal|soft metal|flashing|fascia|soffit|gutter|downspout|vent|chimney|skylight|siding|window|screen|door|garage|fence|decking|sheathing|ceiling|wall|drywall|floor|flooring|paint|interior|room|hvac|air conditioner|a\/c|duct|coil|compressor|personal property|contents?)\b/i;
  if (
    !detail
    || /^(?:missing|unknown|undetermined|not applicable|n\/?a|none|no specific damage categories)\b/i.test(detail)
    || /^(?:damage occurred|property damage|storm damage|hail damage|wind damage)[.!]?$/i.test(detail)
  ) return false;
  if (
    (
      /\bno\s+damage\b/i.test(detail)
      || /\bdamage\s+(?:was|is|has)\s+not\s+(?:observed|reported|documented|found|confirmed|verified)\b/i.test(detail)
      || /^(?:no|none)\b.*\bdamage\b/i.test(detail)
    )
    && !/\b(?:but|however|except)\b/i.test(detail)
  ) return false;
  if (
    /\b(?:wear and tear|old damage|pre[- ]existing damage|unrelated to (?:this|the) loss)\b/i.test(detail)
    && !/\b(?:but|however|except)\b/i.test(detail)
  ) return false;
  if (!concreteComponent.test(detail)) return false;
  return true;
}

function safeApprovedDamageOpening(details) {
  const first = String(details?.[0] || "").trim();
  if (!first) return "Missing";
  // Do not paraphrase, broaden, or relabel an approved detail as documented
  // damage. Preserve its qualifiers and use only the first detail as the short
  // opening; the remaining approved details stay available for follow-up.
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

function normalizePolicyCoverageDate(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "Missing";
  const normalized = normalizeDateOfLoss(value);
  return claimDateKey(normalized) ? normalized : "Invalid";
}

function buildPriorPolicyLookupInstruction({
  goal,
  coverageTermStatus,
  policyCoverageStart,
  policyCoverageEnd,
  dateOfLoss
}) {
  if (goal !== "file_new_claim") return "Not applicable for an existing-claim lookup.";

  const dol = isMissingDate(dateOfLoss) ? "the approved date of loss" : `the ${dateOfLoss} date of loss`;
  const start = claimDateKey(policyCoverageStart);
  const end = claimDateKey(policyCoverageEnd);
  const loss = claimDateKey(dateOfLoss);

  if (coverageTermStatus === "blocked_conflict") {
    return `Policy or coverage evidence conflicts for ${dol}. Do not open a new claim until a newly approved packet resolves that conflict.`;
  }
  if (coverageTermStatus === "verified_in_force") {
    if (!start || !end || !loss || start > end || loss < start || loss > end) {
      return `Coverage is marked verified_in_force, but a complete valid policy term covering ${dol} is not loaded. Do not open a new claim until the packet is corrected.`;
    }
    return `The policy term from ${policyCoverageStart} through ${policyCoverageEnd} is verified in force for ${dol}; no prior-policy lookup is required.`;
  }

  return "Give the available policy number only when the carrier asks for it. Do not volunteer policy-term dates, describe the number as prior or expired, or ask the carrier to confirm active coverage. If the carrier cannot locate the policy, say only that this is the policy number you have, then provide the insured name and property address as requested so the carrier can search. Capture any corrected policy number the carrier volunteers. If the carrier still cannot locate the insured or accept the filing, capture the exact blocker.";
}

function claimDateKey(value) {
  const match = String(value || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";
  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return "";
  return `${year}-${month}-${day}`;
}

function isMissingDate(value) {
  return !value || /^(?:missing|invalid)$/i.test(String(value));
}

export function normalizeGoal(value, file) {
  const goal = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (ALLOWED_GOALS.has(goal)) return goal;
  const claimNumber = cleanClaimNumber(file?.claimNumber);
  return claimNumber ? "status_follow_up" : DEFAULT_GOAL;
}

export function normalizeDateOfLoss(value) {
  if (value === undefined || value === null || value === "") return "Missing";
  const raw = String(value).trim();
  let date;

  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return `${isoDate[2]}/${isoDate[3]}/${isoDate[1]}`;

  let dateOnlyEpoch = false;
  if (/^\d{10}$/.test(raw)) {
    date = new Date(Number(raw) * 1000);
    dateOnlyEpoch = true;
  }
  else if (/^\d{13}$/.test(raw)) {
    date = new Date(Number(raw));
    dateOnlyEpoch = true;
  }
  else {
    const matched = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (matched) {
      const [, month, day, year] = matched;
      return `${month.padStart(2, "0")}/${day.padStart(2, "0")}/${year}`;
    }
    date = new Date(raw);
  }

  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("en-US", {
    // JobNimbus custom date fields are date-only values stored at UTC midnight.
    // Rendering those epochs in Central time shifts the calendar date backward.
    timeZone: dateOnlyEpoch ? "UTC" : "America/Chicago",
    month: "2-digit",
    day: "2-digit",
    year: "numeric"
  }).format(date);
}

function objectiveFor(goal, facts) {
  if (goal === "file_new_claim") return `File a new property damage claim for ${facts.insuredName}.`;
  if (goal === "find_existing_claim") return `Find or confirm the existing claim for ${facts.insuredName}.`;
  if (goal === "lor_destination") return `Confirm where to send representation documents for ${facts.insuredName}.`;
  if (goal === "inspection_scheduling") return `Schedule or confirm the carrier inspection for ${facts.insuredName}.`;
  if (goal === "adjuster_assignment") return `Get the assigned adjuster contact information for ${facts.insuredName}.`;
  return `Follow up on the claim status for ${facts.insuredName}.`;
}

function buildCallScript(goal, facts, damageCategories, damageOpening, damageDetails) {
  return [
    "Use strict IVR discipline: listen to the complete prompt, take a short natural beat, then answer only what the IVR asked or press the explicitly requested digit.",
    "Do not identify as the homeowner.",
    "Only give the full public adjuster introduction to a human representative.",
    "",
    buildHumanScript(goal, facts, damageCategories, damageOpening, damageDetails)
  ].join("\n");
}

function buildIvrAnswers(goal, facts) {
  const answers = [
    `Policy number: ${facts.policyNumber}`,
    `Claim number: ${facts.claimNumber}`,
    `Property address: ${facts.propertyAddress}`,
    `Date of loss: ${facts.dateOfLoss}`,
    `Cause: ${facts.causeOfLoss}`
  ];
  answers.unshift(goal === "file_new_claim" ? "Reason for call: file a property claim" : "Reason for call: existing property claim");
  return answers;
}

function buildHumanScript(goal, facts, damageCategories, damageOpening = "Missing", damageDetails = damageCategories) {
  const filingIntro = "Hi, this is Chance Pearson's AI assistant with Wave Public Adjusting. We're the homeowner's public adjuster, and I'm calling to file a property claim.";
  const intro = `Hi, this is Chance Pearson's AI assistant with Wave Public Adjusting calling regarding the property claim for ${facts.insuredName}.`;
  if (goal === "file_new_claim") {
    return [
      filingIntro,
      "Stop and wait for the representative's next question. Do not volunteer the insured, address, policy, DOL, cause, or damage details in the opening.",
      `When asked broadly what happened, answer: ${damageOpening}`,
      `For follow-up questions, use only these verified details: ${damageDetails.join(", ")}.`
    ].join("\n");
  }
  if (goal === "lor_destination") {
    return [intro, `The claim number I have is ${facts.claimNumber}.`, "I need to confirm where to send the representation documents and what should be included in the subject line."].join("\n");
  }
  if (goal === "inspection_scheduling") {
    return [intro, `The claim number I have is ${facts.claimNumber}.`, "I need to schedule or confirm the carrier inspection and get the assigned adjuster contact information."].join("\n");
  }
  if (goal === "adjuster_assignment") {
    return [intro, `The claim number I have is ${facts.claimNumber}.`, "Can you confirm the assigned desk or field adjuster name, phone, email, and current next step?"].join("\n");
  }
  return [intro, `The claim number I have is ${facts.claimNumber}.`, "I need to check the current status, confirm assigned adjuster information, and confirm next steps."].join("\n");
}

function captureFieldsFor(goal) {
  const fields = [
    "claim number",
    "carrier representative name",
    "document submission email, portal, or fax",
    "subject-line instruction for document submission",
    "required documents now: LOR, FIN535/TDI, estimate, W9, PA contract",
    "adjuster name",
    "adjuster phone",
    "adjuster email",
    "adjuster role/company, if available",
    "next expected carrier action",
    "follow-up timeframe"
  ];
  if (goal === "inspection_scheduling") fields.push("inspection date/time and access requirements");
  if (goal === "file_new_claim") {
    fields.push("any corrected policy number the carrier volunteers during intake");
    fields.push("whether carrier will contact homeowner or PA first");
  }
  return fields;
}

function buildQuoLearnedPattern(goal) {
  const base = [
    "Confirm the client/claim before moving forward.",
    "Ask one direct question at a time.",
    "If documents are requested, ask for the exact destination and subject-line rule.",
    "Only after the claim/reference number and required closing details are captured, ask once whether the representative needs anything else before ending the call.",
    "Capture promised follow-up documents/emails and expected timing."
  ];
  if (goal === "file_new_claim") {
    return [...base, "If the carrier finds an existing claim, switch from filing to claim number, adjuster, and document-submission capture."];
  }
  if (goal === "lor_destination") {
    return [...base, "Repeat the email address back enough to catch spelling/domain issues.", "Confirm if only the claim number should be in the email subject."];
  }
  if (goal === "adjuster_assignment" || goal === "inspection_scheduling") {
    return [...base, "Capture whether the adjuster is staff, desk, field, or third-party.", "Capture the expected report/estimate timeline after inspection."];
  }
  return base;
}

function buildStopRules(goal) {
  const rules = [
    "Stop if the carrier asks for legal interpretation or coverage opinions.",
    "Stop if they cannot locate the policy/claim after policy number, property address, and insured name are checked.",
    "Stop if they require the homeowner on the line.",
    "Stop if they ask for information not verified in the packet."
  ];
  if (goal === "file_new_claim") {
    rules.push("If the carrier says an existing claim is already open, capture that claim number and switch to document-submission/adjuster-contact questions.");
  }
  return rules;
}

function buildResultFormat(goal) {
  return {
    callCompleted: "yes/no",
    objectiveCompleted: "yes/no/partial",
    claimNumber: "",
    representativeName: "",
    adjusterName: "",
    adjusterPhone: "",
    adjusterEmail: "",
    inspectionDateTime: "",
    documentSubmissionInstructions: "",
    documentsRequested: [],
    carrierNextStep: "",
    callbackRequested: "yes/no",
    callbackNumberConfirmed: "",
    blocker: "",
    recommendedJobNimbusUpdates: { fields: {}, status: "", note: "" },
    rawSummary: `Short summary of what happened on the ${goal} call.`
  };
}

function missingCallFields(facts, goal, damageCategories) {
  const requiredKeys = ["insuredName", "propertyAddress", "homeownerPhone", "carrier"];
  if (goal === "file_new_claim") requiredKeys.push("policyNumber", "dateOfLoss");
  if (goal !== "file_new_claim") requiredKeys.push("claimNumber");

  const missing = requiredKeys
    .filter((key) => !facts[key] || /^missing/i.test(facts[key]))
    .map((key) => key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`));

  if (!damageCategories.length || damageCategories[0].startsWith("No specific")) {
    missing.push("property-level damage summary");
  }
  return missing;
}

// ---------- pure field helpers ----------
export function cleanClaimNumber(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\breference\s*#?\b/ig, "")
    .replace(/\bclaim\s*#?\b/ig, "")
    .replace(/(^|\s)#($|\s)/g, " ")
    .trim();
}

function contactPhone(file) {
  return pickField(file.contact, ["mobile_phone", "home_phone", "phone", "Phone", "Mobile Phone"]);
}
function contactEmail(file) {
  return pickField(file.contact, ["email", "Email", "email_address"]);
}
function pickField(record, aliases) {
  if (!record || typeof record !== "object") return "";
  for (const alias of aliases) {
    const direct = record[alias];
    if (direct) return String(direct).trim();
    const normalized = alias.toLowerCase().replace(/[^a-z0-9]/g, "");
    const found = Object.keys(record).find((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized);
    if (found && record[found]) return String(record[found]).trim();
  }
  return "";
}
function formatAdjuster(file) {
  const parts = [file.adjuster?.name, file.adjuster?.phone, file.adjuster?.email].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Missing";
}
