// Local review provenance, not a new execution/approval or provider-data lane.
// A reported document review is not independently verified by its metadata.
export const PACKET_REVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PACKET_REVIEW_SOURCES = Object.freeze([
  "jobnimbus_document", "jobnimbus_activity", "gmail_message", "quo_transcript", "user_provided"
]);
export const PACKET_REVIEW_METHODS = Object.freeze([
  "native_pages", "full_text", "provider_record", "user_statement"
]);
export const PACKET_REVIEW_FACT_KEYS = Object.freeze([
  "insuredName", "propertyAddress", "carrier", "policyNumber", "claimNumber", "dateOfLoss",
  "causeOfLoss", "mortgageCompany", "stormTime", "occupancy", "damageDiscovered",
  "propertyStories", "roofAccessibility", "damagedRooms", "damagedRoomCount", "contractorPhone",
  "injuries", "homeLivable", "temporaryRepairs", "contractorHired", "damageOpening", "damageDetails",
  "coverageTermStatus", "policyCoverageStart", "policyCoverageEnd", "carrierPhone", "to"
]);
export const CLAIM_STOP_SIGNAL_CODES = Object.freeze([
  "claim_number_present_in_evidence", "claim_already_filed", "prior_claim_filing_attempt",
  "existing_claim_confirmed", "carrier_claim_receipt", "adjuster_already_assigned",
  "claim_inspection_already_scheduled", "carrier_callback_unresolved"
]);

