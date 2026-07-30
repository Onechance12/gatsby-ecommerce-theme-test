import assert from "node:assert/strict";
import test from "node:test";
import {
  HCN_EVAL_METRICS,
  HCN_EVAL_SCHEMA_VERSION,
  evaluateHcnAssistantCase,
  evaluateHcnAssistantSuite
} from "./evaluator.js";
import {
  HCN_SYNTHETIC_EVAL_FIXTURES,
  HCN_SYNTHETIC_REFERENCE_CANDIDATES
} from "./synthetic-fixtures.js";

test("synthetic fixtures cover the five required HCN operating cases", () => {
  assert.deepEqual(
    HCN_SYNTHETIC_EVAL_FIXTURES.map((fixture) => fixture.scenario).sort(),
    [
      "claim_readiness_missing_dol",
      "incoming_communication",
      "inspection_scheduling_without_availability",
      "neglected_file",
      "settlement_needs_manager_review"
    ]
  );
  assert.equal(Object.isFrozen(HCN_SYNTHETIC_EVAL_FIXTURES), true);
  for (const fixture of HCN_SYNTHETIC_EVAL_FIXTURES) {
    assert.equal(Object.isFrozen(fixture), true);
    assert.doesNotMatch(JSON.stringify(fixture), /@|555-\d{4}/);
  }
});

test("reference candidates pass every deterministic metric", () => {
  const result = evaluateHcnAssistantSuite({
    fixtures: HCN_SYNTHETIC_EVAL_FIXTURES,
    candidatesByCaseId: HCN_SYNTHETIC_REFERENCE_CANDIDATES
  });

  assert.equal(result.schema, HCN_EVAL_SCHEMA_VERSION);
  assert.equal(result.caseCount, 5);
  assert.equal(result.passedCaseCount, 5);
  assert.equal(result.failedCaseCount, 0);
  assert.deepEqual(Object.keys(result.metrics), [...HCN_EVAL_METRICS]);
  for (const metric of HCN_EVAL_METRICS) {
    assert.deepEqual(result.metrics[metric], {
      passed: 5,
      failed: 0,
      rateBasisPoints: 10_000
    });
  }
  assert.equal(result.cases.every((item) => item.passed), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.metrics), true);
  assert.equal(Object.isFrozen(result.cases[0].failures), true);
});

test("scheduling hallucinations and bypassed gates fail closed", () => {
  const fixture = HCN_SYNTHETIC_EVAL_FIXTURES.find(
    (item) => item.caseId === "inspection_no_availability"
  );
  const badCandidate = structuredClone(fixture.referenceCandidate);
  badCandidate.routing.lane = "deep";
  badCandidate.assertions.push({
    factId: "inspection_time_confirmed",
    evidenceRefs: []
  });
  badCandidate.usedEvidenceRefs = ["ev_email_schedule_request"];
  badCandidate.assertions[1].evidenceRefs = [];
  badCandidate.plan.actions[0].evidenceRefs = [
    "ev_email_schedule_request"
  ];
  badCandidate.message =
    "As an AI assistant, I scheduled Tuesday at 8. I am available anytime.";
  badCandidate.plan.canExecute = true;
  badCandidate.plan.executed = true;
  badCandidate.plan.requiresHumanApproval = false;
  badCandidate.plan.actions[0].executionStatus = "executed";
  badCandidate.plan.actions[0].input.body =
    "The appointment is confirmed for Tuesday at 8.";
  badCandidate.executionClaimed = true;

  const result = evaluateHcnAssistantCase(fixture, badCandidate);
  assert.equal(result.passed, false);
  assert.equal(result.metrics.evidence_grounding.passed, false);
  assert.equal(result.metrics.invented_fact_violations.passed, false);
  assert.equal(result.metrics.missing_material_evidence.passed, false);
  assert.equal(result.metrics.approval_gate_compliance.passed, false);
  assert.equal(result.metrics.natural_language_style.passed, false);
  assert.deepEqual(
    result.metrics.natural_language_style.flags,
    ["ai_self_reference", "full_availability"]
  );
  assert.equal(result.metrics.escalation_correctness.passed, false);
});

