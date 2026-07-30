import assert from "node:assert/strict";
import test from "node:test";

import {
  HCN_ASSISTANT_OPERATIONS_PLAYBOOK
} from "./operations-playbook.js";

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
