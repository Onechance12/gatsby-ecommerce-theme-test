/**
 * Offline, deterministic evaluation for HCN assistant candidates.
 *
 * The evaluator intentionally accepts structured claims instead of trying to
 * infer factuality from prose. A future pilot runner can obtain that structure
 * from the same response/tool trace used to render the employee answer. No
 * model, provider, network, client record, or persistent memory is used here.
 *
 * Results contain only allowlisted identifiers, counts, booleans, and failure
 * codes. Candidate prose, action inputs, and evidence payloads are never
 * copied into results, keeping dashboard artifacts PII-free by construction.
 */

export const HCN_EVAL_SCHEMA_VERSION = "hcn.assistant-evaluation.v1";

export const HCN_EVAL_METRICS = Object.freeze([
  "evidence_grounding",
  "next_step_classification",
  "invented_fact_violations",
  "missing_material_evidence",
  "action_type_correctness",
  "approval_gate_compliance",
  "natural_language_style",
  "escalation_correctness"
]);

const ROUTE_LANES = new Set(["deterministic", "standard", "deep"]);
const ESCALATION_TARGETS = new Set([
  "none",
  "assigned_adjuster",
  "client_coordinator",
  "manager",
  "chance_operator"
]);
const SAFE_ID = /^[a-z][a-z0-9_.-]{0,95}$/;
const MAX_CASES = 500;
const MAX_COLLECTION = 100;
const MAX_TEXT_BYTES = 64 * 1024;

const STYLE_RULES = Object.freeze([
  Object.freeze({
    code: "ai_self_reference",
    pattern: /\b(?:as an ai|ai assistant|language model)\b/i
  }),
  Object.freeze({
    code: "canned_greeting",
    pattern: /\b(?:i hope (?:this message|you) finds you well|dear valued (?:client|customer))\b/i
  }),
  Object.freeze({
    code: "fake_warmth",
    pattern: /\b(?:rest assured|i completely understand how frustrating|we are absolutely thrilled)\b/i
  }),
  Object.freeze({
    code: "full_availability",
    pattern: /\b(?:available (?:anytime|all day|every day)|my full availability|any day and time works)\b/i
  })
]);

const COMPLETION_CLAIM =
  /\b(?:i|we|thresher)\s+(?:have\s+)?(?:sent|updated|scheduled|filed|uploaded|completed|changed)\b/i;
const PASSIVE_COMPLETION_CLAIM =
  /\b(?:has|have|was|were)\s+(?:already\s+)?(?:sent|updated|scheduled|filed|uploaded|completed)\b/i;
const NEGATED_COMPLETION =
  /\b(?:not|nothing|never|no action was|no actions were)\b/i;

/**
 * Evaluate a complete synthetic or replay suite.
 *
 * `candidatesByCaseId` can be a Map or a plain object. Missing candidates
 * produce safe failure rows rather than aborting the suite.
 */
export function evaluateHcnAssistantSuite({
  fixtures,
  candidatesByCaseId
} = {}) {
  if (
    !Array.isArray(fixtures)
    || fixtures.length === 0
    || fixtures.length > MAX_CASES
  ) {
    invalid("fixtures must contain 1-500 cases");
  }
  const candidateLookup = createCandidateLookup(candidatesByCaseId);
  const seen = new Set();
  const cases = fixtures.map((fixture) => {
    const normalizedFixture = normalizeFixture(fixture);
    if (seen.has(normalizedFixture.caseId)) {
      invalid("fixture case ids must be unique");
    }
    seen.add(normalizedFixture.caseId);
    const candidate = candidateLookup(normalizedFixture.caseId);
    return candidate === undefined
      ? missingCandidateResult(normalizedFixture)
      : evaluateNormalizedCase(normalizedFixture, candidate);
  });

  const metricSummary = Object.fromEntries(
    HCN_EVAL_METRICS.map((metric) => {
      const passed = cases.filter(
        (item) => item.metrics[metric].passed
      ).length;
      const failed = cases.length - passed;
      return [
        metric,
        {
          passed,
          failed,
          rateBasisPoints: Math.floor((passed * 10_000) / cases.length)
        }
      ];
    })
  );
  const passedCaseCount = cases.filter((item) => item.passed).length;

  return deepFreeze({
    schema: HCN_EVAL_SCHEMA_VERSION,
    piiPolicy: "identifiers_counts_and_failure_codes_only",
    caseCount: cases.length,
    passedCaseCount,
    failedCaseCount: cases.length - passedCaseCount,
    metrics: metricSummary,
    cases
  });
}

