// Company-approved standard filing answers, damage categorization, and cause
// inference — pure, dependency-free. These are the four intentional business
// defaults Chance confirmed for routine residential storm claims. They are the
// DEFAULTS and are overrideable per call when a specific file/homeowner/carrier
// establishes an exception. They must NOT be copied into routine JobNimbus notes.

// The four Chance-approved defaults, expressed as the exact phrasing the agent
// speaks. Keyed by the standard-answer field name.
export const STANDARD_FILING_ANSWERS = {
  injuries: "No injuries reported",
  homeLivable: "Yes, the home is livable",
  temporaryRepairs: "Yes, temporary repairs have been made",
  contractorHired: "Yes, Titan Reconstruction is the contractor on the project"
};

// Resolve the standard answers for a call: an explicit override always wins; the
// company default fills the rest. homeLivable defaults only apply to storm-like
// losses (a non-storm loss leaves it "Missing" so the rep is asked rather than
// answered from an assumption).
export function resolveStandardAnswers(overrides = {}, { stormLike = true } = {}) {
  const pick = (key, fallback) => {
    const v = overrides[key];
    return v && String(v).trim() ? String(v) : fallback;
  };
  return {
    injuries: pick("injuries", STANDARD_FILING_ANSWERS.injuries),
    homeLivable: pick("homeLivable", stormLike ? STANDARD_FILING_ANSWERS.homeLivable : "Missing"),
    temporaryRepairs: pick("temporaryRepairs", STANDARD_FILING_ANSWERS.temporaryRepairs),
    contractorHired: pick("contractorHired", STANDARD_FILING_ANSWERS.contractorHired)
  };
}

// Infer the cause of loss from free-text evidence (type of loss, status,
// document names, note bodies). Storm-first, since that's Wave's book.
export function inferCause(file = {}, evidence = {}) {
  const source = [
    file.typeOfLoss,
    file.status,
    ...(evidence.documents || []).map((doc) => doc?.name || ""),
    ...(evidence.notes || []).map((note) => note?.body || "")
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
    ...(file.documents || evidence.documents || []).map((doc) => doc?.name || ""),
    ...(file.notes || evidence.notes || []).map((note) => note?.body || "")
  ].join("\n").toLowerCase();

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

  const categories = [];
  for (const [label, pattern] of checks) {
    if (pattern.test(source)) categories.push(label);
  }
  return categories.length ? [...new Set(categories)] : ["No specific damage categories found in synced evidence"];
}
