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

test("HCN assistant playbook requires fresh facts and human-approved effects", () => {
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /exact-file review/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /Never fill a missing fact/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /JobNimbus as the client system of record/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /Review proposed action/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /has no live-call tool/i);
  assert.match(HCN_ASSISTANT_OPERATIONS_PLAYBOOK, /must never claim a claim was filed/i);
  assert.doesNotMatch(
    HCN_ASSISTANT_OPERATIONS_PLAYBOOK,
    /Chance Brain|Jobrolo|bearer|api key|secret/i
  );
});

test("Thresher AI has a fixed HCN-only model identity and no execution path", () => {
  assert.deepEqual(THRESHER_AI_RUNTIME, {
    identity: "hcn.thresher-ai.v1",
    provider: "groq",
    providerApi: "groq_responses_api",
    model: "openai/gpt-oss-20b",
    instructionsVersion: "hcn.thresher-ai.instructions.v1",
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
  assert.match(DEFAULT_THRESHER_AI_INSTRUCTIONS, /cannot execute/i);
  assert.doesNotMatch(
    DEFAULT_THRESHER_AI_INSTRUCTIONS,
    /Chance Brain|Jobrolo|Rolo\.ai|generic (?:AI|LLM)|bearer|api key|secret/i
  );
});