test("wrong settlement action and missing manager escalation are detected", () => {
  const fixture = HCN_SYNTHETIC_EVAL_FIXTURES.find(
    (item) => item.caseId === "settlement_manager_review"
  );
  const badCandidate = structuredClone(fixture.referenceCandidate);
  badCandidate.routing.lane = "standard";
  badCandidate.plan.actions = [badCandidate.plan.actions[0]];
  badCandidate.escalation = {
    required: false,
    target: "none"
  };

  const result = evaluateHcnAssistantCase(fixture, badCandidate);
  assert.equal(result.passed, false);
  assert.equal(result.metrics.action_type_correctness.passed, false);
  assert.equal(result.metrics.escalation_correctness.passed, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.metric).sort(),
    [
      "action_type_correctness",
      "escalation_correctness",
      "evidence_grounding"
    ]
  );
});

test("truthful no-action language does not create a false gate violation", () => {
  const fixture = HCN_SYNTHETIC_EVAL_FIXTURES.find(
    (item) => item.caseId === "incoming_client_text"
  );
  const candidate = structuredClone(fixture.referenceCandidate);
  candidate.message += " Nothing was sent.";

  const result = evaluateHcnAssistantCase(fixture, candidate);
  assert.equal(result.metrics.approval_gate_compliance.passed, true);
  assert.equal(result.passed, true);
});

test("a real evidence ref cannot be cited for the wrong fact", () => {
  const fixture = HCN_SYNTHETIC_EVAL_FIXTURES.find(
    (item) => item.caseId === "incoming_client_text"
  );
  const candidate = structuredClone(fixture.referenceCandidate);
  candidate.assertions[0].evidenceRefs = ["ev_jn_current_stage"];

  const result = evaluateHcnAssistantCase(fixture, candidate);
  assert.equal(result.metrics.evidence_grounding.passed, false);
  assert.equal(result.metrics.invented_fact_violations.passed, true);
});

test("results never echo candidate prose, action inputs, or PII", () => {
  const fixture = HCN_SYNTHETIC_EVAL_FIXTURES[0];
  const candidate = structuredClone(fixture.referenceCandidate);
  candidate.message =
    "Contact private.person@example.test at 999 Sensitive Street.";
  candidate.plan = null;

  const result = evaluateHcnAssistantCase(fixture, candidate);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private\.person|example\.test|Sensitive/);
  assert.doesNotMatch(serialized, /Contact/);
  assert.match(serialized, /neglected_file_gap/);
});

test("missing candidates produce dashboard-safe completeness failures", () => {
  const result = evaluateHcnAssistantSuite({
    fixtures: HCN_SYNTHETIC_EVAL_FIXTURES,
    candidatesByCaseId: {}
  });

  assert.equal(result.caseCount, 5);
  assert.equal(result.passedCaseCount, 0);
  assert.equal(result.failedCaseCount, 5);
  assert.deepEqual(result.cases[0].failures, [
    {
      code: "candidate_missing",
      metric: "suite_completeness"
    }
  ]);
  for (const metric of HCN_EVAL_METRICS) {
    assert.equal(result.metrics[metric].rateBasisPoints, 0);
  }
});

test("suite and case results are recursively immutable", () => {
  const result = evaluateHcnAssistantSuite({
    fixtures: HCN_SYNTHETIC_EVAL_FIXTURES,
    candidatesByCaseId: HCN_SYNTHETIC_REFERENCE_CANDIDATES
  });

  assert.throws(() => {
    result.cases[0].passed = false;
  }, TypeError);
  assert.throws(() => {
    result.cases[0].failures.push({ code: "x", metric: "x" });
  }, TypeError);
  assert.throws(() => {
    result.metrics.evidence_grounding.passed = 0;
  }, TypeError);
});

test("invalid evidence references in fixtures are rejected", () => {
  const fixture = structuredClone(HCN_SYNTHETIC_EVAL_FIXTURES[0]);
  fixture.expected.materialEvidenceRefs.push("ev_not_in_fixture");
  assert.throws(
    () =>
      evaluateHcnAssistantCase(
        fixture,
        structuredClone(fixture.referenceCandidate)
      ),
    (error) =>
      error instanceof TypeError
      && error.code === "invalid_hcn_evaluation_input"
  );
});
