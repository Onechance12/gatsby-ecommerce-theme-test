// Company-approved standard filing answers, damage categorization, and cause
// inference — pure, dependency-free. These are the four intentional business
// defaults confirmed for routine residential storm claims. They are the
// DEFAULTS and are overrideable per call when a specific file/homeowner/carrier
// establishes an exception. They must NOT be copied into routine JobNimbus notes.

// The four approved defaults, expressed as the exact phrasing the agent
// speaks. Keyed by the standard-answer field name.
export const STANDARD_FILING_ANSWERS = {
  injuries: "No injuries reported",
  homeLivable: "Yes, the home is livable",
  temporaryRepairs: "Yes, temporary repairs have been made",
  contractorHired: "Yes, a contractor has been hired"
};

// Resolve the standard answers for a call: an explicit override always wins; the
// company default fills the rest. All four defaults are standard for
// routine residential claims — including habitability — unless a specific file
// establishes an exception (passed as an override). We do NOT downgrade
// habitability to "Missing" for non-storm losses; that would silently drop an
// approved default.
export function resolveStandardAnswers(overrides = {}) {
  const pick = (key, fallback) => {
    const v = overrides[key];
    return v && String(v).trim() ? String(v) : fallback;
  };
  return {
    injuries: pick("injuries", STANDARD_FILING_ANSWERS.injuries),
    homeLivable: pick("homeLivable", STANDARD_FILING_ANSWERS.homeLivable),
    temporaryRepairs: pick("temporaryRepairs", STANDARD_FILING_ANSWERS.temporaryRepairs),
    contractorHired: pick("contractorHired", STANDARD_FILING_ANSWERS.contractorHired)
  };
}

// Merge document/note evidence from BOTH the file record and the evidence block.
// The canonical contract lets the bridge attach documents/notes under `evidence`
// while the local sweep attaches them under `file`; a plain `file.x || evidence.x`
// would ignore the evidence copy whenever file.x is a present-but-empty array.
function mergedDocuments(file, evidence) {
  return [...(file.documents || []), ...(evidence.documents || [])];
}
function mergedNotes(file, evidence) {
  return [...(file.notes || []), ...(evidence.notes || [])];
}

// Infer the cause of loss from free-text evidence (type of loss, status,
// document names, note bodies). Storm-first, since that's Wave's book.
export function inferCause(file = {}, evidence = {}) {
  const source = [
    file.typeOfLoss,
    file.status,
    ...mergedDocuments(file, evidence).map((doc) => doc?.name || ""),
    ...mergedNotes(file, evidence).map((note) => note?.body || "")
  ].join("\n").toLowerCase();
  if (source.includes("hail") && source.includes("wind")) return "Hail / wind";
  if (source.includes("hail")) return "Hail";
  if (source.includes("wind")) return "Wind";
  if (source.includes("water")) return "Water";
  return "Property damage";
}

// Infer the property-level damage categories from free-text evidence. Returns a
// deduped list, or a single explicit "none found" sentinel the readiness check
// recognizes.
export function inferDamageCategories(file = {}, evidence = {}) {
  const source = [
    evidence.recommendedNextAction,
    evidence.bottleneck,
    ...(evidence.categories || []),
    ...mergedDocuments(file, evidence).map((doc) => doc?.name || ""),
    ...mergedNotes(file, evidence).map((note) => note?.body || "")
  ].join("\n").toLowerCase();

  const checks = [
    ["roof hail/wind damage", /roof|shingle|slope|hail|wind/],
    ["gutters/downspouts", /gutter|downspout/],
    ["fascia/soffit", /fascia|soffit/],
    ["window screens/windows", /window|screen|glazing/],
    ["siding/exterior paint", /siding|exterior paint|paint damage|prime\s*&?\s*paint exterior/],
    ["fence", /fence/],
    ["garage door", /garage door|overhead door/],
    ["HVAC/soft metals", /hvac|a\/c|ac unit|air condition|condenser|soft metal/],
    ["detached structures", /shed|carport|detached\s+(?:structure|building|garage)/],
    ["interior water/ceiling damage", /interior|water stain|ceiling|drywall|leak/],
    ["bathroom ceiling and adjoining walls", /bathroom[\s\S]{0,2500}(?:ceiling|wall)[\s\S]{0,500}(?:water|damage|paint|seal|texture)|damage extends from ceiling to corner where it meets the wall/],
    ["personal property", /personal\s+property/]
  ];

  const categories = [];
  for (const [label, pattern] of checks) {
    if (pattern.test(source)) categories.push(label);
  }
  return categories.length ? [...new Set(categories)] : ["No specific damage categories found in synced evidence"];
}
