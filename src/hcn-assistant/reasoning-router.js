/**
 * Deterministic reasoning admission for the embedded HCN assistant.
 *
 * This module does not inspect client records and never returns user text.
 * Callers must construct `serverSignals` from authenticated, server-side
 * evidence through `createHcnAssistantReasoningSignals`. Browser input must
 * never be passed through as server signals.
 */

import {
  THRESHER_AI_MODEL,
  THRESHER_AI_PROVIDER
} from "./thresher-ai-runtime.js";

const MAX_USER_REQUEST_CHARACTERS = 6_000;
const MAX_USER_REQUEST_BYTES = 16 * 1024;
const MAX_EVIDENCE_SOURCES = 8;
const MAX_REQUESTED_CAPABILITIES = 8;
const REQUESTED_MODES = Object.freeze(["auto", "deep"]);

const ROUTES = Object.freeze([
  "deterministic",
  "standard",
  "deep",
  "codex_escalation"
]);

const OPERATIONS = Object.freeze([
  "unknown",
  "general_help",
  "work_center",
  "assigned_work_summary",
  "management_sweep",
  "file_status",
  "interpretation",
  "drafting"
]);

const DOMAINS = Object.freeze([
  "none",
  "settlement",
  "policy",
  "coverage",
  "claim_strategy",
  "financial",
  "legal"
]);

const CAPABILITIES = Object.freeze([
  "read_work_center",
  "assigned_work_summary",
  "management_sweep",
  "file_status",
  "interpret_evidence",
  "draft_communication",
  "live_call",
  "upload",
  "delete",
  "financial_action",
  "legal_action",
  "unsupported"
]);

const REASON_CODES = Object.freeze({
  EXPLICIT_CODEX_REQUEST: "explicit_codex_request",
  UNSUPPORTED_LIVE_CALL: "unsupported_live_call",
  UNSUPPORTED_UPLOAD: "unsupported_upload",
  UNSUPPORTED_DELETE: "unsupported_delete",
  UNSUPPORTED_FINANCIAL_ACTION: "unsupported_financial_action",
  UNSUPPORTED_LEGAL_ACTION: "unsupported_legal_action",
  UNSUPPORTED_CAPABILITY: "unsupported_capability",
  MISSING_REQUIRED_EVIDENCE: "missing_required_evidence",
  EXPLICIT_DEEP_REVIEW: "explicit_deep_review",
  MULTI_SOURCE_CONTRADICTION: "multi_source_contradiction",
  SETTLEMENT_REVIEW: "settlement_review",
  POLICY_REVIEW: "policy_review",
  COVERAGE_REVIEW: "coverage_review",
  CLAIM_STRATEGY: "claim_strategy",
  COMPLEX_DOCUMENT: "complex_document",
  HIGH_STAKES_AMBIGUITY: "high_stakes_ambiguity",
  FACT_ONLY_WORK_CENTER: "fact_only_work_center",
  FACT_ONLY_GENERAL_WORK_CENTER_SUMMARY:
    "fact_only_general_work_center_summary",
  FACT_ONLY_GENERAL_HELP: "fact_only_general_help",
  FACT_ONLY_ASSIGNED_WORK_SUMMARY: "fact_only_assigned_work_summary",
  FACT_ONLY_MANAGEMENT_SWEEP: "fact_only_management_sweep",
  FACT_ONLY_FILE_STATUS: "fact_only_file_status",
  ORDINARY_INTERPRETATION: "ordinary_interpretation",
  ORDINARY_DRAFTING: "ordinary_drafting",
  GENERAL_ASSISTANCE: "general_assistance"
});

export const HCN_ASSISTANT_REASONING_REASON_CODES = REASON_CODES;

export const HCN_ASSISTANT_REASONING_PROFILES = deepFreeze({
  deterministic: {
    profileId: "hcn.deterministic.v1",
    kind: "deterministic",
    provider: null,
    model: null,
    reasoningEffort: null,
    maxOutputTokens: 0,
    callEmbeddedLlm: false
  },
  standard: {
    profileId: "hcn.thresher.groq.gpt-oss-20b.medium.v1",
    kind: "thresher_groq_responses_api",
    provider: THRESHER_AI_PROVIDER,
    model: THRESHER_AI_MODEL,
    reasoningEffort: "medium",
    maxOutputTokens: 1_800,
    callEmbeddedLlm: true
  },
  deep: {
    profileId: "hcn.thresher.groq.gpt-oss-20b.high.v1",
    kind: "thresher_groq_responses_api",
    provider: THRESHER_AI_PROVIDER,
    model: THRESHER_AI_MODEL,
    reasoningEffort: "high",
    maxOutputTokens: 2_400,
    callEmbeddedLlm: true
  },
  codex_escalation: {
    profileId: "hcn.codex-operator-escalation.v1",
    kind: "operator_escalation",
    provider: null,
    model: null,
    reasoningEffort: null,
    maxOutputTokens: 0,
    callEmbeddedLlm: false
  }
});

