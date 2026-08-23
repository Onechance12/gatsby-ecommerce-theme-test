import { createHash } from "node:crypto";

export const CHANCE_OPERATOR_RUN_POLICY_ID = "chance-58-files-v1";
export const CHANCE_OPERATOR_RUN_MANIFEST_SCHEMA_VERSION = 1;
export const CHANCE_OPERATOR_RUN_FILE_COUNT = 58;

export const CHANCE_OPERATOR_EXCLUDED_FILE_NUMBERS = Object.freeze(["2628"]);

export const CHANCE_OPERATOR_ALLOWED_ACTION_TYPES = Object.freeze([
  "jobnimbus.update_contact",
  "jobnimbus.update_status",
  "jobnimbus.ensure_current_task",
  "gmail.create_draft"
]);

export const CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS = Object.freeze([
  "display_name",
  "email",
  "mobile_phone",
  "home_phone",
  "work_phone",
  "address_line1",
  "address_line2",
  "city",
  "state_text",
  "zip",
  "cf_date_1",
  "cf_string_1",
  "cf_string_2",
  "cf_string_4",
  "cf_string_5",
  "cf_string_7",
  "cf_string_8",
  "cf_string_9"
]);

export const CHANCE_OPERATOR_ALLOWED_STAGE_EVIDENCE_SOURCES = Object.freeze([
  "jobnimbus_activity",
  "gmail_message",
  "quo_message"
]);

const EVIDENCE_SOURCES = new Set(CHANCE_OPERATOR_ALLOWED_STAGE_EVIDENCE_SOURCES);

