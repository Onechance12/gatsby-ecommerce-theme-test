import { buildFileReview, findMatches, loadReviews } from "./fileReview.js";
import { buildClaimCallPacket } from "./claimCallPrompt.js";

const TOOL_DEFINITIONS = [
  {
    name: "search_files",
    description: "Find JobNimbus files by client name, claim number, address, carrier, policy number, status, or JobNimbus id.",
    input: { query: "string" },
    readonly: true
  },
  {
    name: "review_file",
    description: "Review one JobNimbus file with timeline, bottleneck, risks, next actions, tasks, payments, documents, and suggested internal note.",
    input: { query: "string" },
    readonly: true
  },
  {
    name: "claim_packet",
    description: "Build a claim-filing or post-filing packet for one JobNimbus file.",
    input: { query: "string" },
    readonly: true
  },
  {
    name: "claim_call_prompt",
    description: "Build a Mitra-ready or future voice-agent-ready phone call prompt/result schema for one JobNimbus file.",
    input: { query: "string", goal: "file_new_claim|find_existing_claim|status_follow_up|lor_destination|inspection_scheduling|adjuster_assignment optional", carrierPhone: "string optional" },
    readonly: true
  },
  {
    name: "draft_message",
    description: "Draft a Quo/Gmail/JobNimbus message for one file. Does not send or update anything.",
    input: { query: "string", audience: "client|adjuster|carrier|internal", purpose: "string" },
    readonly: true
  },
  {
    name: "next_actions",
    description: "Return files that need action, filtered by category/owner-like terms. This is for chat triage, not a dashboard.",
    input: { filter: "string optional", limit: "number optional" },
    readonly: true
  }
];

export function runChatTool(config, args) {
  const [toolName, ...rest] = args;

  if (!toolName || toolName === "list") {
    printJson({ tools: TOOL_DEFINITIONS });
    return;
  }

  const input = parseInput(rest.join(" "));
  const reviews = loadReviews(config);

  if (toolName === "search_files") {
    const query = required(input.query || input._, "query");
    const matches = findMatches(reviews, query).slice(0, input.limit || 10);
    printJson({
      tool: toolName,
      query,
      matches: matches.map((review) => fileSummary(review))
    });
    return;
  }

  if (toolName === "review_file") {
    const query = required(input.query || input._, "query");
    const { review, alternates } = requireFileMatch(reviews, query);
    printJson({
      tool: toolName,
      query,
      file: fileSummary(review),
      structured: structuredReview(review),
      markdown: buildFileReview(review, alternates)
    });
    return;
  }

  if (toolName === "claim_packet") {
    const query = required(input.query || input._, "query");
    const { review } = requireFileMatch(reviews, query);
    printJson({
      tool: toolName,
      query,
      packet: buildClaimPacket(review)
    });
    return;
  }

  if (toolName === "claim_call_prompt") {
    const query = required(input.query || input._, "query");
    const { review } = requireFileMatch(reviews, query);
    const packet = buildClaimCallPacket(review, {
      goal: input.goal,
      carrierPhone: input.carrierPhone
    });
    printJson({
      tool: toolName,
      query,
      packet
    });
    return;
  }

  if (toolName === "draft_message") {
    const query = required(input.query || input._, "query");
    const audience = lower(input.audience || "client");
    const purpose = input.purpose || "status update";
    const { review } = requireFileMatch(reviews, query);
    printJson({
      tool: toolName,
      query,
      audience,
      purpose,
      draft: draftMessage(review, audience, purpose),
      sendable: false,
      reason: "Draft only. Sending through Quo/Gmail must be explicitly approved in chat."
    });
    return;
  }

  if (toolName === "next_actions") {
    const filter = lower(input.filter || input._ || "");
    const limit = Number(input.limit || 12);
    const matches = reviews
      .filter((review) => filterReview(review, filter))
      .slice(0, Number.isFinite(limit) ? limit : 12)
      .map((review) => ({
        ...fileSummary(review),
        action: review.recommendedNextAction,
        task: review.suggestedTask,
        missingInfo: review.missingInfo,
        categories: review.categories
      }));
    printJson({ tool: toolName, filter, matches });
    return;
  }

  throw new Error(`Unknown chat tool: ${toolName}. Run \`npm run chat:tool -- list\`.`);
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
    thresherPhase: review.thresherPhase,
    priority: review.priority,
    carrier: file.carrier || "",
    claimNumber: cleanClaimNumber(file.claimNumber),
    policyNumber: file.policyNumber || "",
    dateOfLoss: file.dateOfLoss || "",
    address: file.address || "",
    lastActivityDate: file.lastActivityDate || ""
  };
}

