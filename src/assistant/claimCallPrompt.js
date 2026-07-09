import { findMatches, loadReviews } from "./fileReview.js";
import { runChanceSweep } from "../sweep/runChanceSweep.js";

const DEFAULT_GOAL = "file_new_claim";

export async function runClaimCallPrompt(config, args) {
  const input = parseInput(args.join(" "));
  if (input.refresh === true) {
    await runChanceSweep(config);
  }
  const query = required(input.query || input._, "query");
  const reviews = loadReviews(config);
  const { review, alternates } = requireFileMatch(reviews, query);
  const goal = normalizeGoal(input.goal || DEFAULT_GOAL, review);
  const packet = buildClaimCallPacket(review, { goal, carrierPhone: input.carrierPhone || "" });

  printJson({
    tool: "claim_call_prompt",
    query,
    file: fileSummary(review),
    alternates: alternates.map((item) => fileSummary(item)),
    packet,
    prompt: renderCallPrompt(packet)
  });
}

export function buildClaimCallPacket(review, options = {}) {
  const file = review.file;
  const goal = normalizeGoal(options.goal || DEFAULT_GOAL, review);
  const facts = {
    insuredName: file.customer || "Missing",
    propertyAddress: file.address || "Missing",
    homeownerPhone: contactPhone(file) || "Missing",
    homeownerEmail: contactEmail(file) || "Missing",
    carrier: file.carrier || "Missing",
    policyNumber: file.policyNumber || "Missing",
    claimNumber: cleanClaimNumber(file.claimNumber) || "Missing / not filed",
    dateOfLoss: file.dateOfLoss || "Missing",
    causeOfLoss: file.typeOfLoss || inferCause(file),
    currentStatus: file.status || "Missing",
    adjuster: formatAdjuster(file),
    carrierPhone: options.carrierPhone || "User will provide / caller should find claims phone if needed"
  };

  const damageCategories = inferDamageCategories(review);
  const missingFields = missingCallFields(facts, goal, damageCategories);

  return {
    objective: objectiveFor(goal, facts),
    goal,
    verifiedFileFacts: facts,
    damageSummary: damageCategories,
    missingFields,
    quoLearnedCallPattern: buildQuoLearnedPattern(goal),
    callScript: buildCallScript(goal, facts, damageCategories),
    shortIvrAnswers: buildIvrAnswers(goal, facts),
    humanRepresentativeScript: buildHumanScript(goal, facts, damageCategories),
    informationToCapture: captureFieldsFor(goal),
    stopRules: buildStopRules(goal),
    resultFormat: buildResultFormat(goal),
    postCallJobNimbusReminder: [
      "Do not update JobNimbus from the call result until Chance approves.",
      "After approval, update claim number/status/adjuster fields and leave one short file-specific note."
    ]
  };
}

function objectiveFor(goal, facts) {
  if (goal === "file_new_claim") return `File a new property damage claim for ${facts.insuredName}.`;
  if (goal === "find_existing_claim") return `Find or confirm the existing claim for ${facts.insuredName}.`;
  if (goal === "lor_destination") return `Confirm where to send representation documents for ${facts.insuredName}.`;
  if (goal === "inspection_scheduling") return `Schedule or confirm the carrier inspection for ${facts.insuredName}.`;
  if (goal === "adjuster_assignment") return `Get the assigned adjuster contact information for ${facts.insuredName}.`;
  return `Follow up on the claim status for ${facts.insuredName}.`;
}