const TRUSTED_SIGNALS = new WeakSet();
const SIGNAL_KEYS = new Set([
  "operation",
  "factOnly",
  "requestedDeepReview",
  "evidenceSourceCount",
  "hasConflictingEvidence",
  "hasMissingRequiredEvidence",
  "hasComplexDocument",
  "hasHighStakesAmbiguity",
  "domain",
  "requestedCapabilities"
]);

const DEEP_REVIEW_PATTERN =
  /\b(?:deep review|review (?:this|the file|the claim) deeply|analy[sz]e (?:this|the file|the claim) deeply|think (?:this|it|the file|the claim) through carefully)\b/i;
const CODEX_REQUEST_PATTERN =
  /\b(?:escalate (?:this )?to codex|have codex (?:handle|review|take over)|send (?:this )?to codex)\b/i;
const LIVE_CALL_PATTERN =
  /\b(?:(?:make|place|start|initiate)\s+(?:a\s+)?(?:live\s+|phone\s+)?call|call\s+(?:the\s+)?(?:carrier|client|homeowner|adjuster|insurance company)|file\s+(?:a|the|this)?\s*claim\s+(?:by phone|over the phone))\b/i;
const UPLOAD_PATTERN =
  /\b(?:upload|attach)\s+(?:a\s+|the\s+|this\s+|that\s+)?(?:file|document|photo|estimate|policy|declaration|report|attachment)\b/i;
const DELETE_PATTERN =
  /\b(?:delete|purge)\s+(?:a\s+|the\s+|this\s+|that\s+)?(?:file|document|photo|record|note|task|email|message|appointment|client|data)\b/i;
const FINANCIAL_ACTION_PATTERN =
  /\b(?:collect|issue|send|release|refund|charge|transfer|deposit)\s+(?:a\s+|the\s+|this\s+|that\s+)?(?:payment|check|money|funds|fee|invoice)\b/i;
const LEGAL_ACTION_PATTERN =
  /\b(?:give|provide|prepare|send|file)\s+(?:me\s+|a\s+|the\s+)?(?:legal advice|lawsuit|suit|complaint|demand letter|legal demand)\b/i;
const FACT_ONLY_BLOCKER_PATTERN =
  /\b(?:review|summarize|explain|recommend|should|draft|write|compose|reply|respond|send|email|text|message|note|call|upload|attach|delete|change|update|schedule|file\s+(?:a|the)\s+claim)\b/i;