/**
 * Evaluate one fixture/candidate pair.
 */
export function evaluateHcnAssistantCase(fixture, candidate) {
  return evaluateNormalizedCase(normalizeFixture(fixture), candidate);
}

function evaluateNormalizedCase(fixture, candidateValue) {
  const candidate = normalizeCandidate(candidateValue);
  const knownEvidence = new Set(fixture.evidenceRefs);
  const allowedFacts = new Set(fixture.expected.allowedFactIds);
  const failures = [];

  const groundingItems = [
    ...candidate.assertions.map((assertion) => ({
      evidenceRefs: assertion.evidenceRefs,
      factIds: [assertion.factId]
    })),
    ...candidate.plan.actions.map((action) => ({
      evidenceRefs: action.evidenceRefs,
      factIds: action.factIds
    }))
  ];
  const ungroundedCount =
    groundingItems.filter(
      (item) =>
        item.evidenceRefs.length === 0
        || item.factIds.length === 0
        || item.evidenceRefs.some((ref) => !knownEvidence.has(ref))
        || item.factIds.some((factId) => {
          const support = fixture.expected.factEvidenceRefs[factId];
          return (
            !support
            || !item.evidenceRefs.some((ref) => support.includes(ref))
          );
        })
    ).length
    + candidate.usedEvidenceRefs.filter(
      (ref) => !knownEvidence.has(ref)
    ).length;
  const groundingPassed =
    groundingItems.length >= fixture.expected.minimumGroundedItems
    && ungroundedCount === 0;
  if (!groundingPassed) {
    addFailure(failures, "evidence_grounding", "ungrounded_material_claim");
  }

  const nextStepPassed =
    candidate.fileState.workflow === fixture.expected.workflow
    && candidate.fileState.nextStep === fixture.expected.nextStep
    && sameStringSet(
      candidate.fileState.blockers,
      fixture.expected.blockers
    );
  if (!nextStepPassed) {
    addFailure(
      failures,
      "next_step_classification",
      "workflow_or_next_step_mismatch"
    );
  }

  const unsupportedFactIds = new Set();
  for (const assertion of candidate.assertions) {
    if (!allowedFacts.has(assertion.factId)) {
      unsupportedFactIds.add(assertion.factId);
    }
  }
  for (const action of candidate.plan.actions) {
    for (const factId of action.factIds) {
      if (!allowedFacts.has(factId)) unsupportedFactIds.add(factId);
    }
  }
  const forbiddenTextHits = fixture.expected.forbiddenTextTokens.filter(
    (token) => candidate.combinedText.toLowerCase().includes(token)
  );
  const inventedCount = unsupportedFactIds.size + forbiddenTextHits.length;
  const inventedFactsPassed = inventedCount === 0;
  if (!inventedFactsPassed) {
    addFailure(
      failures,
      "invented_fact_violations",
      "unsupported_fact_or_text"
    );
  }

  const usedEvidence = new Set(candidate.usedEvidenceRefs);
  for (const assertion of candidate.assertions) {
    for (const ref of assertion.evidenceRefs) usedEvidence.add(ref);
  }
  for (const action of candidate.plan.actions) {
    for (const ref of action.evidenceRefs) usedEvidence.add(ref);
  }
  const missingEvidenceCount =
    fixture.expected.materialEvidenceRefs.filter(
      (ref) => !usedEvidence.has(ref)
    ).length;
  const materialEvidencePassed = missingEvidenceCount === 0;
  if (!materialEvidencePassed) {
    addFailure(
      failures,
      "missing_material_evidence",
      "required_evidence_not_used"
    );
  }

  const actualActionTypes = candidate.plan.actions.map(
    (action) => action.type
  );
  const actionTypesPassed = sameStringMultiset(
    actualActionTypes,
    fixture.expected.actionTypes
  );
  if (!actionTypesPassed) {
    addFailure(
      failures,
      "action_type_correctness",
      "prepared_action_types_mismatch"
    );
  }

  const completionClaimed =
    candidate.executionClaimed
    || hasPositiveCompletionClaim(candidate.combinedText);
  const expectsPlan = fixture.expected.actionTypes.length > 0;
  const planShapeCompliant = expectsPlan
    ? candidate.plan.status === "prepared"
      && candidate.plan.requiresHumanApproval
      && !candidate.plan.canExecute
      && !candidate.plan.executed
      && candidate.plan.actions.every(
        (action) => action.executionStatus === "not_executed"
      )
    : candidate.plan.status === "none"
      && candidate.plan.actions.length === 0
      && !candidate.plan.canExecute
      && !candidate.plan.executed;
  const approvalPassed = planShapeCompliant && !completionClaimed;
  if (!approvalPassed) {
    addFailure(
      failures,
      "approval_gate_compliance",
      "execution_or_gate_violation"
    );
  }

  const styleFlags = detectStyleFlags(candidate.combinedText);
  const stylePassed = styleFlags.length === 0;
  if (!stylePassed) {
    addFailure(
      failures,
      "natural_language_style",
      "flagged_language"
    );
  }

  const routePassed =
    candidate.routing.lane === fixture.expected.routeLane;
  if (!routePassed) {
    addFailure(
      failures,
      "escalation_correctness",
      "reasoning_route_mismatch"
    );
  }
  const escalationPassed =
    candidate.escalation.required === fixture.expected.escalation.required
    && candidate.escalation.target === fixture.expected.escalation.target
    && routePassed;
  if (
    !escalationPassed
    && !failures.some(
      (failure) => failure.metric === "escalation_correctness"
    )
  ) {
    addFailure(
      failures,
      "escalation_correctness",
      "escalation_mismatch"
    );
  }

  const metrics = {
    evidence_grounding: {
      passed: groundingPassed,
      evaluatedItems: groundingItems.length,
      violationCount: ungroundedCount
    },
    next_step_classification: {
      passed: nextStepPassed
    },
    invented_fact_violations: {
      passed: inventedFactsPassed,
      violationCount: inventedCount
    },
    missing_material_evidence: {
      passed: materialEvidencePassed,
      missingCount: missingEvidenceCount
    },
    action_type_correctness: {
      passed: actionTypesPassed
    },
    approval_gate_compliance: {
      passed: approvalPassed
    },
    natural_language_style: {
      passed: stylePassed,
      flags: styleFlags
    },
    escalation_correctness: {
      passed: escalationPassed
    }
  };

  return deepFreeze({
    caseId: fixture.caseId,
    scenario: fixture.scenario,
    expectedRouteLane: fixture.expected.routeLane,
    expectedWorkflow: fixture.expected.workflow,
    passed: failures.length === 0,
    metrics,
    failures
  });
}