function structuredReview(review) {
  const file = review.file;
  return {
    currentStage: file.status,
    thresherPhase: review.thresherPhase,
    workflowLane: review.workflowLane,
    ownerLane: review.ownerLane,
    bottleneck: review.bottleneck,
    riskFlags: review.categories.filter((category) => !category.startsWith("Thresher:")),
    missingInfo: review.missingInfo,
    nextActions: buildNextActions(review),
    suggestedTask: review.suggestedTask,
    suggestedInternalNote: review.suggestedInternalNote,
    openTasks: file.openTasks,
    payments: file.payments,
    documents: file.documents.slice(0, 25),
    recentNotes: recentNotes(file, 8)
  };
}

function buildClaimPacket(review) {
  const file = review.file;
  const docs = file.documents || [];
  const notes = (file.notes || []).map((note) => note.body || "").join("\n");
  const damage = inferDamageCategories(`${notes}\n${docs.map((doc) => doc.name).join("\n")}`);
  const packet = {
    insuredName: file.customer,
    propertyAddress: file.address || "Missing",
    homeownerPhone: contactPhone(file) || "Missing",
    homeownerEmail: contactEmail(file) || "Missing",
    carrier: file.carrier || "Missing",
    policyNumber: file.policyNumber || "Missing",
    claimNumber: cleanClaimNumber(file.claimNumber) || "Missing / not filed",
    dateOfLoss: file.dateOfLoss || "Missing",
    causeOfLoss: file.typeOfLoss || inferCause(notes),
    damageCategories: damage,
    adjuster: formatAdjuster(file),
    requiredBeforeCall: claimNeeds(file, damage, review),
    postFilingChecklist: [
      "Update JobNimbus claim number and correct status.",
      "Send LOR/PA contract/estimate/W9 to the carrier destination.",
      "Confirm carrier receipt and assigned desk/field adjuster.",
      "Confirm payment/check redirection before ACV is released.",
      "Notify homeowner of claim filed and expected next step.",
      "Create a follow-up task for carrier response or inspection scheduling."
    ],
    documentsAvailable: docs.slice(0, 20).map((doc) => doc.name),
    recentNotes: recentNotes(file, 6),
    recommendedNextAction: review.recommendedNextAction
  };
  return packet;
}

function draftMessage(review, audience, purpose) {
  const file = review.file;
  const purposeText = lower(purpose);

  if (audience === "internal") {
    return `${review.suggestedInternalNote}`;
  }

  if (audience === "adjuster") {
    if (purposeText.includes("lor")) {
      return `Hi, this is Chance with Wave Public Adjusting regarding ${file.customer}${cleanClaimNumber(file.claimNumber) ? `, claim ${cleanClaimNumber(file.claimNumber)}` : ""}. Wanted to make sure you got our LOR. If not, where should I send it?`;
    }
    return `Hi, this is Chance with Wave Public Adjusting regarding ${file.customer}${cleanClaimNumber(file.claimNumber) ? `, claim ${cleanClaimNumber(file.claimNumber)}` : ""}. I wanted to check the current status and confirm the next step on this claim.`;
  }

  if (audience === "carrier") {
    return `Hello, this is Chance Pearson with Wave Public Adjusting regarding ${file.customer}${cleanClaimNumber(file.claimNumber) ? `, claim ${cleanClaimNumber(file.claimNumber)}` : ""}. Please confirm receipt of our representation documents and advise the assigned adjuster contact information and next inspection/status step.`;
  }

  if (purposeText.includes("policy") || purposeText.includes("dec")) {
    return `Hi ${firstName(file.customer)}, this is Chance with Wave Public Adjusting. Could you please send me a copy of your policy or declarations page when you get a chance? We need the current coverage and correct insured information so we can keep the file moving.`;
  }

  if (purposeText.includes("inspection") || purposeText.includes("appointment")) {
    return `Hi ${firstName(file.customer)}, this is Chance with Wave Public Adjusting. The insurance inspection is ${inspectionTime(file) || "being scheduled"}. We will need access to the interior so the adjuster can inspect ceilings and any possible interior damage.`;
  }

  return `Hi ${firstName(file.customer)}, this is Chance with Wave Public Adjusting. Quick update on your file: ${plainStatus(review)} I’ll keep pushing this forward and will update you once the next step is confirmed.`;
}

