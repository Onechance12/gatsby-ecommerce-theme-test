import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOfflineRetellSimulationContract,
  RETELL_SIMULATION_GUARDED_END_URL,
  validateOfflineRetellSimulationContract
} from "./contracts.js";

test("static Retell contract is synthetic, isolated, complete, and deterministic", () => {
  const contract = buildOfflineRetellSimulationContract();
  const result = validateOfflineRetellSimulationContract(contract);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.caseCount, 20);
  assert.equal(result.criticalCaseCount, 14);
  assert.equal(result.validationKind, "static_contract_only");
  assert.equal(result.modelInvoked, false);
  assert.equal(result.behaviorExecuted, false);
  assert.equal(result.livePromotionEligible, false);
  assert.match(result.warnings.join(" "), /does not run or grade/i);
  assert.match(result.behaviorDigest, /^[a-f0-9]{64}$/);
  assert.match(result.suiteDigest, /^[a-f0-9]{64}$/);
  assert.match(result.fixtureDigest, /^[a-f0-9]{64}$/);
  const guarded = contract.llm.general_tools.find((tool) => tool.name === "request_guarded_end_call");
  assert.equal(guarded.url, RETELL_SIMULATION_GUARDED_END_URL);
  assert.equal(guarded.headers, undefined);
});

test("static Retell contract rejects a live tool URL and absent per-case catch-all mock", () => {
  const contract = structuredClone(buildOfflineRetellSimulationContract());
  const guarded = contract.llm.general_tools.find((tool) => tool.name === "request_guarded_end_call");
  guarded.url = "https://jobnimbus-chatgpt-bridge.onrender.com/retell/guarded-end-call";
  contract.cases[0].toolMocks = [];
  const result = validateOfflineRetellSimulationContract(contract);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /not isolated/i);
  assert.match(result.errors.join(" "), /catch-all mock/i);
});

test("offline Retell suite rejects real-client data and missing variables", () => {
  const contract = structuredClone(buildOfflineRetellSimulationContract());
  contract.cases[0].dynamicVariables.insuredName = "Danielle Stellrecht";
  delete contract.cases[0].dynamicVariables.policyNumberForSpeech;
  const result = validateOfflineRetellSimulationContract(contract);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /missing variables/i);
  assert.match(result.errors.join(" "), /real-client data/i);
});