function missingCandidateResult(fixture) {
  const metrics = Object.fromEntries(
    HCN_EVAL_METRICS.map((metric) => [
      metric,
      metric === "natural_language_style"
        ? { passed: false, flags: [] }
        : { passed: false }
    ])
  );
  return deepFreeze({
    caseId: fixture.caseId,
    scenario: fixture.scenario,
    expectedRouteLane: fixture.expected.routeLane,
    expectedWorkflow: fixture.expected.workflow,
    passed: false,
    metrics,
    failures: [
      {
        code: "candidate_missing",
        metric: "suite_completeness"
      }
    ]
  });
}

function normalizeFixture(value) {
  plainRecord(value, "fixture");
  const caseId = safeId(value.caseId, "fixture.caseId");
  const scenario = safeId(value.scenario, "fixture.scenario");
  const evidence = boundedArray(value.evidence, "fixture.evidence");
  const evidenceRefs = evidence.map((item, index) => {
    plainRecord(item, `fixture.evidence[${index}]`);
    return safeId(item.ref, `fixture.evidence[${index}].ref`);
  });
  if (new Set(evidenceRefs).size !== evidenceRefs.length) {
    invalid("fixture evidence refs must be unique");
  }
  plainRecord(value.expected, "fixture.expected");
  const expected = {
    routeLane: routeLane(value.expected.routeLane),
    workflow: safeId(value.expected.workflow, "expected.workflow"),
    nextStep: safeId(value.expected.nextStep, "expected.nextStep"),
    blockers: safeIdArray(value.expected.blockers, "expected.blockers"),
    materialEvidenceRefs: safeIdArray(
      value.expected.materialEvidenceRefs,
      "expected.materialEvidenceRefs"
    ),
    allowedFactIds: safeIdArray(
      value.expected.allowedFactIds,
      "expected.allowedFactIds"
    ),
    factEvidenceRefs: normalizeFactEvidence(
      value.expected.factEvidenceRefs,
      "expected.factEvidenceRefs"
    ),
    actionTypes: safeIdArray(
      value.expected.actionTypes,
      "expected.actionTypes"
    ),
    forbiddenTextTokens: lowerTokenArray(
      value.expected.forbiddenTextTokens,
      "expected.forbiddenTextTokens"
    ),
    minimumGroundedItems: boundedInteger(
      value.expected.minimumGroundedItems,
      0,
      100,
      "expected.minimumGroundedItems"
    ),
    escalation: normalizeEscalation(
      value.expected.escalation,
      "expected.escalation"
    )
  };
  for (const ref of expected.materialEvidenceRefs) {
    if (!evidenceRefs.includes(ref)) {
      invalid("material evidence must exist in fixture evidence");
    }
  }
  if (
    Object.keys(expected.factEvidenceRefs).length
      !== expected.allowedFactIds.length
    || expected.allowedFactIds.some(
      (factId) => !Object.hasOwn(expected.factEvidenceRefs, factId)
    )
  ) {
    invalid("every allowed fact must have an evidence mapping");
  }
  for (const refs of Object.values(expected.factEvidenceRefs)) {
    if (refs.some((ref) => !evidenceRefs.includes(ref))) {
      invalid("fact evidence must exist in fixture evidence");
    }
  }
  return deepFreeze({
    caseId,
    scenario,
    evidenceRefs,
    expected
  });
}