function exactObject(value, keys, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label} must be an exact review-provenance object; unknown/control keys are forbidden.`);
  }
}

function reference(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 256
    || /[\x00-\x1f\x7f]/u.test(value)) throw new Error(`${label} must be a bounded single-line reference.`);
  return value.trim();
}

export function normalizePacketReview(value) {
  exactObject(value, ["fileId", "reviewedAt", "sources", "knownStopSignals"], "packetReview");
  const fileId = reference(value.fileId, "packetReview.fileId");
  if (typeof value.reviewedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.reviewedAt)
    || !Number.isFinite(Date.parse(value.reviewedAt))) {
    throw new Error("packetReview.reviewedAt must be an explicit ISO timestamp with a timezone.");
  }
  const [year, month, day] = value.reviewedAt.slice(0, 10).split("-").map(Number);
  const civilDate = new Date(Date.UTC(year, month - 1, day));
  if (civilDate.getUTCFullYear() !== year || civilDate.getUTCMonth() !== month - 1 || civilDate.getUTCDate() !== day) {
    throw new Error("packetReview.reviewedAt must contain a valid calendar date.");
  }
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 30) {
    throw new Error("packetReview.sources requires 1–30 bounded, field-specific review references.");
  }
  const sources = value.sources.map(source => {
    exactObject(source, ["source", "reference", "reviewMethod", "fields"], "packetReview source");
    if (!PACKET_REVIEW_SOURCES.includes(source.source) || !PACKET_REVIEW_METHODS.includes(source.reviewMethod)) {
      throw new Error("Unsupported packet-review source or review method.");
    }
    const allowedMethods = source.source === "jobnimbus_document" ? ["native_pages", "full_text"]
      : source.source === "user_provided" ? ["user_statement"] : ["provider_record"];
    if (!allowedMethods.includes(source.reviewMethod)) throw new Error("The packet-review method does not match its source.");
    if (!Array.isArray(source.fields) || !source.fields.length || source.fields.length > PACKET_REVIEW_FACT_KEYS.length
      || new Set(source.fields).size !== source.fields.length
      || source.fields.some(field => !PACKET_REVIEW_FACT_KEYS.includes(field))) {
      throw new Error("Each packet-review reference must identify unique supported fact fields.");
    }
    return { source: source.source, reference: reference(source.reference, "packetReview source reference"),
      reviewMethod: source.reviewMethod, fields: [...source.fields] };
  });
  if (!Array.isArray(value.knownStopSignals)
    || value.knownStopSignals.length > CLAIM_STOP_SIGNAL_CODES.length
    || new Set(value.knownStopSignals).size !== value.knownStopSignals.length
    || value.knownStopSignals.some(code => !CLAIM_STOP_SIGNAL_CODES.includes(code))) {
    throw new Error("packetReview.knownStopSignals must explicitly list the supported known claim/callback signals, or be empty.");
  }
  return { fileId, reviewedAt: value.reviewedAt, sources, knownStopSignals: [...value.knownStopSignals] };
}

export function assertPacketReviewCurrent(input, now) {
  const review = input.packetReview;
  const at = Date.parse(review.reviewedAt);
  if (at > now || now - at > PACKET_REVIEW_MAX_AGE_MS) {
    throw new Error("The reported packet review is future-dated or older than 24 hours. Review the exact facts again; no call was planned.");
  }
  if (input.goal === "file_new_claim" && review.knownStopSignals.length) {
    throw new Error("The reviewed packet reports a known claim or unresolved filing/callback signal. It cannot authorize a new filing.");
  }
  const required = ["insuredName", "propertyAddress", "carrier"];
  if (input.goal === "file_new_claim") required.push("dateOfLoss", "causeOfLoss", "coverageTermStatus");
  if (required.some(key => !String(input.overrides?.[key] || "").trim())) {
    throw new Error("Reviewed-packet mode requires explicit insured, property and carrier facts, plus DOL, cause and coverage disposition for a new claim.");
  }
  if (input.goal === "file_new_claim"
    && !input.overrides.damageDetails && !String(input.overrides.damageOpening || "").trim()) {
    throw new Error("Reviewed-packet mode requires explicitly reviewed practical damage facts.");
  }
  const fields = new Set(review.sources.flatMap(source => source.fields));
  const supplied = [
    ...Object.keys(input.overrides || {}).filter(key => String(input.overrides[key] ?? "").trim()),
    ...PACKET_REVIEW_FACT_KEYS.filter(key => typeof input[key] === "string" && input[key].trim())
  ];
  if (supplied.some(key => !fields.has(key))) {
    throw new Error("Every supplied packet fact and carrier destination needs a field-specific review source.");
  }
}

export function assertPacketReviewFileSources(input, packet) {
  if (packet.file.id !== input.packetReview.fileId) throw new Error("The reviewed packet belongs to a different JobNimbus file ID.");
  for (const source of input.packetReview.sources) {
    const rows = source.source === "jobnimbus_document" ? packet.liveJobNimbus.operationalDocuments
      : source.source === "jobnimbus_activity" ? packet.liveJobNimbus.recentActivities : null;
    // Existence/binding only. Native pages/text review remains caller-reported.
    if (rows && !rows.some(row => String(row.id || "") === source.reference)) {
      throw new Error("A packet-review JobNimbus source is not in this exact file's fresh evidence inventory.");
    }
  }
}

function dateKey(value) {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const key = iso ? text : us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : "";
  const parsed = new Date(`${key}T00:00:00.000Z`);
  return key && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key ? key : "";
}

export function assertReviewedPacketPlan(response, input, fileId) {
  if (response?.file?.id !== fileId) throw new Error("The prepared call changed the reviewed JobNimbus file ID. No approval was created.");
  if (!/^\+[1-9]\d{6,14}$/.test(String(response.callPlan?.to || response.request?.to || ""))) {
    throw new Error("The reviewed call has no valid exact carrier destination. No approval was created.");
  }
  const facts = response.packet?.verifiedFileFacts || {};
  const variables = response.callPlan?.dynamicVariables || {};
  const suppliedFacts = [
    ...Object.entries(input.overrides || {}),
    ...PACKET_REVIEW_FACT_KEYS.filter(key => typeof input[key] === "string").map(key => [key, input[key]])
  ];
  for (const [key, value] of suppliedFacts) {
    if (key === "damageOpening" || key === "damageDetails") continue;
    if (["carrierPhone", "to"].includes(key)) {
      if (String(response.callPlan?.to || response.request?.to || "").replace(/\D/g, "") !== value.replace(/\D/g, "")) {
        throw new Error("The prepared carrier destination changed. No approval was created.");
      }
      continue;
    }
    const isDate = ["dateOfLoss", "policyCoverageStart", "policyCoverageEnd"].includes(key);
    const equal = isDate ? Boolean(dateKey(value)) && dateKey(value) === dateKey(facts[key])
      : String(value).trim() === String(facts[key] ?? "").trim();
    if (!equal && String(value).trim()) {
      throw new Error(`The prepared call changed reviewed ${key}. Review a fresh packet; no approval was created.`);
    }
    if (String(value).trim() && String(variables[key] ?? "") !== String(facts[key] ?? "")) {
      throw new Error(`The call/callback packet did not bind reviewed ${key}. No approval was created.`);
    }
  }
  if (input.overrides?.damageDetails || (input.goal === "file_new_claim" && input.overrides?.damageOpening)) {
    const expected = input.overrides.damageDetails
      ? Array.isArray(input.overrides.damageDetails)
        ? input.overrides.damageDetails.map(value => value.trim()) : [input.overrides.damageDetails.trim()]
      : [input.overrides.damageOpening.trim()];
    if (JSON.stringify(response.packet.damageDetails) !== JSON.stringify(expected)) {
      throw new Error("The prepared call changed reviewed damage details. No approval was created.");
    }
    if (variables.damageDetails !== expected.join(", ")) {
      throw new Error("The call/callback packet did not bind reviewed damage details. No approval was created.");
    }
  }
  if (input.overrides?.damageOpening && response.packet.damageOpening !== input.overrides.damageOpening.trim()) {
    throw new Error("The prepared call changed the reviewed damage opening. No approval was created.");
  }
  if (variables.damageOpening !== response.packet.damageOpening) {
    throw new Error("The call/callback packet did not bind its reviewed damage opening. No approval was created.");
  }
}