function buildCallScript(goal, facts, damageCategories) {
  return [
    "Use strict IVR discipline: wait for the full prompt, wait about 3 seconds, then answer shortly.",
    "Do not identify as the homeowner.",
    "Only give the full public adjuster introduction to a human representative.",
    "",
    buildHumanScript(goal, facts, damageCategories)
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
  if (goal === "file_new_claim") {
    answers.unshift("Reason for call: file a property claim");
  } else {
    answers.unshift("Reason for call: existing property claim");
  }
  return answers;
}

function buildHumanScript(goal, facts, damageCategories) {
  const intro = `Hi, this is Chance Pearson's assistant calling regarding a property damage claim for ${facts.insuredName} at ${facts.propertyAddress}.`;
  if (goal === "file_new_claim") {
    return [
      intro,
      `I need to file a new residential property claim. The carrier is ${facts.carrier}, policy number ${facts.policyNumber}, date of loss ${facts.dateOfLoss}, cause of loss ${facts.causeOfLoss}.`,
      `The reported damage categories are: ${damageCategories.join(", ")}.`,
      "Can you help get this claim opened and give me the claim number and document submission instructions?"
    ].join("\n");
  }
  if (goal === "lor_destination") {
    return [
      intro,
      `The claim number I have is ${facts.claimNumber}.`,
      "I need to confirm where to send the representation documents and what should be included in the subject line."
    ].join("\n");
  }
  if (goal === "inspection_scheduling") {
    return [
      intro,
      `The claim number I have is ${facts.claimNumber}.`,
      "I need to schedule or confirm the carrier inspection and get the assigned adjuster contact information."
    ].join("\n");
  }
  if (goal === "adjuster_assignment") {
    return [
      intro,
      `The claim number I have is ${facts.claimNumber}.`,
      "Can you confirm the assigned desk or field adjuster name, phone, email, and current next step?"
    ].join("\n");
  }
  return [
    intro,
    `The claim number I have is ${facts.claimNumber}.`,
    "I need to check the current status, confirm assigned adjuster information, and confirm next steps."
  ].join("\n");
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
  if (goal === "file_new_claim") fields.push("whether carrier will contact homeowner or PA first");
  return fields;
}

function buildQuoLearnedPattern(goal) {
  const base = [
    "Confirm the client/claim before moving forward.",
    "Ask one direct question at a time.",
    "If documents are requested, ask for the exact destination and subject-line rule.",
    "Ask whether anything else is needed from Chance before ending the call.",
    "Capture promised follow-up documents/emails and expected timing."
  ];
  if (goal === "file_new_claim") {
    return [
      ...base,
      "If the carrier finds an existing claim, switch from filing to claim number, adjuster, and document-submission capture."
    ];
  }
  if (goal === "lor_destination") {
    return [
      ...base,
      "Repeat the email address back enough to catch spelling/domain issues.",
      "Confirm if only the claim number should be in the email subject."
    ];
  }
  if (goal === "adjuster_assignment" || goal === "inspection_scheduling") {
    return [
      ...base,
      "Capture whether the adjuster is staff, desk, field, or third-party.",
      "Capture the expected report/estimate timeline after inspection."
    ];
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
    blocker: "",
    recommendedJobNimbusUpdates: {
      fields: {},
      status: "",
      note: ""
    },
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

function normalizeGoal(value, review) {
  const goal = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const allowed = new Set([
    "file_new_claim",
    "find_existing_claim",
    "status_follow_up",
    "lor_destination",
    "inspection_scheduling",
    "adjuster_assignment"
  ]);
  if (allowed.has(goal)) return goal;
  const claimNumber = cleanClaimNumber(review?.file?.claimNumber);
  return claimNumber ? "status_follow_up" : DEFAULT_GOAL;
}

function inferDamageCategories(review) {
  const file = review.file;
  const source = [
    review.recommendedNextAction,
    review.bottleneck,
    ...(review.categories || []),
    ...(file.documents || []).map((doc) => doc.name),
    ...(file.notes || []).map((note) => note.body)
  ].join("\n").toLowerCase();

  const categories = [];
  const checks = [
    ["roof hail/wind damage", /roof|shingle|slope|hail|wind/],
    ["gutters/downspouts", /gutter|downspout/],
    ["fascia/soffit", /fascia|soffit/],
    ["window screens/windows", /window|screen|glazing/],
    ["siding/exterior paint", /siding|exterior paint|paint damage|elevation/],
    ["fence", /fence/],
    ["HVAC/soft metals", /hvac|a\/c|ac unit|soft metal|vent|flashing/],
    ["detached structures", /shed|detached|carport/],
    ["interior water/ceiling damage", /interior|water stain|ceiling|drywall|leak/],
    ["personal property", /personal property|grill|chairs|patio|table/]
  ];

  for (const [label, pattern] of checks) {
    if (pattern.test(source)) categories.push(label);
  }

  return categories.length ? [...new Set(categories)] : ["No specific damage categories found in synced evidence"];
}

function inferCause(file) {
  const source = [
    file.typeOfLoss,
    file.status,
    ...(file.documents || []).map((doc) => doc.name),
    ...(file.notes || []).map((note) => note.body)
  ].join("\n").toLowerCase();
  if (source.includes("hail") && source.includes("wind")) return "Hail / wind";
  if (source.includes("hail")) return "Hail";
  if (source.includes("wind")) return "Wind";
  if (source.includes("water")) return "Water";
  return "Property damage";
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

function contactPhone(file) {
  return pickField(file.source?.contact, ["mobile_phone", "home_phone", "phone", "Phone", "Mobile Phone"]);
}

function contactEmail(file) {
  return pickField(file.source?.contact, ["email", "Email", "email_address"]);
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

function cleanClaimNumber(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\breference\s*#?\b/ig, "")
    .replace(/\bclaim\s*#?\b/ig, "")
    .replace(/(^|\s)#($|\s)/g, " ")
    .trim();
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