const WORK_CENTER_PATTERNS = Object.freeze([
  /^(?:please\s+)?(?:show|list|display|open)\s+(?:me\s+)?(?:my\s+)?(?:assigned\s+)?(?:work\s*center|files|jobs)(?:\s+assigned\s+to\s+me)?[.?!]*$/i,
  /^(?:please\s+)?what\s+(?:files|jobs)\s+(?:are\s+)?assigned\s+to\s+me[.?!]*$/i,
  /^(?:please\s+)?(?:work|review|check|triage|open|show)\s+(?:me\s+)?(?:my\s+)?(?:assigned\s+)?(?:work|workload|queue|files|jobs)(?:\s+(?:for\s+)?(?:attention|today))?[.?!]*$/i,
  /^(?:please\s+)?(?:what|which)\s+(?:of\s+my\s+)?(?:files|jobs)?\s*(?:need|needs)\s+(?:my\s+)?attention(?:\s+(?:first|today|right\s+now))?[.?!]*$/i,
  /^(?:please\s+)?(?:where|what)\s+should\s+i\s+(?:start|work\s+first)(?:\s+(?:in\s+)?(?:my\s+)?(?:queue|files|work))?[.?!]*$/i
]);
const GENERAL_HELP_PATTERNS = Object.freeze([
  /^(?:please\s+)?(?:tell\s+me\s+)?what\s+(?:(?:can|do)\s+you|you\s+(?:can|do))\s+(?:safely\s+)?(?:do|help\s+(?:me\s+)?with)[.?!]*$/i,
  /^(?:please\s+)?how\s+can\s+you\s+help(?:\s+me)?[.?!]*$/i,
  /^(?:please\s+)?what\s+do\s+you\s+have\s+access\s+to[.?!]*$/i
]);
const ASSIGNED_WORK_SUMMARY_PATTERNS = Object.freeze([
  /^(?:please\s+)?how many\s+(?:of\s+)?(?:my\s+)?assigned\s+(?:files|jobs)\s+(?:are\s+)?(?:ready|available)\s+for\s+review(?:\s+(?:right\s+now|today))?\s*\??(?:\s+(?:please\s+)?give(?:\s+me)?\s+only\s+(?:the\s+)?(?:count|number)\s+and\s+(?:the\s+)?source\s+status\s*[.!?]*)?(?:\s+do\s+not\s+open\s+any\s+individual\s+file\s+and\s+do\s+not\s+take\s+any\s+action\s*[.!?]*)?$/i,
  /^(?:please\s+)?give(?:\s+me)?\s+only\s+(?:the\s+)?(?:count|number)\s+of\s+(?:my\s+)?assigned\s+(?:files|jobs)(?:\s+(?:ready|available)\s+for\s+review)?(?:\s+(?:right\s+now|today))?\s+and\s+(?:the\s+)?source\s+status\s*[.!?]*$/i
]);
const MANAGEMENT_SWEEP_LEAD_PATTERN =
  /^(?:please\s+)?(?:show|list|run|generate|open)\b/i;
const MANAGEMENT_SWEEP_SUBJECT_PATTERN =
  /\b(?:neglected|stale|untouched)\s+files?\b|\b(?:activity|communication)[ -]?gaps?\b|\blongest\b.{0,100}\b(?:activity|communication)\b.{0,40}\bgaps?\b|\bmanagement\s+sweep\b/i;
