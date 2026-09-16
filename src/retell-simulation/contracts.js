import { createHash } from "node:crypto";

import { buildRetellLlmFromPacket } from "../claim-filing-core/retellPrompt.js";
import { buildRetellClaimLlmSettings } from "../claim-filing-core/retellAgentSettings.js";
import { PROMPT_PLACEHOLDERS } from "../claim-filing-core/dynamicVariables.js";
import { RETELL_CLAIM_SIMULATION_SUITE } from "./suite.js";

export const RETELL_SIMULATION_GUARDED_END_URL = "https://retell-simulation.invalid/guarded-end-call";

export function canonicalDigest(value) {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

export function buildOfflineRetellSimulationContract() {
  const llm = buildRetellLlmFromPacket({}, {
    guardedEndCallUrl: RETELL_SIMULATION_GUARDED_END_URL,
    guardedEndCallAuthorization: ""
  }).toLlmRequestBody(buildRetellClaimLlmSettings());
  const placeholders = [...new Set([...llm.general_prompt.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((match) => match[1]))].sort();
  const defaultToolMocks = [{
    tool_name: "request_guarded_end_call",
    input_match_rule: { type: "any" },
    output: JSON.stringify({ allowed: true, stopped: true, code: "simulation_only" }),
    result: true
  }];
  const contract = {
    schema: "hcn.retell-claim-simulation.v1",
    llm: structuredClone(llm),
    placeholders,
    cases: RETELL_CLAIM_SIMULATION_SUITE.map((testCase) => ({
      ...testCase,
      toolMocks: testCase.toolMocks.length ? testCase.toolMocks : defaultToolMocks
    }))
  };
  return {
    ...contract,
    behaviorDigest: canonicalDigest({ llm: contract.llm, placeholders }),
    suiteDigest: canonicalDigest(contract.cases),
    fixtureDigest: canonicalDigest(contract.cases.map((entry) => entry.dynamicVariables))
  };
}

export function validateOfflineRetellSimulationContract(contract = buildOfflineRetellSimulationContract()) {
  const errors = [];
  const tools = Array.isArray(contract?.llm?.general_tools) ? contract.llm.general_tools : [];
  const placeholders = Array.isArray(contract?.placeholders) ? contract.placeholders : [];
  if (tools.some((tool) => String(tool?.type || "").toLowerCase() === "mcp")) {
    errors.push("MCP tools are forbidden in the Retell simulation workspace because mocks do not intercept them.");
  }
  for (const tool of tools) {
    if (tool.type !== "custom") continue;
    let parsed;
    try {
      parsed = new URL(String(tool.url || ""));
    } catch {
      errors.push(`Custom tool ${tool.name || "(unnamed)"} has an invalid URL.`);
      continue;
    }
    if (parsed.hostname !== "retell-simulation.invalid") {
      errors.push(`Custom tool ${tool.name || "(unnamed)"} is not isolated on the .invalid simulation host.`);
    }
  }
  for (const testCase of contract.cases || []) {
    if (!String(testCase?.id || "").trim()) errors.push("Every static Retell contract case requires an id.");
    if (!String(testCase?.simulatedUser || "").trim()) errors.push(`${testCase.id || "(unnamed)"} requires a simulated user scenario.`);
    if (!Array.isArray(testCase?.successCriteria) || !testCase.successCriteria.length || testCase.successCriteria.some((item) => !String(item || "").trim())) {
      errors.push(`${testCase.id || "(unnamed)"} requires at least one nonempty success criterion.`);
    }
    if (!Array.isArray(testCase?.forbiddenPhrases)) errors.push(`${testCase.id || "(unnamed)"} requires a forbidden-phrases array.`);
    if (!Array.isArray(testCase?.expectedToolTrace)) errors.push(`${testCase.id || "(unnamed)"} requires an expected-tool-trace array.`);
    const caseMocks = Array.isArray(testCase?.toolMocks) ? testCase.toolMocks : [];
    for (const tool of tools) {
      if (tool.type !== "custom") continue;
      const mocks = caseMocks.filter((mock) => mock.tool_name === tool.name);
      if (mocks.length !== 1 || mocks[0]?.input_match_rule?.type !== "any" || !String(mocks[0]?.output || "").trim()) {
        errors.push(`${testCase.id || "(unnamed)"}: custom tool ${tool.name || "(unnamed)"} requires exactly one nonempty catch-all mock.`);
      }
    }
    const missing = placeholders.filter((name) => !String(testCase?.dynamicVariables?.[name] || "").trim());
    if (missing.length) errors.push(`${testCase.id} is missing variables: ${missing.join(", ")}.`);
    const expandedPrompt = String(contract.llm.general_prompt || "").replace(
      /\{\{([A-Za-z0-9_]+)\}\}/g,
      (_, name) => String(testCase?.dynamicVariables?.[name] ?? "")
    );
    if (/\{\{[A-Za-z0-9_]+\}\}/.test(expandedPrompt)) {
      errors.push(`${testCase.id} leaves an unresolved dynamic-variable placeholder.`);
    }
    if (expandedPrompt.length > 16000) {
      errors.push(`${testCase.id} expands the claim prompt beyond the 16,000-character release budget.`);
    }
    const serialized = JSON.stringify(testCase);
    if (/chancepearson|danielle|stellrecht|jobnimbus|@gmail\.com|@aol\.com/i.test(serialized)) {
      errors.push(`${testCase.id} contains production or real-client data.`);
    }
    if (!Number.isInteger(testCase.maxTurns) || testCase.maxTurns < 2 || testCase.maxTurns > 20) {
      errors.push(`${testCase.id} must cap the synthetic conversation between 2 and 20 turns.`);
    }
  }
  const declaredButUnused = PROMPT_PLACEHOLDERS.filter((name) => !placeholders.includes(name));
  return {
    valid: errors.length === 0,
    errors,
    validationKind: "static_contract_only",
    modelInvoked: false,
    behaviorExecuted: false,
    livePromotionEligible: false,
    warnings: [
      "This command validates static prompt fixtures and no-effects tool isolation only; it does not run or grade a Retell model conversation.",
      ...(declaredButUnused.length
        ? [`Declared dynamic variables unused by the compact claim prompt: ${declaredButUnused.join(", ")}.`]
        : [])
    ],
    caseCount: contract.cases?.length || 0,
    criticalCaseCount: (contract.cases || []).filter((entry) => entry.critical).length,
    behaviorDigest: contract.behaviorDigest,
    suiteDigest: contract.suiteDigest,
    fixtureDigest: contract.fixtureDigest
  };
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