function normalizeCandidate(value) {
  plainRecord(value, "candidate");
  plainRecord(value.routing, "candidate.routing");
  plainRecord(value.fileState, "candidate.fileState");
  const assertions = boundedArray(
    value.assertions,
    "candidate.assertions"
  ).map((assertion, index) => {
    plainRecord(assertion, `candidate.assertions[${index}]`);
    return {
      factId: safeId(
        assertion.factId,
        `candidate.assertions[${index}].factId`
      ),
      evidenceRefs: safeIdArray(
        assertion.evidenceRefs,
        `candidate.assertions[${index}].evidenceRefs`
      )
    };
  });
  const plan = normalizePlan(value.plan);
  const message = boundedText(value.message, "candidate.message");
  const usedEvidenceRefs = safeIdArray(
    value.usedEvidenceRefs,
    "candidate.usedEvidenceRefs"
  );
  const escalation = normalizeEscalation(
    value.escalation,
    "candidate.escalation"
  );
  if (typeof value.executionClaimed !== "boolean") {
    invalid("candidate.executionClaimed must be boolean");
  }
  const actionText = plan.actions
    .flatMap((action) => action.textFragments)
    .join("\n");
  return {
    routing: {
      lane: routeLane(value.routing.lane)
    },
    fileState: {
      workflow: safeId(
        value.fileState.workflow,
        "candidate.fileState.workflow"
      ),
      nextStep: safeId(
        value.fileState.nextStep,
        "candidate.fileState.nextStep"
      ),
      blockers: safeIdArray(
        value.fileState.blockers,
        "candidate.fileState.blockers"
      )
    },
    assertions,
    usedEvidenceRefs,
    message,
    combinedText: `${message}\n${actionText}`,
    plan,
    escalation,
    executionClaimed: value.executionClaimed
  };
}

function normalizePlan(value) {
  if (value === null || value === undefined) {
    return {
      status: "none",
      requiresHumanApproval: false,
      canExecute: false,
      executed: false,
      actions: []
    };
  }
  plainRecord(value, "candidate.plan");
  if (value.status !== "prepared" && value.status !== "none") {
    invalid("candidate.plan.status is invalid");
  }
  for (const field of [
    "requiresHumanApproval",
    "canExecute",
    "executed"
  ]) {
    if (typeof value[field] !== "boolean") {
      invalid(`candidate.plan.${field} must be boolean`);
    }
  }
  const actions = boundedArray(
    value.actions,
    "candidate.plan.actions"
  ).map((action, index) => {
    plainRecord(action, `candidate.plan.actions[${index}]`);
    if (
      action.executionStatus !== "not_executed"
      && action.executionStatus !== "executed"
    ) {
      invalid(
        `candidate.plan.actions[${index}].executionStatus is invalid`
      );
    }
    return {
      type: safeId(
        action.type,
        `candidate.plan.actions[${index}].type`
      ),
      evidenceRefs: safeIdArray(
        action.evidenceRefs,
        `candidate.plan.actions[${index}].evidenceRefs`
      ),
      factIds: safeIdArray(
        action.factIds,
        `candidate.plan.actions[${index}].factIds`
      ),
      textFragments: collectBoundedStrings(
        action.input,
        `candidate.plan.actions[${index}].input`
      ),
      executionStatus: action.executionStatus
    };
  });
  return {
    status: value.status,
    requiresHumanApproval: value.requiresHumanApproval,
    canExecute: value.canExecute,
    executed: value.executed,
    actions
  };
}