const MANAGEMENT_SWEEP_OBJECT_PATTERN = /\b(?:files?|report|sweep)\b/i;
const EXACT_FILE_REFERENCE_PATTERN =
  /\b(?:file|job|jobnimbus|jn)\s*(?:#|number|no\.?)?\s*\d{2,12}\b/i;
const FILE_STATUS_PATTERN =
  /\b(?:status|current\s+stage|last\s+(?:meaningful\s+)?(?:activity|touch|contact)|when\s+was\b.{0,80}\blast\s+(?:touched|updated|contacted))\b/i;
const FILE_STATUS_LEAD_PATTERN =
  /^(?:please\s+)?(?:show|give|tell|list|what(?:'s|\s+is)|when\s+was)\b/i;
const DRAFTING_PATTERN =
  /\b(?:draft|write|compose|prepare)\b.{0,80}\b(?:email|text|message|reply|response|follow-up|note)\b|\b(?:draft|write|compose|prepare)\s+(?:a\s+)?(?:reply|response|follow-up)\b/i;
const COMMUNICATION_REVIEW_PATTERN =
  /\b(?:review|summarize|analy[sz]e|check|read|what\s+did)\b.{0,100}\b(?:email|gmail|text|quo|communication|thread|transcript|message|homeowner\s+say)\b/i;
const SETTLEMENT_DOMAIN_PATTERN =
  /\b(?:settlement\s+(?:offer|estimate|amount|breakdown|statement|review|proposal)|review\s+(?:the\s+)?settlement|carrier(?:'s)?\s+settlement)\b/i;
const POLICY_DOMAIN_PATTERN =
  /\b(?:policy\s+(?:language|provision|exclusion|endorsement|limit|deductible|interpretation|question|review)|review\s+(?:the\s+)?policy|interpret\s+(?:the\s+)?policy|what\s+does\s+(?:the\s+)?policy\s+(?:say|mean|cover))\b/i;
const COVERAGE_DOMAIN_PATTERN =
  /\b(?:coverage\s+(?:decision|dispute|issue|position|question|denial|analysis|review)|review\s+(?:the\s+)?coverage|carrier(?:'s)?\s+coverage\s+(?:decision|position))\b/i;
const CLAIM_STRATEGY_DOMAIN_PATTERN =
  /\b(?:claim\s+strategy|strategy\s+(?:for|on)\s+(?:the\s+)?claim|negotiation\s+strategy|how\s+should\s+we\s+(?:handle|respond\s+to|proceed\s+with)\s+(?:the\s+|this\s+)?claim)\b/i;

/**
 * Create a branded, bounded signal object from server-derived facts.
 *
 * The router rejects ordinary lookalike objects so a browser cannot submit
 * JSON that impersonates contradictions, domains, or supported capabilities.
 */
export function createHcnAssistantReasoningSignals(input = {}) {
  if (!isPlainObject(input)) {
    invalidInput("server reasoning signals must be an object");
  }
  rejectUnknownKeys(input, SIGNAL_KEYS, "server reasoning signals");

  const signals = Object.freeze({
    operation: enumValue(input.operation ?? "unknown", OPERATIONS, "operation"),
    factOnly: booleanValue(input.factOnly ?? false, "factOnly"),
    requestedDeepReview: booleanValue(
      input.requestedDeepReview ?? false,
      "requestedDeepReview"
    ),
    evidenceSourceCount: integerBetween(
      input.evidenceSourceCount ?? 0,
      0,
      MAX_EVIDENCE_SOURCES,
      "evidenceSourceCount"
    ),
    hasConflictingEvidence: booleanValue(
      input.hasConflictingEvidence ?? false,
      "hasConflictingEvidence"
    ),
    hasMissingRequiredEvidence: booleanValue(
      input.hasMissingRequiredEvidence ?? false,
      "hasMissingRequiredEvidence"
    ),
    hasComplexDocument: booleanValue(
      input.hasComplexDocument ?? false,
      "hasComplexDocument"
    ),
    hasHighStakesAmbiguity: booleanValue(
      input.hasHighStakesAmbiguity ?? false,
      "hasHighStakesAmbiguity"
    ),
    domain: enumValue(input.domain ?? "none", DOMAINS, "domain"),
    requestedCapabilities: boundedUniqueEnums(
      input.requestedCapabilities ?? [],
      CAPABILITIES,
      MAX_REQUESTED_CAPABILITIES,
      "requestedCapabilities"
    )
  });

  TRUSTED_SIGNALS.add(signals);
  return signals;
}

/**
 * Classify one bounded user request into branded server signals.
 *
 * This helper recognizes only narrow, read-only fact intents. Everything else
 * remains model-backed. `requestedMode` can elevate a turn to deep review but
 * can never select a provider, model, effort, or a lower reasoning route.
 */
export function classifyHcnAssistantRequest(input = {}) {
  if (!isPlainObject(input)) {
    invalidInput("assistant request classification input must be an object");
  }
  rejectUnknownKeys(
    input,
    new Set(["userRequest", "requestedMode"]),
    "assistant request classification input"
  );
  const request = boundedUserRequest(input.userRequest);
  const requestedMode = enumValue(
    Object.prototype.hasOwnProperty.call(input, "requestedMode")
      ? input.requestedMode
      : "auto",
    REQUESTED_MODES,
    "requestedMode"
  );
  const operation = classifyOperation(request);
  const domain = classifyDomain(request);
  const requestedCapabilities = capabilitiesForOperation(operation);

  return createHcnAssistantReasoningSignals({
    operation,
    factOnly: isFactOnlyOperation(operation),
    requestedDeepReview: requestedMode === "deep",
    domain,
    requestedCapabilities
  });
}

/**
 * Select exactly one immutable, hardcoded reasoning profile.
 *
 * Precedence is fail-closed:
 *   unsupported or missing evidence -> Codex operator
 *   high-stakes or complex reasoning -> deep model
 *   verified fact-only operation -> deterministic path
 *   ordinary interpretation/drafting -> standard model
 */
export function routeHcnAssistantReasoning({
  userRequest,
  serverSignals
} = {}) {
  const request = boundedUserRequest(userRequest);
  if (!TRUSTED_SIGNALS.has(serverSignals)) {
    invalidInput(
      "serverSignals must be created by createHcnAssistantReasoningSignals"
    );
  }

  const escalationReasons = collectEscalationReasons(request, serverSignals);
  if (escalationReasons.length > 0) {
    return result("codex_escalation", escalationReasons);
  }

  const deepReasons = collectDeepReasons(request, serverSignals);
  if (deepReasons.length > 0) {
    return result("deep", deepReasons);
  }

  if (serverSignals.factOnly) {
    const deterministicReason = deterministicReasonFor(
      serverSignals.operation
    );
    if (deterministicReason) {
      return result("deterministic", [deterministicReason]);
    }
  }

  if (
    serverSignals.operation === "drafting"
    || serverSignals.requestedCapabilities.includes("draft_communication")
  ) {
    return result("standard", [REASON_CODES.ORDINARY_DRAFTING]);
  }
  if (
    serverSignals.operation === "interpretation"
    || serverSignals.requestedCapabilities.includes("interpret_evidence")
  ) {
    return result("standard", [REASON_CODES.ORDINARY_INTERPRETATION]);
  }
  return result("standard", [REASON_CODES.GENERAL_ASSISTANCE]);
}

function collectEscalationReasons(request, signals) {
  const reasons = [];
  const capabilities = new Set(signals.requestedCapabilities);
  addReason(reasons, CODEX_REQUEST_PATTERN.test(request), REASON_CODES.EXPLICIT_CODEX_REQUEST);
  addReason(
    reasons,
    capabilities.has("live_call") || LIVE_CALL_PATTERN.test(request),
    REASON_CODES.UNSUPPORTED_LIVE_CALL
  );
  addReason(
    reasons,
    capabilities.has("upload") || UPLOAD_PATTERN.test(request),
    REASON_CODES.UNSUPPORTED_UPLOAD
  );
  addReason(
    reasons,
    capabilities.has("delete") || DELETE_PATTERN.test(request),
    REASON_CODES.UNSUPPORTED_DELETE
  );
  addReason(
    reasons,
    capabilities.has("financial_action")
      || signals.domain === "financial"
      || FINANCIAL_ACTION_PATTERN.test(request),
    REASON_CODES.UNSUPPORTED_FINANCIAL_ACTION
  );
  addReason(
    reasons,
    capabilities.has("legal_action")
      || signals.domain === "legal"
      || LEGAL_ACTION_PATTERN.test(request),
    REASON_CODES.UNSUPPORTED_LEGAL_ACTION
  );
  addReason(
    reasons,
    capabilities.has("unsupported"),
    REASON_CODES.UNSUPPORTED_CAPABILITY
  );
  addReason(
    reasons,
    signals.hasMissingRequiredEvidence,
    REASON_CODES.MISSING_REQUIRED_EVIDENCE
  );
  return reasons;
}

function collectDeepReasons(request, signals) {
  const reasons = [];
  addReason(
    reasons,
    signals.requestedDeepReview || DEEP_REVIEW_PATTERN.test(request),
    REASON_CODES.EXPLICIT_DEEP_REVIEW
  );
  addReason(
    reasons,
    signals.hasConflictingEvidence && signals.evidenceSourceCount >= 2,
    REASON_CODES.MULTI_SOURCE_CONTRADICTION
  );
  addReason(
    reasons,
    signals.domain === "settlement",
    REASON_CODES.SETTLEMENT_REVIEW
  );
  addReason(
    reasons,
    signals.domain === "policy",
    REASON_CODES.POLICY_REVIEW
  );
  addReason(
    reasons,
    signals.domain === "coverage",
    REASON_CODES.COVERAGE_REVIEW
  );
  addReason(
    reasons,
    signals.domain === "claim_strategy",
    REASON_CODES.CLAIM_STRATEGY
  );
  addReason(
    reasons,
    signals.hasComplexDocument,
    REASON_CODES.COMPLEX_DOCUMENT
  );
  addReason(
    reasons,
    signals.hasHighStakesAmbiguity,
    REASON_CODES.HIGH_STAKES_AMBIGUITY
  );
  return reasons;
}

function classifyOperation(request) {
  const normalized = request.replace(/\s+/g, " ").trim();
  if (
    normalized.length <= 160
    && GENERAL_HELP_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return "general_help";
  }
  if (
    normalized.length <= 240
    && ASSIGNED_WORK_SUMMARY_PATTERNS.some((pattern) =>
      pattern.test(normalized)
    )
  ) {
    return "assigned_work_summary";
  }
  if (
    normalized.length <= 240
    && WORK_CENTER_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return "work_center";
  }
  if (!FACT_ONLY_BLOCKER_PATTERN.test(normalized)) {
    if (
      normalized.length <= 500
      && MANAGEMENT_SWEEP_LEAD_PATTERN.test(normalized)
      && MANAGEMENT_SWEEP_SUBJECT_PATTERN.test(normalized)
      && MANAGEMENT_SWEEP_OBJECT_PATTERN.test(normalized)
    ) {
      return "management_sweep";
    }
    if (
      normalized.length <= 300
      && FILE_STATUS_LEAD_PATTERN.test(normalized)
      && FILE_STATUS_PATTERN.test(normalized)
      && EXACT_FILE_REFERENCE_PATTERN.test(normalized)
    ) {
      return "file_status";
    }
  }
  if (DRAFTING_PATTERN.test(normalized)) {
    return "drafting";
  }
  if (COMMUNICATION_REVIEW_PATTERN.test(normalized)) {
    return "interpretation";
  }
  return "unknown";
}

function classifyDomain(request) {
  if (SETTLEMENT_DOMAIN_PATTERN.test(request)) {
    return "settlement";
  }
  if (POLICY_DOMAIN_PATTERN.test(request)) {
    return "policy";
  }
  if (COVERAGE_DOMAIN_PATTERN.test(request)) {
    return "coverage";
  }
  if (CLAIM_STRATEGY_DOMAIN_PATTERN.test(request)) {
    return "claim_strategy";
  }
  return "none";
}

function capabilitiesForOperation(operation) {
  if (operation === "work_center") {
    return ["read_work_center"];
  }
  if (operation === "assigned_work_summary") {
    return ["assigned_work_summary"];
  }
  if (operation === "management_sweep") {
    return ["management_sweep"];
  }
  if (operation === "file_status") {
    return ["file_status"];
  }
  if (operation === "drafting") {
    return ["draft_communication"];
  }
  if (operation === "interpretation") {
    return ["interpret_evidence"];
  }
  return [];
}

function isFactOnlyOperation(operation) {
  return operation === "general_help"
    || operation === "work_center"
    || operation === "assigned_work_summary"
    || operation === "management_sweep"
    || operation === "file_status";
}

function deterministicReasonFor(operation) {
  if (operation === "general_help") {
    return REASON_CODES.FACT_ONLY_GENERAL_HELP;
  }
  if (operation === "work_center") {
    return REASON_CODES.FACT_ONLY_GENERAL_WORK_CENTER_SUMMARY;
  }
  if (operation === "assigned_work_summary") {
    return REASON_CODES.FACT_ONLY_ASSIGNED_WORK_SUMMARY;
  }
  if (operation === "management_sweep") {
    return REASON_CODES.FACT_ONLY_MANAGEMENT_SWEEP;
  }
  if (operation === "file_status") {
    return REASON_CODES.FACT_ONLY_FILE_STATUS;
  }
  return null;
}

function result(route, reasonCodes) {
  if (!ROUTES.includes(route)) {
    throw new TypeError("unknown HCN reasoning route");
  }
  const frozenReasons = Object.freeze([...reasonCodes]);
  return Object.freeze({
    schema: "hcn.assistant.reasoning-route.v1",
    route,
    reasonCodes: frozenReasons,
    providerProfile: HCN_ASSISTANT_REASONING_PROFILES[route]
  });
}

function boundedUserRequest(value) {
  if (typeof value !== "string") {
    invalidInput("userRequest must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    invalidInput("userRequest must not be empty");
  }
  if (normalized.length > MAX_USER_REQUEST_CHARACTERS) {
    invalidInput("userRequest exceeds the character limit");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_USER_REQUEST_BYTES) {
    invalidInput("userRequest exceeds the byte limit");
  }
  return normalized;
}

function boundedUniqueEnums(value, allowed, maxItems, label) {
  if (!Array.isArray(value)) {
    invalidInput(`${label} must be an array`);
  }
  if (value.length > maxItems) {
    invalidInput(`${label} exceeds the item limit`);
  }
  const normalized = value.map((item) => enumValue(item, allowed, label));
  if (new Set(normalized).size !== normalized.length) {
    invalidInput(`${label} must not contain duplicates`);
  }
  return Object.freeze([...normalized]);
}

function enumValue(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalidInput(`${label} is invalid`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") {
    invalidInput(`${label} must be a boolean`);
  }
  return value;
}

function integerBetween(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidInput(`${label} is outside the allowed range`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalidInput(`${label} contains an unsupported field`);
    }
  }
}

function addReason(reasons, condition, reason) {
  if (condition && !reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function invalidInput(message) {
  throw new TypeError(message);
}