const GATE_EVIDENCE_PATTERNS = Object.freeze({
  policyAuthorityReviewed: /\b(?:(?:policy|declarations?|dec(?:laration)? pages?|coverage).{0,80}(?:reviewed|verified|confirmed|active|in force|covers?|effective)|(?:signed|received|uploaded|on file).{0,60}(?:fin\s*535|pa contract|public adjuster contract|letter of representation|authority))\b/i,
  claimFiled: /\b(?:claim (?:was |has been |is )?(?:successfully )?(?:filed|reported|opened|submitted)|(?:filed|reported|opened|submitted) (?:the )?(?:property )?claim|claim (?:number|no\.?|#)\s*[:#-]?\s*[a-z0-9-]{5,})\b/i,
  deskAdjusterConfirmed: /\b(?:(?:desk adjuster|claim specialist|claims? handler|inside adjuster)\s*(?:is|:|-)\s*[a-z][a-z.'-]{1,}|(?:assigned|confirmed|identified).{0,50}(?:desk adjuster|claim specialist|claims? handler|inside adjuster)|(?:desk adjuster|claim specialist|claims? handler|inside adjuster).{0,50}(?:assigned|confirmed|identified))\b/i,
  paymentHandlingConfirmed: /\b(?:carrier (?:confirmed|acknowledged|verified).{0,90}(?:payment|check|payees?|mailing|delivery destination|direction|redirection)|(?:payment|check) (?:direction|redirection|handling).{0,80}(?:confirmed|acknowledged|accepted|on file) (?:by|with) (?:the )?carrier)\b/i,
  activeNegotiation: /\b(?:(?:supplement|reconsideration|reinspection|scope dispute|disputed scope).{0,70}(?:sent|submitted|received|acknowledged|scheduled|completed|opened|active)|carrier (?:is )?reviewing.{0,50}(?:supplement|reconsideration|scope))\b/i,
  carrierIssuanceConfirmed: /\b(?:carrier (?:issued|sent|mailed|uploaded).{0,60}(?:scope|estimate|payment|check|acv)|(?:carrier scope|carrier estimate|carrier payment|carrier check|acv payment).{0,60}(?:issued|received|mailed|uploaded)|(?:received|uploaded).{0,40}(?:carrier scope|carrier estimate)|(?:payment|check).{0,40}(?:issued|mailed) by (?:the )?carrier)\b/i,
  paymentReceiptConfirmed: /\b(?:(?:accounting|wave|our office|insured|homeowner|client|titan).{0,80}(?:payment|check|acv).{0,60}(?:received|collected|deposited|cleared|in hand|controlled|custody)|(?:payment|check|acv).{0,60}(?:received|collected|deposited|cleared|in hand|controlled|custody).{0,60}(?:by|with|at) (?:accounting|wave|our office|insured|homeowner|client|titan))\b/i,
  appraisalGapConfirmed: /\b(?:(?:comparison|review).{0,60}(?:shows?|confirms?|documents?).{0,50}(?:appraisal gap|scope gap|difference|underpaid)|(?:carrier scope|carrier estimate).{0,60}(?:below|less than|short of|omits?|underpaid).{0,60}(?:company|contractor|estimate|scope))\b/i,
  appraisalDemandSent: /\b(?:(?:appraisal demand|demand for appraisal).{0,80}(?:sent|submitted|delivered) (?:to|through) (?:the )?(?:carrier|insurer|insurance company|claims? department|adjuster)|(?:carrier|insurer|claims? department|adjuster).{0,80}(?:received|acknowledged).{0,50}(?:appraisal demand|demand for appraisal))\b/i,
  carrierAppraiserAssigned: /\b(?:(?:carrier appraiser|insurance appraiser).{0,60}(?:assigned|identified|confirmed)|(?:assigned|identified|confirmed).{0,50}(?:carrier appraiser|insurance appraiser))\b/i,
  appraisalMeetingScheduled: /\b(appraisal meeting|appraiser meeting).{0,60}(scheduled|set|confirmed).{0,80}(?:\d{1,2}[/-]\d{1,2}|\d{1,2}:\d{2}|a\.?m\.?|p\.?m\.?)\b/i,
  initialAppraisalAgreement: /\b(?:initial appraisal (?:agreement|approval)|appraisers? agreed.{0,40}(?:appraisal )?(?:amount|scope|award)|agreed (?:appraisal )?(?:amount|scope|award))\b/i,
  fullyExecutedAward: /\b(?:(?:appraisal )?award.{0,50}(?:fully executed|signed by all parties|carrier accepted|carrier acceptance)|(?:fully executed|all parties signed|carrier accepted).{0,50}(?:appraisal )?award)\b/i,
  finalPaymentConfirmed: /\b(?:(?:accounting|wave|our office|insured|homeowner|client|titan).{0,80}(?:final payment|appraisal payment|award payment|supplemental payment).{0,60}(?:received|collected|deposited|cleared|in hand|controlled|custody)|(?:final payment|appraisal payment|award payment|supplemental payment).{0,60}(?:received|collected|deposited|cleared|in hand|controlled|custody).{0,60}(?:by|with|at) (?:accounting|wave|our office|insured|homeowner|client|titan))\b/i,
  productionReleased: /\b(?:production (?:released|approved|authorized)|ready for production.{0,30}(?:confirmed|approved)|(?:start date|production owner).{0,40}(?:assigned|confirmed))\b/i,
  richardDecision: /\b(richard).{0,80}(decid|direct|approv|close|escalat|proceed|hold)\w*/i,
  umpireInvoked: /\bumpire.{0,60}(invoked|selected|appointed|assigned|agreed)\b/i
});

const NEGATIVE_OR_PENDING_EVIDENCE = /\?|\b(waiting on|awaiting|pending|missing|unknown|unconfirmed|unclear|no response|received no response|failed|failure|unsuccessful(?:ly)?|bounced|undeliverable|voided|withdrawn|canceled|cancelled|rejected|incorrect|asked|asking|whether|unable|cannot|can't|could not|couldn't|did not|has not|hasn't|not|but not|tbd|none|n\/a|no (?:claim|desk adjuster|payment|check|appraiser|award)|need(?:s|ed)?(?:\s+to)?|must (?:obtain|confirm|verify)|please (?:confirm|send|provide)|obtain|verify whether|request(?:ed|ing)?|checklist|template|draft|proposed|planned|to be confirmed)\b/i;

function evidenceSupportsGate(reference) {
  const gate = String(reference?.gate || "").trim();
  const pattern = GATE_EVIDENCE_PATTERNS[gate];
  const fact = String(reference?.fact || "");
  return Boolean(
    pattern
    && pattern.test(fact)
    && !NEGATIVE_OR_PENDING_EVIDENCE.test(fact)
  );
}

const STAGES = Object.freeze([
  { id: "photo_file", rank: 10, patterns: [/^photo file(?:\s*\/\s*estimate needed)?$/i] },
  { id: "need_info", rank: 15, patterns: [/^need paperwork(?:\s*\/\s*info)?$/i] },
  { id: "ready_pa", rank: 20, patterns: [/^ready for pa review$/i] },
  {
    id: "submitted",
    rank: 30,
    patterns: [
      /^submitted$/i,
      /^submitted awaiting confirmation$/i,
      /^submitted awaiting two key confirmations$/i,
      /^submitted\s*\(awaiting two key confirmations\)$/i
    ]
  },
  {
    id: "appointment_legacy",
    rank: 35,
    patterns: [/^appointment$/i, /^appointment set$/i]
  },
  { id: "negotiating", rank: 40, patterns: [/^negotiating$/i] },
  { id: "hot_final", rank: 50, patterns: [/^(?:hot\s*\/\s*)?final negotiation$/i, /^hot$/i] },
  {
    id: "awaiting_acv",
    rank: 60,
    patterns: [/^awaiting acv$/i, /^estimating finalized\s*\(awaiting acv\)$/i]
  },
  { id: "ready_appraisal", rank: 70, patterns: [/^ready for appraisal$/i] },
  { id: "submitted_appraisal", rank: 80, patterns: [/^submitted for appraisal$/i] },
  { id: "carrier_appraiser", rank: 90, patterns: [/^carrier appraiser assigned$/i] },
  { id: "meeting", rank: 100, patterns: [/^(?:appraisal )?meeting scheduled$/i] },
  {
    id: "initial_approval",
    rank: 110,
    patterns: [/^initial approval$/i, /^appraisal approval\s*\(awaiting estimate\)$/i]
  },
  { id: "umpire", rank: 115, patterns: [/^umpire$/i] },
  {
    id: "finalized",
    rank: 120,
    patterns: [/^finalized$/i, /^appraisal finalized\s*\(awaiting acv\)$/i]
  },
  { id: "ready_production", rank: 130, patterns: [/^ready for production$/i] },
  { id: "review_close", rank: 140, patterns: [/^review for close$/i] }
]);

const GATE_THRESHOLDS = Object.freeze([
  { rank: 20, gates: ["policyAuthorityReviewed"] },
  { rank: 30, gates: ["claimFiled"] },
  { rank: 40, gates: ["deskAdjusterConfirmed", "paymentHandlingConfirmed"] },
  { rank: 60, gates: ["carrierIssuanceConfirmed"] },
  { rank: 70, gates: ["paymentReceiptConfirmed", "appraisalGapConfirmed"] },
  { rank: 80, gates: ["appraisalDemandSent"] },
  { rank: 90, gates: ["carrierAppraiserAssigned"] },
  { rank: 100, gates: ["appraisalMeetingScheduled"] },
  { rank: 110, gates: ["initialAppraisalAgreement"] },
  { rank: 120, gates: ["fullyExecutedAward"] },
  { rank: 130, gates: ["finalPaymentConfirmed", "productionReleased"] }
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactStringSet(values, expected) {
  if (!Array.isArray(values) || values.length !== expected.length) return false;
  const actualSorted = [...values].map(String).sort();
  const expectedSorted = [...expected].map(String).sort();
  return actualSorted.every((value, index) => value === expectedSorted[index]);
}

export function loadChanceOperatorRunManifest(raw, options = {}) {
  const now = Number(options.now ?? Date.now());
  let input;
  try {
    input = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw);
  } catch {
    throw new Error("CHANCE_OPERATOR_RUN_MANIFEST_JSON is not valid JSON.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The Chance operator run manifest must be a JSON object.");
  }
  if (Number(input.schemaVersion) !== CHANCE_OPERATOR_RUN_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`The Chance operator run manifest requires schemaVersion ${CHANCE_OPERATOR_RUN_MANIFEST_SCHEMA_VERSION}.`);
  }
  const id = String(input.id || "").trim();
  if (id !== CHANCE_OPERATOR_RUN_POLICY_ID) {
    throw new Error(`The Chance operator run manifest id must be ${CHANCE_OPERATOR_RUN_POLICY_ID}.`);
  }
  if (String(input.operatorScope || "").trim().toLowerCase() !== "assigned") {
    throw new Error("The Chance operator run manifest must use assigned scope.");
  }
  const expiresAt = String(input.expiresAt || "").trim();
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    throw new Error("The Chance operator run manifest is expired or has an invalid expiresAt value.");
  }
  if (!exactStringSet(input.excludedFileNumbers, CHANCE_OPERATOR_EXCLUDED_FILE_NUMBERS)) {
    throw new Error("The Chance operator run manifest must exclude JobNimbus file #2628.");
  }
  if (!exactStringSet(input.allowedActionTypes, CHANCE_OPERATOR_ALLOWED_ACTION_TYPES)) {
    throw new Error("The Chance operator run manifest action types do not match the locked P0 action lane.");
  }
  if (!exactStringSet(input.allowedContactFields, CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS)) {
    throw new Error("The Chance operator run manifest contact fields do not match the locked P0 field allowlist.");
  }
  if (!Array.isArray(input.files) || input.files.length !== CHANCE_OPERATOR_RUN_FILE_COUNT) {
    throw new Error(`The Chance operator run manifest must bind exactly ${CHANCE_OPERATOR_RUN_FILE_COUNT} files.`);
  }
  const numbers = new Set();
  const ids = new Set();
  const files = input.files.map((row, index) => {
    const number = String(row?.number || "").trim().replace(/^#/, "");
    const fileId = String(row?.fileId || row?.id || "").trim();
    if (!/^\d+$/.test(number)) throw new Error(`Manifest files[${index}].number must be numeric.`);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(fileId)) throw new Error(`Manifest files[${index}].fileId is invalid.`);
    if (CHANCE_OPERATOR_EXCLUDED_FILE_NUMBERS.includes(number)) {
      throw new Error(`Excluded JobNimbus file #${number} cannot appear in the run manifest.`);
    }
    if (numbers.has(number)) throw new Error(`Duplicate JobNimbus file number #${number} in the run manifest.`);
    if (ids.has(fileId)) throw new Error(`Duplicate JobNimbus file id ${fileId} in the run manifest.`);
    numbers.add(number);
    ids.add(fileId);
    return { number, fileId };
  }).sort((left, right) => Number(left.number) - Number(right.number));

  const body = {
    schemaVersion: CHANCE_OPERATOR_RUN_MANIFEST_SCHEMA_VERSION,
    id,
    operatorScope: "assigned",
    expiresAt: new Date(expiresAtMs).toISOString(),
    files,
    excludedFileNumbers: [...CHANCE_OPERATOR_EXCLUDED_FILE_NUMBERS],
    allowedActionTypes: [...CHANCE_OPERATOR_ALLOWED_ACTION_TYPES],
    allowedContactFields: [...CHANCE_OPERATOR_ALLOWED_CONTACT_FIELDS]
  };
  return deepFreeze({ ...body, sha256: sha256(body), fileCount: files.length });
}

export function chanceOperatorRunManifestSummary(manifest) {
  if (!manifest) return { available: false, enforced: true };
  return {
    available: true,
    enforced: true,
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    sha256: manifest.sha256,
    expiresAt: manifest.expiresAt,
    fileCount: manifest.fileCount,
    excludedFileNumbers: [...manifest.excludedFileNumbers],
    allowedActionTypes: [...manifest.allowedActionTypes],
    allowedContactFields: [...manifest.allowedContactFields],
    allowedStageEvidenceSources: [...CHANCE_OPERATOR_ALLOWED_STAGE_EVIDENCE_SOURCES],
    taskCompletionAllowed: false,
    outboundSendAllowed: false,
    noteCreationAllowed: false,
    backwardStageMovesAllowed: false,
    stageEvidenceRequired: true
  };
}

export function chanceOperatorRunPolicy(manifest) {
  if (!manifest) throw new Error("The Chance operator run manifest is not loaded.");
  const policy = chanceOperatorRunManifestSummary(manifest);
  Object.defineProperty(policy, "manifest", { value: manifest, enumerable: false, writable: false });
  return Object.freeze(policy);
}

export function resolveChanceOperatorRunPolicy(input, manifest) {
  if (!manifest) {
    throw new Error("The production Chance operator run manifest is unavailable. Nothing can be changed until the bridge is repaired.");
  }
  const id = String(input?.id || "").trim();
  const manifestSha = String(input?.sha256 || "").trim().toLowerCase();
  if (id !== manifest.id || manifestSha !== manifest.sha256) {
    throw new Error(
      "The Mac JobNimbus plugin is not pinned to the bridge's current 58-file run manifest. Refresh the plugin and start a new chat before preparing actions."
    );
  }
  if (Date.parse(manifest.expiresAt) <= Date.now()) {
    throw new Error("The Chance operator run manifest expired. Refresh and review the 58-file roster before preparing actions.");
  }
  return chanceOperatorRunPolicy(manifest);
}

export function chanceManifestFileBinding(manifest, number, fileId) {
  if (!manifest) return null;
  const normalizedNumber = String(number || "").trim().replace(/^#/, "");
  const normalizedId = String(fileId || "").trim();
  return manifest.files.find((file) => file.number === normalizedNumber && file.fileId === normalizedId) || null;
}

export function normalizeThresherStage(value) {
  const label = String(value || "").trim();
  const stage = STAGES.find((candidate) => candidate.patterns.some((pattern) => pattern.test(label)));
  return stage ? { id: stage.id, rank: stage.rank, label } : null;
}

function requiredTransitionGates(current, target) {
  if (target.id === "review_close") return ["richardDecision"];
  if (target.id === "umpire") {
    const crossed = GATE_THRESHOLDS
      .filter((threshold) => threshold.rank > current.rank && threshold.rank <= 80)
      .flatMap((threshold) => threshold.gates);
    return [...new Set([...crossed, "umpireInvoked"])];
  }
  const crossed = GATE_THRESHOLDS
    .filter((threshold) => threshold.rank > current.rank && threshold.rank <= target.rank)
    .flatMap((threshold) => threshold.gates);
  if (target.id === "hot_final") crossed.push("activeNegotiation");
  return [...new Set(crossed)];
}

export function validateThresherTransition({ currentStatus, targetStatus, evidence, fileId }) {
  const current = normalizeThresherStage(currentStatus);
  const target = normalizeThresherStage(targetStatus);
  if (!current) {
    throw new Error(`Current JobNimbus status is not mapped in Thresher: ${currentStatus || "(blank)"}. Nothing was changed.`);
  }
  if (!target) {
    throw new Error(`Requested JobNimbus status is not mapped in Thresher: ${targetStatus || "(blank)"}. Nothing was changed.`);
  }
  if (current.id === target.id) {
    throw new Error(`The file is already in ${targetStatus}. A same-stage action is not allowed.`);
  }
  if (target.rank < current.rank) {
    throw new Error(
      `Backward Thresher stage moves are blocked: ${currentStatus} -> ${targetStatus}. Use a separately reviewed corrective migration outside the Chance work-file run.`
    );
  }
  if (target.id === "appointment_legacy") {
    throw new Error("The legacy Appointment stage is not a valid Thresher destination. Keep appointments on the calendar/task and use the evidence-backed claim stage.");
  }
  if (current.id === "appointment_legacy" && !["negotiating", "hot_final"].includes(target.id)) {
    throw new Error("Legacy Appointment files may move only to Negotiating or Hot / Final Negotiation after evidence review.");
  }
  if (target.rank === current.rank && target.id !== current.id) {
    throw new Error(`The proposed same-rank transition is ambiguous: ${currentStatus} -> ${targetStatus}.`);
  }

  const reason = String(evidence?.reason || "").trim();
  const references = Array.isArray(evidence?.references) ? evidence.references : [];
  if (reason.length < 12) {
    throw new Error("A Thresher status move requires a concrete transitionEvidence.reason.");
  }
  const expectedFileId = String(fileId || "").trim();
  const validReferences = references.filter((reference) => (
    reference
    && typeof reference === "object"
    && EVIDENCE_SOURCES.has(String(reference.source || "").trim())
    && String(reference.id || "").trim()
    && String(reference.gate || "").trim()
    && String(reference.fact || "").trim()
    && evidenceSupportsGate(reference)
    && (!expectedFileId || String(reference.fileId || "").trim() === expectedFileId)
  ));
  if (!validReferences.length) {
    throw new Error("A Thresher status move requires at least one file-bound provider evidence reference with an allowed source, id, and fact.");
  }
  const requiredGates = requiredTransitionGates(current, target);
  const verifiedGates = new Set(validReferences.map((reference) => String(reference.gate || "").trim()));
  const missingGates = requiredGates.filter((gate) => !verifiedGates.has(gate));
  if (missingGates.length) {
    throw new Error(
      `The ${currentStatus} -> ${targetStatus} move crosses unconfirmed Thresher gate(s): ${missingGates.join(", ")}. Nothing was changed.`
    );
  }
  return {
    current,
    target,
    forward: true,
    requiredGates,
    reason,
    references: validReferences,
    gates: Object.fromEntries([...verifiedGates].map((gate) => [gate, true]))
  };
}
