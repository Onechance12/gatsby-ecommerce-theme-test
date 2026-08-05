import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_ASSISTANT_OPERATIONS_PLAYBOOK
} from "./operations-playbook.js";
import {
  DEFAULT_THRESHER_AI_INSTRUCTIONS
} from "./core.js";
import {
  THRESHER_AI_RUNTIME
} from "./thresher-ai-runtime.js";
import {
  HCN_ASSISTANT_SKILLS,
  HCN_ASSISTANT_SKILL_CODES,
  hcnAssistantSkillInstructions
} from "./skills.js";

test("Thresher has a fixed HCN operating skill catalog without client data", () => {
  assert.equal(HCN_ASSISTANT_SKILLS.length, 15);
  assert.equal(
    new Set(HCN_ASSISTANT_SKILL_CODES).size,
    HCN_ASSISTANT_SKILL_CODES.length
  );
  for (const code of [
    "work_center_triage",
    "claim_filing_readiness",
    "communication_recovery",
    "document_review",
    "date_of_loss_research",
    "closed_file_benchmarking",
    "evidence_and_safety"
  ]) {
    assert.equal(HCN_ASSISTANT_SKILL_CODES.includes(code), true);
  }
  assert.match(hcnAssistantSkillInstructions(), /HCN skill model/);
  assert.doesNotMatch(
    hcnAssistantSkillInstructions(),
    /@|\+1\d{10}|bearer|api key|secret/i
  );
});

test("HCN assistant playbook attaches HCN workflows to a read-only model", () => {
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /exact-file review/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /instead of guessing/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /JobNimbus is the client system of record/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /Claim-filing readiness requires/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /Calendar reads are one local day only/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /absence of a match does not prove no appointment exists/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /read authority only/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /Never create or store an action plan/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /is not proof that no communication exists/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /Automated reminders and system-generated notices/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /Never expose opaque HCN references/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /Chance Brain and Jobrolo are separate systems/i);
  assert.doesNotMatch(
    HCN_ASSISTANT_OPERATIONS_PLAYBOOK,
    /bearer|api key|secret/i
  );
});

test("Thresher AI has a fixed HCN-only model identity and no execution path", () => {
  assert.deepEqual(THRESHER_AI_RUNTIME, {
    identity: "hcn.thresher-ai.v1",
    provider: "groq",
    providerApi: "groq_responses_api",
    model: "openai/gpt-oss-20b",
    instructionsVersion: "hcn.thresher-ai.instructions.v3",
    providerSelectable: false,
    modelSelectable: false,
    providerStateEnabled: false,
    builtInProviderToolsEnabled: false,
    remoteToolsEnabled: false,
    modelCanExecute: false
  });
  assert.match(
    DEFAULT_THRESHER_AI_INSTRUCTIONS,
    /Home Claim Network's dedicated file-operations reasoning system/i
  );
  assert.match(DEFAULT_THRESHER_AI_INSTRUCTIONS, /read-only/i);
  assert.match(DEFAULT_THRESHER_AI_INSTRUCTIONS, /cannot prepare or store an action plan/i);
  assert.doesNotMatch(
    DEFAULT_THRESHER_AI_INSTRUCTIONS,
    /Chance Brain|Jobrolo|Rolo\.ai|generic (?:AI|LLM)|bearer|api key|secret/i
  );
});