function buildNextActions(review) {
  const actions = [review.recommendedNextAction];
  if (review.missingInfo.length) actions.push(`Collect missing info: ${review.missingInfo.join(", ")}.`);
  if (review.suggestedTask) actions.push(`Create/update task: ${review.suggestedTask}.`);
  return [...new Set(actions.filter(Boolean))].slice(0, 3);
}

function filterReview(review, filter) {
  if (!filter) return review.priority !== "Low";
  const haystack = lower([
    review.file.customer,
    review.file.status,
    review.file.carrier,
    review.thresherPhase,
    review.workflowLane,
    review.ownerLane,
    review.bottleneck,
    review.recommendedNextAction,
    ...(review.categories || []),
    ...(review.missingInfo || [])
  ].join(" "));
  return haystack.includes(filter);
}

function recentNotes(file, limit) {
  return (file.notes || [])
    .filter((note) => note.body)
    .slice()
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, limit)
    .map((note) => ({
      createdAt: note.createdAt,
      body: clean(note.body).slice(0, 400)
    }));
}

function inferDamageCategories(text) {
  const source = lower(text);
  const categories = [];
  const checks = [
    ["roof", /roof|shingle|ridge|slope|eave|drip edge/],
    ["exterior elevations", /elevation|exterior|siding|paint|fascia|soffit/],
    ["gutters/downspouts", /gutter|downspout|splash guard/],
    ["windows/screens", /window|screen|glazing/],
    ["fence", /fence/],
    ["interior water/ceiling", /interior|water stain|ceiling|drywall|attic/],
    ["detached structures", /shed|detached|garage|carport/],
    ["personal property", /personal property|grill|chairs|table|patio/],
    ["HVAC/soft metals", /hvac|a\/c|ac unit|soft metal|vents|flashing/]
  ];
  for (const [label, pattern] of checks) {
    if (pattern.test(source)) categories.push(label);
  }
  return categories.length ? categories : ["No specific damage categories found in synced notes/document metadata"];
}

function claimNeeds(file, damage, review) {
  const needs = [];
  if (review?.categories?.includes("Policy/coverage lookup failed")) {
    needs.push("current active policy/declaration page or corrected insured/policy information; prior filing attempt could not locate coverage");
  }
  if (!file.carrier) needs.push("carrier");
  if (!file.policyNumber) needs.push("policy number / dec page");
  if (!file.dateOfLoss) needs.push("date of loss");
  if (!file.address) needs.push("property address");
  if (!contactPhone(file)) needs.push("homeowner phone");
  if (damage.length === 1 && damage[0].startsWith("No specific")) needs.push("damage recap from estimate/scope");
  return needs.length ? needs : ["No obvious missing filing fields from synced data"];
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
    const found = Object.keys(record).find((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === alias.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (found && record[found]) return String(record[found]).trim();
  }
  return "";
}

function formatAdjuster(file) {
  const parts = [file.adjuster?.name, file.adjuster?.phone, file.adjuster?.email].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Missing";
}

function inferCause(text) {
  const source = lower(text);
  if (source.includes("hail") && source.includes("wind")) return "Hail / wind";
  if (source.includes("hail")) return "Hail";
  if (source.includes("wind")) return "Wind";
  if (source.includes("water")) return "Water";
  return "Unknown";
}

function inspectionTime(file) {
  const task = (file.openTasks || []).find((item) => /inspection|adjuster meeting|appointment/i.test(item.title || ""));
  return task?.dueDate ? `set for ${task.dueDate}` : "";
}

function plainStatus(review) {
  const file = review.file;
  if (review.categories.includes("Two key confirmations needed")) {
    return "the claim appears submitted and we are confirming carrier receipt, adjuster assignment, and payment direction.";
  }
  if (review.categories.includes("Ready for appraisal")) {
    return "the file appears ready for appraisal review and package confirmation.";
  }
  if (review.categories.includes("Claims needing filed")) {
    return "we are confirming the details needed to file the claim.";
  }
  if (review.categories.includes("Waiting on carrier")) {
    return "we are waiting on the carrier/adjuster for the next response.";
  }
  return `current status is ${file.status}.`;
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanClaimNumber(value) {
  const text = clean(value)
    .replace(/\breference\s*#?\b/ig, "")
    .replace(/\bclaim\s*#?\b/ig, "")
    .replace(/(^|\s)#($|\s)/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