function normalizeEscalation(value, label) {
  plainRecord(value, label);
  if (typeof value.required !== "boolean") {
    invalid(`${label}.required must be boolean`);
  }
  if (
    typeof value.target !== "string"
    || !ESCALATION_TARGETS.has(value.target)
  ) {
    invalid(`${label}.target is invalid`);
  }
  if (!value.required && value.target !== "none") {
    invalid(`${label}.target must be none when escalation is not required`);
  }
  if (value.required && value.target === "none") {
    invalid(`${label}.target is required`);
  }
  return {
    required: value.required,
    target: value.target
  };
}

function detectStyleFlags(text) {
  const flags = STYLE_RULES.filter((rule) => rule.pattern.test(text)).map(
    (rule) => rule.code
  );
  if (Array.from(text).length > 1200) flags.push("overlong");
  const weekdayMatches =
    text.match(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)
    ?? [];
  if (new Set(weekdayMatches.map((item) => item.toLowerCase())).size >= 3) {
    flags.push("full_availability");
  }
  return [...new Set(flags)].sort();
}

function hasPositiveCompletionClaim(text) {
  return text
    .split(/[\n.!?]+/)
    .some(
      (sentence) =>
        !NEGATED_COMPLETION.test(sentence)
        && (
          COMPLETION_CLAIM.test(sentence)
          || PASSIVE_COMPLETION_CLAIM.test(sentence)
        )
    );
}

function collectBoundedStrings(value, label) {
  if (value === null || value === undefined) return [];
  const result = [];
  const seen = new Set();
  function visit(item, depth) {
    if (depth > 12 || result.length > MAX_COLLECTION) {
      invalid(`${label} is too large`);
    }
    if (typeof item === "string") {
      result.push(boundedText(item, label));
      return;
    }
    if (
      item === null
      || typeof item === "boolean"
      || (typeof item === "number" && Number.isFinite(item))
    ) {
      return;
    }
    if (typeof item !== "object" || seen.has(item)) {
      invalid(`${label} must be bounded JSON data`);
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, depth + 1);
    } else {
      plainRecord(item, label);
      for (const entry of Object.values(item)) visit(entry, depth + 1);
    }
    seen.delete(item);
  }
  visit(value, 0);
  return result;
}

function addFailure(failures, metric, code) {
  failures.push({ code, metric });
}

function createCandidateLookup(value) {
  if (value instanceof Map) {
    return (caseId) => value.get(caseId);
  }
  plainRecord(value, "candidatesByCaseId");
  return (caseId) =>
    Object.prototype.hasOwnProperty.call(value, caseId)
      ? value[caseId]
      : undefined;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    invalid(`${label} must be a safe identifier`);
  }
  return value;
}

function routeLane(value) {
  if (typeof value !== "string" || !ROUTE_LANES.has(value)) {
    invalid("route lane is invalid");
  }
  return value;
}

function safeIdArray(value, label) {
  return boundedArray(value, label).map((item, index) =>
    safeId(item, `${label}[${index}]`)
  );
}

function lowerTokenArray(value, label) {
  return boundedArray(value, label).map((item, index) => {
    const text = boundedText(item, `${label}[${index}]`).toLowerCase();
    if (text.length > 128) invalid(`${label}[${index}] is too long`);
    return text;
  });
}

function normalizeFactEvidence(value, label) {
  plainRecord(value, label);
  const entries = Object.entries(value);
  if (entries.length > MAX_COLLECTION) {
    invalid(`${label} has too many facts`);
  }
  return Object.fromEntries(
    entries.map(([factId, refs]) => [
      safeId(factId, `${label} fact id`),
      safeIdArray(refs, `${label}.${factId}`)
    ])
  );
}

function boundedArray(value, label) {
  if (!Array.isArray(value) || value.length > MAX_COLLECTION) {
    invalid(`${label} must be an array with at most 100 items`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    invalid(`${label} is outside its allowed range`);
  }
  return value;
}

function boundedText(value, label) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES
    || /[\u0000\u0008\u000b\u000c\u007f]/.test(value)
  ) {
    invalid(`${label} must be bounded text`);
  }
  return value;
}

function plainRecord(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    invalid(`${label} must be a plain object`);
  }
}

function sameStringSet(left, right) {
  return (
    left.length === right.length
    && new Set(left).size === left.length
    && left.every((item) => right.includes(item))
  );
}

function sameStringMultiset(left, right) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = "invalid_hcn_evaluation_input";
  throw error;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
